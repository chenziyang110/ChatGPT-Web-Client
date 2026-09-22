#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { argumentsFor, seconds } from './arguments';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Discovery } from '../core/agent/LocalApi';
import type { AgentTask } from '../shared/types';

const help = `ChatGPT Web Client — local agent CLI

  node dist-electron/cli.cjs [--data-dir PATH] <command>

  status                              Workspace status
  accounts                            List accounts
  account-create NAME                 Create an isolated account
  account-rename ID NAME              Rename an account
  account-alias ID ALIAS              Set a stable account alias
  account-switch ID                   Activate an account
  account-remove ID CONFIRM_NAME      Delete account and local login data
  navigate ID URL                     Open a ChatGPT URL
  snapshot ID                         Read visible page text
  browser inspect --account ID        Diagnose page readiness without queueing or sending
  prompt ID TEXT [--submit] [--wait]   Prepare draft, or explicitly submit
  task ID JSON [--wait]               Run navigate/snapshot/fill/click/prompt
  conversations list --account ID
  conversations add --account ID --url URL [--alias NAME]
  conversations create --account ID [--alias NAME]
  conversations get --account ID --conversation ID_OR_ALIAS
  prompt --account ID --conversation ID_OR_ALIAS --text TEXT --submit --wait
  prompt --account ID --new [--alias NAME] --text TEXT --submit
    --text-file PATH                   Read a UTF-8 question file instead of --text
  agent-prompt --account ID [--conversation ID | --url URL | --current]
                                      Generate Agent instructions without sending
    Targets: --conversation, --url, --current, or --new (choose one).
    --idempotency-key KEY              Reuse the same key when retrying
    --reply-timeout SECONDS            Server reply budget (default 600)
    --idle-timeout SECONDS             Previous-reply waiting budget (default 600)
    --background                      Keep the selected page while executing
    --wait-timeout SECONDS             Client waiting budget; does not cancel
  queue status
  queue pause|resume|takeover --account ID [--conversation ID]
    resume --acknowledged              Confirm manual review of uncertain sends
  task wait|get|cancel TASK_ID
  tasks                               List task history
  task-get ID                         Inspect task result
  task-cancel ID                      Cancel waiting/running task
  tasks-clear                         Clear finished task history
  rpc METHOD [JSON]                   Call the documented RPC interface

Enable Local API in the desktop app's Settings first.
Use WORKSPACE_USER_DATA or --data-dir for custom profiles.
Results are JSON. Errors exit 1; invalid command exits 2; client wait timeout exits 3. Waiting has no client deadline unless --wait-timeout is provided.
`;
function defaultDirectory(): string {
  if (process.env.WORKSPACE_USER_DATA) return path.resolve(process.env.WORKSPACE_USER_DATA);
  const base = process.platform === 'darwin' ? path.join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config');
  return path.join(base, 'ChatGPT-Web-Client');
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args[0] === 'help') { console.log(help); return; }
  const { positional, options } = argumentsFor(args);
  const replyTimeoutMs = seconds(options['reply-timeout']);
  const idleTimeoutMs = seconds(options['idle-timeout']);
  const waitTimeoutMs = seconds(options['wait-timeout']);
  const directory = typeof options['data-dir'] === 'string' ? path.resolve(options['data-dir']) : defaultDirectory();
  let discovery: Discovery;
  try { discovery = JSON.parse(readFileSync(path.join(directory, 'agent-runtime.json'), 'utf8')); }
  catch { throw new Error('Local API is unavailable. Start the desktop app and enable Local API in Settings.'); }
  const endpoint = new URL(discovery.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password ||
    endpoint.pathname !== '/' || endpoint.search || endpoint.hash || !endpoint.port || typeof discovery.token !== 'string') throw new Error('Invalid local API discovery file');
  async function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${endpoint.origin}/v1/rpc`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${discovery.token}` },
      body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(30000) });
    const data = await response.json() as { ok: boolean; result: T; error?: string };
    if (!response.ok || !data.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data.result;
  }
  const [command, id, value] = positional;
  let result: unknown; let shouldWait = false;
  const requireArg = (arg: unknown, name: string): string => { if (typeof arg !== 'string' || !arg) throw new Error(`Missing ${name}`); return arg; };
  const account = () => requireArg(options.account ?? id, 'account');
  const promptText = () => {
    if (options['text-file'] !== undefined) {
      if (options.text !== undefined || value !== undefined) throw new Error('Choose --text-file or prompt text, not both');
      const filename = path.resolve(requireArg(options['text-file'], 'text file'));
      const info = statSync(filename);
      if (!info.isFile() || info.size > 128000) throw new Error('Question file must be a regular file no larger than 128000 bytes');
      return readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
    }
    return requireArg(options.text ?? value, 'prompt');
  };
  const target = () => ({ conversation: options.conversation, url: options.url, new: options.new, current: options.current, alias: options.alias });
  async function create(input: unknown): Promise<AgentTask> {
    const idempotencyKey = options['idempotency-key'] ?? randomUUID();
    // Print the recovery key before the request, even if the response is lost.
    console.error(JSON.stringify({ idempotencyKey }));
    const navigation = typeof input === 'object' && input !== null && 'type' in input && input.type === 'navigate';
    return call<AgentTask>('tasks.create', { accountId: account(), input, ...(navigation ? {} : target()), idempotencyKey, replyTimeoutMs, idleTimeoutMs, background: options.background });
  }
  switch (command) {
    case 'browser':
      if (id !== 'inspect') throw new Error('Use browser inspect --account ID');
      result = await call('browser.inspect', { accountId: requireArg(options.account, 'account') }); break;
    case 'status': result = await call('workspace.status'); break;
    case 'accounts': result = await call('accounts.list'); break;
    case 'account-create': result = await call('accounts.create', { name: requireArg(id, 'name') }); break;
    case 'account-rename': result = await call('accounts.rename', { id: requireArg(id, 'ID'), name: requireArg(value, 'name') }); break;
    case 'account-alias': result = await call('accounts.alias', { id: requireArg(id, 'ID'), alias: requireArg(value, 'alias') }); break;
    case 'account-switch': result = await call('accounts.switch', { id: requireArg(id, 'ID') }); break;
    case 'account-remove': result = await call('accounts.remove', { id: requireArg(id, 'ID'), confirmName: requireArg(value, 'confirmation name') }); break;
    case 'navigate': result = await create({ type: 'navigate', url: requireArg(options.url ?? value, 'URL') }); shouldWait = true; break;
    case 'snapshot': result = await create({ type: 'snapshot' }); shouldWait = true; break;
    case 'prompt': result = await create({ type: 'prompt', prompt: promptText(), submit: options.submit === true }); shouldWait = options.wait === true; break;
    case 'agent-prompt':
      if (options.new) throw new Error('For an account-scoped Agent prompt, omit the conversation target');
      result = await call('agent.prompt', { accountId: account(), conversation: options.conversation, url: options.url, current: options.current }); break;
    case 'task':
      if (['wait', 'get', 'cancel'].includes(id)) {
        result = await call(id === 'cancel' ? 'tasks.cancel' : 'tasks.get', { id: requireArg(value, 'task ID') }); shouldWait = id === 'wait';
      } else { result = await create(JSON.parse(requireArg(value, 'task JSON'))); shouldWait = options.wait === true; }
      break;
    case 'conversations': {
      const accountId = requireArg(options.account, 'account');
      if (id === 'list') result = await call('conversations.list', { accountId });
      else if (id === 'add') result = await call('conversations.register', { accountId, url: requireArg(options.url, 'URL'), alias: options.alias });
      else if (id === 'create') result = await call('conversations.create', { accountId, alias: options.alias });
      else if (id === 'get') result = await call('conversations.get', { accountId, conversation: requireArg(options.conversation, 'conversation') });
      else throw new Error('Use conversations list|add|create|get');
      break;
    }
    case 'queue':
      if (!['status', 'pause', 'resume', 'takeover'].includes(id)) throw new Error('Use queue status|pause|resume|takeover');
      result = await call(`queues.${id}`, id === 'status' ? {} : { accountId: requireArg(options.account, 'account'), acknowledged: options.acknowledged, conversation: options.conversation }); break;
    case 'tasks': result = await call('tasks.list'); break;
    case 'task-get': result = await call('tasks.get', { id: requireArg(id, 'ID') }); break;
    case 'task-cancel': result = await call('tasks.cancel', { id: requireArg(id, 'ID') }); break;
    case 'tasks-clear': result = await call('tasks.clear'); break;
    case 'rpc': result = await call(requireArg(id, 'method'), value ? JSON.parse(value) : {}); break;
    default: console.error(help); process.exitCode = 2; return;
  }
  if (shouldWait) {
    const taskId = (result as AgentTask).id;
    const deadline = Date.now() + (waitTimeoutMs ?? Infinity);
    console.error(JSON.stringify({ taskId, waiting: true }));
    while (['pending', 'running', 'waiting_user'].includes((result as AgentTask).status) && Date.now() < deadline) {
      result = await call<AgentTask>('tasks.wait', { id: taskId, timeoutMs: Math.max(0, Math.min(25000, Math.floor(deadline - Date.now()))), afterUpdatedAt: (result as AgentTask).updatedAt });
    }
    if (['pending', 'running', 'waiting_user'].includes((result as AgentTask).status)) {
      process.exitCode = 3; console.error(JSON.stringify({ taskId, error: 'Client wait timed out; task continues. Use task wait to reconnect.' }));
    } else if ((result as AgentTask).status !== 'done') process.exitCode = 1;
  }
  console.log(JSON.stringify(result, null, 2));
}
void main().catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });
