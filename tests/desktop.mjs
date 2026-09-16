import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Exercises actual Electron sessions/IPC/SQLite. All remote pages are served
// by a deterministic HTTPS protocol fixture; no credentials or live ChatGPT.
const fixture = `<!doctype html><html><head><title>ChatGPT fixture</title></head>
<body><main><h1>Fixture conversation</h1><textarea id="prompt-textarea"></textarea>
<button data-testid="send-button">Send</button><div id="messages"></div></main>
<script>document.querySelector('button').onclick = () => {
 const value = document.querySelector('textarea').value;
 const reply = document.createElement('div'); reply.dataset.messageAuthorRole = 'assistant';
 reply.textContent = 'Fixture reply: ' + value; document.querySelector('#messages').append(reply);
};</script></body></html>`;
const directory = await mkdtemp(path.resolve('.test-desktop-'));
await mkdir('test-results', { recursive: true });
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const { app } = require('electron');
app.on('session-created', isolated => isolated.protocol.handle('https', () => new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html' } })));
require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});
`);
let desktop;
let page;
let cleanExit = false;
const errors = [];
async function launch() {
  const env = { ...process.env, WORKSPACE_USER_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WORKSPACE_DEV_URL;
  desktop = await electron.launch({ args: ['--no-sandbox', bootstrap], env });
  // --no-sandbox is ONLY used by this disposable CI harness; production keeps it enabled.
  desktop.process().stderr.on('data', buffer => errors.push(buffer.toString()));
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.workspace);
}
async function rpc(method, params = {}) { return page.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params }); }
async function waitTask(task) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const next = await rpc('tasks.get', { id: task.id });
    if (!['pending', 'running'].includes(next.status)) { assert.equal(next.status, 'done', next.error); return next; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Task did not finish');
}
async function profileState(account, write = false) {
  return desktop.evaluate(async ({ session, webContents }, { account, write }) => {
    const isolated = session.fromPartition(account.partition);
    const wc = webContents.getAllWebContents().find(wc => wc.session === isolated && wc.getURL().startsWith('https://chatgpt.com'));
    if (!wc) throw new Error('Account WebContents missing');
    if (write) {
      await isolated.cookies.set({ url: 'https://chatgpt.com', name: 'isolation-test', value: account.name, expirationDate: Date.now() / 1000 + 3600 });
      await wc.executeJavaScript(`localStorage.setItem('isolation-test', ${JSON.stringify(account.name)})`);
      await isolated.cookies.flushStore();
    }
    return { cookies: await isolated.cookies.get({ name: 'isolation-test' }),
      storage: await wc.executeJavaScript("localStorage.getItem('isolation-test')"),
      bridge: await wc.executeJavaScript('typeof window.workspace'), preferences: wc.getLastWebPreferences() };
  }, { account, write });
}
try {
  await launch();
  await page.getByRole('button', { name: '＋ 创建第一个账号', exact: true }).click();
  await page.getByLabel('账号名称', { exact: true }).fill('Personal');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByRole('heading', { name: 'Personal', exact: true }).waitFor();
  let state = await rpc('workspace.status');
  const personal = state.accounts[0];
  await waitTask(await rpc('tasks.create', { accountId: personal.id, input: { type: 'snapshot' } }));
  const first = await profileState(personal, true);
  assert.equal(first.bridge, 'undefined');
  assert.equal(first.preferences.nodeIntegration, false);
  assert.equal(first.preferences.contextIsolation, true);
  assert.equal(first.preferences.sandbox, true);
  const work = await rpc('accounts.create', { name: 'Work' });
  await waitTask(await rpc('tasks.create', { accountId: work.id, input: { type: 'snapshot' } }));
  const second = await profileState(work);
  assert.equal(second.storage, null);
  assert.deepEqual(second.cookies, []);
  await profileState(work, true);
  assert.equal((await profileState(personal)).storage, 'Personal');
  const draft = await waitTask(await rpc('tasks.create', { accountId: work.id, input: { type: 'prompt', prompt: 'Draft only' } }));
  assert.equal(draft.result.prepared, true);
  const submitted = await waitTask(await rpc('tasks.create', { accountId: work.id, input: { type: 'prompt', prompt: 'Hello', submit: true } }));
  assert.equal(submitted.result.response, 'Fixture reply: Hello');
  await rpc('browser.navigate', { accountId: personal.id, url: 'https://chatgpt.com/c/restored' });
  await rpc('accounts.switch', { id: personal.id });
  await rpc('settings.api', { enabled: true });
  assert.equal((await rpc('workspace.status')).api.enabled, true);
  await page.getByRole('button', { name: /任务中心/ }).click();
  await page.screenshot({ path: 'test-results/tasks.png' });
  await page.getByRole('button', { name: /设置与集成/ }).click();
  await page.screenshot({ path: 'test-results/settings.png' });
  await desktop.close();
  await launch();
  state = await rpc('workspace.status');
  assert.equal(state.activeAccountId, personal.id);
  assert.equal(state.accounts.length, 2);
  await waitTask(await rpc('tasks.create', { accountId: personal.id, input: { type: 'snapshot' } }));
  assert.equal((await rpc('workspace.status')).page.url, 'https://chatgpt.com/c/restored');
  assert.equal((await profileState(personal)).storage, 'Personal');
  assert.equal((await profileState(personal)).cookies[0].value, 'Personal');
  await rpc('accounts.remove', { id: personal.id, confirmName: 'Personal' });
  state = await rpc('workspace.status');
  assert.equal(state.activeAccountId, work.id);
  assert.equal(state.accounts.length, 1);
  const deletedCookies = await desktop.evaluate(({ session }, partition) => session.fromPartition(partition).cookies.get({}), personal.partition);
  assert.deepEqual(deletedCookies, []);
  await rpc('settings.api', { enabled: false });
  await page.screenshot({ path: 'test-results/workspace.png' });
  await desktop.close();
  desktop = undefined;
  cleanExit = true;
  assert.equal(errors.some(message => /database is not open|Uncaught Exception|Uncaught ReferenceError|Untrusted IPC sender/i.test(message)), false, errors.join('\n'));
  console.log('Desktop integration passed: real session isolation, prompt execution, persistence, deletion and clean shutdown.');
} finally {
  if (!cleanExit) {
    if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/failure.png' }).catch(() => {});
    console.error(errors.join('\n'));
  }
  if (desktop) await desktop.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
