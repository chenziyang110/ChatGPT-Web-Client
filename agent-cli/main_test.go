package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func server(t *testing.T, handler http.HandlerFunc) string {
	t.Helper()
	dir := t.TempDir()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Error("missing auth")
		}
		handler(w, r)
	}))
	t.Cleanup(s.Close)
	b, _ := json.Marshal(discovery{Endpoint: s.URL, Token: "test-secret"})
	if err := os.WriteFile(filepath.Join(dir, "agent-runtime.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	return dir
}
func envelope(w http.ResponseWriter, v any) {
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": v})
}

type rpcRequest struct {
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

func decode(t *testing.T, r *http.Request) rpcRequest {
	t.Helper()
	var v rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestBlockingStreamAndSavedReplay(t *testing.T) {
	var created atomic.Int32
	var step atomic.Int32
	var accepted string
	dir := ""
	dir = server(t, func(w http.ResponseWriter, r *http.Request) {
		req := decode(t, r)
		if req.Method == "tasks.create" {
			files, _ := filepath.Glob(filepath.Join(dir, "agent-requests", "*.json"))
			if len(files) != 1 {
				t.Error("request was not saved before sending")
			}
			raw, _ := json.Marshal(req.Params)
			if accepted != "" && accepted != string(raw) {
				t.Error("replay changed the request")
			}
			accepted = string(raw)
			if created.Add(1) == 1 {
				conn, _, _ := w.(http.Hijacker).Hijack()
				conn.Close()
				return
			}
			envelope(w, map[string]any{"id": "one-task", "conversationId": "fixed", "status": "running", "updatedAt": 1})
			return
		}
		if req.Method != "tasks.wait" {
			t.Errorf("unexpected mutation: %s", req.Method)
		}
		if req.Params["id"] != "one-task" || req.Params["updates"] != true {
			t.Error("not waiting for same task")
		}
		time.Sleep(25 * time.Millisecond)
		n := step.Add(1)
		result := map[string]any{"id": "one-task", "conversationId": "fixed", "status": "running", "updatedAt": n + 1}
		switch n {
		case 1:
			result["progress"] = map[string]any{"response": "你好"}
		case 2:
			result["progress"] = map[string]any{"response": "你好，世"}
		case 3:
			result["progress"] = map[string]any{"response": "修订后的回答"}
		case 4:
			result["status"] = "waiting_user"
		default:
			result["status"] = "done"
			result["result"] = map[string]any{"response": "修订后的回答。", "url": "https://chatgpt.com/c/fixed"}
		}
		envelope(w, result)
	})
	var out, stderr bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	code, err := run(ctx, []string{"ask", "--data-dir", dir, "--account", "account", "--new", "--text", "问题\n$(不执行)", "--idempotency-key", "fixed-key", "--stream"}, &out, &stderr)
	if err != nil || code != 0 {
		t.Fatalf("%d %v %s", code, err, stderr.String())
	}
	if created.Load() != 2 {
		t.Fatal("lost creation response should only retry the identical request")
	}
	var events []map[string]any
	assembled := ""
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
		switch event["event"] {
		case "delta":
			assembled += event["text"].(string)
		case "replace":
			assembled = event["text"].(string)
		}
	}
	if assembled != "修订后的回答。" || events[len(events)-1]["event"] != "done" {
		t.Fatal(out.String())
	}
	if !strings.Contains(out.String(), "waiting_user") || strings.Contains(out.String()+stderr.String(), "test-secret") {
		t.Fatal("missing wait state or leaked secret")
	}
	files, _ := filepath.Glob(filepath.Join(dir, "agent-requests", "*.json"))
	var saved map[string]any
	b, _ := os.ReadFile(files[0])
	json.Unmarshal(b, &saved)
	saved["new"] = false
	if _, err := saveRequest(dir, saved); err == nil {
		t.Fatal("different request reused same key")
	}
}

func TestQuietWaitSurvivesHumanTakeoverAndOnlyPrintsFinalResult(t *testing.T) {
	var waits atomic.Int32
	dir := server(t, func(w http.ResponseWriter, r *http.Request) {
		req := decode(t, r)
		if req.Method == "tasks.get" {
			envelope(w, map[string]any{"id": "quiet", "status": "running", "updatedAt": 1})
			return
		}
		if req.Method != "tasks.wait" {
			t.Errorf("unexpected mutation: %s", req.Method)
		}
		n := waits.Add(1)
		result := map[string]any{"id": "quiet", "status": "running", "updatedAt": n + 1}
		switch n {
		case 1:
			result["status"] = "waiting_user"
			result["attention"] = map[string]any{"title": "你已接管，任务等待继续"}
		case 2:
			result["status"] = "pending"
		default:
			result["status"] = "done"
			result["result"] = map[string]any{"response": "恢复后的最终回答", "url": "https://chatgpt.com/c/quiet"}
		}
		envelope(w, result)
	})
	var out, stderr bytes.Buffer
	code, err := run(context.Background(), []string{"resume", "quiet", "--data-dir", dir}, &out, &stderr)
	if err != nil || code != 0 {
		t.Fatalf("%d %v %s", code, err, stderr.String())
	}
	if waits.Load() != 3 || strings.Count(strings.TrimSpace(out.String()), "\n") != 0 {
		t.Fatalf("quiet wait emitted intermediate stdout: %q", out.String())
	}
	var result task
	if json.Unmarshal(out.Bytes(), &result) != nil || result.Status != "done" || !strings.Contains(string(result.Result), "恢复后的最终回答") {
		t.Fatal(out.String())
	}
}

func TestResumeNeverSendsAndRecoversReadOnly(t *testing.T) {
	var reads atomic.Int32
	dir := server(t, func(w http.ResponseWriter, r *http.Request) {
		req := decode(t, r)
		switch req.Method {
		case "tasks.get":
			envelope(w, map[string]any{"id": "original", "status": "uncertain", "error": "routing changed"})
		case "tasks.response":
			n := reads.Add(1)
			state := "reading"
			if n > 1 {
				state = "done"
			}
			envelope(w, map[string]any{"state": state, "result": map[string]any{"response": "原问题的回答", "url": "https://chatgpt.com/c/original"}})
		default:
			t.Errorf("resume must never send: %s", req.Method)
		}
	})
	var out, stderr bytes.Buffer
	code, err := run(context.Background(), []string{"resume", "original", "--data-dir", dir}, &out, &stderr)
	if err != nil || code != 0 {
		t.Fatalf("%d %v", code, err)
	}
	var result task
	json.Unmarshal(out.Bytes(), &result)
	if !result.Recovered || result.Status != "done" || result.Error != "" {
		t.Fatal(out.String())
	}
}

func TestBlockingAndTimeoutDoNotCancel(t *testing.T) {
	var calls atomic.Int32
	dir := server(t, func(w http.ResponseWriter, r *http.Request) {
		req := decode(t, r)
		calls.Add(1)
		if req.Method != "tasks.get" && req.Method != "tasks.wait" {
			t.Error("unexpected mutation")
		}
		if req.Method == "tasks.wait" {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
		envelope(w, map[string]any{"id": "wait", "status": "running", "updatedAt": 1})
	})
	var out, stderr bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	code, err := run(ctx, []string{"resume", "wait", "--data-dir", dir, "--stream"}, &out, &stderr)
	if code == 0 || !errors.Is(err, context.DeadlineExceeded) || calls.Load() != 2 || strings.Contains(out.String(), `"event":"done"`) {
		t.Fatalf("%d %v %s", code, err, out.String())
	}
}

func TestValidationAndRedirect(t *testing.T) {
	for _, args := range [][]string{{"ask", "--account", "a", "--new", "--url", "https://chatgpt.com/c/x", "--text", "x"}, {"resume", "id", "--text", "another"}, {"ask", "--account", "a", "--text", "x"}} {
		if _, err := parse(args); err == nil {
			t.Fatal(args)
		}
	}
	dir := t.TempDir()
	for _, endpoint := range []string{"http://evil.test:1234", "http://127.0.0.1:1/path", "http://user@127.0.0.1:1", "http://127.0.0.1:1?x=1", "http://127.0.0.1:1#fragment"} {
		b, _ := json.Marshal(discovery{endpoint, "secret"})
		os.WriteFile(filepath.Join(dir, "agent-runtime.json"), b, 0600)
		if _, err := loadDiscovery(dir); err == nil {
			t.Fatal(endpoint)
		}
	}
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("followed redirect") }))
	defer target.Close()
	dir = server(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) })
	c := newClient(dir, &bytes.Buffer{}, true)
	var v any
	if err := c.call(context.Background(), "tasks.get", map[string]any{"id": "id"}, &v); err == nil || !strings.Contains(err.Error(), "redirect") {
		t.Fatal(fmt.Sprint(err))
	}
}
