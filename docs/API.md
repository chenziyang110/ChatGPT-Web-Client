# Local API and CLI

Enable Local Agent API in the desktop Settings first. Read `agent-runtime.json` from the data directory listed in README. It contains `{endpoint, token, pid, version:1}`. Never publish that file. The port is randomly assigned on `127.0.0.1`; the token rotates on each start.

Both `GET /health` and `POST /v1/rpc` require `Authorization: Bearer <token>`. RPC requires `Content-Type: application/json`, a body no larger than 64 KiB, and the following shape:

```json
{"method":"tasks.create","params":{"accountId":"<uuid>","input":{"type":"prompt","prompt":"Hello","submit":false}}}
```

Success: `{ok:true,result:...}`. Errors: `{ok:false,error:"..."}` with non-2xx HTTP status. Browser-origin requests are rejected. Do not expose this service through a public proxy. A successful task creation means queued, not completed; poll `tasks.get`.

| Method | Parameters | Result |
| --- | --- | --- |
| `workspace.status` | `{}` | Accounts, active account, page, task history, API status without token |
| `accounts.list` | `{}` | Account metadata |
| `accounts.create` | `{name}` | Creates and activates an account |
| `accounts.rename` | `{id,name}` | Renamed account |
| `accounts.switch` | `{id}` | Activated account |
| `accounts.remove` | `{id,confirmName}` | Clears profile, session and task history; exact name confirmation required |
| `browser.navigate` | `{accountId,url}` | Opens an HTTPS ChatGPT URL |
| `browser.control` | `{accountId,action}` | `reload`, `back`, `forward` |
| `tasks.create` | `{accountId,input}` | Queued task |
| `tasks.list` | `{}` | Latest 200 tasks, newest first |
| `tasks.get` | `{id}` | Task state, result or error |
| `tasks.cancel` | `{id}` | Cancels queued/running work |
| `tasks.clear` | `{}` | Clears finished history; rejected while executing |

The trusted renderer also has `ui.visibility {visible}` and `settings.api {enabled}`. These are not available through HTTP.

## Task inputs

```json
{"type":"navigate","url":"https://chatgpt.com/c/conversation-id"}
{"type":"snapshot"}
{"type":"fill","selector":"#prompt-textarea","text":"Draft"}
{"type":"click","selector":"[data-testid='send-button']"}
{"type":"prompt","prompt":"Draft","submit":false}
{"type":"prompt","prompt":"Please answer","submit":true}
```

Snapshots return `{url,title,text}`, truncated to 64,000 characters of visible main content. Fill supports input/textarea/contenteditable, rejects password fields, and emits native input events. Click targets one visible, enabled element and may cause side effects. Browser actions require the ChatGPT origin; no arbitrary page script or shell command is accepted.

Prompt defaults to draft-only and returns `{prepared:true}`. Explicit submission waits for a new assistant message, no stop button, and stable text, returning `{submitted:true,response,url}`. This heuristic may need adapting when ChatGPT changes.

Tasks follow `pending → running → done | failed | cancelled`, run FIFO, have a 120-second execution timeout and a 30-task outstanding limit. Interrupted tasks become failed on restart and are not replayed. Cancellation cannot undo submitted messages, clicks or navigation. Account deletion is refused while its tasks are executing/queued. Prefer navigation tasks over synchronous `browser.navigate` when cancellation/polling is needed.

## External tools / AnythingCLI

Configure the external tool's generic command or HTTP adapter to call this interface. No undocumented AnythingCLI-specific plugin API is assumed. Pass arguments separately to prevent shell interpolation:

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const { stdout } = await run(process.execPath, [
  '/absolute/path/to/ChatGPT-Web-Client/dist-electron/cli.cjs',
  'prompt', accountId, 'Explain the current topic', '--submit', '--wait'
]);
const task = JSON.parse(stdout);
```

The CLI reads the private discovery file and never prints its token. Use `--data-dir PATH` before the command or `WORKSPACE_USER_DATA` for custom profiles. `--wait` exits nonzero on task failure/cancellation/timeout; `snapshot` waits by default. Without `--wait`, task commands return queued metadata. Transport/runtime errors exit 1; unknown commands exit 2. Use `--help` for the command list.
