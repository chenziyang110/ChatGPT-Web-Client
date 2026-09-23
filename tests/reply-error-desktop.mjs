import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-reply-error-'));
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
    const deadline = Date.now() + 30000;
    while (!await check()) { assert.ok(Date.now() < deadline, 'Reply error condition timed out'); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  const script = (url, code) => desktop.evaluate(async ({ webContents }, { url, code }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url);
    if (!contents) throw new Error('Fixture page not found');
    return contents.executeJavaScript(code);
  }, { url, code });

  const account = await rpc('accounts.create', { name: 'Reply error fixture' });
  await until(async () => (await rpc('browser.inspect', { accountId: account.id })).readiness === 'ready');
  const first = await rpc('tasks.create', { accountId: account.id, new: true, input: { type: 'prompt', prompt: 'HOLD:first', submit: true }, background: true });
  const second = await rpc('tasks.create', { accountId: account.id, conversation: first.conversationId, input: { type: 'prompt', prompt: 'next', submit: true }, background: true });
  await until(async () => !!(await rpc('tasks.get', { id: first.id })).submittedAt);
  const live = (await rpc('workspace.status')).pages.find(item => item.conversationId === first.conversationId);
  assert.ok(live?.url);
  await script(live.url, 'window.fixtureFail()');
  await until(async () => (await rpc('tasks.get', { id: first.id })).status === 'failed');
  const failed = await rpc('tasks.get', { id: first.id });
  assert.match(failed.error, /异常活动/);
  assert.equal(failed.attention, undefined);
  assert.equal((await rpc('tasks.get', { id: second.id })).status, 'pending');
  assert.equal((await script(live.url, 'window.fixtureSendCount')), 1);
  const queue = (await rpc('queues.status')).find(item => item.accountId === account.id && item.conversationId === first.conversationId);
  assert.equal(queue?.paused, true);
  assert.match(queue.reason, /ChatGPT 回复报错/);

  await rpc('queues.resume', { accountId: account.id, conversation: first.conversationId });
  await until(async () => (await rpc('tasks.get', { id: second.id })).status === 'done');
  assert.equal(await script(live.url, 'window.fixtureSendCount'), 2, 'The failed message is never resent');
  assert.equal((await rpc('tasks.get', { id: first.id })).status, 'failed');
  console.log('Reply error desktop passed: inline ChatGPT error terminates the sent item, pauses this conversation, and explicit resume sends the next item once.');
} finally {
  await desktop?.close();
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root); assert.ok(path.basename(target).startsWith('.test-reply-error-'));
  await rm(target, { recursive: true, force: true });
}
