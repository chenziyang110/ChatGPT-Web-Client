package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const help = `ChatGPT Web Client — Go Agent CLI

chatgpt-agent.exe ask --account ID --new --text-file QUESTION.txt [--stream]
chatgpt-agent.exe ask --account ID --conversation ID --text-file QUESTION.txt
chatgpt-agent.exe ask --account ID --url URL --text-file QUESTION.txt
chatgpt-agent.exe resume TASK_ID [--stream] [--url VERIFIED_CONVERSATION_URL]
chatgpt-agent.exe resume --request-file SAVED_REQUEST.json [--stream]
chatgpt-agent.exe accounts
chatgpt-agent.exe status

Options (before or after the command):
  --data-dir PATH          Desktop profile directory; defaults to the current user's profile
  --text TEXT             Question text instead of --text-file
  --idempotency-key UUID   Same question retries MUST keep the same key and parameters
  --stream                UTF-8 NDJSON: task, status, delta, replace, heartbeat, done, error
  --wait-timeout SECONDS   Optional local deadline; does NOT cancel the webpage task
  --reply-timeout SECONDS  Webpage reply budget, default 3600 (1–3600)

ask sends once and blocks until the full reply. No Node.js is needed.
The tool saves the full request and key BEFORE sending, and prints its path to stderr.
On connection failure it rereads discovery and reconnects to the SAME request/task.
resume reads the original task; it never fills or sends another webpage message.
For stream output append delta.text; replace.text replaces the entire accumulated text.
Only done confirms completion; done.result.response contains the full final answer.
Without --stream, stdout contains one final task JSON. Status goes to stderr.
Exit: 0 answer received, 1 error/review needed, 2 invalid arguments, 3 local timeout,
130 interrupted. On timeout/interruption keep the task ID and use resume.
The desktop app must be running with Local API enabled. Models follow webpage settings.
`

type options struct {
	command string
	id      string
	values  map[string]string
	stream  bool
	fresh   bool
}

func parse(args []string) (options, error) {
	o := options{values: map[string]string{}}
	positional := []string{}
	allowed := map[string]bool{"data-dir": true, "account": true, "conversation": true, "url": true, "text-file": true, "text": true, "idempotency-key": true, "wait-timeout": true, "reply-timeout": true, "request-file": true}
	seen := map[string]bool{}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "--") {
			positional = append(positional, a)
			continue
		}
		k := strings.TrimPrefix(a, "--")
		if seen[k] {
			return o, fmt.Errorf("duplicate option: %s", a)
		}
		seen[k] = true
		switch k {
		case "stream":
			o.stream = true
		case "new":
			o.fresh = true
		default:
			if !allowed[k] || i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
				return o, fmt.Errorf("unknown option or missing value: %s", a)
			}
			i++
			o.values[k] = args[i]
		}
	}
	if len(positional) == 0 || len(positional) > 2 {
		return o, errors.New("use ask, resume, accounts or status; see --help")
	}
	o.command = positional[0]
	if len(positional) > 1 {
		o.id = positional[1]
	}
	switch o.command {
	case "ask":
		count := 0
		for _, key := range []string{"conversation", "url"} {
			if o.values[key] != "" {
				count++
			}
		}
		if o.fresh {
			count++
		}
		_, hasText := o.values["text"]
		_, hasFile := o.values["text-file"]
		if o.id != "" || o.values["account"] == "" || count != 1 || hasText == hasFile || o.values["request-file"] != "" {
			return o, errors.New("ask requires --account, exactly one of --new/--conversation/--url, and --text-file or --text")
		}
	case "resume":
		if (o.id == "") == (o.values["request-file"] == "") || o.fresh || o.values["account"] != "" || o.values["conversation"] != "" || o.values["text"] != "" || o.values["text-file"] != "" || o.values["idempotency-key"] != "" || o.values["reply-timeout"] != "" || o.values["request-file"] != "" && o.values["url"] != "" {
			return o, errors.New("resume requires TASK_ID or --request-file; it cannot change the question or account")
		}
	case "accounts", "status":
		if o.id != "" {
			return o, errors.New("unexpected argument")
		}
	default:
		return o, errors.New("unknown command; see --help")
	}
	return o, nil
}

func duration(value string, fallback time.Duration) (time.Duration, error) {
	if value == "" {
		return fallback, nil
	}
	v, err := strconv.Atoi(value)
	if err != nil || v < 1 || v > 3600 {
		return 0, errors.New("timeout must be 1–3600 seconds")
	}
	return time.Duration(v) * time.Second, nil
}
func profile(explicit string) (string, error) {
	if explicit == "" {
		explicit = os.Getenv("WORKSPACE_USER_DATA")
	}
	if explicit != "" {
		return filepath.Abs(explicit)
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "ChatGPT-Web-Client"), nil
}

type discovery struct {
	Endpoint string `json:"endpoint"`
	Token    string `json:"token"`
}

func loadDiscovery(dir string) (discovery, error) {
	var d discovery
	b, err := os.ReadFile(filepath.Join(dir, "agent-runtime.json"))
	if err != nil {
		return d, err
	}
	if json.Unmarshal(b, &d) != nil {
		return d, errors.New("invalid discovery file")
	}
	u, err := url.Parse(d.Endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || d.Token == "" {
		return d, errors.New("invalid local API endpoint")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return d, errors.New("invalid local API port")
	}
	d.Endpoint = strings.TrimSuffix(d.Endpoint, "/")
	return d, nil
}

type client struct {
	directory string
	http      *http.Client
	stderr    io.Writer
	retry     bool
}

func newClient(dir string, stderr io.Writer, retry bool) *client {
	return &client{dir, &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, stderr, retry}
}
func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func output(w io.Writer, value any) error { return json.NewEncoder(w).Encode(value) }
func (c *client) call(ctx context.Context, method string, params any, out any) error {
	body, err := json.Marshal(map[string]any{"method": method, "params": params})
	if err != nil {
		return err
	}
	if len(body) > 65536 {
		return errors.New("request exceeds 64 KiB")
	}
	offline := false
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		d, e := loadDiscovery(c.directory)
		if e != nil && !os.IsNotExist(e) {
			return e
		}
		if e == nil {
			req, e := http.NewRequestWithContext(ctx, "POST", d.Endpoint+"/v1/rpc", strings.NewReader(string(body)))
			if e != nil {
				return e
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+d.Token)
			res, transportErr := c.http.Do(req)
			if transportErr == nil {
				raw, readErr := io.ReadAll(io.LimitReader(res.Body, 2<<20))
				res.Body.Close()
				if res.StatusCode >= 300 && res.StatusCode < 400 {
					return errors.New("local API redirect refused")
				}
				if res.StatusCode == 401 {
					latest, loadErr := loadDiscovery(c.directory)
					if loadErr == nil && (latest.Token != d.Token || latest.Endpoint != d.Endpoint) {
						continue
					}
				}
				var envelope struct {
					OK     bool            `json:"ok"`
					Result json.RawMessage `json:"result"`
					Error  string          `json:"error"`
				}
				if readErr == nil && json.Unmarshal(raw, &envelope) == nil {
					if !envelope.OK || res.StatusCode != 200 {
						if res.StatusCode != 503 || !c.retry {
							return fmt.Errorf("local API: %s (HTTP %d)", envelope.Error, res.StatusCode)
						}
					} else {
						if value, ok := out.(*task); ok {
							*value = task{}
						}
						return json.Unmarshal(envelope.Result, out)
					}
				} else if readErr == nil {
					return errors.New("invalid local API response")
				}
			}
		}
		if !c.retry {
			return errors.New("本地服务不可用，请启动客户端并启用本地 API")
		}
		if !offline {
			output(c.stderr, map[string]any{"waiting": true, "message": "等待本地服务重新连接；原请求已保留，不会重复发送"})
			offline = true
		}
		if err := sleep(ctx, time.Second); err != nil {
			return err
		}
	}
}

func question(o options) (string, error) {
	text := o.values["text"]
	if file := o.values["text-file"]; file != "" {
		f, err := os.Open(file)
		if err != nil {
			return "", err
		}
		defer f.Close()
		b, err := io.ReadAll(io.LimitReader(f, 128001))
		if err != nil {
			return "", err
		}
		if len(b) > 128000 {
			return "", errors.New("question file too large")
		}
		text = string(b)
	}
	text = strings.TrimPrefix(text, "\ufeff")
	if !utf8.ValidString(text) || strings.TrimSpace(text) == "" || len([]rune(text)) > 32000 {
		return "", errors.New("question must be valid UTF-8, nonempty and at most 32000 characters")
	}
	return text, nil
}
func requestParams(o options) (map[string]any, error) {
	q, err := question(o)
	if err != nil {
		return nil, err
	}
	budget, err := duration(o.values["reply-timeout"], time.Hour)
	if err != nil {
		return nil, err
	}
	key := o.values["idempotency-key"]
	if key == "" {
		var b [16]byte
		if _, err := rand.Read(b[:]); err != nil {
			return nil, err
		}
		b[6] = (b[6] & 15) | 64
		b[8] = (b[8] & 63) | 128
		key = fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
	}
	p := map[string]any{"accountId": o.values["account"], "idempotencyKey": key, "replyTimeoutMs": budget.Milliseconds(), "input": map[string]any{"type": "prompt", "prompt": q, "submit": true}}
	if o.fresh {
		p["new"] = true
	}
	for _, k := range []string{"conversation", "url"} {
		if o.values[k] != "" {
			p[k] = o.values[k]
		}
	}
	b, _ := json.Marshal(map[string]any{"method": "tasks.create", "params": p})
	if len(b) > 65536 {
		return nil, errors.New("question request exceeds 64 KiB")
	}
	return p, nil
}
func saveRequest(dir string, p map[string]any) (string, error) {
	folder := filepath.Join(dir, "agent-requests")
	if err := os.MkdirAll(folder, 0700); err != nil {
		return "", err
	}
	identity, _ := json.Marshal([]any{p["accountId"], p["idempotencyKey"]})
	hash := sha256.Sum256(identity)
	file := filepath.Join(folder, fmt.Sprintf("%x.json", hash))
	body, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		old, e := os.ReadFile(file)
		if e != nil {
			return "", e
		}
		if string(old) != string(body) {
			return "", errors.New("IDEMPOTENCY_CONFLICT: 原请求已保存，用 resume --request-file 继续")
		}
		return file, nil
	}
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err = f.Write(body); err != nil {
		return "", err
	}
	if err = f.Sync(); err != nil {
		return "", err
	}
	return file, nil
}

type task struct {
	Recovered      bool            `json:"recovered,omitempty"`
	ID             string          `json:"id"`
	AccountID      string          `json:"accountId"`
	ConversationID string          `json:"conversationId,omitempty"`
	Status         string          `json:"status"`
	UpdatedAt      int64           `json:"updatedAt"`
	Error          string          `json:"error,omitempty"`
	Result         json.RawMessage `json:"result,omitempty"`
	Progress       *struct {
		Response string `json:"response"`
		URL      string `json:"url"`
	} `json:"progress,omitempty"`
	Attention *struct {
		Title string `json:"title"`
	} `json:"attention,omitempty"`
}

func wait(ctx context.Context, c *client, t task, stream bool, recoveryURL string, stdout io.Writer) (int, error) {
	text, status := "", ""
	recovered := false
	emit := func(event string, data map[string]any) error {
		data["event"] = event
		data["taskId"] = t.ID
		return output(stdout, data)
	}
	progress := func(value string) error {
		var err error
		if stream && value != text {
			if strings.HasPrefix(value, text) {
				err = emit("delta", map[string]any{"text": strings.TrimPrefix(value, text)})
			} else {
				err = emit("replace", map[string]any{"text": value})
			}
		}
		text = value
		return err
	}
	output(c.stderr, map[string]any{"taskId": t.ID, "conversationId": t.ConversationID, "waiting": true})
	if stream {
		if err := emit("task", map[string]any{"conversationId": t.ConversationID}); err != nil {
			return 1, err
		}
	}
	for {
		if ctx.Err() != nil {
			return 1, ctx.Err()
		}
		if status != t.Status {
			status = t.Status
			message := t.Error
			if t.Attention != nil {
				message = t.Attention.Title
			}
			output(c.stderr, map[string]any{"taskId": t.ID, "status": status, "message": message})
			if stream {
				if err := emit("status", map[string]any{"status": status, "message": message}); err != nil {
					return 1, err
				}
			}
		}
		if t.Progress != nil && t.Status != "uncertain" {
			if err := progress(t.Progress.Response); err != nil {
				return 1, err
			}
		}
		if t.Status == "done" {
			var result struct {
				Response *string `json:"response"`
			}
			if json.Unmarshal(t.Result, &result) != nil || result.Response == nil || *result.Response == "" {
				return 1, errors.New("task completed without an answer")
			}
			if err := progress(*result.Response); err != nil {
				return 1, err
			}
			if stream {
				return 0, emit("done", map[string]any{"result": t.Result, "conversationId": t.ConversationID, "recovered": recovered})
			}
			return 0, output(stdout, t)
		}
		if t.Status == "uncertain" {
			p := map[string]any{"id": t.ID}
			if recoveryURL != "" {
				p["url"] = recoveryURL
			}
			var read struct {
				State  string          `json:"state"`
				Reason string          `json:"reason"`
				Result json.RawMessage `json:"result"`
			}
			if err := c.call(ctx, "tasks.response", p, &read); err != nil {
				return 1, err
			}
			if read.State == "done" {
				t.Status = "done"
				t.Result = read.Result
				t.Progress = nil
				t.Error = ""
				t.Attention = nil
				t.Recovered = true
				recovered = true
				continue
			}
			if read.State == "reading" {
				var partial struct {
					Response string `json:"response"`
				}
				if json.Unmarshal(read.Result, &partial) == nil {
					if err := progress(partial.Response); err != nil {
						return 1, err
					}
				}
				if err := sleep(ctx, time.Second); err != nil {
					return 1, err
				}
				if err := c.call(ctx, "tasks.get", map[string]any{"id": t.ID}, &t); err != nil {
					return 1, err
				}
				continue
			}
			t.Error = read.Reason
		} else if t.Status == "pending" || t.Status == "running" || t.Status == "waiting_user" || t.Status == "blocked" {
			before := t.UpdatedAt
			if err := c.call(ctx, "tasks.wait", map[string]any{"id": t.ID, "timeoutMs": 15000, "afterUpdatedAt": before, "updates": true}, &t); err != nil {
				return 1, err
			}
			if t.UpdatedAt == before && stream {
				if err := emit("heartbeat", map[string]any{"status": t.Status}); err != nil {
					return 1, err
				}
			}
			continue
		}
		if stream {
			return 1, emit("error", map[string]any{"status": t.Status, "message": t.Error})
		}
		return 1, output(stdout, t)
	}
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) (int, error) {
	if len(args) == 0 {
		fmt.Fprint(stdout, help)
		return 0, nil
	}
	for _, a := range args {
		if a == "--help" || len(args) == 1 && a == "help" {
			fmt.Fprint(stdout, help)
			return 0, nil
		}
	}
	o, err := parse(args)
	if err != nil {
		return 2, err
	}
	timeout, err := duration(o.values["wait-timeout"], 0)
	if err != nil {
		return 2, err
	}
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	dir, err := profile(o.values["data-dir"])
	if err != nil {
		return 1, err
	}
	c := newClient(dir, stderr, o.command == "ask" || o.command == "resume")
	defer c.http.CloseIdleConnections()
	if o.command == "accounts" || o.command == "status" {
		method := "accounts.list"
		if o.command == "status" {
			method = "workspace.status"
		}
		var result json.RawMessage
		if err := c.call(ctx, method, map[string]any{}, &result); err != nil {
			return 1, err
		}
		return 0, output(stdout, result)
	}
	var t task
	if o.command == "ask" || o.values["request-file"] != "" {
		var p map[string]any
		if o.command == "ask" {
			p, err = requestParams(o)
		} else {
			var b []byte
			b, err = os.ReadFile(o.values["request-file"])
			if err == nil {
				err = json.Unmarshal(b, &p)
			}
			if err == nil {
				key, ok := p["idempotencyKey"].(string)
				if !ok || key == "" {
					err = errors.New("saved request has no idempotency key")
				}
			}
		}
		if err != nil {
			return 2, err
		}
		file, err := saveRequest(dir, p)
		if err != nil {
			return 1, err
		}
		output(stderr, map[string]any{"idempotencyKey": p["idempotencyKey"], "requestFile": file})
		if err := c.call(ctx, "tasks.create", p, &t); err != nil {
			return 1, err
		}
	} else {
		if err := c.call(ctx, "tasks.get", map[string]any{"id": o.id}, &t); err != nil {
			return 1, err
		}
	}
	if t.ID == "" {
		return 1, errors.New("server returned no task ID")
	}
	return wait(ctx, c, t, o.stream, o.values["url"], stdout)
}
func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	code, err := run(ctx, os.Args[1:], os.Stdout, os.Stderr)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			code = 3
		}
		if errors.Is(err, context.Canceled) {
			code = 130
		}
		output(os.Stderr, map[string]any{"error": err.Error(), "message": "原任务未取消；保留任务 ID 或请求文件，用 resume 继续。"})
	}
	if err != nil && code == 0 {
		code = 1
	}
	os.Exit(code)
}
