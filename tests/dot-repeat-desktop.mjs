import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { surfaceFixture } from './surface-queue-fixture.mjs';

// Exercise the production queue UI and native Dot sender against an owned,
// offline document. This profile never reads the user's accounts or cookies.
const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-dot-repeat-'));
const bootstrap = path.join(directory, 'fixture.cjs');
const captureUi = process.env.WORKSPACE_TEST_CAPTURE_UI === '1';
const fixture = surfaceFixture.replace('</script>', `
window.startPersistentWork=()=>window.startWork();
const originalDotSubmit=send.onclick;
if(dot)send.onclick=()=>{originalDotSubmit();window.startWork()};
</script>`);
await writeFile(bootstrap, `const {app,Notification}=require('electron');Notification.isSupported=()=>false;
const realNow=Date.now;globalThis.dotRepeatTestOffset=Number(process.env.WORKSPACE_TEST_CLOCK_OFFSET||'0');
Date.now=()=>realNow()+globalThis.dotRepeatTestOffset;
app.on('browser-window-created',(_,w)=>{w.webContents.setBackgroundThrottling(false);${captureUi
  ? "w.setSkipTaskbar(true);if(process.platform==='win32')w.setPosition(-20000,-20000)"
  : "w.on('show',()=>w.hide())"}});
app.on('session-created',s=>s.protocol.handle('https',()=>new Response(${JSON.stringify(fixture)},{headers:{'Content-Type':'text/html'}})));
require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory,
  WORKSPACE_HIDDEN_PAGE_IDLE_MS: '3600000', WORKSPACE_PAGE_IDLE_MS: '3600000' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKSPACE_DEV_URL;
let desktop, ui, clockOffset = 0, passed = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label = 'Dot repetition condition timed out') => {
  const end = Date.now() + 45000;
  while (!await check()) { assert.ok(Date.now() < end, label); await sleep(100); }
};
const launch = async () => {
  desktop = await electron.launch({ args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    ...(captureUi ? ['--disable-backgrounding-occluded-windows'] : []), bootstrap],
    env: { ...env, WORKSPACE_TEST_CLOCK_OFFSET: String(clockOffset) } });
  await until(async () => !!(ui = desktop.windows().find(page => page.url().startsWith('file:'))));
  ui.setDefaultTimeout(15000);
  await ui.waitForFunction(() => !!window.workspace);
};
const rpc = (method, params = {}) => ui.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params });
const tasks = () => rpc('tasks.list');
const task = value => rpc('tasks.get', { id: value.id });
const read = (account, url, script) => desktop.evaluate(async ({ webContents, session }, { partition, url, script }) => {
  const contents = webContents.getAllWebContents().find(value => value.session === session.fromPartition(partition) && value.getURL() === url);
  if (!contents) throw Error('Own isolated repetition page unavailable');
  return contents.executeJavaScript(script);
}, { partition: account.partition, url, script });
const open = async (account, name, alias, surface = 'dots') => {
  const url = `https://chatgpt.com/${surface}/${name}`;
  const conversation = await rpc('conversations.register', { accountId: account.id, url, alias });
  await rpc('conversations.open', { accountId: account.id, conversation: conversation.id });
  await until(async () => { try { return await read(account, url, 'typeof window.sent === "function"'); } catch { return false; } });
  return conversation;
};
const panel = () => ui.getByRole('complementary', { name: '会话队列' });
const composer = () => panel().getByLabel('下一条消息', { exact: true });
const repetition = () => panel().getByRole('spinbutton', { name: '发送次数', exact: true });
const openPanel = async conversation => {
  if (!await panel().count()) await ui.getByRole('button', { name: '会话队列', exact: true }).click();
  await until(async () => (await panel().locator('.cq-header').innerText()).includes(conversation.alias) && await composer().isEnabled());
};
const fence = async (account, conversation) => {
  await rpc('conversations.get', { accountId: account.id, conversation: conversation.id });
  return tasks();
};
const advance = async (account, conversation, ms) => {
  clockOffset += ms;
  await desktop.evaluate((_, offset) => { globalThis.dotRepeatTestOffset = offset; }, clockOffset);
  await rpc('queues.resume', { accountId: account.id, conversation: conversation.id });
};
try {
  await launch();
  const account = await rpc('accounts.create', { name: 'Dot repetition owner' });
  const compoundPrefix = '11111111-2222-4333-8444-555555555555';
  const dot = await open(account, `${compoundPrefix}~repeat`, 'Repeated timed Dot');
  await rpc('queues.pause', { accountId: account.id, conversation: dot.id });
  await rpc('queues.timing', { accountId: account.id, conversation: dot.id, mode: 'interval', intervalMs: 60000 });
  await read(account, dot.url, 'window.startPersistentWork()');
  await openPanel(dot);
  assert.equal(await repetition().inputValue(), '1');
  const repeatedPrompt = 'Repeated identical Dot message\nSecond line';
  await panel().getByRole('button', { name: '×10', exact: true }).click();
  assert.equal(await repetition().inputValue(), '10');
  await composer().fill(repeatedPrompt);
  await panel().getByRole('button', { name: '加入队列 ×10', exact: true }).click();
  await until(async () => await composer().inputValue() === '');
  const batch = (await fence(account, dot)).filter(item => item.conversationId === dot.id);
  assert.equal(batch.length, 10, 'The ×10 UI action must create exactly ten independent queue items');
  assert.equal(new Set(batch.map(item => item.id)).size, 10);
  assert.deepEqual([...batch].sort((a, b) => a.seq - b.seq).map(item => item.seq), Array.from({ length: 10 }, (_, index) => Math.min(...batch.map(item => item.seq)) + index));
  assert.ok(batch.every(item => item.accountId === account.id && item.input.prompt === repeatedPrompt && item.input.submit && item.background && item.sendMode === 'dot_interval' && !item.sendIntentAt));
  await until(async () => await panel().locator('.cq-item').count() === 10, 'The whole batch must appear in the queue UI');
  assert.equal(await panel().locator('.cq-item').count(), 10);
  assert.deepEqual(await read(account, dot.url, 'window.sent()'), []);

  await composer().fill('Invalid counts must retain this draft');
  for (const value of ['', '0', '-1', '1.5', '1001']) {
    await repetition().fill(value);
    await composer().press('Enter');
    assert.equal((await fence(account, dot)).length, 10, `Invalid count ${JSON.stringify(value)} must not enqueue anything`);
    assert.equal(await composer().inputValue(), 'Invalid counts must retain this draft');
    assert.equal(await panel().locator('.cq-composer button.primary').isDisabled(), true);
    assert.match(await panel().locator('#queue-repeat-help').innerText(), /1.*1000/);
  }
  await repetition().fill('3');
  await composer().fill('Custom repetition entered with keyboard');
  await composer().press('Enter');
  await until(async () => await composer().inputValue() === '');
  const custom = (await fence(account, dot)).filter(item => item.input.prompt === 'Custom repetition entered with keyboard');
  assert.equal(custom.length, 3, 'A custom integer plus Enter must create that many queue items');
  assert.ok(custom.every(item => item.accountId === account.id && item.conversationId === dot.id));
  assert.equal(await repetition().inputValue(), '3');
  if (captureUi) {
    await mkdir(path.join(root, 'release'), { recursive: true });
    await ui.screenshot({ path: path.join(root, 'release', 'dot-repeat-ui.png'), animations: 'disabled' });
  }

  const sibling = await open(account, `${compoundPrefix}~sibling`, 'Independent Dot queue');
  await rpc('queues.pause', { accountId: account.id, conversation: sibling.id });
  await openPanel(sibling);
  assert.equal(await repetition().inputValue(), '1', 'A different Dot must not inherit the original repeat count');
  await panel().getByRole('button', { name: '×5', exact: true }).click();
  await composer().fill('Sibling only');
  await panel().getByRole('button', { name: '加入队列 ×5', exact: true }).click();
  await until(async () => await composer().inputValue() === '');
  assert.equal((await fence(account, sibling)).filter(item => item.conversationId === sibling.id).length, 5);
  await rpc('conversations.open', { accountId: account.id, conversation: dot.id });
  await openPanel(dot);
  assert.equal(await repetition().inputValue(), '3', 'Returning to the same Dot must restore its own repeat selection');
  await until(async () => await panel().locator('.cq-item').count() === 13, 'Returning to Dot must display its own complete queue');
  assert.equal(await panel().locator('.cq-item').count(), 13);
  const chat = await open(account, 'repeat-chat', 'Ordinary Chat', 'c');
  await openPanel(chat);
  assert.equal(await repetition().count(), 0, 'Ordinary Chat keeps its one-message composer');

  const other = await rpc('accounts.create', { name: 'Other repetition owner' });
  const otherDot = await open(other, `${compoundPrefix}~repeat`, 'Other account Dot');
  await rpc('queues.pause', { accountId: other.id, conversation: otherDot.id });
  await openPanel(otherDot);
  assert.equal(await repetition().inputValue(), '1', 'Another account starts with its own selection');
  const replayParams = { accountId: other.id, conversation: otherDot.id, prompt: 'Idempotent other account batch', count: 2, idempotencyKey: 'desktop-repeat-persisted-request' };
  const replayBatch = await rpc('tasks.repeat', replayParams);
  assert.equal(replayBatch.length, 2);
  await until(async () => await panel().locator('.cq-item').count() === 2, 'The other account must display only its own two queued items');
  assert.deepEqual(await read(other, otherDot.url, 'window.sent()'), []);
  assert.deepEqual(await read(account, dot.url, 'window.sent()'), [], 'Account and Dot switches must not execute a paused batch');
  console.log('Dot repetition UI passed: ×10, custom count + Enter, invalid inputs, independent Dot counts, Chat exclusion and account isolation.');

  await rpc('conversations.open', { accountId: account.id, conversation: dot.id });
  await openPanel(dot);
  assert.equal(await repetition().inputValue(), '3', 'Returning from another account must preserve this Dot\'s own repeat selection');
  const orderedBatch = [...batch].sort((a, b) => a.seq - b.seq);
  await advance(account, dot, 61000);
  await until(async () => (await task(orderedBatch[0])).status === 'done', 'First repeated item must send once when its interval is due');
  assert.equal((await task(orderedBatch[1])).sendIntentAt, undefined);
  assert.deepEqual(await read(account, dot.url, 'window.sent()'), [repeatedPrompt]);
  await advance(account, dot, 50000);
  await sleep(500);
  assert.equal((await task(orderedBatch[1])).sendIntentAt, undefined, 'Identical text must not bypass the next delivery interval');
  await advance(account, dot, 11000);
  await until(async () => (await task(orderedBatch[1])).status === 'done');
  await advance(account, dot, 61000);
  await until(async () => (await task(orderedBatch[2])).status === 'done');
  assert.deepEqual(await read(account, dot.url, 'window.sent()'), Array(3).fill(repeatedPrompt));
  assert.equal(await read(account, dot.url, 'Number(localStorage.getItem(location.pathname+":clicks"))'), 3, 'Three same-text tasks require exactly three native Send clicks');
  assert.equal((await task(orderedBatch[3])).sendIntentAt, undefined);
  const beforeRestartIds = (await tasks()).map(item => item.id).sort();
  await desktop.close();
  clockOffset += 120000;
  await launch();
  await until(async () => (await task(orderedBatch[3])).status === 'done', 'One overdue repeated item must resume after restart');
  assert.equal((await task(orderedBatch[4])).sendIntentAt, undefined, 'Restart must not burst the remaining identical queue');
  assert.deepEqual((await tasks()).map(item => item.id).sort(), beforeRestartIds, 'Restart preserves exactly the original task set');
  assert.deepEqual((await rpc('tasks.repeat', replayParams)).map(item => item.id), replayBatch.map(item => item.id), 'Retrying a persisted batch request must return the same tasks after restart');
  assert.deepEqual((await tasks()).map(item => item.id).sort(), beforeRestartIds, 'A retry must not append another batch');
  await rpc('conversations.open', { accountId: account.id, conversation: dot.id });
  await until(async () => { try { return await read(account, dot.url, 'window.sent().length === 4'); } catch { return false; } });
  assert.deepEqual(await read(account, dot.url, 'window.sent()'), Array(4).fill(repeatedPrompt));
  assert.equal(await read(account, dot.url, 'Number(localStorage.getItem(location.pathname+":clicks"))'), 4, 'Restart must not replay any of the first three acknowledged sends');
  const sent = await Promise.all(orderedBatch.slice(0, 4).map(task));
  assert.ok(sent.every(item => item.submittedAt && item.submittedMessageId && item.result.submittedOnly));
  assert.equal(new Set(sent.map(item => item.submittedMessageId)).size, 4, 'Identical text must be acknowledged against four independent user-message IDs');
  assert.equal(await read(account, dot.url, 'new Set([...document.querySelectorAll("article.self")].map(item=>item.dataset.messageId)).size'), 4);
  assert.ok(sent.slice(1).every((item, index) => item.submittedAt - sent[index].submittedAt >= 60000));
  assert.ok((await tasks()).filter(item => item.conversationId === sibling.id || item.conversationId === otherDot.id).every(item => !item.sendIntentAt), 'Other paused conversations remain untouched');
  passed = true;
  console.log('Dot repeated delivery passed: same-text messages have distinct receipts, respect intervals, preserve remaining tasks across restart, do not burst or replay, and batch retries remain idempotent.');
} finally {
  if (!passed && ui && !ui.isClosed()) console.error(JSON.stringify({
    panel: await panel().innerText().catch(error => error.message),
    tasks: await tasks().then(values => values.map(value => ({ id: value.id, accountId: value.accountId, conversationId: value.conversationId,
      prompt: value.input.prompt, status: value.status, phase: value.phase, submitted: value.submittedAt, error: value.error }))).catch(error => error.message)
  }));
  await desktop?.close();
  assert.equal(path.dirname(directory), root);
  assert.ok(path.basename(directory).startsWith('.test-dot-repeat-'));
  await rm(directory, { recursive: true, force: true });
}
