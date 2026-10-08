import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-stuck-view-recovery-'));
const bootstrap = path.join(directory, 'fixture.cjs');
const slowResourceFixture = fixture.replace('</main>', '<iframe id="stuck-subresource" src="/slow-resource" hidden></iframe></main>');
assert.notEqual(slowResourceFixture, fixture);

await writeFile(bootstrap, `const { app, Notification } = require('electron');
Notification.isSupported = () => false;
globalThis.blockedTargetUrls = new Set();
globalThis.oneShotBlockedTargetUrls = new Set();
globalThis.badNativeLoads = [];
globalThis.blockedMainLoads = 0;
globalThis.protocolRequests = [];
app.on('browser-window-created', (_, win) => {
  win.webContents.setBackgroundThrottling(false);
  win.setSkipTaskbar(true);
  if (process.platform === 'win32') win.setPosition(-20000, -20000);
});
app.on('session-created', isolated => {
  isolated.protocol.handle('https', async request => {
    const url = new URL(request.url);
    globalThis.protocolRequests.push(request.url);
    if (url.pathname === '/__stuck__' || url.pathname === '/slow-resource') {
      await new Promise(() => {});
    }
    const blockedByUrl = globalThis.blockedTargetUrls.has(request.url) || globalThis.blockedTargetUrls.has(url.pathname);
    const oneShotBlockedByUrl = globalThis.oneShotBlockedTargetUrls.has(request.url) || globalThis.oneShotBlockedTargetUrls.has(url.pathname);
    if (oneShotBlockedByUrl) {
      globalThis.oneShotBlockedTargetUrls.delete(request.url);
      globalThis.oneShotBlockedTargetUrls.delete(url.pathname);
    }
    if (blockedByUrl || oneShotBlockedByUrl) {
      globalThis.blockedMainLoads++;
      await new Promise(() => {});
    }
    const body = url.pathname === '/c/slow-subresource' ? ${JSON.stringify(slowResourceFixture)} : ${JSON.stringify(fixture)};
    return new Response(body, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  });
});
require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);

const env = { ...process.env, WORKSPACE_USER_DATA: directory, WORKSPACE_PAGE_LOAD_TIMEOUT_MS: '300',
  WORKSPACE_PAGE_IDLE_MS: '3600000', WORKSPACE_HIDDEN_PAGE_IDLE_MS: '3600000' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKSPACE_DEV_URL;

let desktop;
let desktopPid;
let shell;
let passed = false;
let firstAccount;

function bounded(promise, label, ms = 20000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

const until = async (check, label, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (!await check()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

const rpc = (method, params = {}) => bounded(shell.evaluate(({ method, params }) =>
  window.workspace.call(method, params), { method, params }), method);

const webContentsFor = (account, url) => desktop.evaluate(({ session, webContents }, { partition, url }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.getURL() === url);
  if (!contents) return null;
  return { id: contents.id, url: contents.getURL(), loading: contents.isLoading(), waitingResponse: contents.isWaitingForResponse(),
    loadingMainFrame: contents.isLoadingMainFrame(), crashed: contents.isCrashed() };
}, { partition: account.partition, url });

const requireWebContentsFor = async (account, url) => {
  const contents = await webContentsFor(account, url);
  assert.ok(contents, `Expected fixture WebContents for ${url}`);
  return contents;
};

const webContentsById = (account, id) => desktop.evaluate(({ session, webContents }, { partition, id }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.id === id);
  if (!contents) return null;
  return { id: contents.id, url: contents.getURL(), loading: contents.isLoading(), waitingResponse: contents.isWaitingForResponse(),
    loadingMainFrame: contents.isLoadingMainFrame(), crashed: contents.isCrashed() };
}, { partition: account.partition, id });

const runInPage = (account, url, script) => desktop.evaluate(async ({ session, webContents }, { partition, url, script }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.getURL() === url);
  if (!contents) throw new Error(`Fixture page missing: ${url}`);
  return contents.mainFrame.executeJavaScript(script);
}, { partition: account.partition, url, script });

const runInPageById = (account, id, script) => desktop.evaluate(async ({ session, webContents }, { partition, id, script }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.id === id);
  if (!contents) throw new Error(`Fixture WebContents missing: ${id}`);
  return contents.mainFrame.executeJavaScript(script);
}, { partition: account.partition, id, script });

const emitPageEvent = (account, id, event) => desktop.evaluate(({ session, webContents }, { partition, id, event }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.id === id);
  if (!contents) throw new Error(`Fixture WebContents missing: ${id}`);
  contents.emit(event);
  return { id: contents.id, url: contents.getURL(), loading: contents.isLoading(), waitingResponse: contents.isWaitingForResponse() };
}, { partition: account.partition, id, event });

const simulatePendingMainNavigationById = (account, id, url) => desktop.evaluate(({ session, webContents }, { partition, id, url }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.id === id);
  if (!contents) throw new Error(`Fixture WebContents missing: ${id}`);
  contents.isLoading = () => true;
  contents.isLoadingMainFrame = () => true;
  contents.isWaitingForResponse = () => true;
  contents.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
  return { id: contents.id, url: contents.getURL(), loading: contents.isLoading(), waitingResponse: contents.isWaitingForResponse(), loadingMainFrame: contents.isLoadingMainFrame() };
}, { partition: account.partition, id, url });

const installStuckWrapper = (account, url) => desktop.evaluate(({ session, webContents }, { partition, url }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.getURL() === url);
  if (!contents) throw new Error(`Fixture page missing: ${url}`);
  const stuckUrl = `https://chatgpt.com/__stuck__?wc=${contents.id}&n=`;
  const originalLoadURL = contents.loadURL.bind(contents);
  const originalReload = contents.reload.bind(contents);
  let count = 0;
  contents.loadURL = (nextUrl, options) => {
    if (nextUrl === url || String(nextUrl).startsWith(stuckUrl)) {
      count++;
      globalThis.badNativeLoads.push({ webContentsId: contents.id, url: nextUrl, count });
      return originalLoadURL(stuckUrl + count, options);
    }
    return originalLoadURL(nextUrl, options);
  };
  contents.reload = () => {
    count++;
    globalThis.badNativeLoads.push({ webContentsId: contents.id, url, count, action: 'reload' });
    return originalLoadURL(stuckUrl + count);
  };
  return { id: contents.id, url: contents.getURL(), originalReloadName: originalReload.name };
}, { partition: account.partition, url });

const profileState = (account, write = false) => desktop.evaluate(async ({ session, webContents }, { account, write }) => {
  const isolated = session.fromPartition(account.partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.getURL().startsWith('https://chatgpt.com'));
  if (!contents) throw new Error('Account WebContents missing');
  if (write) {
    await isolated.cookies.set({ url: 'https://chatgpt.com', name: 'stuck-view-test', value: account.name, expirationDate: Date.now() / 1000 + 3600 });
    await contents.mainFrame.executeJavaScript(`localStorage.setItem('stuck-view-test', ${JSON.stringify(account.name)})`);
    await isolated.cookies.flushStore();
  }
  return { cookies: await isolated.cookies.get({ name: 'stuck-view-test' }),
    storage: await contents.mainFrame.executeJavaScript("localStorage.getItem('stuck-view-test')") };
}, { account, write });

try {
  desktop = await electron.launch({ args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', bootstrap], env });
  desktopPid = desktop.process()?.pid;
  shell = await bounded(desktop.firstWindow(), 'First window');
  shell.setDefaultTimeout(15000);
  await bounded(shell.waitForFunction(() => !!window.workspace), 'Workspace bridge');

  const first = await rpc('accounts.create', { name: 'Stuck view account' });
  firstAccount = first;
  await until(async () => (await rpc('browser.inspect', { accountId: first.id })).editor,
    'First account did not load');
  const second = await rpc('accounts.create', { name: 'Switch target account' });
  await until(async () => (await rpc('browser.inspect', { accountId: second.id })).editor,
    'Second account did not load');
  const third = await rpc('accounts.create', { name: 'Persistent account' });
  await until(async () => (await rpc('browser.inspect', { accountId: third.id })).editor,
    'Third account did not load');
  assert.equal((await profileState(third, true)).storage, third.name);
  await rpc('accounts.switch', { id: first.id });

  const targetUrl = 'https://chatgpt.com/c/stuck-view';
  const navigation = await rpc('browser.navigate', { accountId: first.id, url: targetUrl });
  await until(async () => (await rpc('tasks.get', { id: navigation.id })).status === 'done',
    'Target navigation did not finish');
  await until(async () => (await rpc('browser.inspect', { accountId: first.id })).editor,
    'Target page did not become ready');
  const selected = (await rpc('workspace.status')).page;
  assert.equal(selected.url, targetUrl);
  assert.ok(selected.id);
  assert.ok(selected.conversationId);

  await rpc('queues.pause', { accountId: first.id, conversation: selected.conversationId });
  const queuedOne = await rpc('tasks.create', { accountId: first.id, conversation: selected.conversationId,
    background: true, input: { type: 'prompt', prompt: 'first after recreate', submit: true } });
  const queuedTwo = await rpc('tasks.create', { accountId: first.id, conversation: selected.conversationId,
    background: true, input: { type: 'prompt', prompt: 'second after recreate', submit: true } });
  assert.equal((await rpc('tasks.get', { id: queuedOne.id })).status, 'pending');
  assert.equal((await rpc('tasks.get', { id: queuedTwo.id })).status, 'pending');

  const sibling = await rpc('conversations.register', { accountId: first.id, url: 'https://chatgpt.com/c/sibling-held' });
  const siblingTask = await rpc('tasks.create', { accountId: first.id, conversation: sibling.id,
    background: true, input: { type: 'prompt', prompt: 'HOLD:sibling stays alive', submit: true } });
  await until(async () => !!(await rpc('tasks.get', { id: siblingTask.id })).submittedAt,
    'Sibling held reply did not start');
  const siblingContents = await requireWebContentsFor(first, sibling.url);

  const originalContents = await requireWebContentsFor(first, targetUrl);
  await installStuckWrapper(first, targetUrl);
  await rpc('browser.control', { accountId: first.id, action: 'reload' });
  await until(async () => (await desktop.evaluate(() => globalThis.badNativeLoads.length)) >= 1,
    'Bad WebContents did not receive the simulated stuck navigation');
  await until(async () => {
    const contents = await webContentsById(first, originalContents.id);
    return !!contents?.loading && contents.waitingResponse && contents.loadingMainFrame;
  }, 'Bad WebContents did not become a real pending main-frame load', 1200);
  await rpc('accounts.switch', { id: second.id });
  await until(async () => (await rpc('workspace.status')).activeAccountId === second.id,
    'Account switching was blocked by a stuck page', 1500);
  await until(async () => {
    const contents = await webContentsFor(first, targetUrl);
    return !!contents && contents.id !== originalContents.id && (await rpc('browser.inspect', { accountId: first.id, pageId: selected.id })).editor;
  }, 'Stuck selected page was not recreated with a new WebContents');

  const recreated = await requireWebContentsFor(first, targetUrl);
  assert.notEqual(recreated.id, originalContents.id, 'Recovery must replace the damaged WebContents');
  const afterRecreate = (await rpc('workspace.status')).pages.find(page => page.id === selected.id);
  assert.ok(afterRecreate, 'The original tab remains registered');
  assert.equal(afterRecreate.conversationId, selected.conversationId, 'The original conversation binding is preserved');
  assert.equal(afterRecreate.url, targetUrl, 'The original tab URL is preserved');
  assert.equal((await requireWebContentsFor(first, sibling.url)).id, siblingContents.id,
    'A healthy sibling reply in the same account keeps its native WebContents during recovery');
  assert.equal((await profileState(third)).storage, third.name, 'Recovery must not clear another account localStorage');
  assert.equal((await profileState(third)).cookies[0]?.value, third.name, 'Recovery must not clear another account cookies');
  assert.equal((await rpc('tasks.get', { id: queuedOne.id })).status, 'pending', 'Pending queue survives native view recreation');
  assert.equal((await rpc('tasks.get', { id: queuedTwo.id })).status, 'pending');
  await runInPage(first, sibling.url, 'window.fixtureFinish()');
  await until(async () => (await rpc('tasks.get', { id: siblingTask.id })).status === 'done',
    'Sibling held reply did not finish after target recovery');

  await rpc('queues.resume', { accountId: first.id, conversation: selected.conversationId });
  await until(async () => (await rpc('tasks.get', { id: queuedTwo.id })).status === 'done',
    'Queue did not resume after recreating the stuck view');
  assert.equal((await rpc('tasks.get', { id: queuedOne.id })).status, 'done');
  assert.deepEqual(await runInPage(first, targetUrl,
    "[...document.querySelectorAll('[data-message-author-role=user]')].map(node => node.textContent)"),
  ['first after recreate', 'second after recreate']);
  assert.equal(await runInPage(first, targetUrl, 'window.fixtureSendCount'), 2, 'Recovered queue sends each queued message once');

  const retryUrl = 'https://chatgpt.com/c/manual-retry';
  const retryNav = await rpc('browser.navigate', { accountId: first.id, url: retryUrl });
  await until(async () => (await rpc('tasks.get', { id: retryNav.id })).status === 'done',
    'Manual retry page did not open');
  await rpc('accounts.switch', { id: first.id });
  await until(async () => {
    const state = await rpc('workspace.status');
    return state.activeAccountId === first.id && state.page?.url === retryUrl;
  }, 'Manual retry page was not selected before cap testing');
  const retryPage = (await rpc('workspace.status')).page;
  const retryOriginal = await requireWebContentsFor(first, retryUrl);
  await desktop.evaluate((_electron, url) => { globalThis.blockedTargetUrls.add(url); globalThis.blockedTargetUrls.add(new URL(url).pathname); }, retryUrl);
  await rpc('browser.control', { accountId: first.id, action: 'reload' });
  await until(async () => (await desktop.evaluate(() => globalThis.blockedMainLoads)) >= 4,
    'Automatic recovery did not perform the initial load plus three rebuild attempts', 15000);
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(await desktop.evaluate(() => globalThis.blockedMainLoads), 4,
    'Automatic recovery must stop after the capped attempts until manual recovery');
  const blockedState = await rpc('workspace.status');
  assert.equal(blockedState.page.id, retryPage.id, 'Failed automatic attempts keep the same tab selected');
  assert.equal(blockedState.page.conversationId, retryPage.conversationId, 'Failed automatic attempts keep the same conversation');
  assert.ok(blockedState.page.error || blockedState.page.loading, 'Blocked page remains visible as recoverable instead of becoming a new blank tab');
  await desktop.evaluate((_electron, url) => { globalThis.blockedTargetUrls.delete(url); globalThis.blockedTargetUrls.delete(new URL(url).pathname); }, retryUrl);
  await rpc('browser.control', { accountId: first.id, action: 'reload' });
  await until(async () => {
    const contents = await webContentsFor(first, retryUrl);
    return !!contents && contents.id !== retryOriginal.id && (await rpc('browser.inspect', { accountId: first.id, pageId: retryPage.id })).editor;
  }, 'Manual recovery did not recreate the page after automatic attempts were exhausted');
  const retryRestored = (await rpc('workspace.status')).pages.find(page => page.id === retryPage.id);
  assert.equal(retryRestored?.conversationId, retryPage.conversationId);
  assert.equal(retryRestored?.url, retryUrl);

  const slowUrl = 'https://chatgpt.com/c/slow-subresource';
  const slowNav = await rpc('browser.navigate', { accountId: first.id, url: slowUrl });
  await until(async () => (await rpc('tasks.get', { id: slowNav.id })).status === 'done',
    'Slow subresource page did not become usable');
  const slowPage = (await rpc('workspace.status')).page;
  const slowContents = await requireWebContentsFor(first, slowUrl);
  assert.equal(slowContents.loading, true, 'Fixture must keep native loading true for a pending subresource');
  assert.equal(slowContents.waitingResponse, false, 'Pending subresource is not a main-frame response stall');
  await new Promise(resolve => setTimeout(resolve, 2800));
  const slowAfter = await requireWebContentsFor(first, slowUrl);
  const slowState = (await rpc('workspace.status')).pages.find(page => page.id === slowPage.id);
  assert.equal(slowAfter.id, slowContents.id, 'A permanently pending subresource must not recreate a ready composer page');
  assert.equal(slowState?.id, slowPage.id);
  assert.equal((await rpc('workspace.status')).page?.error, undefined, 'A ready composer page with a pending subresource must not be hidden behind recovery UI');
  assert.equal((await rpc('browser.inspect', { accountId: first.id, pageId: slowPage.id })).readiness, 'ready');
  const slowConversation = slowPage.conversationId;
  assert.ok(slowConversation);
  const slowQueued = await rpc('tasks.create', { accountId: first.id, conversation: slowConversation,
    background: true, input: { type: 'prompt', prompt: 'send while subresource is pending', submit: true } });
  await until(async () => (await rpc('tasks.get', { id: slowQueued.id })).status === 'done',
    'Queue did not send on a ready page with a pending subresource');
  assert.deepEqual(await runInPage(first, slowUrl,
    "[...document.querySelectorAll('[data-message-author-role=user]')].map(node => node.textContent)"),
  ['send while subresource is pending']);

  const responsiveUrl = 'https://chatgpt.com/c/responsive-after-warning';
  const responsiveNav = await rpc('browser.navigate', { accountId: first.id, url: responsiveUrl });
  await until(async () => (await rpc('tasks.get', { id: responsiveNav.id })).status === 'done',
    'Responsive recovery page did not open');
  await until(async () => (await rpc('browser.inspect', { accountId: first.id })).readiness === 'ready',
    'Responsive recovery page did not become ready');
  const responsivePage = (await rpc('workspace.status')).page;
  const responsiveContents = await requireWebContentsFor(first, responsiveUrl);
  await emitPageEvent(first, responsiveContents.id, 'unresponsive');
  await until(async () => /没有响应/.test((await rpc('workspace.status')).page?.error ?? ''),
    'Unresponsive event did not enter the recovery warning state', 1200);
  await runInPageById(first, responsiveContents.id,
    "document.querySelector('#prompt-textarea').value='human draft survives responsive recovery'; document.querySelector('#prompt-textarea').dispatchEvent(new Event('input',{bubbles:true}));");
  await emitPageEvent(first, responsiveContents.id, 'responsive');
  await new Promise(resolve => setTimeout(resolve, 2300));
  const responsiveAfter = await requireWebContentsFor(first, responsiveUrl);
  assert.equal(responsiveAfter.id, responsiveContents.id, 'Responsive page must cancel the scheduled unresponsive recovery');
  assert.equal((await rpc('workspace.status')).page?.id, responsivePage.id);
  assert.equal((await rpc('workspace.status')).page?.error, undefined, 'Responsive event clears the recovery warning');
  assert.equal(await runInPage(first, responsiveUrl, "document.querySelector('#prompt-textarea').value"),
    'human draft survives responsive recovery', 'Draft input survives a cancelled unresponsive recovery timer');

  const usableResetStartUrl = 'https://chatgpt.com/c/usable-reset-start';
  const usableResetNav = await rpc('browser.navigate', { accountId: first.id, url: usableResetStartUrl });
  await until(async () => (await rpc('tasks.get', { id: usableResetNav.id })).status === 'done',
    'Usable reset start page did not open');
  const usableResetPage = (await rpc('workspace.status')).page;
  const usableResetOriginal = await requireWebContentsFor(first, usableResetStartUrl);
  await runInPage(first, usableResetStartUrl,
    "const iframe = document.createElement('iframe'); iframe.hidden = true; iframe.src = '/slow-resource?usable-reset'; document.body.append(iframe);");
  await until(async () => (await webContentsById(first, usableResetOriginal.id))?.loading === true,
    'Usable reset fixture did not keep loading true with a pending iframe');
  assert.equal(await runInPageById(first, usableResetOriginal.id,
    "!!document.querySelector('#prompt-textarea') && !document.querySelector('#prompt-textarea').disabled"), true,
  'The page DOM remains usable while the iframe keeps native loading true');
  await new Promise(resolve => setTimeout(resolve, 2800));
  assert.equal((await requireWebContentsFor(first, usableResetStartUrl)).id, usableResetOriginal.id,
    'Pending iframe marks the page usable without replacing it');
  const pendingMain = await simulatePendingMainNavigationById(first, usableResetOriginal.id, usableResetStartUrl);
  assert.equal(pendingMain.loading, true, 'Injected main navigation keeps the old WebContents loading');
  assert.equal(pendingMain.waitingResponse, true, 'Injected main navigation waits for the main-frame response');
  assert.equal(pendingMain.loadingMainFrame, true, 'Injected main navigation marks the main frame as loading');
  let sawInjectedRecoveryState = false;
  await until(async () => {
    const pageError = (await rpc('workspace.status')).page?.error ?? '';
    sawInjectedRecoveryState ||= /加载超时|恢复/.test(pageError);
    const contents = await webContentsFor(first, usableResetStartUrl);
    return sawInjectedRecoveryState || !!contents && contents.id !== usableResetOriginal.id;
  }, 'Injected pending main navigation did not enter recovery or recreate the WebContents', 5000);
  await until(async () => {
    const contents = await webContentsFor(first, usableResetStartUrl);
    return !!contents && contents.id !== usableResetOriginal.id && (await rpc('browser.inspect', { accountId: first.id, pageId: usableResetPage.id })).readiness === 'ready';
  }, 'Main navigation after a usable pending-resource page did not recreate the WebContents');
  const usableResetRestored = (await rpc('workspace.status')).pages.find(page => page.id === usableResetPage.id);
  assert.equal(usableResetRestored?.url, usableResetStartUrl, 'Main navigation recovery keeps the same tab on its conversation URL');

  passed = true;
  console.log('Stuck view recovery passed: damaged WebContents are recreated, queued messages survive and resume once, manual recovery resets exhausted retries, account switching stays responsive, ready pages with stuck subresources are not rebuilt, responsive pages cancel recovery timers, and usable pages reset on later main navigation stalls.');
} catch (error) {
  const runtimeLog = await readFile(path.join(directory, 'logs/runtime.jsonl'), 'utf8')
    .then(content => content.trim().split('\n').slice(-20).map(line => JSON.parse(line)))
    .catch(error => [{ error: String(error) }]);
  const shellState = shell && !shell.isClosed() ? await shell.evaluate(async () => {
    const state = await window.workspace?.call?.('workspace.status').catch(error => ({ error: String(error) }));
    return { activeAccountId: state?.activeAccountId, page: state?.page,
      selectedPages: state?.pages?.filter?.(page => page.selected), errors: state?.tasks?.filter?.(task => ['failed', 'uncertain', 'blocked', 'waiting_user'].includes(task.status)) };
  }).catch(error => ({ error: String(error) })) : undefined;
  const nativeState = await desktop?.evaluate(({ BrowserWindow, session, webContents }, partition) => {
    const isolated = session.fromPartition(partition);
    return {
      badNativeLoads: globalThis.badNativeLoads,
      blockedMainLoads: globalThis.blockedMainLoads,
      oneShotBlockedRemaining: [...globalThis.oneShotBlockedTargetUrls],
      lastProtocolRequests: globalThis.protocolRequests.slice(-20),
      accountWebContents: webContents.getAllWebContents().filter(item => item.session === isolated).map(item => ({
        id: item.id, url: item.getURL(), destroyed: item.isDestroyed(), loading: item.isLoading(),
        waitingResponse: item.isWaitingForResponse(), loadingMainFrame: item.isLoadingMainFrame(), crashed: item.isCrashed()
      })),
      windows: BrowserWindow.getAllWindows().map(window => ({
        url: window.webContents.getURL(), destroyed: window.webContents.isDestroyed(), loading: window.webContents.isLoading()
      }))
    };
  }, firstAccount?.partition).catch(error => ({ error: String(error) }));
  console.error(JSON.stringify({ shellState, nativeState, runtimeLog }, null, 2));
  throw error;
} finally {
  try { if (desktop) await bounded(desktop.close(), 'Fixture shutdown', 10000); }
  catch { if (desktopPid) { try { process.kill(desktopPid); } catch {} } }
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root);
  assert.ok(path.basename(target).startsWith('.test-stuck-view-recovery-'));
  await rm(target, { recursive: true, force: true });
  if (!passed) process.exitCode = 1;
}
