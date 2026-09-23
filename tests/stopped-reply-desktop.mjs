import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-stopped-reply-'));
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
    while (!await check()) { assert.ok(Date.now() < deadline, 'Stopped reply condition timed out'); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  const script = (account, url, code) => desktop.evaluate(async ({ session, webContents }, { account, url, code }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(account.partition) && item.getURL() === url);
    if (!contents) throw new Error('Fixture page not found');
    return contents.executeJavaScript(code);
  }, { account, url, code });
  const account = await rpc('accounts.create', { name: 'Stopped reply fixture' });
  await until(async () => (await rpc('browser.inspect', { accountId: account.id })).readiness === 'ready');

  // A manual turn's interrupted connection must release the first queued item.
  const home = (await rpc('workspace.status')).pages.find(item => item.accountId === account.id && item.selected);
  await script(account, home.url, "window.fixtureHold = true; document.querySelector('textarea').value = 'Manual turn'; document.querySelector('[data-testid=send-button]').click()");
  await until(async () => (await rpc('workspace.status')).pages.some(item => item.accountId === account.id && item.url.startsWith('https://chatgpt.com/c/') && item.conversationId));
  const manualPage = (await rpc('workspace.status')).pages.find(item => item.accountId === account.id && item.selected);
  const afterManual = await rpc('tasks.create', { accountId: account.id, conversation: manualPage.conversationId,
    input: { type: 'prompt', prompt: 'After manual interruption', submit: true }, background: true });
  await until(async () => (await rpc('tasks.get', { id: afterManual.id })).phase === 'waiting_idle');
  await script(account, manualPage.url, 'window.fixtureHold = false; window.fixtureInterrupt()');
  await until(async () => (await rpc('tasks.get', { id: afterManual.id })).status === 'done');
  assert.equal(await script(account, manualPage.url, 'window.fixtureSendCount'), 2);

  // A queued turn with the same interruption fails once and advances its queue.
  const interrupted = await rpc('tasks.create', { accountId: account.id, new: true,
    input: { type: 'prompt', prompt: 'HOLD:queued interruption', submit: true }, background: true });
  const afterInterrupted = await rpc('tasks.create', { accountId: account.id, conversation: interrupted.conversationId,
    input: { type: 'prompt', prompt: 'After queued interruption', submit: true }, background: true });
  await until(async () => !!(await rpc('tasks.get', { id: interrupted.id })).submittedAt);
  const interruptedPage = (await rpc('workspace.status')).pages.find(item => item.conversationId === interrupted.conversationId);
  await script(account, interruptedPage.url, 'window.fixtureInterrupt()');
  await until(async () => (await rpc('tasks.get', { id: afterInterrupted.id })).status === 'done');
  const failed = await rpc('tasks.get', { id: interrupted.id });
  assert.equal(failed.status, 'failed'); assert.equal(failed.phase, 'completed');
  assert.match(failed.error, /连接已中断/);
  assert.equal(await script(account, interruptedPage.url, 'window.fixtureSendCount'), 2);
  assert.equal((await rpc('queues.status')).find(item => item.conversationId === interrupted.conversationId)?.paused, false);

  // Even without a recognizable error card, an idle composer and stopped
  // generation end an incomplete reply after the normal stability window.
  const stopped = await rpc('tasks.create', { accountId: account.id, new: true,
    input: { type: 'prompt', prompt: 'HOLD:stopped without answer', submit: true }, background: true });
  const afterStopped = await rpc('tasks.create', { accountId: account.id, conversation: stopped.conversationId,
    input: { type: 'prompt', prompt: 'After stopped reply', submit: true }, background: true });
  await until(async () => !!(await rpc('tasks.get', { id: stopped.id })).submittedAt);
  const stoppedPage = (await rpc('workspace.status')).pages.find(item => item.conversationId === stopped.conversationId);
  await script(account, stoppedPage.url, 'window.fixtureStopEmpty()');
  await until(async () => (await rpc('tasks.get', { id: afterStopped.id })).status === 'done');
  assert.equal((await rpc('tasks.get', { id: stopped.id })).status, 'failed');
  assert.match((await rpc('tasks.get', { id: stopped.id })).error, /已停止回复/);
  assert.equal(await script(account, stoppedPage.url, 'window.fixtureSendCount'), 2);
  assert.equal((await rpc('queues.status')).find(item => item.conversationId === stopped.conversationId)?.paused, false);
  console.log('Stopped reply desktop passed: interrupted and silent stopped turns release manual and queued conversation work.');
} finally {
  await desktop?.close();
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root); assert.ok(path.basename(target).startsWith('.test-stopped-reply-'));
  await rm(target, { recursive: true, force: true });
}
