import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

// Every document, message and account in this regression is an offline fixture.
// Unlike the stopped-reply fixture, the interrupted card retains a visible Stop.
function fixtureDocument() {
  const modern = location.pathname.endsWith('-modern');
  const key = 'disconnected-reply:' + location.pathname;
  // The live modern status uses 答复, with no streaming test attribute.
  // Keep the older 回复 wording and data-is-streaming schema independently.
  const label = modern ? '连接已中断，正在等待完整答复' : '连接已中断，正在等待完整回复';
  let state = JSON.parse(localStorage.getItem(key) || 'null') || {
    messages: [], sent: [], busy: false, disconnected: false, remaining: 0, stopClicks: 0,
  };
  const main = document.querySelector('main');
  main.innerHTML = '<div id="turns"></div>' + (modern
    ? '<form data-chatgpt-composer><div contenteditable="true" role="textbox" data-composer-markdown aria-label="询问 ChatGPT" style="min-height:40px"></div></form>'
    : '<textarea id="prompt-textarea"></textarea><div id="controls"></div>');
  const editor = main.querySelector(modern ? '[contenteditable]' : 'textarea');
  const controls = main.querySelector(modern ? 'form' : '#controls');
  const turns = main.querySelector('#turns');
  const save = () => localStorage.setItem(key, JSON.stringify(state));
  const draft = () => modern ? editor.innerText : editor.value;
  const setDraft = text => { if (modern) editor.textContent = text; else editor.value = text; control(); };
  function card() {
    const node = document.createElement('div');
    node.id = 'fixture-disconnected';
    if (modern) {
      node.setAttribute('role', 'status');
      const status = document.createElement('span'); status.textContent = label; node.append(status);
    } else {
      node.dataset.isStreaming = 'true'; node.textContent = label;
    }
    return node;
  }
  function render() {
    turns.replaceChildren();
    for (const message of state.messages) {
      const turn = document.createElement(modern ? 'div' : 'article');
      turn.dataset.turnKey = message.id;
      const text = document.createElement('div');
      if (modern) {
        text.dataset.chatgptSearchUnitKey = 'turn:' + message.id + ':0:' + message.role;
        text.dataset.chatgptSearchMessageIds = message.id;
        const body = document.createElement('div');
        if (message.role === 'user') body.dataset.userMessageBubble = 'true';
        else body.dataset.chatgptSelectionMessageId = message.id;
        body.textContent = message.text; text.append(body);
      } else {
        text.dataset.messageAuthorRole = message.role;
        text.dataset.messageId = message.id; text.textContent = message.text;
      }
      if (message.quoted) {
        const quote = document.createElement('blockquote');
        const p = document.createElement('p'); p.textContent = label; quote.append(p); text.append(quote);
      }
      if (message.userQuote) (modern ? text.querySelector('[data-user-message-bubble]') : text).append(card());
      turn.append(text);
      if (message.finished && message.role === 'assistant') {
        const actions = document.createElement('div'); actions.className = 'turn-action-controls';
        const copy = document.createElement('button'); copy.setAttribute('aria-label', '复制');
        if (!modern) copy.dataset.testid = 'copy-turn-action-button';
        copy.textContent = 'Copy'; actions.append(copy); turn.append(actions);
      }
      if (message.historical) turn.append(card());
      turns.append(turn);
    }
    if (state.disconnected) turns.append(card());
    save(); control();
  }
  function control() {
    controls.querySelectorAll('button').forEach(button => button.remove());
    const button = document.createElement('button');
    button.type = state.busy ? 'button' : modern ? 'submit' : 'button';
    button.setAttribute('aria-label', state.busy ? '停止' : '发送');
    if (!modern) button.dataset.testid = state.busy ? 'stop-button' : 'send-button';
    button.textContent = state.busy ? 'Stop' : 'Send';
    button.onclick = event => {
      event.preventDefault();
      if (state.busy) { state.stopClicks++; save(); return; }
      send();
    };
    controls.append(button);
  }
  function finish() {
    state.disconnected = false; state.busy = false;
    if (state.messages.at(-1)?.role === 'assistant') {
      state.messages.at(-1).text ||= 'Fixture completed reply'; state.messages.at(-1).finished = true;
    }
    render();
  }
  function send(text = draft()) {
    if (state.busy || !text.trim()) throw new Error('Fixture rejected send while busy or empty');
    state.sent.push(text); setDraft(''); state.busy = true;
    state.messages.push({ role: 'user', id: crypto.randomUUID(), text });
    state.messages.push({ role: 'assistant', id: crypto.randomUUID(), text: '', finished: false });
    render();
    if (!text.startsWith('HOLD:')) setTimeout(finish, 200);
  }
  if (modern) controls.onsubmit = event => { event.preventDefault(); send(); };
  editor.addEventListener('input', control);
  // A native refresh/rebuild resumes the existing server-side turn. The Stop
  // remains until fixtureFinish, so merely reloading cannot release the queue.
  if (state.disconnected && state.remaining > 0) {
    state.remaining--;
    if (!state.remaining) {
      state.disconnected = false;
      state.messages.at(-1).text = 'Fixture reconnected reply, still generating';
    }
  }
  render();
  window.fixtureSend = send;
  window.fixtureFinish = finish;
  window.fixtureSetDraft = setDraft;
  window.fixtureDisconnect = (reloads = 1) => {
    state.disconnected = true; state.remaining = reloads; render();
  };
  window.fixtureReconnect = () => { state.disconnected = false; state.remaining = 0; render(); };
  window.fixtureProgress = () => { state.messages.at(-1).text += ' more real response text'; render(); };
  window.fixtureVolatileTicker = () => {
    // Site timers belong to the turn chrome, outside the real assistant body.
    // They must not count as reply progress and postpone reconnect forever.
    const clock = document.createElement('span'); clock.id = 'fixture-reply-clock';
    [...turns.querySelectorAll('[data-turn-key]')].at(-1).append(clock);
    window.fixtureTickerTicks = 0;
    setInterval(() => { clock.textContent = 'Elapsed ticks: ' + ++window.fixtureTickerTicks; }, 700);
  };
  window.fixtureQuoteAndHistory = () => {
    state.messages.unshift({ role: 'user', id: crypto.randomUUID(), text: 'Historical turn' },
      { role: 'assistant', id: crypto.randomUUID(), text: 'Historical answer', finished: true, historical: true });
    state.messages.filter(message => message.role === 'user').at(-1).userQuote = true;
    state.messages.at(-1).quoted = true; render();
    const sidebar = document.createElement('aside'); sidebar.append(card()); document.body.append(sidebar);
    const hidden = card(); hidden.hidden = true; turns.append(hidden);
  };
  window.fixtureState = () => {
    const marker = turns.querySelector('#fixture-disconnected');
    const stop = controls.querySelector(modern ? 'button[aria-label="停止"]' : '[data-testid="stop-button"]');
    return { ...state, draft: draft(), marker: !!marker, stop: !!stop,
      fault: marker && { label: marker.textContent, role: marker.getAttribute('role'),
        streaming: marker.getAttribute('data-is-streaming'), span: marker.querySelector('span')?.textContent ?? null,
        inMessage: !!marker.closest('[data-message-author-role], [data-chatgpt-search-unit-key], [data-user-message-bubble]'),
        inQuote: !!marker.closest('pre, code, blockquote'), hidden: !marker.getClientRects().length,
        stopLabel: stop?.getAttribute('aria-label'), stopTestId: stop?.getAttribute('data-testid'),
        stopVisible: !!stop?.getClientRects().length } };
  };
}
const fixture = '<!doctype html><html><head><meta charset="utf-8"><title>Disconnected reply fixture</title>' +
  '<style>[data-message-author-role], [data-chatgpt-search-unit-key] { white-space: pre-wrap; }</style>' +
  '</head><body><main></main><script>(' + fixtureDocument.toString() + ')();</script></body></html>';
const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-disconnected-reply-'));
const bootstrap = path.join(directory, 'fixture.cjs');
const mainEntry = process.env.WORKSPACE_TEST_MAIN_CJS || path.join(root, 'dist-electron/main.cjs');
await writeFile(bootstrap, `const { app, Notification } = require('electron');
Notification.isSupported = () => false;
globalThis.fixtureRequests = [];
app.on('browser-window-created', (_, win) => {
  win.webContents.setBackgroundThrottling(false); win.setSkipTaskbar(true);
  if (process.platform === 'win32') win.setPosition(-20000, -20000);
});
app.on('session-created', isolated => isolated.protocol.handle('https', request => {
  globalThis.fixtureRequests.push(request.url);
  return new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
}));
require(${JSON.stringify(mainEntry)});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory,
  WORKSPACE_PAGE_IDLE_MS: '3600000', WORKSPACE_HIDDEN_PAGE_IDLE_MS: '3600000' };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop, shell, desktopPid, passed = false;
function bounded(promise, label, ms = 12000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  })]).finally(() => clearTimeout(timer));
}
async function until(check, label, ms = 16000) {
  const deadline = Date.now() + ms;
  while (!await check()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const rpc = (method, params = {}) => bounded(shell.evaluate(({ method, params }) =>
  window.workspace.call(method, params), { method, params }), method);
const contents = (account, url, script) => bounded(desktop.evaluate(async ({ session, webContents }, { partition, url, script }) => {
  const view = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.getURL() === url);
  if (!view) throw new Error(`Fixture page missing: ${url}`);
  return script ? view.mainFrame.executeJavaScript(script) : { id: view.id, url: view.getURL(),
    loading: view.isLoading(), waitingResponse: view.isWaitingForResponse() };
}, { partition: account.partition, url, script }), 'Fixture operation');
const requests = url => desktop.evaluate((_electron, url) => globalThis.fixtureRequests.filter(item => item === url).length, url);
const state = (account, url) => contents(account, url,
  "typeof window.fixtureState === 'function' ? window.fixtureState() : null");
async function reconnected(account, url) {
  try {
    const native = await contents(account, url);
    if (native.loading || native.waitingResponse) return false;
    const current = await state(account, url);
    return !!current && !current.disconnected;
  } catch (error) {
    // A request is observed before Chromium finishes mounting the replacement
    // native frame. Retry that gap without hiding unrelated fixture failures.
    if (/Fixture page missing|Fixture operation timed out|Execution context was destroyed|frame was disposed|Render frame was disposed|Object has been destroyed/i.test(String(error))) return false;
    throw error;
  }
}
const task = id => rpc('tasks.get', { id });
const inspect = (account, pageId) => rpc('browser.inspect', { accountId: account.id, pageId });
async function open(account, name) {
  await rpc('accounts.switch', { id: account.id });
  const url = 'https://chatgpt.com/c/disconnected-' + name;
  const conversation = await rpc('conversations.register', { accountId: account.id, url });
  const page = await rpc('conversations.open', { accountId: account.id, conversation: conversation.id });
  await until(async () => (await inspect(account, page.id)).readiness === 'ready', 'Fixture did not mount');
  return { conversation, page, url, native: await contents(account, url) };
}
const add = (account, conversation, prompt) => rpc('tasks.create', { accountId: account.id, conversation: conversation.id,
  background: true, input: { type: 'prompt', prompt, submit: true } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function retained(account, original) {
  const page = (await rpc('workspace.status')).pages.find(item => item.id === original.page.id);
  assert.equal(page?.accountId, account.id, 'Recovery retains the account');
  assert.equal(page?.conversationId, original.conversation.id, 'Recovery retains the conversation');
  assert.equal(page?.url, original.url, 'Recovery retains the original URL');
  assert.equal((await state(account, original.url)).stopClicks, 0, 'Recovery never clicks Stop');
}
async function exactDisconnect(account, current, mode) {
  const modern = mode === 'modern';
  const label = modern ? '连接已中断，正在等待完整答复' : '连接已中断，正在等待完整回复';
  const disconnected = await state(account, current.url);
  assert.equal(disconnected.stop, true, 'The observed fault retains its visible Stop');
  assert.deepEqual(disconnected.fault, { label, role: modern ? 'status' : null,
    streaming: modern ? null : 'true', span: modern ? label : null, inMessage: false, inQuote: false,
    hidden: false, stopLabel: '停止', stopTestId: modern ? null : 'stop-button', stopVisible: true },
    'The fixture reproduces the exact status card and Stop controls before recovery');
}
async function editableDraft(account, current, humanDraft) {
  assert.equal(await requests(current.url), 1, 'A human draft defers native recovery');
  assert.equal((await contents(account, current.url)).id, current.native.id);
  assert.equal((await state(account, current.url)).draft, humanDraft, 'A nonempty composer draft is preserved');
  const selected = (await rpc('workspace.status')).page;
  assert.equal(selected?.id, current.page.id, 'The human draft remains on the selected conversation');
  assert.equal(selected?.error, undefined, 'Draft-held recovery keeps the conversation editable instead of covering it with a page error');
  assert.equal((await inspect(account, current.page.id)).draftLength, humanDraft.length);
  assert.equal(await desktop.evaluate(({ BrowserWindow }, nativeId) => {
    const native = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
      .find(view => view.webContents?.id === nativeId);
    return native?.getVisible();
  }, current.native.id), true, 'The selected native composer remains visible and accessible');
}
async function submittedRecovery(account, other, mode) {
  const submitted = await open(account, 'submitted-' + mode);
  const head = await add(account, submitted.conversation, 'HOLD:confirmed original queued turn');
  const next = await add(account, submitted.conversation, 'Successor after queued reconnect');
  await until(async () => !!(await task(head.id)).submittedAt, 'Queue head needs a send receipt');
  const receipt = await task(head.id);
  assert.ok(receipt.submittedMessageId);
  assert.ok(receipt.sendReceipt, 'The original turn has a persisted complete send receipt');
  assert.equal(receipt.sendReceipt.url, submitted.url);
  assert.ok(Array.isArray(receipt.sendReceipt.users));
  await rpc('accounts.switch', { id: other.id });
  await contents(account, submitted.url, 'window.fixtureDisconnect()');
  await exactDisconnect(account, submitted, mode);
  await until(async () => await requests(submitted.url) === 2, 'A background submitted reply must automatically reconnect', 14000);
  await until(() => reconnected(account, submitted.url), 'Submitted head did not reconnect');
  assert.equal((await inspect(account, submitted.page.id)).busy, true, 'The reconnected submitted reply remains busy');
  await sleep(3200);
  assert.equal((await task(next.id)).status, 'pending', 'Submitted head holds its successor while resumed reply is busy');
  const reconnectingHead = await task(head.id);
  assert.ok(['pending', 'running'].includes(reconnectingHead.status),
    'A submitted head remains active while the gateway reattaches to the replacement native view');
  assert.equal(reconnectingHead.submittedAt, receipt.submittedAt);
  assert.equal(reconnectingHead.submittedMessageId, receipt.submittedMessageId);
  assert.deepEqual(reconnectingHead.sendReceipt, receipt.sendReceipt);
  assert.deepEqual((await state(account, submitted.url)).sent, ['HOLD:confirmed original queued turn']);
  await retained(account, submitted);
  await contents(account, submitted.url, 'window.fixtureFinish()');
  await until(async () => (await task(next.id)).status === 'done', 'Reconnected submitted head must complete and advance', 30000);
  const recovered = await task(head.id);
  assert.equal(recovered.status, 'done', recovered.error);
  assert.equal(recovered.submittedAt, receipt.submittedAt);
  assert.equal(recovered.submittedMessageId, receipt.submittedMessageId);
  assert.deepEqual(recovered.sendReceipt, receipt.sendReceipt, 'Rebuild preserves the original complete receipt');
  assert.deepEqual((await state(account, submitted.url)).sent,
    ['HOLD:confirmed original queued turn', 'Successor after queued reconnect']);
  assert.equal((await rpc('workspace.status')).activeAccountId, other.id, 'Background reconnect retains the selected account');
}
try {
  desktop = await electron.launch({ args: ['--no-sandbox', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', bootstrap], env });
  desktopPid = desktop.process()?.pid;
  shell = await bounded(desktop.firstWindow(), 'Workspace window');
  await bounded(shell.waitForFunction(() => !!window.workspace), 'Workspace bridge');
  const account = await rpc('accounts.create', { name: 'Disconnected reply regression' });
  await until(async () => (await inspect(account)).readiness === 'ready', 'Account fixture did not load');
  if (process.argv.includes('--draft-only')) {
    const draft = await open(account, 'human-draft-legacy');
    const humanDraft = 'Unsent human draft must remain editable during reconnect';
    await contents(account, draft.url, "window.fixtureSend('HOLD:focused draft'); window.fixtureDisconnect(); window.fixtureSetDraft(" + JSON.stringify(humanDraft) + ')');
    await sleep(10500);
    await editableDraft(account, draft, humanDraft);
    await contents(account, draft.url, "window.fixtureSetDraft('')");
    await until(async () => await requests(draft.url) === 2, 'Clearing the draft permits deferred recovery', 14000);
    await until(() => reconnected(account, draft.url), 'Deferred recovery mounts the original reply');
    await retained(account, draft);
    passed = true;
    console.log('Disconnected reply draft hold passed: selected PageState has no blocking error, native composer remains visible, draft is preserved, and clearing it permits reconnect.');
  } else if (process.argv.includes('--receipt-only')) {
    const other = await rpc('accounts.create', { name: 'Independent receipt profile' });
    await until(async () => (await inspect(other)).readiness === 'ready', 'Independent profile did not load');
    for (const mode of ['legacy', 'modern']) await submittedRecovery(account, other, mode);
    passed = true;
    console.log('Disconnected reply receipt recovery passed: legacy 完整回复 and modern 完整答复 status faults preserve original receipts across rebuild, actual busy holds successors, and each prompt is sent once.');
  } else {
    const other = await rpc('accounts.create', { name: 'Healthy independent profile' });
    await until(async () => (await inspect(other)).readiness === 'ready', 'Other account fixture did not load');
    const otherNative = await contents(other, 'https://chatgpt.com/');
    await contents(other, 'https://chatgpt.com/', "localStorage.setItem('isolated-marker', 'retained')");
    const sibling = await open(account, 'healthy-sibling');
    const siblingTask = await add(account, sibling.conversation, 'HOLD:healthy sibling');
    await until(async () => !!(await task(siblingTask.id)).submittedAt, 'Healthy sibling did not start');

    for (const mode of ['legacy', 'modern']) {
      const manual = await open(account, 'manual-' + mode);
      await contents(account, manual.url, "window.fixtureSend('HOLD:manual previous turn')");
      const next = await add(account, manual.conversation, 'Next after manual reconnect ' + mode);
      await until(async () => (await task(next.id)).phase === 'waiting_idle', 'Manual prior turn must hold the queue');
      await contents(account, manual.url, 'window.fixtureDisconnect()');
      if (mode === 'legacy') await contents(account, manual.url, 'window.fixtureVolatileTicker()');
      await exactDisconnect(account, manual, mode);
      const disconnected = await inspect(account, manual.page.id);
      assert.equal(disconnected.loadFailure, 'reply_connection', 'Reply disconnection is a recoverable page fault');
      assert.equal(disconnected.busy, true, 'Recognizing the fault does not force the reply idle');
      await sleep(4000);
      assert.equal(await requests(manual.url), 1, 'A disconnected marker must remain stable before recovery');
      if (mode === 'legacy') assert.ok(await contents(account, manual.url, 'window.fixtureTickerTicks >= 4'),
        'The fixture clock keeps changing outside the actual assistant body');
      await until(async () => await requests(manual.url) === 2,
        'A stable disconnected reply with Stop must automatically reload the same tab', 14000);
      await until(() => reconnected(account, manual.url), 'Reload must reconnect the existing reply');
      assert.notEqual((await contents(account, manual.url)).id, manual.native.id, 'Automatic recovery rebuilds the damaged native view');
      assert.equal((await inspect(account, manual.page.id)).busy, true, 'A resumed reply is still actually generating');
      await sleep(3200);
      const waitingManual = await task(next.id);
      assert.ok(['pending', 'running'].includes(waitingManual.status), 'The queue remains active during reconnect');
      assert.equal(waitingManual.submittedAt, undefined, 'Queue waits for the real reply to finish after reconnect');
      assert.deepEqual((await state(account, manual.url)).sent, ['HOLD:manual previous turn']);
      await retained(account, manual);
      await contents(account, manual.url, 'window.fixtureFinish()');
      await until(async () => (await task(next.id)).status === 'done', 'Manual recovery must eventually advance its queue', 30000);
      assert.deepEqual((await state(account, manual.url)).sent,
        ['HOLD:manual previous turn', 'Next after manual reconnect ' + mode]);
      assert.equal(await requests(manual.url), 2, 'Successful reconnect runs once');
    }

    for (const mode of ['legacy', 'modern']) await submittedRecovery(account, other, mode);

    // Start independent negative cases together, then give the real stability
    // window time to expire. They retain their native documents and Stop controls.
    const transient = await open(account, 'transient-legacy');
    const progressing = await open(account, 'progress-modern');
    const quoted = await open(account, 'quoted-history-modern');
    const draft = await open(account, 'human-draft-legacy');
    for (const current of [transient, progressing, quoted, draft]) {
      await contents(account, current.url, "window.fixtureSend('HOLD:negative case')");
    }
    await contents(account, transient.url, 'window.fixtureDisconnect(); setTimeout(window.fixtureReconnect, 2200)');
    await contents(account, progressing.url, `window.fixtureDisconnect();
      window.fixtureProgressTimer = setInterval(window.fixtureProgress, 700);
      setTimeout(() => { clearInterval(window.fixtureProgressTimer); window.fixtureReconnect(); }, 9500);`);
    await contents(account, quoted.url, 'window.fixtureQuoteAndHistory()');
    const humanDraft = 'Unsent human draft must survive the disconnected reply';
    await contents(account, draft.url, 'window.fixtureDisconnect(); window.fixtureSetDraft(' + JSON.stringify(humanDraft) + ')');
    await sleep(10500);
    for (const current of [transient, progressing, quoted, draft]) {
      assert.equal(await requests(current.url), 1, 'Transient, progressing, quoted/history and drafted replies must not reload: ' + current.url);
      assert.equal((await contents(account, current.url)).id, current.native.id, 'Negative case retains its original native view');
      assert.equal((await state(account, current.url)).stop, true);
      assert.equal((await state(account, current.url)).stopClicks, 0);
    }
    await editableDraft(account, draft, humanDraft);
    assert.equal((await inspect(account, quoted.page.id)).loadFailure, undefined, 'Quoted/history cards are not current reply disconnections');
    await contents(account, draft.url, "window.fixtureSetDraft('')");
    await until(async () => await requests(draft.url) === 2, 'Clearing the human draft allows the still disconnected reply to recover', 14000);
    await until(() => reconnected(account, draft.url), 'Draft-safe recovery must mount the existing reply');
    await retained(account, draft);

    const refresh = await open(account, 'refresh-modern');
    await contents(account, refresh.url, "window.fixtureSend('HOLD:refresh reconnects'); window.fixtureDisconnect()");
    await rpc('browser.control', { accountId: account.id, action: 'reload' });
    await until(async () => await requests(refresh.url) === 2 && await reconnected(account, refresh.url),
      'Manual Refresh must reconnect the same conversation');
    assert.equal((await state(account, refresh.url)).stop, true);
    assert.deepEqual((await state(account, refresh.url)).sent, ['HOLD:refresh reconnects']);
    await retained(account, refresh);

    const repeated = await open(account, 'repeated-legacy');
    await contents(account, repeated.url, "window.fixtureSend('HOLD:repeated disconnect'); window.fixtureDisconnect(4)");
    await until(async () => await requests(repeated.url) === 5 && await reconnected(account, repeated.url),
      'A disconnected reply must keep recovering beyond three attempts', 60000);
    await retained(account, repeated);
    assert.equal((await inspect(account, repeated.page.id)).busy, true);
    assert.deepEqual((await state(account, repeated.url)).sent, ['HOLD:repeated disconnect']);
    assert.equal((await contents(account, sibling.url)).id, sibling.native.id, 'Recovery retains the healthy busy sibling view');
    assert.equal((await state(account, sibling.url)).stop, true, 'Healthy sibling is still generating');
    assert.equal((await task(siblingTask.id)).status, 'running');
    assert.equal(await requests(sibling.url), 1, 'Recovery never reloads the healthy busy sibling');
    assert.equal((await contents(other, 'https://chatgpt.com/')).id, otherNative.id);
    assert.equal(await contents(other, 'https://chatgpt.com/', "localStorage.getItem('isolated-marker')"), 'retained');
    await contents(account, sibling.url, 'window.fixtureFinish()');
    await until(async () => (await task(siblingTask.id)).status === 'done', 'Healthy sibling can still finish', 30000);
    passed = true;
    console.log('Disconnected reply desktop passed: legacy/modern Stop faults reconnect, real busy replies hold manual/submitted queues, original receipts survive without replay, repeated faults retry beyond three, transient/progress/history/quoted/draft cases stay intact, Refresh reconnects, and healthy profiles/siblings remain live.');
  }
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
  assert.ok(path.basename(target).startsWith('.test-disconnected-reply-'));
  await rm(target, { recursive: true, force: true });
  if (!passed) process.exitCode = 1;
}
