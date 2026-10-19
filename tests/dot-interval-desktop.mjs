import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { surfaceFixture } from './surface-queue-fixture.mjs';

// Run the production runtime against offline Dot documents in an isolated
// profile. Only the main-process clock is offset; the minimum real setting
// remains one minute, while native editor/send operations use real timers.
const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-dot-interval-'));
const bootstrap = path.join(directory, 'fixture.cjs');
const captureUi = process.env.WORKSPACE_TEST_CAPTURE_UI === '1';
const fixture = surfaceFixture.replace('</script>', `
window.keepWorking=dot&&localStorage.getItem(key+':keep-working')==='true';
window.startPersistentWork=()=>{window.keepWorking=true;localStorage.setItem(key+':keep-working','true');window.startWork()};
const originalDotSubmit=send.onclick;
if(dot)send.onclick=()=>{const submittedText=editor.innerText;originalDotSubmit();if(window.keepWorking)window.startWork();if(window.retainSubmittedDraft&&submittedText==='keep-own-draft'){editor.textContent=submittedText;control()}};
const originalControl=control;
control=()=>{originalControl();if(window.blockSend){send.disabled=true;send.setAttribute('aria-disabled','true')}};
window.setSendBlocked=value=>{window.blockSend=value;control()};
window.setComposerStop=value=>{root.querySelector('[data-fixture-stop]')?.remove();if(value){const stop=document.createElement('button');stop.dataset.fixtureStop='true';stop.setAttribute('aria-label','停止');stop.textContent='Stop';root.append(stop)}};
window.setHumanDraft=value=>{editor.textContent=value;editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));control()};
window.getDraft=()=>editor.innerText;
window.liveUpdates=0;
setInterval(()=>{if(window.keepWorking){const body=turns.querySelector('article:not(.self) .message-body');if(body){window.liveUpdates++;body.textContent='Background work update '+window.liveUpdates}}},200);
</script>`);
await writeFile(bootstrap, `const {app,Notification}=require('electron');Notification.isSupported=()=>false;
const realNow=Date.now;globalThis.dotIntervalTestOffset=Number(process.env.WORKSPACE_TEST_CLOCK_OFFSET||'0');
Date.now=()=>realNow()+globalThis.dotIntervalTestOffset;
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
const until = async (check, label) => {
  const end = Date.now() + 45000;
  while (!await check()) { assert.ok(Date.now() < end, label ?? 'Dot interval queue timed out'); await sleep(100); }
};
const launch = async () => {
  desktop = await electron.launch({ args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    ...(captureUi ? ['--disable-backgrounding-occluded-windows'] : []), bootstrap],
    env: { ...env, WORKSPACE_TEST_CLOCK_OFFSET: String(clockOffset) } });
  await until(async () => !!(ui = desktop.windows().find(page => page.url().startsWith('file:'))));
  await ui.waitForFunction(() => !!window.workspace);
};
const rpc = (method, params = {}) => ui.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params });
const read = (account, url, script) => desktop.evaluate(async ({ webContents, session }, { partition, url, script }) => {
  const contents = webContents.getAllWebContents().find(value => value.session === session.fromPartition(partition) && value.getURL() === url);
  if (!contents) throw Error('Own isolated Dot page unavailable');
  const result = await contents.executeJavaScript(`(()=>{try{return {ok:true,value:eval(${JSON.stringify(script)})}}catch(e){return {ok:false,error:e.message}}})()`);
  if (!result.ok) throw Error(result.error);
  return result.value;
}, { partition: account.partition, url, script });
const task = value => rpc('tasks.get', { id: value.id });
const add = (account, conversation, prompt) => rpc('tasks.create', { accountId: account.id, conversation: conversation.id,
  background: true, input: { type: 'prompt', prompt, submit: true } });
const resume = (account, conversation) => rpc('queues.resume', { accountId: account.id, conversation: conversation.id });
const timing = (account, conversation) => rpc('queues.timing', { accountId: account.id, conversation: conversation.id, mode: 'interval', intervalMs: 60000 });
const advance = async (account, conversation, milliseconds) => {
  clockOffset += milliseconds;
  await desktop.evaluate((_, offset) => { globalThis.dotIntervalTestOffset = offset; }, clockOffset);
  // Resume is idempotent and wakes scheduling without resetting its due time.
  await resume(account, conversation);
};
const openDot = async (account, name) => {
  const url = `https://chatgpt.com/dots/${name}`;
  const conversation = await rpc('conversations.register', { accountId: account.id, url });
  await rpc('conversations.open', { accountId: account.id, conversation: conversation.id });
  await until(async () => { try { return await read(account, url, 'typeof window.startPersistentWork === "function"'); } catch { return false; } });
  return conversation;
};
const assertSubmittedOnly = async value => {
  const result = await task(value);
  assert.equal(result.status, 'done');
  assert.equal(result.sendMode, 'dot_interval');
  assert.ok(result.submittedAt);
  assert.equal(result.result.submittedOnly, true);
  assert.equal(result.result.responseUnavailable, true);
};
try {
  await launch();
  const account = await rpc('accounts.create', { name: 'Timed Dot fixture' });
  const dot = await openDot(account, 'interval-dot');
  await read(account, dot.url, 'window.startPersistentWork()');
  await ui.getByRole('button', { name: '会话队列', exact: true }).click();
  const panel = ui.getByRole('complementary', { name: '会话队列' });
  const settings = panel.getByRole('form', { name: 'Dot 队列发送设置' });
  await settings.getByRole('combobox', { name: 'Dot 队列发送方式' }).click();
  await ui.getByRole('option', { name: '定时发送', exact: true }).click();
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  const ownQueue = async () => (await rpc('queues.status')).find(queue => queue.accountId === account.id && queue.conversationId === dot.id);
  await until(async () => (await ownQueue())?.timing?.intervalMs === 600000, 'The 10-minute preset must be saved by the UI');
  await until(async () => await settings.getByRole('combobox', { name: 'Dot 队列发送间隔' }).isEnabled() && await settings.getByRole('button', { name: '保存', exact: true }).isDisabled());
  await settings.getByRole('combobox', { name: 'Dot 队列发送间隔' }).click();
  await ui.getByRole('option', { name: '20 分钟', exact: true }).click();
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await until(async () => (await ownQueue())?.timing?.intervalMs === 1200000, 'The selected preset must be saved by the UI');
  await until(async () => await settings.getByRole('combobox', { name: 'Dot 队列发送间隔' }).isEnabled() && await settings.getByRole('button', { name: '保存', exact: true }).isDisabled());
  await rpc('queues.pause', { accountId: account.id, conversation: dot.id });
  await until(() => panel.getByRole('button', { name: '恢复队列', exact: true }).isVisible());
  await settings.getByRole('combobox', { name: 'Dot 队列发送间隔' }).click();
  await ui.getByRole('option', { name: '自定义', exact: true }).click();
  await settings.getByRole('spinbutton', { name: '自定义发送间隔（分钟）' }).fill('1');
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await until(async () => (await ownQueue())?.timing?.intervalMs === 60000);
  assert.equal((await ownQueue()).paused, true, 'Saving an interval must not resume a paused queue');
  const first = await add(account, dot, 'timer-first');
  const second = await add(account, dot, 'timer-second');
  await panel.getByRole('button', { name: '恢复队列', exact: true }).click();
  await until(async () => /下一条还有 (0:\d{2}|1:00)/.test(await settings.locator('.cq-timing-footer').innerText()), 'The queue UI must show the first-message countdown');
  if (captureUi) {
    const preview = path.join(root, 'release', 'dot-interval-ui-preview.png');
    await mkdir(path.dirname(preview), { recursive: true });
    await ui.screenshot({ path: preview, animations: 'disabled' });
  }
  await panel.getByRole('button', { name: '关闭队列面板' }).click();
  await sleep(500);
  assert.equal((await task(first)).sendIntentAt, undefined, 'The first message must wait for its interval');
  await advance(account, dot, 50000);
  await sleep(500);
  assert.equal((await task(first)).sendIntentAt, undefined, 'A partial interval must not send early');
  await advance(account, dot, 11000);
  await until(async () => (await task(first)).status === 'done', 'A working Dot with changing output must accept its due message');
  await assertSubmittedOnly(first);
  assert.equal((await task(second)).sendIntentAt, undefined, 'The next message must wait from confirmed submission');
  assert.ok(await read(account, dot.url, 'window.liveUpdates > 0'));
  assert.equal(await read(account, dot.url, 'document.querySelector("[data-codex-pet-state]").dataset.codexPetState'), 'running');
  await advance(account, dot, 50000);
  await sleep(500);
  assert.equal((await task(second)).sendIntentAt, undefined, 'A quick acknowledgement cannot bypass the next interval');
  await advance(account, dot, 11000);
  await until(async () => (await task(second)).status === 'done');
  await assertSubmittedOnly(second);
  assert.deepEqual(await read(account, dot.url, 'window.sent()'), ['timer-first', 'timer-second']);
  console.log('Dot interval fixture: preset/custom UI settings, pause preservation, first countdown, and continuing background work passed.');

  // Restoring an overdue queue sends one item and starts a new interval from
  // its actual submission; it never catches up by sending all overdue items.
  const third = await add(account, dot, 'timer-third');
  const fourth = await add(account, dot, 'timer-fourth');
  await desktop.close();
  clockOffset += 120000;
  await launch();
  await until(async () => (await task(third)).status === 'done');
  await assertSubmittedOnly(third);
  assert.equal((await task(fourth)).sendIntentAt, undefined, 'Restart must not burst overdue items');
  assert.deepEqual(await read(account, dot.url, 'window.sent()'), ['timer-first', 'timer-second', 'timer-third']);
  await advance(account, dot, 61000);
  await until(async () => (await task(fourth)).status === 'done');
  assert.deepEqual(await read(account, dot.url, 'window.sent()'), ['timer-first', 'timer-second', 'timer-third', 'timer-fourth']);

  // A known delivered legacy message can become timed and survive restart
  // without waiting for Dot work or replaying its persisted send receipt.
  const restored = await openDot(account, 'restored-ack');
  const delivered = await add(account, restored, 'ack-then-work');
  await until(async () => !!(await task(delivered)).submittedAt);
  assert.equal((await task(delivered)).status, 'running');
  const messageId = (await task(delivered)).submittedMessageId;
  await timing(account, restored);
  await desktop.close();
  await launch();
  await until(async () => (await task(delivered)).status === 'done');
  await assertSubmittedOnly(delivered);
  assert.equal((await task(delivered)).submittedMessageId, messageId);
  await rpc('conversations.open', { accountId: account.id, conversation: restored.id });
  await until(async () => { try { return await read(account, restored.url, 'typeof window.sent === "function"'); } catch { return false; } });
  assert.deepEqual(await read(account, restored.url, 'window.sent()'), ['ack-then-work']);
  assert.equal(await read(account, restored.url, 'Number(localStorage.getItem(location.pathname+":clicks"))'), 1, 'A restored acknowledgement must never click Send again');
  console.log('Dot interval fixture: restart spacing and acknowledged receipt recovery passed.');

  // Completion-based Dot queues keep their existing semantics unless the
  // user explicitly chooses interval delivery for that conversation.
  const completion = await openDot(account, 'completion-dot');
  const working = await add(account, completion, 'ack-then-work');
  const afterWork = await add(account, completion, 'after-work');
  await until(async () => !!(await task(working)).submittedAt);
  await sleep(2500);
  assert.equal((await task(working)).status, 'running');
  assert.equal((await task(afterWork)).sendIntentAt, undefined, 'Ordinary Dot queues must keep waiting for work completion');
  await read(account, completion.url, 'window.finishWork()');
  await until(async () => (await task(afterWork)).status === 'done');

  // Enabling timing while a completion-mode task is waiting to send must
  // return it to the scheduler, instead of bypassing its first interval.
  const converted = await openDot(account, 'converted-wait');
  await read(account, converted.url, 'window.startPersistentWork()');
  const convertedWait = await add(account, converted, 'converted-after-interval');
  await until(async () => (await task(convertedWait)).phase === 'waiting_idle');
  assert.equal((await task(convertedWait)).sendIntentAt, undefined);
  await timing(account, converted);
  await sleep(1000);
  assert.equal((await task(convertedWait)).sendIntentAt, undefined, 'Switching an unsent task to timing must not send immediately');
  await advance(account, converted, 50000);
  await sleep(500);
  assert.equal((await task(convertedWait)).sendIntentAt, undefined, 'A converted task must wait for its complete first interval');
  await advance(account, converted, 11000);
  await until(async () => (await task(convertedWait)).status === 'done');
  await assertSubmittedOnly(convertedWait);
  console.log('Dot interval fixture: completion-mode preservation and switching an unsent active task to timing passed.');

  // Timed delivery bypasses only background work, never an unavailable Send
  // button, an active composer Stop button, or text written by a person.
  const guarded = await openDot(account, 'guarded-dot');
  await read(account, guarded.url, 'window.startPersistentWork()');
  await timing(account, guarded);
  for (const protection of [
    { name: 'disabled-send', enable: 'window.setSendBlocked(true)', check: 'window.sent().length===0', release: 'window.setSendBlocked(false)' },
    { name: 'composer-stop', enable: 'window.setComposerStop(true)', check: 'window.getDraft()===""', release: 'window.setComposerStop(false)' },
    { name: 'human-draft', enable: 'window.setHumanDraft("Human text must survive")', check: 'window.getDraft()==="Human text must survive"', release: 'window.setHumanDraft("")' }
  ]) {
    const before = await read(account, guarded.url, 'window.sent().length');
    await read(account, guarded.url, protection.enable);
    const blocked = await add(account, guarded, protection.name);
    await advance(account, guarded, 61000);
    await until(async () => { const value = await task(blocked); return value.status === 'running' || /DRAFT_CONFLICT/.test(value.error ?? ''); });
    await sleep(2500);
    assert.equal((await task(blocked)).sendIntentAt, undefined, `${protection.name} must block send intent`);
    assert.equal(await read(account, guarded.url, 'window.sent().length'), before);
    assert.ok(await read(account, guarded.url, protection.check), `${protection.name} must preserve the protected editor state`);
    await read(account, guarded.url, protection.release);
    await until(async () => (await task(blocked)).status === 'done', `${protection.name} must recover without manual queue intervention`);
    await assertSubmittedOnly(blocked);
  }
  assert.deepEqual(await read(account, guarded.url, 'window.sent()'), ['disabled-send', 'composer-stop', 'human-draft']);

  // Some Dot builds acknowledge a send while leaving the identical prompt in
  // the composer. Clear only that confirmed own draft so a different next
  // item can be delivered, without requiring the user to empty the editor.
  await read(account, guarded.url, 'window.retainSubmittedDraft=true');
  const retained = await add(account, guarded, 'keep-own-draft');
  const different = await add(account, guarded, 'different-next-message');
  await advance(account, guarded, 61000);
  await until(async () => (await task(retained)).status === 'done');
  await assertSubmittedOnly(retained);
  assert.equal(await read(account, guarded.url, 'window.getDraft()'), '', 'A confirmed identical own draft must be cleared automatically');
  assert.equal((await task(different)).sendIntentAt, undefined);
  await advance(account, guarded, 61000);
  await until(async () => (await task(different)).status === 'done');
  await assertSubmittedOnly(different);
  assert.deepEqual(await read(account, guarded.url, 'window.sent()'), ['disabled-send', 'composer-stop', 'human-draft', 'keep-own-draft', 'different-next-message']);
  console.log('Dot interval fixture: disabled Send, real Stop, human drafts, and confirmed own-draft cleanup passed.');

  // An explicitly paused timed queue remains paused over restart even when
  // its deadline is long overdue. Resuming starts one item, not a burst.
  await rpc('queues.pause', { accountId: account.id, conversation: guarded.id });
  const paused = await add(account, guarded, 'paused-until-resume');
  await desktop.close();
  clockOffset += 120000;
  await launch();
  await sleep(1000);
  assert.equal((await task(paused)).sendIntentAt, undefined);
  const queues = await rpc('queues.status');
  assert.equal(queues.find(queue => queue.accountId === account.id && queue.conversationId === guarded.id).paused, true);
  await resume(account, guarded);
  await until(async () => (await task(paused)).status === 'done');
  await assertSubmittedOnly(paused);
  passed = true;
  console.log('Dot interval queues passed: delayed first send, confirmed-send spacing, changing background output, restart without bursts/replay, completion mode preservation, disabled Send, Stop, drafts, and persistent pause.');
} finally {
  if (!passed && ui) console.error(JSON.stringify(await rpc('workspace.status').then(state => state.tasks.map(value => ({
    prompt: value.input.prompt, status: value.status, phase: value.phase, sendMode: value.sendMode,
    intent: value.sendIntentAt, submitted: value.submittedAt, error: value.error
  }))).catch(() => [])));
  await desktop?.close();
  assert.equal(path.dirname(directory), root);
  assert.ok(path.basename(directory).startsWith('.test-dot-interval-'));
  await rm(directory, { recursive: true, force: true });
}
