import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

// This is an offline native-Electron integration regression, not a live ChatGPT
// network capture. Each account uses a temporary profile, HTTPS is served by an
// in-process fixture, and synthetic webRequest metadata is delivered through the
// actual listeners registered by BrowserRuntime. No request/response bodies,
// authentication tokens, external endpoints, or user profiles are inspected.
// A generic SSE cannot be correlated with a reply from metadata alone. Native
// failures only prompt DOM review: no-banner, healthy long-thinking turns must
// remain untouched. Reconnection requires the current visible fault card.
function fixtureDocument() {
  const key = 'reply-stream-fixture:' + location.pathname;
  const state = JSON.parse(localStorage.getItem(key) || 'null') || {
    messages: [], sent: [], busy: false, stalled: false, disconnected: false, live: false,
    ticks: 0, mounts: 0, stopClicks: 0,
  };
  state.mounts++;
  // Model a remote turn that survives the native document and resumes streaming
  // on reconnect. Reload never submits, finishes, or cancels that existing turn.
  if (state.disconnected) {
    state.stalled = false; state.disconnected = false;
    state.messages.at(-1).text += ' Reconnected existing server-side reply';
  }
  const main = document.querySelector('main');
  main.innerHTML = '<div id="turns"></div><form data-chatgpt-composer>' +
    '<div contenteditable="true" role="textbox" data-composer-markdown aria-label="询问 ChatGPT" style="min-height:40px"></div></form>';
  const turns = main.querySelector('#turns');
  const form = main.querySelector('form');
  const editor = form.querySelector('[contenteditable]');
  const save = () => localStorage.setItem(key, JSON.stringify(state));
  function controls() {
    form.querySelectorAll('button').forEach(button => button.remove());
    const button = document.createElement('button');
    button.type = state.busy ? 'button' : 'submit';
    button.setAttribute('aria-label', state.busy ? '停止' : '发送');
    button.textContent = state.busy ? 'Stop' : 'Send';
    button.onclick = event => {
      event.preventDefault();
      if (state.busy) { state.stopClicks++; save(); return; }
      send();
    };
    form.append(button);
  }
  function render() {
    turns.replaceChildren();
    for (const message of state.messages) {
      const turn = document.createElement('div');
      turn.dataset.turnKey = message.id;
      const messageNode = document.createElement('div');
      messageNode.dataset.chatgptSearchUnitKey = 'turn:' + message.id + ':0:' + message.role;
      messageNode.dataset.chatgptSearchMessageIds = message.id;
      const body = document.createElement('div');
      if (message.role === 'user') body.dataset.userMessageBubble = 'true';
      else body.dataset.chatgptSelectionMessageId = message.id;
      body.textContent = message.text;
      messageNode.append(body); turn.append(messageNode);
      if (message.role === 'assistant' && message.finished) {
        const actions = document.createElement('div');
        actions.className = 'turn-action-controls';
        const copy = document.createElement('button');
        copy.setAttribute('aria-label', '复制'); copy.textContent = 'Copy';
        actions.append(copy); turn.append(actions);
      }
      turns.append(turn);
    }
    if (state.disconnected) {
      const card = document.createElement('div');
      card.id = 'fixture-current-connection-fault'; card.setAttribute('role', 'status');
      const label = document.createElement('span');
      label.textContent = '连接已中断，正在等待完整答复'; card.append(label); turns.append(card);
    }
    save(); controls();
  }
  function finish() {
    state.busy = false; state.stalled = false; state.disconnected = false; state.live = false;
    if (state.messages.at(-1)?.role === 'assistant') {
      state.messages.at(-1).text ||= 'Fixture completed answer';
      state.messages.at(-1).finished = true;
    }
    render();
  }
  function send(text = editor.innerText) {
    if (state.busy || !text.trim()) throw new Error('Fixture cannot send while busy or empty');
    state.sent.push(text); editor.textContent = ''; state.busy = true;
    state.messages.push({ role: 'user', id: crypto.randomUUID(), text });
    state.messages.push({ role: 'assistant', id: crypto.randomUUID(), text: 'Existing partial answer', finished: false });
    render();
    if (!text.startsWith('HOLD:')) setTimeout(finish, 200);
  }
  form.onsubmit = event => { event.preventDefault(); send(); };
  editor.addEventListener('input', controls);
  window.fixtureSend = send;
  window.fixtureFinish = finish;
  window.fixtureLive = () => { state.live = true; save(); };
  window.fixtureStall = () => { state.stalled = true; save(); };
  window.fixtureDisconnect = () => { state.disconnected = true; render(); };
  window.fixtureDraft = text => { editor.textContent = text; controls(); };
  window.fixtureState = () => ({ ...state, draft: editor.innerText,
    stop: !!form.querySelector('button[aria-label="停止"]'),
    disconnectBanner: /连接已中断|Connection interrupted/.test(main.innerText) });
  render();
  setInterval(() => {
    if (state.busy && state.live && !state.stalled) {
      state.messages.at(-1).text += ' streamed output ' + ++state.ticks;
      render();
    }
  }, 700);
}

const fixture = '<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT stream fixture</title>' +
  '<style>[data-chatgpt-search-unit-key] { white-space:pre-wrap }</style></head><body><main></main>' +
  '<script>(' + fixtureDocument.toString() + ')();</script></body></html>';
const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-reply-stream-recovery-'));
const bootstrap = path.join(directory, 'fixture.cjs');
const mainEntry = process.env.WORKSPACE_TEST_MAIN_CJS || path.join(root, 'dist-electron/main.cjs');
await writeFile(bootstrap, `const { app, Notification } = require('electron');
Notification.isSupported = () => false;
globalThis.fixtureRequests = [];
globalThis.fixtureStreamListeners = new WeakMap();
globalThis.fixtureStreamId = 1000000;
app.on('browser-window-created', (_, win) => {
  win.webContents.setBackgroundThrottling(false); win.setSkipTaskbar(true);
  if (process.platform === 'win32') win.setPosition(-20000, -20000);
});
app.on('session-created', isolated => {
  const listeners = {};
  globalThis.fixtureStreamListeners.set(isolated, listeners);
  for (const event of ['onHeadersReceived', 'onCompleted', 'onErrorOccurred']) {
    const original = isolated.webRequest[event].bind(isolated.webRequest);
    isolated.webRequest[event] = (...args) => {
      listeners[event] = args.at(-1);
      return original(...args);
    };
  }
  isolated.protocol.handle('https', request => {
    globalThis.fixtureRequests.push(request.url);
    return new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  });
});
require(${JSON.stringify(mainEntry)});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory,
  WORKSPACE_PAGE_IDLE_MS: '3600000', WORKSPACE_HIDDEN_PAGE_IDLE_MS: '3600000' };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop, shell, desktopPid, passed = false;
function bounded(promise, label, ms = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
  })]).finally(() => clearTimeout(timer));
}
async function until(check, label, ms = 18000) {
  const deadline = Date.now() + ms;
  while (!await check()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rpc = (method, params = {}) => bounded(shell.evaluate(({ method, params }) =>
  window.workspace.call(method, params), { method, params }), method);
const contents = (account, url, script) => bounded(desktop.evaluate(async ({ session, webContents }, { partition, url, script }) => {
  const view = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.getURL() === url);
  if (!view) throw new Error('Fixture page missing: ' + url);
  return script ? view.mainFrame.executeJavaScript(script) : { id: view.id, url: view.getURL(),
    loading: view.isLoading(), waitingResponse: view.isWaitingForResponse() };
}, { partition: account.partition, url, script }), 'Fixture operation');
const state = (account, current) => contents(account, current.url,
  "typeof window.fixtureState === 'function' ? window.fixtureState() : null");
const requests = url => desktop.evaluate((_electron, url) => globalThis.fixtureRequests.filter(item => item === url).length, url);
const task = id => rpc('tasks.get', { id });
const inspect = (account, pageId) => rpc('browser.inspect', { accountId: account.id, pageId });
const add = (account, current, prompt) => rpc('tasks.create', { accountId: account.id,
  conversation: current.conversation.id, background: true, input: { type: 'prompt', prompt, submit: true } });
async function open(account, name) {
  await rpc('accounts.switch', { id: account.id });
  const url = 'https://chatgpt.com/c/stream-recovery-' + name;
  const conversation = await rpc('conversations.register', { accountId: account.id, url });
  const page = await rpc('conversations.open', { accountId: account.id, conversation: conversation.id });
  await until(async () => (await inspect(account, page.id)).readiness === 'ready', 'Fixture did not mount');
  return { url, page, conversation, native: await contents(account, url) };
}
async function inject(account, current, mode = 'reset') {
  return bounded(desktop.evaluate(({ session, webContents }, { partition, url, mode }) => {
    const isolated = session.fromPartition(partition);
    const view = webContents.getAllWebContents().find(item => item.session === isolated && item.getURL() === url);
    if (!view) throw new Error('Fixture stream owner missing');
    const listeners = globalThis.fixtureStreamListeners.get(isolated);
    if (!listeners?.onHeadersReceived || !listeners.onCompleted || !listeners.onErrorOccurred) {
      throw new Error('BrowserRuntime did not register all three native stream listeners');
    }
    const details = { id: ++globalThis.fixtureStreamId,
      // These offline fixture URLs assert no knowledge of live reply endpoints.
      url: 'https://chatgpt.com/offline-fixture/' + (mode === 'notification' ? 'background-notifications' : 'unidentified-events'),
      method: 'POST', webContentsId: view.id, webContents: view, initiatorOrigin: 'https://chatgpt.com',
      frame: mode === 'iframe' ? { parent: view.mainFrame, url } : view.mainFrame,
      resourceType: 'xhr', referrer: url, timestamp: Date.now(), statusCode: 200, statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'Content-Type': [mode === 'ordinary' ? 'application/json' : 'text/event-stream; charset=utf-8'] } };
    const responses = [];
    listeners.onHeadersReceived(details, response => responses.push(response));
    if (responses.length !== 1 || Object.keys(responses[0]).length) throw new Error('Passive observer changed original headers');
    if (mode === 'completed') listeners.onCompleted({ ...details, fromCache: false, error: '' });
    else listeners.onErrorOccurred({ ...details, fromCache: false,
      error: mode === 'aborted' ? 'net::ERR_ABORTED' : 'net::ERR_CONNECTION_RESET' });
    return { nativeId: view.id, unchangedResponse: true };
  }, { partition: account.partition, url: current.url, mode }), 'Native metadata injection');
}
async function mounted(account, current) {
  try {
    const native = await contents(account, current.url);
    if (native.loading || native.waitingResponse) return false;
    const latest = await state(account, current);
    return !!latest && latest.mounts === 2 && !latest.stalled;
  } catch (error) {
    if (/Fixture page missing|Fixture operation timed out|Execution context was destroyed|frame was disposed|Render frame was disposed|Object has been destroyed/i.test(String(error))) return false;
    throw error;
  }
}
async function retained(account, current, prompt) {
  const page = (await rpc('workspace.status')).pages.find(item => item.id === current.page.id);
  assert.equal(page?.accountId, account.id);
  assert.equal(page?.conversationId, current.conversation.id);
  assert.equal(page?.url, current.url);
  const latest = await state(account, current);
  assert.equal(latest.stopClicks, 0, 'Reconnect never clicks Stop');
  assert.equal(latest.stop, true, 'Remote task remains busy after reconnect');
  assert.equal(latest.disconnectBanner, false, 'The confirmed current fault clears after reconnect');
  assert.deepEqual(latest.sent, [prompt], 'Original submitted turn is never replayed');
  assert.equal(latest.mounts, 2);
}
async function visible(account, current) {
  const workspace = await rpc('workspace.status');
  assert.equal(workspace.page?.id, current.page.id);
  assert.equal(workspace.page?.error, undefined, 'The current body is not covered by a loading error');
  assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => {
    const native = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
      .find(view => view.webContents?.id === id);
    return native?.getVisible();
  }, (await contents(account, current.url)).id), true, 'Native output remains visible');
}
async function outputResumed(account, current) {
  const before = (await state(account, current)).messages.at(-1).text;
  await until(async () => {
    const latest = await state(account, current);
    return latest.messages.at(-1).text !== before && latest.ticks > 0;
  }, 'Reconnected assistant body must resume real fixture text', 5000);
}
try {
  desktop = await electron.launch({ args: ['--no-sandbox', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', bootstrap], env });
  desktopPid = desktop.process()?.pid;
  shell = await bounded(desktop.firstWindow(), 'Workspace window');
  await bounded(shell.waitForFunction(() => !!window.workspace), 'Workspace bridge');
  const account = await rpc('accounts.create', { name: 'Offline native stream regression' });
  await until(async () => (await inspect(account)).readiness === 'ready', 'Primary fixture did not load');
  const other = await rpc('accounts.create', { name: 'Healthy isolated stream profile' });
  await until(async () => (await inspect(other)).readiness === 'ready', 'Other fixture did not load');
  const healthy = await open(other, 'healthy-other-account');
  await contents(other, healthy.url, "window.fixtureSend('HOLD:healthy independent reply'); window.fixtureLive(); localStorage.setItem('isolation-marker', 'retained')");
  const negatives = [];
  for (const mode of ['completed', 'aborted', 'iframe', 'ordinary', 'notification', 'reset']) {
    const current = await open(account, mode);
    await contents(account, current.url, "window.fixtureSend('HOLD:negative metadata case')");
    await inject(account, current, mode);
    negatives.push(current);
  }
  const oldTurn = await open(account, 'previous-turn-failure');
  await contents(account, oldTurn.url, "window.fixtureSend('HOLD:previous turn with unrelated stream failure')");
  await inject(account, oldTurn);
  await contents(account, oldTurn.url, "window.fixtureFinish(); window.fixtureSend('HOLD:new healthy long-thinking turn')");
  negatives.push(oldTurn);
  const progressing = await open(account, 'growing-body');
  await contents(account, progressing.url, "window.fixtureSend('HOLD:genuine body progress'); window.fixtureLive(); window.fixtureDisconnect()");
  await inject(account, progressing);
  const growingBefore = (await state(account, progressing)).messages.at(-1).text;
  const draft = await open(account, 'unsent-draft');
  const draftPrompt = 'HOLD:keep existing turn and human draft';
  const humanDraft = 'Unsent human text must stay editable during the stream failure';
  await contents(account, draft.url, 'window.fixtureSend(' + JSON.stringify(draftPrompt) + '); window.fixtureStall(); window.fixtureDisconnect(); window.fixtureDraft(' + JSON.stringify(humanDraft) + ')');
  await inject(account, draft);

  // Exceed the six-second stability window with no assistant growth. Even a
  // successful unknown SSE followed by a transport error is insufficient proof
  // that a visible busy turn needs recovery; it could be a notification stream.
  await sleep(12000);
  for (const current of [...negatives, progressing, draft]) {
    assert.equal(await requests(current.url), 1, 'Unknown/no-banner, cross-turn, progress and draft cases must not refresh: ' + current.url);
    assert.equal((await contents(account, current.url)).id, current.native.id);
    assert.equal((await state(account, current)).stop, true);
    assert.equal((await state(account, current)).stopClicks, 0);
  }
  for (const current of negatives) {
    assert.equal((await state(account, current)).disconnectBanner, false);
    assert.equal((await inspect(account, current.page.id)).loadFailure, undefined,
      'Unidentified stream failure cannot fabricate a current reply failure');
  }
  assert.deepEqual((await state(account, oldTurn)).sent,
    ['HOLD:previous turn with unrelated stream failure', 'HOLD:new healthy long-thinking turn'],
    'A prior stream fault does not become a failure on a new busy turn');

  const ordinary = await open(account, 'manual-without-queue');
  const ordinaryPrompt = 'HOLD:manual reply without queue';
  await contents(account, ordinary.url, 'window.fixtureSend(' + JSON.stringify(ordinaryPrompt) + '); window.fixtureLive(); window.fixtureStall(); window.fixtureDisconnect()');
  assert.equal((await state(account, ordinary)).disconnectBanner, true);
  await inject(account, ordinary);
  await sleep(3500);
  assert.equal(await requests(ordinary.url), 1, 'An interrupted transport must respect the stability interval');
  await visible(account, ordinary);
  await until(async () => await requests(ordinary.url) === 2 && await mounted(account, ordinary),
    'Native stream metadata plus a confirmed current reply fault reconnects the manual turn', 16000);
  await retained(account, ordinary, ordinaryPrompt);
  assert.notEqual((await contents(account, ordinary.url)).id, ordinary.native.id, 'The damaged native view is rebuilt');
  await outputResumed(account, ordinary);
  await visible(account, ordinary);
  assert.equal((await rpc('workspace.status')).tasks.filter(item => item.conversationId === ordinary.conversation.id).length, 0,
    'Manual reply recovery creates no queue tasks');
  for (const current of [...negatives, progressing, draft]) {
    assert.equal(await requests(current.url), 1, 'Healthy/aborted/subframe/ordinary/progress/draft case cannot reload: ' + current.url);
    assert.equal((await contents(account, current.url)).id, current.native.id);
    assert.equal((await state(account, current)).stopClicks, 0);
  }
  assert.notEqual((await state(account, progressing)).messages.at(-1).text, growingBefore,
    'Continuously growing assistant text defers a stale transport hint');
  assert.equal((await state(account, draft)).draft, humanDraft, 'Unsent human draft is preserved');
  await rpc('conversations.open', { accountId: account.id, conversation: draft.conversation.id });
  await visible(account, draft);
  assert.equal((await inspect(account, draft.page.id)).draftLength, humanDraft.length);
  await contents(account, draft.url, "window.fixtureDraft(''); window.fixtureLive()");
  await until(async () => await requests(draft.url) === 2 && await mounted(account, draft),
    'Clearing an unsent draft permits a deferred native reconnect');
  await retained(account, draft, draftPrompt);
  await outputResumed(account, draft);
  for (const current of [...negatives, progressing, draft, ordinary]) {
    await contents(account, current.url, 'window.fixtureFinish()');
  }

  const queued = await open(account, 'submitted-with-successor');
  const queuedPrompt = 'HOLD:confirmed queued original turn';
  const head = await add(account, queued, queuedPrompt);
  const next = await add(account, queued, 'Send next only after the server task actually finishes');
  await until(async () => !!(await task(head.id)).submittedAt, 'Queue head needs its persisted send receipt');
  const receipt = await task(head.id);
  assert.ok(receipt.submittedMessageId);
  assert.ok(receipt.sendReceipt);
  await rpc('accounts.switch', { id: other.id });
  await contents(account, queued.url, 'window.fixtureLive(); window.fixtureStall(); window.fixtureDisconnect()');
  await inject(account, queued);
  await until(async () => await requests(queued.url) === 2 && await mounted(account, queued),
    'A background queued turn reconnects only with current DOM connection evidence', 18000);
  await retained(account, queued, queuedPrompt);
  await outputResumed(account, queued);
  await sleep(3200);
  assert.equal((await task(next.id)).submittedAt, undefined, 'Reconnection does not advance the queue while Stop is still visible');
  const continuing = await task(head.id);
  assert.equal(continuing.submittedAt, receipt.submittedAt);
  assert.equal(continuing.submittedMessageId, receipt.submittedMessageId);
  assert.deepEqual(continuing.sendReceipt, receipt.sendReceipt, 'Rebuilding retains the full original send receipt');
  assert.ok(['pending', 'running'].includes(continuing.status), 'The queue head remains active during server work');
  await contents(account, queued.url, 'window.fixtureFinish()');
  await until(async () => (await task(next.id)).status === 'done', 'Real server completion releases the successor exactly once', 30000);
  assert.equal((await task(head.id)).status, 'done');
  assert.deepEqual((await state(account, queued)).sent,
    [queuedPrompt, 'Send next only after the server task actually finishes']);
  assert.equal((await rpc('workspace.status')).activeAccountId, other.id, 'Background recovery preserves selected account');
  assert.equal((await contents(other, healthy.url)).id, healthy.native.id, 'A healthy sibling account retains its native view');
  assert.equal(await requests(healthy.url), 1, 'A healthy sibling account is never refreshed');
  const healthyState = await state(other, healthy);
  assert.equal(healthyState.stop, true);
  assert.ok(healthyState.ticks > 0, 'Healthy sibling output keeps streaming');
  assert.equal(await contents(other, healthy.url, "localStorage.getItem('isolation-marker')"), 'retained');
  await contents(other, healthy.url, 'window.fixtureFinish()');
  await sleep(1800);
  assert.equal(await requests(queued.url), 2, 'Recovered output cannot enter a reload loop after completion');
  passed = true;
  console.log('Reply stream recovery desktop passed: actual session listeners accept offline SSE metadata; unidentified/notification failures and prior-turn faults never refresh healthy no-banner long-thinking replies; confirmed current connection faults reconnect and resume text; completion/abort/iframe/ordinary/progress/draft guards, original receipts, busy queues and isolated healthy accounts remain intact. This verifies conservative native API integration, not live ChatGPT traffic or reply endpoint attribution.');
} catch (error) {
  const workspace = shell && await rpc('workspace.status').catch(failure => ({ error: String(failure) }));
  const runtimeLog = await readFile(path.join(directory, 'logs/runtime.jsonl'), 'utf8')
    .then(content => content.trim().split('\n').slice(-20).map(line => JSON.parse(line))).catch(() => []);
  console.error(JSON.stringify({ pages: workspace?.pages, tasks: workspace?.tasks?.map(item => ({
    prompt: item.input.prompt, status: item.status, phase: item.phase, error: item.error, submittedAt: item.submittedAt,
  })), requests: await desktop?.evaluate(() => globalThis.fixtureRequests).catch(() => []), runtimeLog }, null, 2));
  throw error;
} finally {
  try { if (desktop) await bounded(desktop.close(), 'Fixture shutdown', 10000); }
  catch { if (desktopPid) { try { process.kill(desktopPid); } catch {} } }
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root);
  assert.ok(path.basename(target).startsWith('.test-reply-stream-recovery-'));
  await rm(target, { recursive: true, force: true });
  if (!passed) process.exitCode = 1;
}
