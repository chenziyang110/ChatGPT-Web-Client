import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

// Native navigation succeeds, but ChatGPT cannot mount the requested conversation.
// All requests and account profiles belong to this offline fixture.
const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-conversation-load-'));
const initialUrl = 'https://chatgpt.com/c/6ac8a40d-feb0-83ee-90f1-9fe754214765';
const queuedUrl = 'https://chatgpt.com/c/6ac8a40d-feb0-83ee-90f1-9fe754214766';
const siblingUrl = 'https://chatgpt.com/c/6ac8a40d-feb0-83ee-90f1-9fe754214767';
const quoteUrl = 'https://chatgpt.com/c/6ac8a40d-feb0-83ee-90f1-9fe754214768';
const repeatedUrl = 'https://chatgpt.com/c/6ac8a40d-feb0-83ee-90f1-9fe754214769';
const skeletonUrl = 'https://chatgpt.com/c/6ac8a40d-feb0-83ee-90f1-9fe754214770';
const restoredUrl = 'https://chatgpt.com/c/6ac8a40d-feb0-83ee-90f1-9fe754214771';
const soleUrl = 'https://chatgpt.com/c/6ac8a40d-feb0-83ee-90f1-9fe754214772';
const compoundUrl = 'https://chatgpt.com/c/6ac8a40d-feb0-83ee-90f1-9fe754214773';
const cappedNativeUrl = 'https://chatgpt.com/c/6ac8a40d-feb0-83ee-90f1-9fe754214774';
const canceledUrl = 'https://chatgpt.com/c/6ac8a40d-feb0-83ee-90f1-9fe754214775';
const pausedUrl = 'https://chatgpt.com/c/6ac8a40d-feb0-83ee-90f1-9fe754214776';
const plainPendingUrl = 'https://chatgpt.com/c/6ac8a40d-feb0-83ee-90f1-9fe754214777';
const errorCard = '<div id="conversation-load-error"><p>无法加载此 ChatGPT 对话</p><button onclick="location.reload()">重试</button></div>';
const failureFixture = `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT</title></head><body>
<aside><a href="/">新聊天</a></aside><main>${errorCard}</main></body></html>`;
const pendingFailureFixture = `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT</title></head><body>
<aside><a href="/">新聊天</a></aside><main>${errorCard}</main><iframe src="/pending-conversation-resource"></iframe></body></html>`;
const healthyFixture = fixture
  .replace('window.fixtureSendCount = (window.fixtureSendCount || 0) + 1;',
    `window.fixtureSendCount = (window.fixtureSendCount || 0) + 1;
     localStorage.setItem('fixture-total-sends:' + location.pathname,
       Number(localStorage.getItem('fixture-total-sends:' + location.pathname) || 0) + 1);`)
  .replace('</script>', `
window.fixtureConversationLoadError = () => {
  // The remote reply completes while the conversation body is disconnected.
  // Preserve the same message IDs so a recorded send can be correlated on reload.
  if (messages.at(-1)?.role === 'assistant') messages.at(-1).finished = true;
  localStorage.setItem(historyKey(), JSON.stringify(messages));
  document.querySelector('main').innerHTML = ${JSON.stringify(errorCard)};
};
</script>`);
assert.notEqual(healthyFixture, fixture);
const bootstrap = path.join(directory, 'fixture.cjs');
const mainEntry = process.env.WORKSPACE_TEST_MAIN_CJS || path.join(root, 'dist-electron/main.cjs');
await writeFile(bootstrap, `const { app, Notification } = require('electron');
Notification.isSupported = () => false;
globalThis.fixtureRequests = [];
globalThis.pendingConversationStreams = [];
globalThis.fixtureInitialFailureSent = false;
globalThis.fixtureConnectionResets = new WeakMap();
app.on('browser-window-created', (_, win) => {
  win.webContents.setBackgroundThrottling(false);
  win.setSkipTaskbar(true);
  if (process.platform === 'win32') win.setPosition(-20000, -20000);
});
app.on('session-created', isolated => {
  const closeAllConnections = isolated.closeAllConnections.bind(isolated);
  isolated.closeAllConnections = async () => {
    globalThis.fixtureConnectionResets.set(isolated, (globalThis.fixtureConnectionResets.get(isolated) || 0) + 1);
    await closeAllConnections();
  };
  isolated.protocol.handle('https', async request => {
  globalThis.fixtureRequests.push(request.url);
  if (request.url === 'https://chatgpt.com/pending-conversation-resource') {
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('<!doctype html><html><body>pending conversation resource'));
      globalThis.pendingConversationStreams.push(controller);
    } });
    return new Response(stream, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  }
  if (request.url === ${JSON.stringify(plainPendingUrl)})
    return new Response(${JSON.stringify(pendingFailureFixture)},
      { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  const initialFailure = request.url === ${JSON.stringify(initialUrl)} && !globalThis.fixtureInitialFailureSent;
  if (initialFailure) globalThis.fixtureInitialFailureSent = true;
  const repeatedFailure = request.url === ${JSON.stringify(repeatedUrl)} &&
    globalThis.fixtureRequests.filter(url => url === request.url).length <= 4;
  const compoundCount = globalThis.fixtureRequests.filter(url => url === ${JSON.stringify(compoundUrl)}).length;
  const compoundFailure = request.url === ${JSON.stringify(compoundUrl)} && compoundCount <= 4;
  if (request.url === ${JSON.stringify(cappedNativeUrl)} || request.url === ${JSON.stringify(compoundUrl)} && compoundCount === 5)
    await new Promise(() => {});
  return new Response(initialFailure || repeatedFailure || compoundFailure ? ${JSON.stringify(failureFixture)} : ${JSON.stringify(healthyFixture)},
    { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  });
});
require(${JSON.stringify(mainEntry)});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory,
  WORKSPACE_PAGE_IDLE_MS: '3600000', WORKSPACE_HIDDEN_PAGE_IDLE_MS: '3600000',
  ...(process.argv.includes('--plain-pending-only') ? { WORKSPACE_PAGE_LOAD_TIMEOUT_MS: '1200' } : {}) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKSPACE_DEV_URL;
let desktop, shell, desktopPid;
let passed = false;

function bounded(promise, label, ms = 20000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  })]).finally(() => clearTimeout(timer));
}
const until = async (check, label, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (!await check()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
const rpc = (method, params = {}, ms = 20000) => bounded(shell.evaluate(({ method, params }) =>
  window.workspace.call(method, params), { method, params }), method, ms);
const nativeFor = (account, url) => desktop.evaluate(({ session, webContents }, { partition, url }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.getURL() === url);
  if (!contents) return null;
  return { id: contents.id, url: contents.getURL(), loading: contents.isLoading(), waitingResponse: contents.isWaitingForResponse() };
}, { partition: account.partition, url });
const visibleFor = nativeId => desktop.evaluate(({ BrowserWindow }, nativeId) => {
  const native = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
    .find(view => view.webContents?.id === nativeId);
  return native?.getVisible();
}, nativeId);
const inPage = (account, url, script) => desktop.evaluate(async ({ session, webContents }, { partition, url, script }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.getURL() === url);
  if (!contents) throw new Error(`Fixture page missing: ${url}`);
  return contents.mainFrame.executeJavaScript(script);
}, { partition: account.partition, url, script });
const requestCount = url => desktop.evaluate((_electron, url) =>
  globalThis.fixtureRequests.filter(request => request === url).length, url);
const inspect = async (account, pageId) => {
  // A logical tab survives recovery while its native frame is replaced. Do not
  // send diagnostics into a loading frame, and bound the narrow race between
  // this native check and the actual RPC so one disposed-frame request cannot
  // consume the readiness deadline without polling the replacement document.
  const workspace = await rpc('workspace.status');
  const page = workspace.pages.find(item => item.accountId === account.id &&
    (pageId ? item.id === pageId : item.selected));
  const native = page && await nativeFor(account, page.url);
  if (!native || native.loading || native.waitingResponse) return { readiness: 'loading' };
  try {
    return await rpc('browser.inspect', { accountId: account.id, pageId }, 1500);
  } catch (error) {
    if (/Execution context was destroyed|Render frame was disposed|frame was disposed|Object has been destroyed/i.test(String(error))) {
      return { readiness: 'loading' };
    }
    if (/browser\.inspect timed out/.test(String(error))) {
      const current = await nativeFor(account, page.url);
      if (!current || current.id !== native.id || current.loading || current.waitingResponse) {
        return { readiness: 'loading' };
      }
    }
    throw error;
  }
};
const open = async (account, url) => {
  await rpc('accounts.switch', { id: account.id });
  const conversation = await rpc('conversations.register', { accountId: account.id, url });
  const page = await rpc('conversations.open', { accountId: account.id, conversation: conversation.id });
  return { conversation, page };
};
const ready = (account, pageId, label, ms) => until(async () =>
  (await inspect(account, pageId)).readiness === 'ready', label, ms);
const sends = (account, url) => inPage(account, url,
  "Number(localStorage.getItem('fixture-total-sends:' + location.pathname) || 0)");
const addTask = (account, conversation, prompt) => rpc('tasks.create', { accountId: account.id, conversation: conversation.id,
  background: true, input: { type: 'prompt', prompt, submit: true } });
const settled = (account, url) => until(async () => {
  const native = await nativeFor(account, url);
  return native && !native.loading && !native.waitingResponse &&
    await inPage(account, url, "document.readyState === 'complete'");
}, 'Original fixture navigation must finish before a semantic fault is mounted');
const faultObserved = pageId => until(async () => {
  const state = await rpc('workspace.status');
  return state.page?.id === pageId && /会话.*加载|自动重试/.test(state.page.error ?? '');
},
  'The runtime must observe the semantic error before the fixture simulates its asynchronous Retry result', 4000);
const connectionResets = account => desktop.evaluate(({ session }, partition) =>
  globalThis.fixtureConnectionResets.get(session.fromPartition(partition)) || 0, account.partition);

try {
  desktop = await electron.launch({ args: ['--no-sandbox', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', bootstrap], env });
  desktopPid = desktop.process()?.pid;
  shell = await bounded(desktop.firstWindow(), 'Workspace window');
  await bounded(shell.waitForFunction(() => !!window.workspace), 'Workspace bridge');
  const account = await rpc('accounts.create', { name: 'Conversation load recovery' });
  await ready(account, undefined, 'First fixture account did not load');
  const other = await rpc('accounts.create', { name: 'Independent profile' });
  await ready(other, undefined, 'Second fixture account did not load');
  const otherNative = await nativeFor(other, 'https://chatgpt.com/');
  assert.ok(otherNative);
  await inPage(other, 'https://chatgpt.com/', "localStorage.setItem('fixture-profile-marker', 'retained');");
  await desktop.evaluate(async ({ session }, partition) => {
    const isolated = session.fromPartition(partition);
    await isolated.cookies.set({ url: 'https://chatgpt.com', name: 'fixture-profile', value: 'retained' });
  }, other.partition);

  const sibling = await rpc('conversations.register', { accountId: account.id, url: siblingUrl });
  const siblingTask = await rpc('tasks.create', { accountId: account.id, conversation: sibling.id,
    background: true, input: { type: 'prompt', prompt: 'HOLD:healthy sibling remains working', submit: true } });
  await until(async () => !!(await rpc('tasks.get', { id: siblingTask.id })).submittedAt,
    'Healthy sibling reply did not start');
  const siblingNative = await nativeFor(account, siblingUrl);
  assert.ok(siblingNative);

  const current = await open(account, initialUrl);
  await until(async () => {
    const native = await nativeFor(account, initialUrl);
    return !!native && !native.loading && !native.waitingResponse &&
      await inPage(account, initialUrl, "document.readyState === 'complete' && !!document.querySelector('#conversation-load-error') && !document.querySelector('#prompt-textarea')");
  }, 'Fixture must reproduce a completed native load with the visible conversation error', 5000);
  const currentNative = await nativeFor(account, initialUrl);
  assert.equal(await requestCount(initialUrl), 1, 'Initial response contains the semantic error, not a network failure');
  await new Promise(resolve => setTimeout(resolve, 4500));
  assert.equal(await requestCount(initialUrl), 1,
    'A normal conversation load error without its own queue must not auto-reload');
  assert.equal((await nativeFor(account, initialUrl)).id, currentNative.id,
    'A normal conversation load error keeps the original WebContents visible');
  assert.equal(await visibleFor(currentNative.id), true,
    'A normal conversation load error keeps the original WebContentsView visible');
  const currentState = (await rpc('workspace.status')).page;
  assert.equal(currentState.id, current.page.id, 'The selected logical tab stays visible');
  assert.equal(currentState.conversationId, current.conversation.id);
  assert.equal(currentState.url, initialUrl);
  assert.equal(currentState.error, undefined, 'A normal conversation load error is not covered by a client page error');
  assert.equal((await inspect(account, current.page.id)).loadFailure, 'conversation',
    'Diagnostics still expose the site-level conversation load failure');
  assert.equal(await inPage(account, initialUrl, "!!document.querySelector('#conversation-load-error button')"), true,
    'The site Retry control remains clickable for a normal conversation');
  assert.equal(await inPage(account, initialUrl,
    "!!document.querySelector('#conversation-load-error button')?.getClientRects().length"), true,
  'The site Retry control remains visible for a normal conversation');
  assert.equal(await sends(account, initialUrl), 0, 'A nonqueued conversation failure must not send anything');
  assert.equal((await nativeFor(account, siblingUrl)).id, siblingNative.id,
    'Another same-account queue must not authorize recovery of this normal conversation');
  assert.equal((await rpc('tasks.get', { id: siblingTask.id })).status, 'running');
  await inPage(account, initialUrl, "document.querySelector('#conversation-load-error button').click(); true");
  await ready(account, current.page.id, 'The site Retry button can manually recover the normal conversation', 10000);
  assert.equal(await requestCount(initialUrl), 2, 'Manual site Retry performs the only reload for a normal conversation');
  assert.equal((await rpc('workspace.status')).page?.error, undefined);

  const assertPlainPendingGuard = async () => {
    const pendingPlain = await open(account, plainPendingUrl);
    await until(async () => {
      const native = await nativeFor(account, plainPendingUrl);
      return !!native && native.loading &&
        await inPage(account, plainPendingUrl, "document.readyState !== 'loading' && !!document.querySelector('#conversation-load-error button')");
    }, 'Pending-resource conversation error fixture must show the site Retry while native loading stays pending', 8000);
    const pendingNative = await nativeFor(account, plainPendingUrl);
    const pendingRequests = await requestCount(plainPendingUrl);
    // Cross the native load watchdog as well as the ordinary DOM monitor.
    await new Promise(resolve => setTimeout(resolve, process.argv.includes('--plain-pending-only') ? 3500 : 23000));
    assert.equal(await requestCount(plainPendingUrl), pendingRequests,
      'A normal conversation error with a pending subresource must not auto-reload after the native watchdog fires');
    assert.equal((await nativeFor(account, plainPendingUrl)).id, pendingNative.id,
      'A normal pending-resource error keeps the original WebContents visible');
    assert.equal(await visibleFor(pendingNative.id), true,
      'A normal pending-resource error keeps the original WebContentsView visible');
    const pendingPage = (await rpc('workspace.status')).page;
    assert.equal(pendingPage?.id, pendingPlain.page.id,
      'The pending-resource guard checks the active PageState for the normal conversation');
    assert.equal(pendingPage?.error, undefined,
      'A normal pending-resource error is not covered by a client page error');
    assert.equal(await inPage(account, plainPendingUrl, "!!document.querySelector('#conversation-load-error button')"), true,
      'The site Retry control remains available while the subresource is pending');
    assert.equal(await inPage(account, plainPendingUrl,
      "!!document.querySelector('#conversation-load-error button')?.getClientRects().length"), true,
    'The site Retry control remains visible while the subresource is pending');
    assert.equal((await nativeFor(account, siblingUrl)).id, siblingNative.id,
      'Another same-account queue still must not authorize pending-resource recovery');
  };

  if (process.argv.includes('--plain-pending-only')) {
    await assertPlainPendingGuard();
    passed = true;
    console.log('Pending-resource conversation load guard passed: a normal visible site error with native loading still pending is not rebuilt without its own queue.');
  } else if (process.argv.includes('--initial-only')) {
    assert.equal((await nativeFor(other, 'https://chatgpt.com/')).id, otherNative.id,
      'Initial semantic failure retains the independent profile document');
    assert.equal(await inPage(other, 'https://chatgpt.com/', "localStorage.getItem('fixture-profile-marker')"), 'retained');
    const cookies = await desktop.evaluate(({ session }, partition) =>
      session.fromPartition(partition).cookies.get({ name: 'fixture-profile' }), other.partition);
    assert.equal(cookies[0]?.value, 'retained');
    passed = true;
    console.log('Initial conversation load guard passed: a normal semantic failure stays visible until site Retry, does not send, and does not disturb another queued sibling or profile.');
  } else {
  await assertPlainPendingGuard();
  const skeleton = await open(account, skeletonUrl);
  await ready(account, skeleton.page.id, 'Skeleton fixture did not load');
  await settled(account, skeletonUrl);
  const skeletonHead = await addTask(account, skeleton.conversation, 'HOLD:skeleton queued turn before conversation load error');
  const skeletonNext = await addTask(account, skeleton.conversation, 'next after skeleton conversation retry');
  await until(async () => !!(await rpc('tasks.get', { id: skeletonHead.id })).submittedAt,
    'Skeleton queue head must have a confirmed receipt before recovery');
  const skeletonRequests = await requestCount(skeletonUrl);
  await inPage(account, skeletonUrl, 'window.fixtureConversationLoadError();');
  await faultObserved(skeleton.page.id);
  await inPage(account, skeletonUrl,
    "document.querySelector('main').innerHTML = '<div role=\"status\">正在加载对话…</div>';");
  await until(async () => (await rpc('tasks.get', { id: skeletonNext.id })).status === 'done',
    'A queued conversation whose Retry only leaves a loading skeleton must continue automatic recovery', 30000);
  assert.equal(await requestCount(skeletonUrl), skeletonRequests + 1,
    'An asynchronous skeleton is not healthy until the queued conversation has an editor again');
  assert.equal((await rpc('workspace.status')).page?.id, skeleton.page.id);
  assert.equal(await sends(account, skeletonUrl), 2,
    'Queued skeleton recovery sends the recorded head and successor exactly once');

  const restored = await open(account, restoredUrl);
  await ready(account, restored.page.id, 'Restored-draft fixture did not load');
  await settled(account, restoredUrl);
  const restoredNative = await nativeFor(account, restoredUrl);
  const restoredRequests = await requestCount(restoredUrl);
  await inPage(account, restoredUrl,
    "window.fixtureOriginalMainNodes = [...document.querySelector('main').childNodes]; window.fixtureConversationLoadError();");
  await new Promise(resolve => setTimeout(resolve, 4500));
  assert.equal((await nativeFor(account, restoredUrl)).id, restoredNative.id,
    'A normal restored page without its own queue is not rebuilt by semantic recovery');
  assert.equal(await requestCount(restoredUrl), restoredRequests,
    'A normal restored page without its own queue is not reloaded');
  const humanDraft = 'human draft entered after the site recovered';
  await inPage(account, restoredUrl, `
    document.querySelector('main').replaceChildren(...window.fixtureOriginalMainNodes);
    document.querySelector('#prompt-textarea').value = ${JSON.stringify(humanDraft)};
    document.querySelector('#prompt-textarea').dispatchEvent(new Event('input', { bubbles: true }));
  `);
  assert.equal(await inPage(account, restoredUrl, "document.querySelector('#prompt-textarea').value"), humanDraft,
    'A human draft entered after the site restored itself must survive without deferred recovery');
  assert.equal((await rpc('workspace.status')).page?.error, undefined);

  const queued = await rpc('conversations.register', { accountId: account.id, url: queuedUrl });
  const head = await addTask(account, queued, 'HOLD:confirmed send before conversation load error');
  const next = await addTask(account, queued, 'next after automatic conversation retry');
  await until(async () => !!(await rpc('tasks.get', { id: head.id })).submittedAt,
    'The queue head must have a confirmed receipt before its conversation fails');
  const headReceipt = await rpc('tasks.get', { id: head.id });
  assert.ok(headReceipt.submittedMessageId);
  const queuedPage = (await rpc('workspace.status')).pages.find(page => page.conversationId === queued.id);
  assert.ok(queuedPage);
  await rpc('accounts.switch', { id: other.id });
  const loadsBeforeError = await requestCount(queuedUrl);
  await inPage(account, queuedUrl, 'window.fixtureConversationLoadError();');
  await until(async () => (await rpc('tasks.get', { id: next.id })).status === 'done',
    'Background queue must recover the semantic conversation load error and advance to its next item', 30000);
  const recoveredHead = await rpc('tasks.get', { id: head.id });
  assert.equal(recoveredHead.status, 'done', recoveredHead.error);
  assert.equal(recoveredHead.submittedMessageId, headReceipt.submittedMessageId,
    'Conversation reload must retain the original submitted-message receipt');
  assert.equal(recoveredHead.submittedAt, headReceipt.submittedAt);
  assert.equal(await sends(account, queuedUrl), 2, 'The recorded head and successor are each sent exactly once');
  assert.deepEqual(await inPage(account, queuedUrl,
    "[...document.querySelectorAll('[data-message-author-role=user]')].map(node => node.textContent)"),
  ['HOLD:confirmed send before conversation load error', 'next after automatic conversation retry']);
  assert.equal(await requestCount(queuedUrl), loadsBeforeError + 1, 'Background semantic failure recovers with one same-URL retry');
  const backgroundState = await rpc('workspace.status');
  assert.equal(backgroundState.activeAccountId, other.id, 'Background recovery must not switch the visible account');
  const retainedQueuePage = backgroundState.pages.find(page => page.id === queuedPage.id);
  assert.equal(retainedQueuePage?.conversationId, queued.id);
  assert.equal(retainedQueuePage?.url, queuedUrl);
  assert.equal((await inspect(account, queuedPage.id)).readiness, 'ready');
  assert.equal((await nativeFor(account, siblingUrl)).id, siblingNative.id);
  assert.equal((await nativeFor(other, 'https://chatgpt.com/')).id, otherNative.id,
    'Another account keeps its healthy WebContents');
  assert.equal(await inPage(other, 'https://chatgpt.com/', "localStorage.getItem('fixture-profile-marker')"), 'retained');
  const cookies = await desktop.evaluate(({ session }, partition) =>
    session.fromPartition(partition).cookies.get({ name: 'fixture-profile' }), other.partition);
  assert.equal(cookies[0]?.value, 'retained', 'Automatic recovery must not clear account cookies');

  const canceled = await open(account, canceledUrl);
  await ready(account, canceled.page.id, 'Canceled-recovery fixture did not load');
  await settled(account, canceledUrl);
  const canceledHead = await addTask(account, canceled.conversation, 'HOLD:canceled before semantic recovery fires');
  const canceledNext = await addTask(account, canceled.conversation, 'must not send after canceled recovery');
  await until(async () => !!(await rpc('tasks.get', { id: canceledHead.id })).submittedAt,
    'Canceled-recovery queue head must have a receipt before the fault');
  const canceledRequests = await requestCount(canceledUrl);
  const canceledNative = await nativeFor(account, canceledUrl);
  await inPage(account, canceledUrl, 'window.fixtureConversationLoadError();');
  await faultObserved(canceled.page.id);
  await rpc('tasks.cancel', { id: canceledHead.id });
  await rpc('tasks.cancel', { id: canceledNext.id });
  await new Promise(resolve => setTimeout(resolve, 4500));
  assert.equal(await requestCount(canceledUrl), canceledRequests,
    'Canceling the queued tasks after a semantic fault cancels the pending recovery timer');
  assert.equal((await nativeFor(account, canceledUrl)).id, canceledNative.id,
    'Canceled semantic recovery leaves the original page visible for manual handling');
  assert.equal(await sends(account, canceledUrl), 1,
    'Canceled semantic recovery does not submit the queued successor');

  const paused = await open(account, pausedUrl);
  await ready(account, paused.page.id, 'Paused-recovery fixture did not load');
  await settled(account, pausedUrl);
  const pausedHead = await addTask(account, paused.conversation, 'HOLD:paused before semantic recovery fires');
  const pausedNext = await addTask(account, paused.conversation, 'must wait while semantic recovery is paused');
  await until(async () => !!(await rpc('tasks.get', { id: pausedHead.id })).submittedAt,
    'Paused-recovery queue head must have a receipt before the fault');
  const pausedRequests = await requestCount(pausedUrl);
  const pausedNative = await nativeFor(account, pausedUrl);
  await inPage(account, pausedUrl, 'window.fixtureConversationLoadError();');
  await faultObserved(paused.page.id);
  await rpc('queues.pause', { accountId: account.id, conversation: paused.conversation.id });
  await new Promise(resolve => setTimeout(resolve, 4500));
  assert.equal(await requestCount(pausedUrl), pausedRequests,
    'Pausing the conversation queue after a semantic fault cancels the pending recovery timer');
  assert.equal((await nativeFor(account, pausedUrl)).id, pausedNative.id,
    'Paused semantic recovery leaves the original page visible for manual handling');
  assert.equal((await rpc('tasks.get', { id: pausedNext.id })).status, 'pending',
    'Paused semantic recovery does not advance queued successors');

  const sole = await rpc('accounts.create', { name: 'Sole locked conversation' });
  await ready(sole, undefined, 'Sole-page fixture account did not load');
  const soleHome = (await rpc('workspace.status')).page;
  const soleConversation = await rpc('conversations.register', { accountId: sole.id, url: soleUrl });
  const soleHead = await addTask(sole, soleConversation, 'HOLD:confirmed receipt in sole live page');
  const soleNext = await addTask(sole, soleConversation, 'next after isolated connection reset');
  await until(async () => !!(await rpc('tasks.get', { id: soleHead.id })).submittedAt,
    'Sole queued page must hold a confirmed receipt before recovery');
  const soleReceipt = await rpc('tasks.get', { id: soleHead.id });
  await rpc('browser.closePage', { accountId: sole.id, pageId: soleHome.id });
  const solePages = (await rpc('workspace.status')).pages.filter(page => page.accountId === sole.id);
  assert.equal(solePages.length, 1, 'The damaged queued tab must be this account\'s sole live page');
  assert.equal(solePages[0].locked, true);
  await rpc('accounts.switch', { id: other.id });
  const resetBefore = await connectionResets(sole);
  await inPage(sole, soleUrl, 'window.fixtureConversationLoadError();');
  await until(async () => (await rpc('tasks.get', { id: soleNext.id })).status === 'done',
    'A sole locked queued page must reset its connection pool and continue without replaying its head', 30000);
  assert.equal(await connectionResets(sole), resetBefore + 1,
    'A semantic failure in a sole queued tab allows a same-account connection reset');
  assert.equal((await rpc('tasks.get', { id: soleHead.id })).submittedMessageId, soleReceipt.submittedMessageId);
  assert.equal((await rpc('tasks.get', { id: soleHead.id })).submittedAt, soleReceipt.submittedAt);
  assert.equal((await rpc('tasks.get', { id: soleHead.id })).status, 'done');
  assert.equal(await sends(sole, soleUrl), 2, 'A connection reset must not replay a confirmed queue head');
  assert.equal((await rpc('workspace.status')).activeAccountId, other.id);
  assert.equal((await nativeFor(account, siblingUrl)).id, siblingNative.id);
  assert.equal((await nativeFor(other, 'https://chatgpt.com/')).id, otherNative.id);

  // A reply may quote the exact error and a retry button. Even without a composer,
  // message content is not the page-level failure card.
  const quoted = await open(account, quoteUrl);
  await ready(account, quoted.page.id, 'Quoted-error fixture did not load');
  const quoteNative = await nativeFor(account, quoteUrl);
  const quoteRequests = await requestCount(quoteUrl);
  await inPage(account, quoteUrl, `
    document.querySelector('main').innerHTML = '<article><div data-message-author-role="assistant" data-message-id="quoted-error"><p>无法加载此 ChatGPT 对话</p><button onclick="location.reload()">重试</button></div></article>';
    const aside = document.createElement('aside'); aside.innerHTML = ${JSON.stringify(errorCard)}; document.body.append(aside);
    const hidden = document.createElement('div'); hidden.hidden = true; hidden.innerHTML = ${JSON.stringify(errorCard)}; document.querySelector('main').append(hidden);
  `);
  await new Promise(resolve => setTimeout(resolve, 4500));
  assert.equal(await requestCount(quoteUrl), quoteRequests,
    'A quoted assistant error, sidebar card and hidden card must not trigger recovery');
  assert.equal((await nativeFor(account, quoteUrl)).id, quoteNative.id,
    'False error matches must not recreate the conversation');
  assert.equal((await rpc('workspace.status')).page?.id, quoted.page.id);
  assert.equal((await rpc('workspace.status')).page?.error, undefined);
  assert.equal((await nativeFor(account, siblingUrl)).id, siblingNative.id);

  const repeatedConversation = await rpc('conversations.register', { accountId: account.id, url: repeatedUrl });
  const repeatedTask = await addTask(account, repeatedConversation, 'queued prompt after repeated conversation load errors');
  await until(async () => (await rpc('tasks.get', { id: repeatedTask.id })).status === 'done',
    'A queued recurring conversation load error must keep retrying beyond three failures without manual intervention', 45000);
  const repeated = { conversation: repeatedConversation,
    page: (await rpc('workspace.status')).pages.find(page => page.conversationId === repeatedConversation.id) };
  assert.ok(repeated.page);
  assert.equal(await requestCount(repeatedUrl), 5,
    'Four semantic error responses are followed by one successful same-conversation retry');
  await rpc('conversations.open', { accountId: account.id, conversation: repeated.conversation.id });
  const repeatedState = (await rpc('workspace.status')).page;
  assert.equal(repeatedState.id, repeated.page.id);
  assert.equal(repeatedState.url, repeatedUrl);
  assert.equal(repeatedState.conversationId, repeated.conversation.id);
  assert.equal(repeatedState.error, undefined);
  assert.equal(await sends(account, repeatedUrl), 1, 'Queued repeated page recovery sends its prompt once');
  assert.equal((await nativeFor(account, siblingUrl)).id, siblingNative.id,
    'Repeated failures must not reset healthy sibling pages');

  const compoundConversation = await rpc('conversations.register', { accountId: account.id, url: compoundUrl });
  const compoundTask = await addTask(account, compoundConversation, 'queued prompt after compound conversation recovery');
  await until(async () => (await rpc('tasks.get', { id: compoundTask.id })).status === 'done',
    'Four queued semantic failures followed by a native same-target load stall must continue automatic recovery', 100000);
  const compound = { conversation: compoundConversation,
    page: (await rpc('workspace.status')).pages.find(page => page.conversationId === compoundConversation.id) };
  assert.ok(compound.page);
  const compoundRequests = await requestCount(compoundUrl);
  assert.ok(compoundRequests >= 6,
    'The queued compound recovery reaches a healthy same-conversation request after semantic failures and a native stall');
  await rpc('conversations.open', { accountId: account.id, conversation: compound.conversation.id });
  const compoundState = (await rpc('workspace.status')).page;
  assert.equal(compoundState.id, compound.page.id);
  assert.equal(compoundState.url, compoundUrl);
  assert.equal(compoundState.error, undefined);
  assert.equal(await sends(account, compoundUrl), 1);
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(await requestCount(compoundUrl), compoundRequests,
    'A completed queued compound recovery stops retrying after the prompt is sent once');
  const compoundNative = await nativeFor(account, compoundUrl);
  await settled(account, compoundUrl);
  await desktop.evaluate(({ session, webContents }, { partition, id, url }) => {
    const isolated = session.fromPartition(partition);
    const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.id === id);
    if (!contents) throw new Error('Recovered native fixture is missing');
    void contents.loadURL(url).catch(() => {});
  }, { partition: account.partition, id: compoundNative.id, url: cappedNativeUrl });
  await until(async () => (await requestCount(cappedNativeUrl)) >= 4,
    'A new native target must receive its independent initial load plus three normal recovery attempts', 100000);
  // The final native request must reach its normal watchdog before asserting the cap.
  // This uses the product's default 20-second timeout, not a fixture-only fast path.
  await new Promise(resolve => setTimeout(resolve, 24000));
  assert.equal(await requestCount(cappedNativeUrl), 4,
    'A distinct native navigation after healthy semantic recovery retains the normal three-rebuild budget');
  const cappedState = (await rpc('workspace.status')).page;
  assert.equal(cappedState.id, compound.page.id, 'The capped native fault still retains the original logical tab');
  assert.ok(cappedState.error || cappedState.loading, 'A capped native fault stays recoverable in the UI');
  assert.equal((await nativeFor(account, siblingUrl)).id, siblingNative.id);
  await inPage(account, siblingUrl, 'window.fixtureFinish();');
  await until(async () => (await rpc('tasks.get', { id: siblingTask.id })).status === 'done',
    'Healthy sibling still completes after semantic-error recovery');

  passed = true;
  console.log('Conversation load recovery passed: settled semantic errors and async retry skeletons recover, restored drafts cancel deferred rebuilds, queued receipts survive page/isolated-connection recovery without replay, recurring failures and a same-target native stall continue automatically, a distinct native failure retains its normal cap, healthy profiles/siblings remain live, and quoted/sidebar/hidden errors are ignored.');
  }
} catch (error) {
  const state = await rpc('workspace.status').catch(failure => ({ error: String(failure) }));
  const runtimeLog = await readFile(path.join(directory, 'logs/runtime.jsonl'), 'utf8')
    .then(content => content.trim().split('\n').slice(-15).map(line => JSON.parse(line))).catch(() => []);
  const requests = await desktop?.evaluate(() => globalThis.fixtureRequests).catch(() => []);
  console.error(JSON.stringify({ pages: state.pages, tasks: state.tasks?.map(task => ({ id: task.id,
    status: task.status, error: task.error, submittedAt: task.submittedAt })), requests, runtimeLog }, null, 2));
  throw error;
} finally {
  try { if (desktop) await bounded(desktop.close(), 'Fixture shutdown', 10000); }
  catch { if (desktopPid) { try { process.kill(desktopPid); } catch {} } }
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root);
  assert.ok(path.basename(target).startsWith('.test-conversation-load-'));
  await rm(target, { recursive: true, force: true });
  if (!passed) process.exitCode = 1;
}
