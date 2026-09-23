import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-tabs-restore-'));
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const { app, Notification } = require('electron');
Notification.isSupported = () => false;
app.on('session-created', isolated => isolated.protocol.handle('https', () => new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html' } })));
require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory, WORKSPACE_PAGE_IDLE_MS: '100' };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop;
try {
  const launch = () => electron.launch({ args: ['--no-sandbox', bootstrap], env });
  desktop = await launch();
  let shell = await desktop.firstWindow();
  shell.setDefaultTimeout(15000);
  await shell.waitForFunction(() => !!window.workspace);
  const rpc = (method, params = {}) => shell.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params });
  const until = async check => {
    const deadline = Date.now() + 30000;
    while (!await check()) { assert.ok(Date.now() < deadline, 'Tab restoration condition timed out'); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  const waitTask = async task => until(async () => {
    const current = await rpc('tasks.get', { id: task.id });
    assert.ok(!['failed', 'uncertain', 'blocked', 'waiting_user'].includes(current.status), current.error);
    return current.status === 'done';
  });
  const pageFor = (state, accountId, url) => state.pages.find(page => page.accountId === accountId && page.url === url);
  const navigate = async (accountId, url) => waitTask(await rpc('browser.navigate', { accountId, url }));
  const a = await rpc('accounts.create', { name: 'First tabs' });
  await until(async () => (await rpc('browser.inspect', { accountId: a.id })).editor);
  await navigate(a.id, 'https://chatgpt.com/c/a-one');
  await navigate(a.id, 'https://chatgpt.com/c/a-two');
  let state = await rpc('workspace.status');
  const home = pageFor(state, a.id, 'https://chatgpt.com/');
  await rpc('browser.closePage', { accountId: a.id, pageId: home.id });
  state = await rpc('workspace.status');
  assert.equal(state.pages.filter(page => page.accountId === a.id).length, 2);

  const b = await rpc('accounts.create', { name: 'Second tabs' });
  await until(async () => (await rpc('browser.inspect', { accountId: b.id })).editor);
  await navigate(b.id, 'https://chatgpt.com/c/b-one');
  await navigate(b.id, 'https://chatgpt.com/c/b-two');
  state = await rpc('workspace.status');
  const bOne = pageFor(state, b.id, 'https://chatgpt.com/c/b-one');
  await rpc('browser.select', { accountId: b.id, pageId: bOne.id });
  await rpc('accounts.switch', { id: a.id });
  await until(async () => (await rpc('workspace.status')).page?.url === 'https://chatgpt.com/c/a-two');
  state = await rpc('workspace.status');
  const aTwo = pageFor(state, a.id, 'https://chatgpt.com/c/a-two');
  assert.equal(state.page.url, aTwo.url);

  const first = await rpc('tasks.create', { accountId: a.id, current: true,
    input: { type: 'prompt', prompt: 'HOLD:continue while hidden', submit: true } });
  const next = await rpc('tasks.create', { accountId: a.id, conversation: first.conversationId,
    input: { type: 'prompt', prompt: 'Next while hidden', submit: true } });
  await until(async () => !!(await rpc('tasks.get', { id: first.id })).submittedAt);
  await shell.getByRole('button', { name: '隐藏到系统托盘', exact: true }).click();
  await until(() => desktop.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()));
  assert.equal(desktop.process().exitCode, null, 'Closing the window hides it without exiting');
  await desktop.evaluate(async ({ session, webContents }, { partition, url }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.getURL() === url);
    if (!contents) throw new Error('Queued page disappeared while hidden');
    await contents.executeJavaScript('window.fixtureFinish()');
  }, { partition: a.partition, url: aTwo.url });
  await waitTask(first); await waitTask(next);
  assert.equal(await desktop.evaluate(async ({ session, webContents }, { partition, url }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.getURL() === url);
    return contents?.executeJavaScript('window.fixtureSendCount');
  }, { partition: a.partition, url: aTwo.url }), 2, 'The queue sends the next message while hidden');
  await desktop.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });

  const before = await rpc('workspace.status');
  const tabIds = accountId => before.pages.filter(page => page.accountId === accountId).map(page => page.id).sort();
  await desktop.close();
  desktop = await launch(); shell = await desktop.firstWindow();
  await shell.waitForFunction(() => !!window.workspace);
  await until(async () => (await rpc('workspace.status')).page?.url === aTwo.url);
  state = await rpc('workspace.status');
  assert.deepEqual(state.pages.filter(page => page.accountId === a.id).map(page => page.id).sort(), tabIds(a.id));
  assert.deepEqual(state.pages.filter(page => page.accountId === b.id).map(page => page.id).sort(), tabIds(b.id));
  assert.equal(state.pages.some(page => page.accountId === a.id && page.url === 'https://chatgpt.com/'), false,
    'Explicitly closed tabs stay closed');
  assert.equal(state.activeAccountId, a.id);
  assert.equal(state.page.url, aTwo.url);
  assert.equal(state.pages.find(page => page.id === aTwo.id)?.selected, true);
  await rpc('accounts.switch', { id: b.id });
  await until(async () => (await rpc('workspace.status')).page?.url === bOne.url);
  state = await rpc('workspace.status');
  assert.equal(state.page.url, bOne.url, 'Each account keeps its own selected tab');
  assert.equal(state.pages.find(page => page.id === bOne.id)?.selected, true);
  const bTwo = pageFor(state, b.id, 'https://chatgpt.com/c/b-two');
  assert.equal(bTwo.sleeping, true, 'Unselected tabs are restored without opening every web page');
  await rpc('browser.select', { accountId: b.id, pageId: bTwo.id });
  await until(async () => (await rpc('workspace.status')).page?.url === bTwo.url);
  assert.equal((await rpc('workspace.status')).pages.filter(page => page.accountId === b.id).length, 3);
  console.log('Tabs restore desktop passed: close hides to tray, hidden queue continues, and account tabs and selections survive a full restart.');
} finally {
  await desktop?.close();
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root); assert.ok(path.basename(target).startsWith('.test-tabs-restore-'));
  await rm(target, { recursive: true, force: true });
}
