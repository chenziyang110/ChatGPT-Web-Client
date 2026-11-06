import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { modernFixture } from './modern-chatgpt-fixture.mjs';

// Exercise the production panel and native sender against owned offline pages.
// The disposable profile never loads real accounts, cookies or business chats.
const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-project-queue-'));
const bootstrap = path.join(directory, 'fixture.cjs');
const project = 'g-p-6aedd1cd55308191bd405e8f082c8a31-xiang-jin-shi-jin-gong';
const siblingProject = 'g-p-7bedd1cd55308191bd405e8f082c8a31-sibling-project';
const projectUrl = `https://chatgpt.com/g/${project}/c/project-thread`;
const siblingUrl = `https://chatgpt.com/g/${siblingProject}/c/project-thread`;
// Persist the fixture's remote history and stable message IDs across a genuine
// Electron process restart, independently of the client's local queue database.
const fixture = modernFixture.replace('</script>', `
const persisted=JSON.parse(localStorage.getItem(location.pathname+':project-fixture')||'null');
if(persisted){window.sent=persisted.sent;window.clicks=persisted.clicks;turns.innerHTML=persisted.turns;}
new MutationObserver(()=>localStorage.setItem(location.pathname+':project-fixture',JSON.stringify({sent:window.sent,clicks:window.clicks,turns:turns.innerHTML}))).observe(turns,{childList:true,subtree:true,characterData:true});
</script>`);
assert.notEqual(fixture, modernFixture);
await writeFile(bootstrap, `const {app,Notification}=require('electron');
Notification.isSupported=()=>false;
app.on('browser-window-created',(_,win)=>{win.webContents.setBackgroundThrottling(false);win.on('show',()=>win.hide());});
app.on('session-created',s=>s.protocol.handle('https',()=>new Response(${JSON.stringify(fixture)},{headers:{'Content-Type':'text/html'}})));
require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory,
  WORKSPACE_HIDDEN_PAGE_IDLE_MS: '3600000', WORKSPACE_PAGE_IDLE_MS: '3600000' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKSPACE_DEV_URL;
let desktop, ui, passed = false;
const until = async (check, label = 'Project queue condition timed out') => {
  const deadline = Date.now() + 45000;
  while (!await check()) { assert.ok(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 100)); }
};
const launch = async () => {
  desktop = await electron.launch({ args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', bootstrap], env });
  await until(async () => !!(ui = desktop.windows().find(page => page.url().startsWith('file:'))));
  ui.setDefaultTimeout(15000);
  await ui.waitForFunction(() => !!window.workspace);
};
const rpc = (method, params = {}) => ui.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params });
const read = (account, url, script) => desktop.evaluate(async ({ webContents, session }, { partition, url, script }) => {
  const contents = webContents.getAllWebContents().find(value => value.session === session.fromPartition(partition) && value.getURL() === url);
  if (!contents) throw Error('Isolated project fixture page is unavailable');
  return contents.executeJavaScript(script);
}, { partition: account.partition, url, script });
const waitPage = (account, url) => until(async () => {
  try { return await read(account, url, 'Array.isArray(window.sent)'); } catch { return false; }
}, 'Project fixture failed to open');
const panel = () => ui.getByRole('complementary', { name: '会话队列' });
const composer = () => panel().getByLabel('下一条消息', { exact: true });
const task = id => rpc('tasks.get', { id });
const pending = (account, conversation, prompt) => rpc('tasks.create', { accountId: account.id,
  conversation: conversation.id, background: true, input: { type: 'prompt', prompt, submit: true } });
const open = async (account, conversation) => {
  await rpc('conversations.open', { accountId: account.id, conversation: conversation.id });
  await waitPage(account, conversation.url);
};
const addThroughPanel = async prompt => {
  await composer().fill(prompt);
  await composer().press('Enter');
  await until(async () => await composer().inputValue() === '');
};
try {
  await launch();
  const account = await rpc('accounts.create', { name: 'Project queue owner' });
  await waitPage(account, 'https://chatgpt.com/');
  const firstPage = (await rpc('workspace.status')).page.id;
  // Enter the same project route shown in the user's screenshot without first
  // registering a conversation, so the UI must recognize and pin the live page.
  await read(account, 'https://chatgpt.com/', `history.pushState({},'',${JSON.stringify(projectUrl)})`);
  await until(async () => (await rpc('workspace.status')).page.url === projectUrl);
  await ui.getByRole('button', { name: '会话队列', exact: true }).click();
  await until(async () => await composer().isEnabled(), 'A ready project conversation must enable the queue composer');
  const conversationId = (await rpc('workspace.status')).pages.find(page => page.id === firstPage).conversationId;
  const conversation = await rpc('conversations.get', { accountId: account.id, conversation: conversationId });
  assert.equal(conversation.url, projectUrl);
  assert.equal(conversation.remoteId, `project:${project}:project-thread`);
  assert.equal(conversation.surface, 'chat');
  await rpc('queues.pause', { accountId: account.id, conversation: conversation.id });
  await addThroughPanel('project first');
  await addThroughPanel('project second');
  const originalTasks = (await rpc('tasks.list')).filter(item => item.conversationId === conversation.id).sort((a, b) => a.seq - b.seq);
  assert.deepEqual(originalTasks.map(item => item.input.prompt), ['project first', 'project second']);
  assert.ok(originalTasks.every(item => item.targetUrl === projectUrl && item.accountId === account.id && !item.sendIntentAt));
  await rpc('queues.resume', { accountId: account.id, conversation: conversation.id });
  await until(async () => (await task(originalTasks[1].id)).status === 'done', 'Project FIFO did not complete its second message');
  assert.deepEqual(await read(account, projectUrl, 'window.sent'), ['project first', 'project second']);
  assert.equal(await read(account, projectUrl, 'window.clicks'), 2);
  assert.ok((await Promise.all(originalTasks.map(item => task(item.id)))).every(item => item.status === 'done' && item.result.url === projectUrl));

  const sibling = await rpc('conversations.register', { accountId: account.id, url: siblingUrl });
  const plain = await rpc('conversations.register', { accountId: account.id, url: 'https://chatgpt.com/c/project-thread' });
  const other = await rpc('accounts.create', { name: 'Other project account' });
  const otherConversation = await rpc('conversations.register', { accountId: other.id, url: projectUrl });
  assert.equal(new Set([conversation.id, sibling.id, plain.id, otherConversation.id]).size, 4, 'Project namespace, plain route and accounts retain separate queue identities');
  assert.equal(sibling.remoteId, `project:${siblingProject}:project-thread`);
  await rpc('queues.pause', { accountId: account.id, conversation: sibling.id });
  await rpc('queues.pause', { accountId: other.id, conversation: otherConversation.id });
  const siblingTask = await pending(account, sibling, 'sibling project only');
  const otherTask = await pending(other, otherConversation, 'other account only');

  await open(account, conversation);
  if (!await panel().count()) await ui.getByRole('button', { name: '会话队列', exact: true }).click();
  await until(async () => await composer().isEnabled());
  await rpc('queues.pause', { accountId: account.id, conversation: conversation.id });
  await addThroughPanel('project after restart');
  const deferred = (await rpc('tasks.list')).find(item => item.input.prompt === 'project after restart');
  assert.ok(deferred && !deferred.sendIntentAt);
  const beforeRestartIds = (await rpc('tasks.list')).map(item => item.id).sort();
  await desktop.close();
  await launch();
  await waitPage(account, projectUrl);
  assert.deepEqual((await rpc('tasks.list')).map(item => item.id).sort(), beforeRestartIds);
  assert.equal((await task(deferred.id)).status, 'pending', 'An explicit project queue pause survives restart');
  assert.deepEqual(await read(account, projectUrl, 'window.sent'), ['project first', 'project second']);
  assert.equal(await read(account, projectUrl, 'window.clicks'), 2, 'Restart cannot replay either acknowledged project message');
  await rpc('queues.resume', { accountId: account.id, conversation: conversation.id });
  await until(async () => (await task(deferred.id)).status === 'done');
  assert.deepEqual(await read(account, projectUrl, 'window.sent'), ['project first', 'project second', 'project after restart']);
  assert.equal(await read(account, projectUrl, 'window.clicks'), 3);
  assert.equal((await task(siblingTask.id)).status, 'pending');
  assert.equal((await task(otherTask.id)).status, 'pending');
  await rpc('queues.resume', { accountId: account.id, conversation: sibling.id });
  await rpc('queues.resume', { accountId: other.id, conversation: otherConversation.id });
  await until(async () => (await task(siblingTask.id)).status === 'done' && (await task(otherTask.id)).status === 'done');
  assert.deepEqual(await read(account, siblingUrl, 'window.sent'), ['sibling project only']);
  assert.deepEqual(await read(other, projectUrl, 'window.sent'), ['other account only']);
  assert.deepEqual(await read(account, projectUrl, 'window.sent'), ['project first', 'project second', 'project after restart']);

  await open(account, conversation);
  let currentUrl = projectUrl;
  for (const unsupported of [`https://chatgpt.com/g/${project}`, 'https://chatgpt.com/g/custom/c/project-thread']) {
    await read(account, currentUrl, `history.pushState({},'',${JSON.stringify(unsupported)})`);
    await until(async () => (await rpc('workspace.status')).page.url === unsupported);
    const selected = (await rpc('workspace.status')).page;
    await assert.rejects(rpc('conversations.forPage', { accountId: account.id, pageId: selected.id }));
    await assert.rejects(rpc('conversations.register', { accountId: account.id, url: unsupported }));
    currentUrl = unsupported;
  }
  assert.deepEqual((await rpc('tasks.list')).map(item => item.id).sort(), beforeRestartIds, 'Unsupported project homes and custom GPTs cannot append tasks');
  passed = true;
  console.log('Project queue desktop passed: screenshot route pins through UI, native FIFO keeps full project URLs, same-ID project/account isolation, paused restart without replay, and unsupported project-home/custom-GPT guards.');
} finally {
  if (!passed && ui && !ui.isClosed()) console.error(JSON.stringify(await rpc('workspace.status').then(state => ({ page: state.page,
    tasks: state.tasks.map(item => ({ id: item.id, status: item.status, phase: item.phase, targetUrl: item.targetUrl, error: item.error })) })).catch(error => error.message)));
  await desktop?.close();
  assert.equal(path.dirname(directory), root);
  assert.ok(path.basename(directory).startsWith('.test-project-queue-'));
  await rm(directory, { recursive: true, force: true });
}
