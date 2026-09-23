import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-image-reply-'));
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const { app, Notification } = require('electron');
Notification.isSupported = () => false;
app.on('browser-window-created', (_, window) => { window.webContents.setBackgroundThrottling(false); window.on('show', () => window.hide()); });
app.on('session-created', session => session.protocol.handle('https', () => new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html' } })));
require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop;
try {
  desktop = await electron.launch({ args: ['--no-sandbox', '--disable-renderer-backgrounding', bootstrap], env });
  const shell = await desktop.firstWindow();
  await shell.waitForFunction(() => !!window.workspace);
  const rpc = (method, params = {}) => shell.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params });
  const until = async check => {
    const deadline = Date.now() + 30000;
    while (!await check()) { assert.ok(Date.now() < deadline, 'Image reply condition timed out'); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  const script = (partition, code) => desktop.evaluate(async ({ session, webContents }, { partition, code }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.getURL().startsWith('https://chatgpt.com/'));
    if (!contents) throw new Error('Fixture page not found');
    return contents.executeJavaScript(code);
  }, { partition, code });
  const account = await rpc('accounts.create', { name: 'Image reply fixture' });
  await until(async () => (await rpc('browser.inspect', { accountId: account.id })).readiness === 'ready');
  await script(account.partition, `window.fixtureHold = true;
    document.querySelector('#prompt-textarea').value = 'Manual image';
    document.querySelector('[data-testid="send-button"]').click();
    const sidebar = document.createElement('aside'); sidebar.setAttribute('aria-busy', 'true'); document.body.append(sidebar);`);
  await until(async () => (await rpc('workspace.status')).page?.url.startsWith('https://chatgpt.com/c/'));
  const pageId = (await rpc('workspace.status')).page.id;
  const conversation = await rpc('conversations.forPage', { accountId: account.id, pageId });
  const first = await rpc('tasks.create', { accountId: account.id, conversation: conversation.id,
    input: { type: 'prompt', prompt: 'HOLD:queued image', submit: true }, background: true });
  const next = await rpc('tasks.create', { accountId: account.id, conversation: conversation.id,
    input: { type: 'prompt', prompt: 'After image', submit: true }, background: true });
  await until(async () => (await rpc('tasks.get', { id: first.id })).phase === 'waiting_idle');
  await script(account.partition, 'window.fixtureFinishImage(); window.fixtureHold = false');
  await until(async () => !!(await rpc('tasks.get', { id: first.id })).submittedAt);
  assert.equal(await script(account.partition, 'window.fixtureSendCount'), 2, 'Finished manual image lets queued message send');
  await script(account.partition, 'window.fixtureFinishImage()');
  await until(async () => (await rpc('tasks.get', { id: first.id })).status === 'done');
  await until(async () => (await rpc('tasks.get', { id: next.id })).status === 'done');
  assert.equal(await script(account.partition, 'window.fixtureSendCount'), 3, 'Finished queued image advances to next message exactly once');
  assert.equal((await rpc('browser.inspect', { accountId: account.id })).busy, false, 'Unrelated and completed-media busy markers are ignored');
  console.log('Image reply desktop passed: a completed image ends manual and queued turns despite unrelated and stale busy markers.');
} finally {
  await desktop?.close();
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root); assert.ok(path.basename(target).startsWith('.test-image-reply-'));
  await rm(target, { recursive: true, force: true });
}
