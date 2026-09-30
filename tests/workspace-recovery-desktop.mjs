import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-workspace-recovery-'));
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const { app, ipcMain, Notification } = require('electron');
Notification.isSupported = () => false;
globalThis.statusBlocked = false; globalThis.statusFailures = 0;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, async (...args) => {
  if (channel === 'workspace:call' && args[1] === 'workspace.status' && globalThis.statusBlocked) {
    globalThis.statusFailures++; throw new Error('Synthetic status read failure');
  }
  return handler(...args);
});
app.on('browser-window-created', (_, win) => { win.on('show', () => win.hide()); });
app.on('session-created', s => s.protocol.handle('https', () => new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html' } })));
require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop;
const until = async check => {
  const end = Date.now() + 20000;
  while (!await check()) { assert.ok(Date.now() < end, 'Recovery timed out'); await new Promise(resolve => setTimeout(resolve, 100)); }
};
try {
  desktop = await electron.launch({ args: [bootstrap], env });
  const shell = await desktop.firstWindow();
  await shell.waitForFunction(() => !!window.workspace);
  const rpc = (method, params = {}) => shell.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params });
  const accounts = [];
  for (const name of ['First saved', 'Second saved', 'Third saved']) accounts.push(await rpc('accounts.create', { name }));
  const account = accounts[0];
  const conversation = await rpc('conversations.register', { accountId: account.id, url: 'https://chatgpt.com/c/recovery' });
  await rpc('queues.pause', { accountId: account.id, conversation: conversation.id });
  const task = await rpc('tasks.create', { accountId: account.id, conversation: conversation.id,
    background: true, input: { type: 'prompt', prompt: 'Preserve this queued message', submit: true } });
  const before = await rpc('workspace.status');
  await desktop.evaluate(() => { globalThis.statusBlocked = true; });
  await shell.reload();
  await shell.getByText('暂时无法读取账号', { exact: true }).waitFor();
  assert.equal(await shell.getByText('在这里管理 ChatGPT 账号', { exact: true }).count(), 0);
  assert.equal(await shell.getByText('还没有账号', { exact: true }).count(), 0);
  assert.ok(await shell.getByRole('button', { name: '添加账号', exact: true }).isDisabled());
  await until(() => desktop.evaluate(() => globalThis.statusFailures >= 3));
  await desktop.evaluate(() => { globalThis.statusBlocked = false; });
  await shell.getByTitle('Third saved', { exact: true }).waitFor();
  const recovered = await rpc('workspace.status');
  assert.deepEqual(recovered.accounts, before.accounts);
  assert.deepEqual(recovered.pages.map(p => p.id).sort(), before.pages.map(p => p.id).sort());
  assert.equal((await rpc('tasks.get', { id: task.id })).status, 'pending');
  // The local shell can fail independently of account pages and persisted queues.
  const crashed = shell.waitForEvent('crash');
  await desktop.evaluate(({ BrowserWindow }) => { setImmediate(() => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()); });
  await crashed;
  await until(async () => (await readFile(path.join(directory, 'logs/runtime.jsonl'), 'utf8')).includes('workspace_renderer_recovered'));
  const recoveredRpc = (method, params = {}) => desktop.evaluate(({ BrowserWindow }, { method, params }) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`window.workspace.call(${JSON.stringify(method)}, ${JSON.stringify(params)})`), { method, params });
  await until(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('document.querySelectorAll(".account-row").length === 3')));
  const final = await recoveredRpc('workspace.status');
  assert.deepEqual(final.accounts, before.accounts);
  assert.deepEqual(final.pages.map(p => p.id).sort(), before.pages.map(p => p.id).sort());
  assert.equal((await recoveredRpc('tasks.get', { id: task.id })).status, 'pending');
  await desktop.close(); desktop = undefined;
  assert.equal(JSON.parse(await readFile(path.join(directory, 'logs/session.json'), 'utf8')).clean, true);
  console.log('Workspace recovery passed: repeated read failures retry without empty-account onboarding; shell crash preserves three accounts, tabs and queued work.');
} catch (error) {
  console.error(await readFile(path.join(directory, 'logs/runtime.jsonl'), 'utf8'));
  console.error(await desktop?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({
    url: w.webContents.getURL(), destroyed: w.webContents.isDestroyed(), loading: w.webContents.isLoading()
  }))));
  console.error(desktop?.windows().map(p => ({ url: p.url(), closed: p.isClosed() })));
  throw error;
} finally {
  await desktop?.close();
  assert.equal(path.dirname(directory), root);
  assert.ok(path.basename(directory).startsWith('.test-workspace-recovery-'));
  await rm(directory, { recursive: true, force: true });
}
