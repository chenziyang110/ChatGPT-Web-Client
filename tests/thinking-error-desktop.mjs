import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-thinking-error-'));
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const { app, Notification } = require('electron');
Notification.isSupported = () => false;
app.on('browser-window-created', (_, window) => window.on('show', () => window.hide()));
app.on('session-created', session => session.protocol.handle('https', () => new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html' } })));
require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop;
try {
  desktop = await electron.launch({ args: ['--no-sandbox', bootstrap], env });
  const page = await desktop.firstWindow();
  await page.waitForFunction(() => !!window.workspace);
  const rpc = (method, params = {}) => page.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params });
  const until = async check => {
    const deadline = Date.now() + 45000;
    while (!await check()) { assert.ok(Date.now() < deadline, 'Thinking failure condition timed out'); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  const script = (account, url, code) => desktop.evaluate(async ({ session, webContents }, { account, url, code }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(account.partition) && item.getURL() === url);
    if (!contents) throw new Error('Fixture page not found');
    return contents.executeJavaScript(code);
  }, { account, url, code });
  const account = await rpc('accounts.create', { name: 'Thinking failure fixture' });
  await until(async () => (await rpc('browser.inspect', { accountId: account.id })).readiness === 'ready');

  // A manually sent failed turn must not keep the first queued message waiting.
  const home = (await rpc('workspace.status')).pages.find(item => item.accountId === account.id && item.selected);
  await script(account, home.url, "window.fixtureHold = true; document.querySelector('textarea').value = 'Manual turn'; document.querySelector('[data-testid=send-button]').click()");
  await until(async () => (await rpc('workspace.status')).pages.some(item => item.accountId === account.id && item.url.startsWith('https://chatgpt.com/c/') && item.conversationId));
  const manualPage = (await rpc('workspace.status')).pages.find(item => item.accountId === account.id && item.selected);
  const afterManual = await rpc('tasks.create', { accountId: account.id, conversation: manualPage.conversationId,
    input: { type: 'prompt', prompt: 'After manual failure', submit: true }, background: true });
  await until(async () => (await rpc('tasks.get', { id: afterManual.id })).phase === 'waiting_idle');
  await script(account, manualPage.url, 'window.fixtureHold = false; window.fixtureFailThinking()');
  await until(async () => (await rpc('tasks.get', { id: afterManual.id })).status === 'done');
  assert.equal(await script(account, manualPage.url, 'window.fixtureSendCount'), 2);
  assert.equal((await rpc('queues.status')).find(item => item.conversationId === manualPage.conversationId)?.paused, false);

  // A queued turn that itself fails is recorded once, then its successor runs.
  const first = await rpc('tasks.create', { accountId: account.id, new: true,
    input: { type: 'prompt', prompt: 'HOLD:queued failure', submit: true }, background: true });
  const next = await rpc('tasks.create', { accountId: account.id, conversation: first.conversationId,
    input: { type: 'prompt', prompt: 'After queued failure', submit: true }, background: true });
  await until(async () => !!(await rpc('tasks.get', { id: first.id })).submittedAt);
  const queuedPage = (await rpc('workspace.status')).pages.find(item => item.conversationId === first.conversationId);
  await script(account, queuedPage.url, 'window.fixtureFailThinking()');
  await until(async () => (await rpc('tasks.get', { id: next.id })).status === 'done');
  const failed = await rpc('tasks.get', { id: first.id });
  assert.equal(failed.status, 'failed'); assert.equal(failed.phase, 'completed');
  assert.match(failed.error, /无法思考/);
  assert.equal(await script(account, queuedPage.url, 'window.fixtureSendCount'), 2, 'The failed turn is not resent');
  assert.equal((await rpc('queues.status')).find(item => item.conversationId === first.conversationId)?.paused, false);
  console.log('Thinking failure desktop passed: manual and queued failures finish and later messages send once.');
} finally {
  await desktop?.close();
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root); assert.ok(path.basename(target).startsWith('.test-thinking-error-'));
  await rm(target, { recursive: true, force: true });
}
