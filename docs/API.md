# Local API and CLI

## Recommended Agent tool (Go)

From v1.1.0 all platforms include a native Agent under `resources/agent/` (`Contents/Resources/agent/` inside the macOS app). The executable is `chatgpt-agent.exe` on Windows and `chatgpt-agent` on macOS/Linux. Development builds place it in `dist-agent/`. It is a standalone Go binary with no Node.js dependency. The copied Agent prompt includes its absolute path and fixed account/conversation arguments.

```powershell
.\chatgpt-agent.exe ask --account ACCOUNT_ID --new --text-file question.txt
.\chatgpt-agent.exe ask --account ACCOUNT_ID --conversation CONVERSATION_ID --text-file question.txt
.\chatgpt-agent.exe resume TASK_ID
.\chatgpt-agent.exe resume --request-file SAVED_REQUEST.json
```

`ask` submits once and **blocks until the full reply**. Agents that only need the final answer should omit `--stream`, keep this one process alive, and use their longest process-wait operation instead of creating a recurring monitor or polling `tasks.get`. There is no local deadline unless `--wait-timeout` is supplied. The webpage reply budget defaults to one hour; if that expires after sending, the tool attempts read-only recovery while the page continues generating. Requests and UUIDs are written under the profile's `agent-requests/` before sending. The tool rereads private discovery on reconnect and retries creation only with identical parameters and key. Once it has a task ID, it only waits/reads that task. Ctrl+C, an Agent process-wait yield, or a local timeout is not completion and must not trigger a new send. Continue waiting for the running process or use `resume`.

With `--stream`, stdout is UTF-8 newline-delimited JSON. `task` identifies the operation; `status` and `heartbeat` describe ongoing work; append `delta.text`, and replace the accumulated answer on `replace.text`. Only `done` signals success, containing the full `result.response` and conversation URL. Partial text may be revised by the webpage and is not a completed answer. Without `--stream`, stdout is one final task JSON. stderr carries progress, request path, and task ID, never the connection token. Exit codes: 0 answer received; 1 error/review required; 2 invalid arguments; 3 local timeout; 130 interrupted.

`waiting_user` keeps the same tool process waiting while the user handles the client dialog. Notify the user once; after takeover, the user clicks **交还 Agent 并继续**, which resumes the original task and wakes the existing waiter. Do not classify this expected pause as `blocked` or start another monitor. For `uncertain`, `tasks.response` reads only the associated page and verifies the exact submitted question/message ID, final controls, absence of generation/draft, and six seconds of stable content. It never sends, navigates, resumes a queue or acknowledges a task. If page association was lost on restart, the human can identify the already-open original page using `resume TASK_ID --url URL`. An unavailable/mismatched page still requires review; arbitrary page text never counts as the answer. Recovered responses are marked `recovered:true`, while the original uncertain task audit record remains unchanged.

Internally, `tasks.wait` accepts `id`, `timeoutMs` (0–25000), `afterUpdatedAt`, and `updates:true` for incremental snapshots. Its timeout returns the current task without cancellation. This releases the Electron event loop, so other conversations and the UI continue operating while the calling CLI blocks.

Build with `npm run build:agent` (Go 1.24+ required on the build machine); test with `npm run test:agent`. The normal `npm run build` also builds the Go tool; Packaging builds a matching target binary using GOOS/GOARCH and copies it into the app resource directory. `npm run build:agent:all` cross-compiles all six OS/CPU combinations. The older Node CLI below remains available for administrative commands.

Enable **Local Agent API** in the desktop Settings. The CLI reads `agent-runtime.json` from the app's data directory. The service binds a random port on `127.0.0.1`, rotates its token on startup, and rejects browser Origin/Fetch Metadata on operational endpoints and unexpected Host headers on all endpoints. Public GET /help.html and /help.json provide static documentation without credentials or account data. Never publish the discovery file.

## Account and conversation targeting

Account references accept UUID, unique alias, or an unambiguous display name. Conversation references are scoped to the selected account and accept local UUID, alias, remote ID, or a registered URL. Only ordinary personal `https://chatgpt.com/c/<id>` conversations are supported for prompt automation. Shared links, temporary chats, project/custom-GPT paths and specialized tool workflows are outside this first version.

The conversation list is a **local registry** populated by registration and visited account pages. It does not enumerate all server-side ChatGPT history. Registration records a target; login/access is checked when executing.

```sh
node dist-electron/cli.cjs accounts
node dist-electron/cli.cjs account-alias <account-id> work
node dist-electron/cli.cjs conversations add --account work --url https://chatgpt.com/c/<id> --alias daily
node dist-electron/cli.cjs prompt --account work --conversation daily --text "总结当前主题" --submit --wait --idempotency-key daily-001
node dist-electron/cli.cjs prompt --account work --new --alias research --text "研究这个问题" --submit --wait
node dist-electron/cli.cjs prompt --account work --conversation research --text "继续分析" --submit --wait
node dist-electron/cli.cjs conversations list --account work
```

Choose at most one of `--conversation`, `--url`, `--current`, or `--new`. With no target, a prompt captures that account's current ordinary conversation **when enqueued**. Switching tabs/pages later does not change the task target. Homepage prompts require an explicit new conversation. `--new` requires `--submit`; `conversations create` can reserve a local target/alias for several queued prompts before the first send binds its real URL.

Without `--submit`, prompts prepare a draft. Existing non-empty drafts pause automation rather than being overwritten. For a new conversation whose initial send remains uncertain and whose URL was never bound, register its actual URL as a separate target and cancel its pending local-target tasks; the unresolved new target is never recreated automatically.

## Queue and recovery

Each conversation has a serial queue and an independent browser page. Different conversations in the same account share only the login partition and can run concurrently. Up to **two active browser operations** execute at once; waiting for an idle page or a confirmed sent reply releases that capacity while preserving the conversation lock. Ready pages reacquire capacity and recheck the page before writing. Thus two long replies in one account do not block another account or conversation. Background replies are polled every two seconds, with faster checks while confirming submission or completion and while viewing the page. Generating pages remain loaded; completed idle pages can hibernate. The queue has a global limit of 30 pending/running/waiting_user tasks. Pending work does not automatically resume after an application restart.

Before switching pages or submitting, automation waits for the current page to become idle, preserves existing drafts, and rechecks the pinned target and user-message anchor. An ordinary response requires the matching newly submitted user turn, a later assistant turn, a recognized completion control, no visible busy indicator, an empty composer, and six seconds of stable content. Missing/unknown signals never count as successful completion. DOM changes can require an adapter update.

After sending, recent user turns are matched by their message IDs. Older DOM nodes may unmount, or earlier history may appear before the known sequence, without invalidating the current reply. Initial acknowledgement still requires the last pre-send user anchor followed by exactly one matching new turn. After acknowledgement the exact submitted ID and text remain required; edited or reordered known history, missing interior turns, duplicate IDs and additional user messages pause the task. Positional fallback IDs cannot authorize history-window changes. Once submission is confirmed, review notices say that the message was sent and the reply needs verification; they do not offer a resend.

| Status | Meaning and next step |
| --- | --- |
| `pending` | Queued; may be waiting for account capacity or resume |
| `running` | Inspect `phase` for preparing, waiting for idle, sending or waiting for reply |
| `done` | Operation completed; submitted prompts include the response and bound URL |
| `waiting_user` | Preserved before send; human chooses takeover, retry the same task, or cancel in the desktop |
| `blocked` | Legacy records migrate to waiting_user at startup |
| `uncertain` | A click/message may have happened; review the actual conversation before resuming |
| `cancelled` | Cancelled before send intent |
| `failed` | Legacy task without a safe target was not replayed during migration |

Preparation has a 60-second budget. Direct RPC and Node CLI tasks default to independent 10-minute budgets for the previous generation and the new reply. `--idle-timeout SECONDS` and `--reply-timeout SECONDS` set them independently (1–3600 seconds); the desktop conversation queue uses 60 minutes for each. Errors pause the affected conversation. Local cancellation/takeover does not retract messages or guarantee stopping ChatGPT generation.

```sh
node dist-electron/cli.cjs queue status
node dist-electron/cli.cjs queue pause --account work
node dist-electron/cli.cjs queue takeover --account work
# Inspect the page, finish/clear drafts, and check whether a message was sent.
node dist-electron/cli.cjs queue resume --account work --acknowledged
node dist-electron/cli.cjs task wait <task-id> --wait-timeout 120
node dist-electron/cli.cjs task cancel <task-id>
```

Pause preserves an already sent reply but gates every later send. A task still waiting for the previous reply returns to pending. If the adapter has just filled a draft, it removes only that exact unchanged draft before returning to pending; conflicts require human review. Resume can enable subsequent messages while the current sent reply continues, without duplicating execution. Takeover also cancels local execution, waits for browser-operation cleanup, and restores manual control. The native account page and popups stay hidden while Agent-controlled. Trusted desktop IPC captures a bounded JPEG frame for a live read-only preview every second; no screenshot endpoint is exposed to HTTP. Waiting-for-choice pages stay locked until takeover; account shortcuts move focus away from a locked page. An external browser/device can still change a conversation; detected conflicts pause execution. This cannot guarantee exclusion of remote concurrent edits.

Pass `conversation` to pause/resume/takeover for one conversation; omit it for all queues in the account. Account summary `paused` describes the account-wide switch, while `pausedConversationCount` counts independently paused conversations. Inspect the separate conversation queue rows for their states. `background:true` (Node CLI `--background`) keeps the selected page unchanged while the pinned task executes.

Acknowledgement resolves uncertain tasks for queue management; it **does not resend them**. Pre-send waiting_user tasks require an explicit desktop decision. Generic resume returns USER_DECISION_REQUIRED. The decision carries task ID and a current attention token; stale decisions are rejected. A queued browser task cannot bypass a paused queue.

## Idempotency, retention and CLI waiting

The CLI automatically generates and prints a recovery key to stderr before task creation. Pass the same `--idempotency-key` with identical parameters after a lost response. The server returns the existing task; different parameters return HTTP 409 `IDEMPOTENCY_CONFLICT`. Keys are scoped to an account. A key's target is resolved only on its first successful creation, including `--current` and `--new`.

Task history normally retains up to 200 records, preserving unresolved work. Clearing/pruning history deletes prompts and results from task records; minimal key/hash/task-ID records remain to prevent accidental replay. Reusing a key after its history was deleted returns `REQUEST_ALREADY_HANDLED` with the original task ID. Deleting the account removes its keys. SQLite pages and pre-migration backups are not secure erasure; backups can contain older task data. Exactly-once delivery to ChatGPT cannot be guaranteed across the click/acknowledgement boundary: send intent is persisted before clicking, and uncertain outcomes require manual review.

`--wait` has no client deadline by default. `--wait-timeout` ends only CLI waiting and **does not cancel** the server task. Reconnect with `task wait`. JSON results go to stdout; recovery metadata/errors go to stderr. waiting_user remains in the wait loop, allowing human decisions without recreating tasks. Exit codes: 0 success/queued, 1 error/legacy-blocked/uncertain/cancelled, 2 unknown command, 3 client wait timeout. `snapshot` and `navigate` wait by default. Use `--data-dir PATH` or `WORKSPACE_USER_DATA` for the desktop app's custom profile. `--help` lists compatibility commands such as `task-get` and `task-cancel`.

## HTTP RPC

`GET /health` and `POST /v1/rpc` require `Authorization: Bearer <token>`. RPC requires `Content-Type: application/json` and a body at most 64 KiB:

```json
{"method":"tasks.create","params":{"accountId":"work","conversation":"daily","idempotencyKey":"daily-001","input":{"type":"prompt","prompt":"Hello","submit":true}}}
```

Success is `{ok:true,result:...}`. Errors use `{ok:false,error:"..."}` and non-2xx status. Successful creation means queued, not completed; use `tasks.wait` to long-poll the same task until it reaches a terminal state. IPC and HTTP share the dispatcher and queue.

| Method | Parameters | Result |
| --- | --- | --- |
| `workspace.status` | `{}` | Accounts, active page, conversations, queues, tasks and API status without token |
| `agent.prompt` | `{accountId,conversation?,url?,current?}` | Read-only Agent handoff: prompt, resolved target, scope, API-enabled flag, example RPC request and optional CLI argument arrays |
| `accounts.list/create/rename/switch/remove` | `{}`, `{name}`, `{id,name}`, `{id}`, `{id,confirmName}` | Account operations; deletion requires no unresolved tasks |
| `accounts.alias` | `{id,alias}` | Stable account alias |
| `conversations.list` | `{accountId?}` | Locally registered conversations |
| `conversations.register` | `{accountId,url,alias?}` | Register/update an ordinary conversation target |
| `conversations.create` | `{accountId,alias?}` | Reserve an unbound local conversation |
| `conversations.get` | `{accountId,conversation}` | Resolve a target within its account |
| `conversations.forPage` | `{accountId,pageId}` | Pin a live page to a local conversation, including an empty new-chat page |
| `conversations.open` | `{accountId,conversation}` | Select the target's existing page or open a separate page |
| `tasks.create` | `{accountId,input,conversation?,url?,current?,new?,alias?,idempotencyKey?,replyTimeoutMs?,idleTimeoutMs?,background?}` | Pinned queued task; choose at most one target selector; timeout values are integer milliseconds, 1000–3600000 |
| `tasks.list/get/cancel/clear` | `{}`, `{id}`, `{id}`, `{}` | History, detail, cancellation, or clear resolved history |
| `tasks.edit` | `{accountId,conversation,id,expectedUpdatedAt,prompt}` | Edit a pending prompt; maximum 32000 characters |
| `tasks.removeQueued` | `{accountId,conversation,id,expectedUpdatedAt}` | Cancel a still-pending item; stale controls cannot cancel a running task |
| `queues.reorder` | `{accountId,conversation,items:[{id,updatedAt}]}` | Reorder the complete set of pending items in one conversation |
| `queues.status/pause/resume/takeover` | `{}`, `{accountId,conversation?}`, `{accountId,conversation?,acknowledged?}`, `{accountId,conversation?}` | Account-wide or conversation-specific queue controls |
| `browser.navigate` | `{accountId,url}` | Queued navigation; rejected with outstanding account work |
| `browser.inspect` | `{accountId,pageId?}` | Read-only page readiness, URL/title, editor presence, draft length, busy flag and structural DOM diagnostics; bypasses the sending queue without resuming it |
| `browser.control` | `{accountId,action}` | Manual `reload/back/forward`; locked during execution |

The trusted renderer additionally exposes `ui.bounds`, `ui.visibility`, `window.state/control`, `settings.api`, `agent.prompt.copy`, `browser.preview` and `tasks.decide`. HTTP cannot call those methods. Update operations (`updates.status/check/configure/open/download/cancel/install`) are also trusted IPC only. Downloads are explicit, architecture-specific and hash-verified. Normal installation refuses running tasks or webpage replies; an explicit trusted-UI `updates.install` request with `{ "force": true }` shuts down after persisting state and pausing queues. Interrupted sent tasks need human review and are never resent automatically. `agent.prompt.copy` accepts the same target parameters and writes the generated prompt to the system clipboard; ordinary `agent.prompt` only returns data.

Task inputs:

```json
{"type":"navigate","url":"https://chatgpt.com/c/conversation-id"}
{"type":"snapshot"}
{"type":"fill","selector":"#prompt-textarea","text":"Draft"}
{"type":"click","selector":"[data-testid='send-button']"}
{"type":"prompt","prompt":"Draft","submit":false}
{"type":"prompt","prompt":"Please answer","submit":true}
```

Low-level click means the click ran; it does not promise a ChatGPT reply. Use submitted prompts for reply-aware sequencing. Fill refuses passwords and nonempty fields. Snapshot returns up to 64,000 characters of visible main content. Browser actions have no arbitrary script/shell or credential export interface. Tasks carry `conversationId`, `targetUrl`, phase/timestamps, `seq`, `queueOrder`, `background`, `sendIntentAt`, `submittedAt`, and (after review) `resolvedAt`; an unbound target resolves its URL through the conversation registry at execution.

Editing, removal and reordering require the latest `updatedAt` from task reads. Reordering must provide every pending item exactly once and leaves started tasks untouched. A changed version, started item or stale pending set returns 409 `QUEUE_CHANGED`; reread before offering another change. Editing preserves the original creation key and request hash: retrying the original creation returns the edited existing task instead of sending a duplicate. All these methods also work through `node dist-electron/cli.cjs rpc METHOD JSON`.

## External tools / AnythingCLI

### Generate a scoped Agent handoff

```sh
node dist-electron/cli.cjs agent-prompt --account work
node dist-electron/cli.cjs agent-prompt --account work --conversation daily
node dist-electron/cli.cjs agent-prompt --account work --current
node dist-electron/cli.cjs browser inspect --account work
node dist-electron/cli.cjs prompt --account work --conversation daily --text-file /absolute/path/question.txt --submit --idempotency-key consult-001
```

`agent-prompt` prints a JSON handoff; its `prompt` field is the complete text to give an Agent. Choose at most one conversation, URL or current selector. With none, the handoff starts a new consultation in the specified account; with a selector, the resolved ID or canonical URL is pinned at generation. `current` is never retained in the generated target. Generation neither enables the API nor creates tasks or conversations; CLI/HTTP generation still requires an already enabled API, while the desktop can generate offline.

The handoff contains no token and does not read the discovery file. CLI arrays include the app's actual data directory and built CLI path; packaged applications omit those arrays and provide the HTTP procedure instead. The short prompt links to help.html (help.json for machine reading), which covers response polling, same-conversation follow-ups, idempotency and waiting_user/uncertain recovery. They require local tool access and a logged-in account; they do not select the webpage model. Target scope is an instruction, not an account-restricted API credential.

`--text-file PATH` accepts a regular UTF-8 file up to 128000 bytes, strips an optional leading BOM, and rejects simultaneous `--text` or positional prompt text. Server limits still apply: 32000 prompt characters and 64 KiB per RPC body. Pass arguments separately; do not interpolate questions into shell commands.

### Diagnose a blocked browser task

Use `browser inspect --account ID` before retrying a page error. It never creates a task, changes the queue, navigates, reads draft/message text or exports credentials. It inspects only an already opened account view; `not_open` means open that account in the desktop first. `ready` reports an available composer, while `draftLength` and `busy` identify reasons not to submit yet. `loading`, `verification_required`, `login_required` and `unavailable` include a suggested next step. A ready page does not imply that its queue is resumed or that a particular model was selected.

The optional `dom` result describes the editor tag/contenteditable flag, visible editor count, draft line lengths, editor child tags/text lengths/line-break counts (first 20 lines/children), send button availability, individual busy markers, message count, final message role and terminal-action visibility. It contains no draft or message bodies. These are observations, not a guarantee of reply completion. The HTTP `browser.inspect` method accepts an optional `pageId` to pin repeated samples to one already opened account page.

Page automation errors retain their known guard code and report the failing stage (for example `focus_editor`, `write_text`, or `verify_send`). Unexpected page exceptions report `PAGE_SCRIPT_FAILED` with a safe error class instead of storing arbitrary exception text. These diagnostics do not retry, submit, resume queues, or bypass existing human decisions.

Document-load completion is insufficient for a dynamically initialized composer. Before mutating the page, prompt execution waits up to 30 seconds (bounded by its preparation budget) for the composer and account state to become ready. Persistent verification/login pages are reported explicitly; verification challenges are never solved automatically. `COMPOSER_NOT_READY` indicates the input never became available. Preserve and inspect the original waiting_user task; do not submit duplicates. Model selection remains controlled by the webpage, with no automatic Pro selection API.

### Call from another tool

Use a normal subprocess or HTTP adapter. Pass arguments separately instead of shell interpolation:

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const { stdout } = await promisify(execFile)(process.execPath, [
  '/absolute/path/to/ChatGPT-Web-Client/dist-electron/cli.cjs',
  'prompt', '--account', 'work', '--conversation', 'daily',
  '--text', 'Explain the current topic', '--submit', '--wait',
  '--idempotency-key', 'explain-001'
]);
const task = JSON.parse(stdout);
```

Batch import, background daemon operation without Electron, and server-history synchronization remain later phases. The desktop app must stay running with the target accounts logged in.

## Conversation notifications and shortcut settings

`workspace.status` also returns `notifications` and `shortcuts`. Notification records contain account ID, canonical conversation URL, title, running/unread flags, completion time and a reply fingerprint token; notification storage does not duplicate prompt/response text. Counts are distinct unread conversations per account, not the number of generated turns. Historical page loads establish a baseline rather than emit new notifications. An unread receipt is cleared when its exact conversation is visibly selected in the focused workspace; background selection, hidden/minimized windows, modals and Agent-locked previews do not count as viewed. Running flags reset on restart while genuinely unread receipts persist.

| Method | Parameters | Result |
| --- | --- | --- |
| `notifications.list` | `{accountId?}` | Per-conversation activity and receipts |
| `notifications.read` | `{accountId,id,token}` | Mark the specific observed completion handled; a newer token returns 409 |
| `notifications.open` | `{accountId,id,token}` | Activate/open the conversation, then mark its completion handled; busy pages/drafts and queue locks prevent unsafe navigation |
| `settings.shortcuts.get` | `{}` | Complete shortcut configuration |
| `settings.shortcuts.save` | `{shortcuts}` | Validate and persist the whole configuration; reject duplicate bindings |
| `settings.shortcuts.reset` | `{}` | Restore platform defaults |

Use `rpc notifications.list` or `rpc settings.shortcuts.get` with the CLI. A shortcut config maps `focus`, `previous`, `next`, and `account1` through `account9` to `null` (disabled) or `{code,control,meta,alt,shift}`. Key codes accept letters, digits, arrows, F1–F12, Home/End and PageUp/PageDown, with at least Control, Meta or Alt. The global boss key is fixed and reserved as `Ctrl+Shift+S` on Windows/Linux and `Command+Shift+S` on macOS; it is not part of this configurable map. `settings.shortcuts.capture {active}` is a trusted-renderer-only IPC method used by the settings recorder; HTTP cannot invoke it.

The monitor reads each live supported page every 1.5 seconds, with at most one outstanding read per page. Completion requires a recognized finished assistant turn with stable content for six seconds and no busy indicator. Temporary composer re-renders preserve an in-flight observation, while opening a historical user-only conversation does not fabricate a running state. The task executor and monitor share a completion fingerprint, so they cannot double-count one reply or recreate a notification after it was handled. New completion tokens also emit an operating-system notification; clicking it restores the window and opens the exact conversation. No remote-page bridge is added. This observes live client pages, not all remote ChatGPT activity. Navigating away or safely hibernating an idle background page clears observed running status without fabricating completion.

### Desktop-only human choices

`tasks.decide({id,token,choice})` is trusted IPC only; `token` is `task.attention.id`. Allowed choices are returned in `task.attention.choices`. Retrying uses the original task ID, target and input. An uncertain task never offers retry. `browser.preview({accountId})` is trusted IPC only, returning `{accountId,image,capturedAt}` or null when unlocked. Neither method is callable over HTTP. `workspace.status.lockedAccountIds` is the authoritative lock list, covering execution cleanup and unresolved user choices. Queue `control` is agent/human; takeover persists human control across restart.


### Parallel conversation pages

`agent.prompt({accountId,pageId})` pins an exact open page, validating its account ownership. `pageId`, `current`, `url`, and `conversation` are mutually exclusive. A loaded blank homepage produces a new-conversation handoff; an opening or closed page raises an error rather than substituting a saved URL. The toolbar snapshots the live selected page when clicked: ordinary conversations are pinned by URL, while home, project and other unsupported pages default the dialog to a new consultation. Explicitly selecting an unsupported current conversation still fails with actionable guidance. Preview and copy keep the resolved target, including when enabling the service or switching background pages.

`workspace.status.pages` lists opened page IDs, account/conversation IDs, selected/locked state and the current task ID. `browser.select({accountId,pageId})` changes the visible page without navigating or stopping the other pages; `browser.closePage({accountId,pageId})` refuses locked pages. `browser.inspect` and trusted `browser.preview` accept optional `pageId`. Every page reference is checked against the account.

While the workspace shows a locked page, `browser.preview` scrolls its conversation viewport to the latest reply before each capture. It finds the scrollable ancestor of the last message turn rather than clicking page controls; sidebars, nested code blocks and drafts are untouched. Inactive pages are captured without following. Following stops when the page is unlocked or taken over, and captures interrupted by navigation are discarded.

The desktop **New conversation** button is a trusted manual action, not `browser.navigate`: it opens a separate ChatGPT home tab immediately and never creates or waits behind an Agent task. The queued `browser.navigate` RPC remains available for automated navigation that must follow task safety rules.

`queues.pause/resume/takeover` accept optional `conversation` (resolved within the account). CLI: `queue takeover --account ID --conversation ID`. Omitting it retains an explicit account-wide action. Queue status includes account summaries and per-conversation rows; account summaries include all `runningTaskIds`. A page error or scoped takeover pauses only that conversation. Deleting an account still waits for every active conversation and wipes all its pages before clearing its profile.

The desktop now has conversation tabs. The takeover button and shortcut operate on the selected conversation. Independent pages keep their generation and drafts while hidden, and notifications observe them separately. There are at most 20 open pages per account; close unused pages to free resources. On application restart only the last selected page is restored automatically; other task pages reopen when their paused tasks are explicitly continued.
