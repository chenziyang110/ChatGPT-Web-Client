#!/usr/bin/env node
import { readFileSync } from 'node:fs';
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
  account-switch ID                   Activate an account
  account-remove ID CONFIRM_NAME      Delete account and local login data
  navigate ID URL                     Open a ChatGPT URL
  snapshot ID                         Read visible page text
  prompt ID TEXT [--submit] [--wait]   Prepare draft, or explicitly submit
  task ID JSON [--wait]               Run navigate/snapshot/fill/click/prompt
  tasks                               List task history
  task-get ID                         Inspect task result
  task-cancel ID                      Cancel waiting/running task
  tasks-clear                         Clear finished task history
  rpc METHOD [JSON]                   Call the documented RPC interface

Enable Local API in the desktop app's Settings first.
Use WORKSPACE_USER_DATA or --data-dir for custom profiles.
Results are JSON. Errors exit with code 1; invalid usage exits with code 2.
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
  let directory = defaultDirectory();
  if (args[0] === '--data-dir') {
    if (!args[1]) throw new Error('--data-dir requires a path');
    directory = path.resolve(args[1]); args.splice(0, 2);
  }
  let discovery: Discovery;
  try { discovery = JSON.parse(readFileSync(path.join(directory, 'agent-runtime.json'), 'utf8')); }
  catch { throw new Error('Local API is unavailable. Start the desktop app and enable Local API in Settings.'); }
  const endpoint = new URL(discovery.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password ||
    endpoint.pathname !== '/' || endpoint.search || endpoint.hash || !endpoint.port || typeof discovery.token !== 'string') {
    throw new Error('Invalid local API discovery file');
  }
  async function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${endpoint.origin}/v1/rpc`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${discovery.token}` },
      body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(30000) });
    const data = await response.json() as { ok: boolean; result: T; error?: string };
    if (!response.ok || !data.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data.result;
  }
  const [command, id, value, ...flags] = args;
  let result: unknown;
  let createdTask = false;
  const requireArg = (arg: string | undefined, name: string): string => { if (!arg) throw new Error(`Missing ${name}`); return arg; };
  switch (command) {
    case 'status': result = await call('workspace.status'); break;
    case 'accounts': result = await call('accounts.list'); break;
    case 'account-create': result = await call('accounts.create', { name: requireArg(id, 'name') }); break;
    case 'account-rename': result = await call('accounts.rename', { id: requireArg(id, 'ID'), name: requireArg(value, 'name') }); break;
    case 'account-switch': result = await call('accounts.switch', { id: requireArg(id, 'ID') }); break;
    case 'account-remove': result = await call('accounts.remove', { id: requireArg(id, 'ID'), confirmName: requireArg(value, 'confirmation name') }); break;
    case 'navigate': result = await call('browser.navigate', { accountId: requireArg(id, 'ID'), url: requireArg(value, 'URL') }); break;
    case 'snapshot': result = await call('tasks.create', { accountId: requireArg(id, 'ID'), input: { type: 'snapshot' } }); createdTask = true; break;
    case 'prompt':
      if (flags.some(flag => !['--submit', '--wait'].includes(flag))) throw new Error('Unknown prompt option');
      result = await call('tasks.create', { accountId: requireArg(id, 'ID'), input: {
        type: 'prompt', prompt: requireArg(value, 'prompt'), submit: flags.includes('--submit') } }); createdTask = true; break;
    case 'task':
      if (flags.some(flag => flag !== '--wait')) throw new Error('Unknown task option');
      result = await call('tasks.create', { accountId: requireArg(id, 'ID'), input: JSON.parse(requireArg(value, 'task JSON')) }); createdTask = true; break;
    case 'tasks': result = await call('tasks.list'); break;
    case 'task-get': result = await call('tasks.get', { id: requireArg(id, 'ID') }); break;
    case 'task-cancel': result = await call('tasks.cancel', { id: requireArg(id, 'ID') }); break;
    case 'tasks-clear': result = await call('tasks.clear'); break;
    case 'rpc': result = await call(requireArg(id, 'method'), value ? JSON.parse(value) : {}); break;
    default: console.error(help); process.exitCode = 2; return;
  }
  if (createdTask && (command === 'snapshot' || flags.includes('--wait'))) {
    const taskId = (result as AgentTask).id;
    const deadline = Date.now() + 130000;
    do {
      await new Promise(resolve => setTimeout(resolve, 300));
      result = await call<AgentTask>('tasks.get', { id: taskId });
      if (!['pending', 'running'].includes((result as AgentTask).status)) break;
    } while (Date.now() < deadline);
    if ((result as AgentTask).status !== 'done') process.exitCode = 1;
  }
  console.log(JSON.stringify(result, null, 2));
}
void main().catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });
