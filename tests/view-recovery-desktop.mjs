import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-view-recovery-'));
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const { app, Notification } = require('electron');
Notification.isSupported = () => false;
app.on('browser-window-created', (_, win) => {
  win.webContents.setBackgroundThrottling(false);
  win.setSkipTaskbar(true);
  if (process.platform === 'win32') win.setPosition(-20000, -20000);
});
app.on('session-created', isolated => isolated.protocol.handle('https', () => new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html' } })));
require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop, desktopPid;
function bounded(promise, label, ms = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })])
    .finally(() => clearTimeout(timer));
}
try {
  desktop = await electron.launch({ args: ['--no-sandbox', bootstrap], env });
  desktopPid = await desktop.evaluate(() => process.pid);
  const shell = await bounded(desktop.firstWindow(), 'First window');
  shell.setDefaultTimeout(15000);
  await bounded(shell.waitForFunction(() => !!window.workspace), 'Workspace bridge');
  const rpc = (method, params = {}) => bounded(shell.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params }), method);
  const until = async check => {
    const deadline = Date.now() + 15000;
    while (!await check()) { assert.ok(Date.now() < deadline, 'Selected browser view did not recover'); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  const account = await rpc('accounts.create', { name: 'View recovery' });
  await until(async () => (await rpc('browser.inspect', { accountId: account.id })).editor);
  const targetUrl = 'https://chatgpt.com/c/view-recovery';
  const navigation = await rpc('browser.navigate', { accountId: account.id, url: targetUrl });
  await until(async () => (await rpc('tasks.get', { id: navigation.id })).status === 'done');
  const before = await rpc('workspace.status');
  const selected = before.pages.find(page => page.accountId === account.id && page.selected);
  assert.ok(selected && !selected.sleeping && selected.conversationId);
  await rpc('queues.pause', { accountId: account.id, conversation: selected.conversationId });
  const queued = await rpc('tasks.create', { accountId: account.id, conversation: selected.conversationId,
    background: true, input: { type: 'prompt', prompt: 'HOLD:Keep this queued while the page recovers', submit: true } });
  const next = await rpc('tasks.create', { accountId: account.id, conversation: selected.conversationId,
    background: true, input: { type: 'prompt', prompt: 'Continue after the interrupted page', submit: true } });
  assert.equal((await rpc('tasks.get', { id: queued.id })).status, 'pending');
  assert.equal((await rpc('tasks.get', { id: next.id })).status, 'pending');
  const originalViewCount = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length);
  console.log('Destroying selected fixture view');
  await bounded(desktop.evaluate(({ webContents, session }, { partition, url }) => {
    const view = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.getURL() === url);
    if (!view) throw new Error('Fixture view must exist before simulating renderer destruction');
    setImmediate(() => view.close({ waitForBeforeUnload: false }));
  }, { partition: account.partition, url: targetUrl }), 'Destroy fixture view');
  await until(async () => {
    const state = await rpc('workspace.status');
    return state.page?.id === selected.id && !state.pages.find(page => page.id === selected.id)?.sleeping &&
      (await rpc('browser.inspect', { accountId: account.id })).editor;
  });
  const restored = await rpc('workspace.status');
  assert.equal(restored.pages.find(page => page.id === selected.id)?.selected, true, 'Recovery preserves the selected tab');
  assert.equal(restored.page?.url, targetUrl);
  assert.equal((await rpc('tasks.get', { id: queued.id })).status, 'pending', 'Recovery preserves pending queue messages');
  assert.equal((await rpc('tasks.get', { id: next.id })).status, 'pending');
  assert.equal(restored.queues.find(queue => queue.conversationId === selected.conversationId)?.paused, true);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win.contentView.children.some(view => view.webContents?.getURL() === 'https://chatgpt.com/c/view-recovery' && view.getVisible());
  }), true, 'Recovered ChatGPT view is attached and visible');
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length),
    originalViewCount, 'Recovery does not leave an orphaned native view');
  // A background diagnostic may recreate the web contents before the visible
  // tab's delayed restoration runs. It still needs to attach that warm view.
  await bounded(desktop.evaluate(({ webContents, session }, { partition, url }) => {
    const view = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.getURL() === url);
    if (!view) throw new Error('Restored fixture view is missing');
    setImmediate(() => view.close({ waitForBeforeUnload: false }));
  }, { partition: account.partition, url: targetUrl }), 'Destroy restored fixture view');
  await until(async () => (await rpc('workspace.status')).page === null);
  await rpc('browser.inspect', { accountId: account.id, pageId: selected.id });
  await until(async () => (await rpc('workspace.status')).page?.id === selected.id);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.some(
    view => view.webContents?.getURL() === 'https://chatgpt.com/c/view-recovery' && view.getVisible())), true,
  'A page reopened in the background is reattached to the selected tab');
  await rpc('queues.resume', { accountId: account.id, conversation: selected.conversationId });
  await until(async () => !!(await rpc('tasks.get', { id: queued.id })).submittedAt);
  await bounded(desktop.evaluate(({ webContents, session }, { partition, url }) => {
    const view = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.getURL() === url);
    if (!view) throw new Error('Running queue fixture view is missing');
    setImmediate(() => view.close({ waitForBeforeUnload: false }));
  }, { partition: account.partition, url: targetUrl }), 'Destroy running fixture view');
  await until(async () => (await rpc('tasks.get', { id: queued.id })).status === 'failed');
  await until(async () => (await rpc('workspace.status')).page?.id === selected.id);
  assert.equal((await rpc('workspace.status')).pages.find(page => page.id === selected.id)?.selected, true,
    'A failed running task leaves its original conversation tab selected');
  await until(async () => !!(await rpc('tasks.get', { id: next.id })).submittedAt);
  await desktop.evaluate(async ({ webContents, session }, { partition, url }) => {
    const view = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.getURL() === url);
    if (!view) throw new Error('Following queued message did not get a page');
    await view.executeJavaScript('window.fixtureFinish()');
  }, { partition: account.partition, url: targetUrl });
  await until(async () => (await rpc('tasks.get', { id: next.id })).status === 'done');
  console.log('View recovery desktop passed: destroyed ChatGPT pages recover the selected tab and the next queued message sends after an interrupted reply.');
} catch (error) {
  console.error('View recovery failure:', error);
  throw error;
} finally {
  try { if (desktop) await bounded(desktop.close(), 'Fixture shutdown', 10000); }
  catch { if (desktopPid) process.kill(desktopPid); }
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root); assert.ok(path.basename(target).startsWith('.test-view-recovery-'));
  for (let attempt = 0; attempt < 10; attempt++) {
    try { await rm(target, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 9) console.warn('Fixture data cleanup delayed:', error.code); else await new Promise(resolve => setTimeout(resolve, 300)); }
  }
}
