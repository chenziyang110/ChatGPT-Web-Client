import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-duplicate-conversation-'));
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const { app, Notification } = require('electron');
Notification.isSupported = () => false;
app.on('browser-window-created', (_, window) => window.on('show', () => window.hide()));
app.on('session-created', session => session.protocol.handle('https', () => new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html' } })));
require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory, WORKSPACE_HIDDEN_PAGE_IDLE_MS: '3600000' };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop;
try {
  desktop = await electron.launch({ args: ['--no-sandbox', bootstrap], env });
  const page = await desktop.firstWindow();
  await page.waitForFunction(() => !!window.workspace);
  const rpc = (method, params = {}) => page.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params });
  const until = async check => {
    const deadline = Date.now() + 30000;
    while (!await check()) { assert.ok(Date.now() < deadline, 'Duplicate conversation condition timed out'); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  const script = (url, code, partition) => desktop.evaluate(async ({ webContents, session }, { url, code, partition }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url && item.session === session.fromPartition(partition));
    if (!contents) throw new Error('Fixture page not found');
    return contents.executeJavaScript(code);
  }, { url, code, partition });

  const account = await rpc('accounts.create', { name: 'Same-account tabs' });
  await until(async () => (await rpc('browser.inspect', { accountId: account.id })).readiness === 'ready');
  const first = await rpc('tasks.create', { accountId: account.id, new: true, input: { type: 'prompt', prompt: 'HOLD:queued conversation', submit: true }, background: true });
  const follow = await rpc('tasks.create', { accountId: account.id, conversation: first.conversationId,
    input: { type: 'prompt', prompt: 'queued follow-up', submit: true }, background: true });
  await until(async () => !!(await rpc('tasks.get', { id: first.id })).submittedAt);
  const original = (await rpc('workspace.status')).pages.find(item => item.conversationId === first.conversationId);
  assert.ok(original?.url.includes('/c/'));
  await rpc('browser.newConversation', { accountId: account.id });
  await until(async () => (await rpc('browser.inspect', { accountId: account.id })).readiness === 'ready');
  const fresh = (await rpc('workspace.status')).page;
  assert.notEqual(fresh.id, original.id);
  assert.equal(fresh.url, 'https://chatgpt.com/');
  const freshConversation = await rpc('conversations.forPage', { accountId: account.id, pageId: fresh.id });
  await rpc('queues.pause', { accountId: account.id, conversation: freshConversation.id });
  const freshQueued = await rpc('tasks.create', { accountId: account.id, conversation: freshConversation.id,
    input: { type: 'prompt', prompt: 'independent new-chat queue', submit: true }, background: true });

  // ChatGPT's sidebar changes the URL in-page, rather than using the app's
  // openConversation action. The existing queued tab must remain the owner.
  await script(fresh.url, `history.pushState({}, '', ${JSON.stringify(original.url)})`, account.partition);
  await until(async () => {
    const state = await rpc('workspace.status');
    return state.page?.id === original.id && state.pages.find(item => item.id === fresh.id)?.url === 'https://chatgpt.com/';
  });
  const state = await rpc('workspace.status');
  assert.equal(state.pages.length, 3, 'The new tab is retained for a different conversation');
  assert.equal(state.pages.find(item => item.id === original.id).locked, true);
  assert.equal(state.pages.find(item => item.id === fresh.id).locked, false);
  assert.equal(state.pages.find(item => item.id === fresh.id).conversationId, freshConversation.id);
  assert.equal((await rpc('tasks.get', { id: first.id })).status, 'running');
  assert.equal((await rpc('tasks.get', { id: follow.id })).status, 'pending');
  assert.equal((await rpc('tasks.get', { id: freshQueued.id })).status, 'pending');
  assert.equal((await rpc('queues.status')).find(item => item.conversationId === first.conversationId)?.paused, false);
  assert.equal((await rpc('queues.status')).find(item => item.conversationId === freshConversation.id)?.paused, true);

  await rpc('browser.select', { accountId: account.id, pageId: fresh.id });
  assert.equal((await rpc('workspace.status')).page.url, 'https://chatgpt.com/');
  assert.equal((await rpc('browser.inspect', { accountId: account.id, pageId: fresh.id })).readiness, 'ready');
  const otherAccount = await rpc('accounts.create', { name: 'Separate account' });
  const independent = await rpc('conversations.register', { accountId: otherAccount.id, url: original.url });
  await rpc('conversations.open', { accountId: otherAccount.id, conversation: independent.id });
  const otherPage = (await rpc('workspace.status')).pages.find(item => item.accountId === otherAccount.id && item.conversationId === independent.id);
  assert.equal(otherPage?.url, original.url, 'Another account can open its own copy of the same remote URL');
  assert.equal(otherPage.locked, false);
  await script(original.url, 'window.fixtureFinish()', account.partition);
  await until(async () => (await rpc('tasks.get', { id: follow.id })).status === 'done');
  assert.equal(await script(original.url, 'window.fixtureSendCount', account.partition), 2);
  console.log('Duplicate conversation desktop passed: sidebar navigation reuses the queued tab, preserves the new tab and does not take over either queue.');
} finally {
  await desktop?.close();
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root); assert.ok(path.basename(target).startsWith('.test-duplicate-conversation-'));
  await rm(target, { recursive: true, force: true });
}
