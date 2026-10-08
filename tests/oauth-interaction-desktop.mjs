import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-oauth-interaction-'));
const bootstrap = path.join(directory, 'fixture.cjs');
const mainEntry = process.env.WORKSPACE_TEST_MAIN_CJS || path.join(root, 'dist-electron/main.cjs');

const chatPage = `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT OAuth fixture</title></head><body>
<main><h1>ChatGPT fixture</h1><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>
<button id="google-login">Continue with Google</button><button id="popup-login">Popup Google login</button><button id="external-link">External link</button>
<div id="messages"></div></main><script>
const historyKey = () => 'oauth-history:' + location.pathname;
let messages = JSON.parse(localStorage.getItem(historyKey()) || '[]');
function render(){ const box=document.querySelector('#messages'); box.replaceChildren(); for(const message of messages){ const article=document.createElement('article'); const div=document.createElement('div'); div.dataset.messageAuthorRole=message.role; div.dataset.messageId=message.id; div.textContent=message.text; article.append(div); if(message.role==='assistant'&&message.finished){ const copy=document.createElement('button'); copy.dataset.testid='copy-turn-action-button'; copy.textContent='Copy'; article.append(copy); } box.append(article); } localStorage.setItem(historyKey(), JSON.stringify(messages)); }
render();
document.querySelector('#google-login').addEventListener('click', () => { location.href = 'https://auth.openai.com/login?connection=google&return_to=' + encodeURIComponent('https://chatgpt.com/'); });
document.querySelector('#popup-login').addEventListener('click', () => { window.open('https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=' + encodeURIComponent('https://auth.openai.com/callback') + '&state=popup', 'oauth-popup'); });
document.querySelector('#external-link').addEventListener('click', () => { location.href = 'https://evil.example/phish'; });
document.querySelector('[data-testid="send-button"]').addEventListener('click', () => { const composer=document.querySelector('#prompt-textarea'); const value=composer.value; window.fixtureSendCount=(window.fixtureSendCount||0)+1; composer.value=''; messages.push({role:'user',id:crypto.randomUUID(),text:value}); messages.push({role:'assistant',id:crypto.randomUUID(),text:'Fixture reply: '+value,finished:false}); const stop=document.createElement('button'); stop.dataset.testid='stop-button'; stop.textContent='Stop'; document.querySelector('main').append(stop); render(); window.fixtureFinish=()=>{messages.at(-1).finished=true; stop.remove(); render();}; if(!value.startsWith('HOLD:')) setTimeout(()=>window.fixtureFinish(),100); });
</script></body></html>`;

const authPage = `<!doctype html><html><head><meta charset="utf-8"><title>OpenAI Auth fixture</title></head><body><main>
<h1>OpenAI Auth</h1><button id="continue-google">Continue to Google</button>
<form id="post-callback" method="post" action="https://auth.openai.com/callback"><input name="code" value="posted-code"><button id="post-callback-button" type="submit">POST callback</button></form>
<script>document.querySelector('#continue-google').onclick=()=>{ location.href='https://accounts.google.com/o/oauth2/v2/auth?redirect_uri='+encodeURIComponent('https://auth.openai.com/callback')+'&state=main'; };</script>
</main></body></html>`;

const googlePage = `<!doctype html><html><head><meta charset="utf-8"><title>Google fixture</title></head><body><main>
<h1>Choose an account</h1><button id="account-choice" data-email="fixture@example.com">fixture@example.com</button>
<script>document.querySelector('#account-choice').addEventListener('click',()=>{ localStorage.setItem('google-selected-account', document.querySelector('#account-choice').dataset.email); const redirect=new URL(location.href).searchParams.get('redirect_uri') || 'https://auth.openai.com/callback'; location.href=redirect+'?code=syntheticsecret&state='+encodeURIComponent(new URL(location.href).searchParams.get('state')||'main'); });
if (new URL(location.href).searchParams.get('pending') === '1') { const iframe = document.createElement('iframe'); iframe.hidden = true; iframe.src = 'https://accounts.google.com/never'; document.body.append(iframe); }</script>
</main></body></html>`;

const callbackPage = `<!doctype html><html><head><meta charset="utf-8"><title>OAuth callback fixture</title></head><body><main><h1>Callback</h1><script>localStorage.setItem('oauth-callback-method', document.body.dataset.method || 'GET'); setTimeout(()=>{ location.href='https://chatgpt.com/?oauth=done'; }, 20);</script></main></body></html>`;

await writeFile(bootstrap, `const { app, Notification, dialog, shell } = require('electron');
Notification.isSupported = () => false;
globalThis.oauthRequests = [];
globalThis.externalOpenAttempts = [];
globalThis.oneShotBlockedTargetUrls = new Set();
globalThis.pendingNavigationEvents = [];
dialog.showMessageBox = async (_window, options) => { globalThis.externalOpenAttempts.push({ kind: 'dialog', message: options.message, detail: options.detail }); return { response: 0 }; };
shell.openExternal = async url => { globalThis.externalOpenAttempts.push({ kind: 'openExternal', url }); };
app.on('browser-window-created', (_, win) => { win.webContents.setBackgroundThrottling(false); win.setSkipTaskbar(true); if (process.platform === 'win32') win.setPosition(-20000, -20000); });
app.on('session-created', isolated => isolated.protocol.handle('https', async request => {
  const url = new URL(request.url); globalThis.oauthRequests.push({ url: request.url, method: request.method });
  if (globalThis.oneShotBlockedTargetUrls.delete(request.url)) await new Promise(() => {});
  if (url.hostname === 'chatgpt.com') return new Response(${JSON.stringify(chatPage)}, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  if (url.hostname === 'auth.openai.com' || url.hostname === 'auth0.openai.com') {
    if (url.pathname.includes('callback')) {
      const body = ${JSON.stringify(callbackPage)}.replace('<body>', '<body data-method="' + request.method + '">');
      return new Response(body, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
    }
    return new Response(${JSON.stringify(authPage)}, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  }
  if (url.hostname === 'accounts.google.com' && url.pathname === '/never') await new Promise(() => {});
  if (url.hostname === 'accounts.google.com') return new Response(${JSON.stringify(googlePage)}, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  return new Response('<!doctype html><title>external should not load</title><h1>external loaded</h1>', { headers: { 'Content-Type': 'text/html' } });
}));
require(${JSON.stringify(mainEntry)});`);

const env = { ...process.env, WORKSPACE_USER_DATA: directory, WORKSPACE_HIDDEN_PAGE_IDLE_MS: '3600000', WORKSPACE_PAGE_IDLE_MS: '3600000', WORKSPACE_PAGE_LOAD_TIMEOUT_MS: '300' };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;

let desktop;
let shellPage;
let desktopPid;
let passed = false;
let primaryAccount;

function bounded(promise, label, ms = 20000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
}
const until = async (check, label, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (!await check()) { assert.ok(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 100)); }
};
const rpc = (method, params = {}) => bounded(shellPage.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params }), method);
const waitTask = task => until(async () => {
  const current = await rpc('tasks.get', { id: task.id });
  assert.ok(!['failed', 'blocked', 'waiting_user'].includes(current.status), current.error ?? current.status);
  return current.status === 'done';
}, `Task ${task.id} did not finish`);
const webContentsFor = (account, url) => desktop.evaluate(({ session, webContents }, { partition, url }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.getURL() === url);
  if (!contents) return null;
  return { id: contents.id, url: contents.getURL(), loading: contents.isLoading(), title: contents.getTitle(), destroyed: contents.isDestroyed() };
}, { partition: account.partition, url });

const accountWebContents = account => desktop.evaluate(({ session, webContents }, partition) => {
  const isolated = session.fromPartition(partition);
  return webContents.getAllWebContents().filter(item => item.session === isolated && !item.isDestroyed()).map(item => ({
    id: item.id, url: item.getURL(), title: item.getTitle(), loading: item.isLoading()
  }));
}, account.partition);
const openNewConversationContents = async (account, label) => {
  const before = new Set((await accountWebContents(account)).map(item => item.id));
  const page = await rpc('browser.newConversation', { accountId: account.id });
  await until(async () => (await accountWebContents(account)).some(item => !before.has(item.id) && item.url.startsWith('https://chatgpt.com/')), `${label} did not attach`);
  const contents = (await accountWebContents(account)).find(item => !before.has(item.id) && item.url.startsWith('https://chatgpt.com/'));
  assert.ok(contents, `${label} should have a new WebContents`);
  return { page, contents };
};

const selectedWebContents = account => desktop.evaluate(({ BrowserWindow, session }, partition) => {
  const isolated = session.fromPartition(partition);
  const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().startsWith('file:'));
  const visible = window?.contentView.children.find(view => view.webContents && !view.webContents.isDestroyed() && view.webContents.session === isolated)?.webContents;
  if (!visible) return null;
  return { id: visible.id, url: visible.getURL(), title: visible.getTitle(), loading: visible.isLoading() };
}, account.partition);
const contentsById = (account, id) => desktop.evaluate(({ session, webContents }, { partition, id }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.id === id);
  if (!contents || contents.isDestroyed()) return null;
  return { id: contents.id, url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading(),
    waitingResponse: contents.isWaitingForResponse(), loadingMainFrame: contents.isLoadingMainFrame() };
}, { partition: account.partition, id });
const clickSelector = (account, id, selector) => desktop.evaluate(async ({ app, BrowserWindow, session, webContents }, { partition, id, selector }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.id === id);
  if (!contents || contents.isDestroyed()) throw new Error(`Missing WebContents ${id}`);
  const rect = await contents.mainFrame.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: el.textContent, disabled: !!el.disabled }; })()`);
  if (!rect) throw new Error(`Missing selector ${selector} at ${contents.getURL()}`);
  // Account WebContentsViews are children of the main window, whereas login
  // popups own their WebContents. Focus the actual visible host in either case.
  const host = BrowserWindow.fromWebContents(contents) ?? BrowserWindow.getAllWindows().find(window =>
    !window.isDestroyed() && window.contentView.children.some(child => child.webContents === contents));
  if (!host || host.isDestroyed() || !host.isVisible()) throw new Error(`Missing visible host for WebContents ${id}`);
  if (process.platform === 'darwin') app.focus({ steal: true });
  host.focus();
  const focusDeadline = Date.now() + 3000;
  contents.focus();
  while (!host.isFocused() || !contents.isFocused()) {
    if (host.isDestroyed() || contents.isDestroyed() || Date.now() >= focusDeadline)
      throw new Error(`Native host/page did not focus for WebContents ${id}`);
    if (!host.isFocused()) host.focus();
    contents.focus();
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  contents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
  contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: rect.x, y: rect.y });
  contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: rect.x, y: rect.y });
  return { url: contents.getURL(), rect };
}, { partition: account.partition, id, selector });
const scriptIn = (account, id, script) => desktop.evaluate(({ session, webContents }, { partition, id, script }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.id === id);
  if (!contents || contents.isDestroyed()) throw new Error(`Missing WebContents ${id}`);
  return contents.mainFrame.executeJavaScript(script);
}, { partition: account.partition, id, script });

const startPendingMainNavigationById = (account, id, url) => desktop.evaluate(({ session, webContents }, { partition, id, url }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.id === id);
  if (!contents || contents.isDestroyed()) throw new Error(`Missing WebContents ${id}`);
  const started = Date.now();
  const record = (event, details = {}) => globalThis.pendingNavigationEvents.push({ event, id,
    elapsedMs: Date.now() - started, loading: contents.isDestroyed() ? undefined : contents.isLoading(),
    waitingResponse: contents.isDestroyed() ? undefined : contents.isWaitingForResponse(),
    loadingMainFrame: contents.isDestroyed() ? undefined : contents.isLoadingMainFrame(), ...details });
  contents.on('did-start-navigation', details => record('did-start-navigation', {
    url: details.url, isMainFrame: details.isMainFrame, isSameDocument: details.isSameDocument }));
  contents.on('did-start-loading', () => record('did-start-loading'));
  contents.on('did-stop-loading', () => record('did-stop-loading'));
  contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => record('did-fail-load', {
    code, description, url: validatedUrl, isMainFrame }));
  contents.on('did-navigate', (_event, committedUrl) => record('did-navigate', { url: committedUrl }));
  globalThis.oneShotBlockedTargetUrls.add(url);
  record('loadURL-start', { url });
  void contents.loadURL(url).then(() => record('loadURL-resolved'), error => record('loadURL-rejected', {
    code: error.code, errno: error.errno, message: error.message }));
}, { partition: account.partition, id, url });

const waitSelector = (account, id, selector, label = `Selector ${selector} did not become ready`) => until(async () => {
  const contents = await contentsById(account, id);
  return !!contents && !contents.loading && await scriptIn(account, id, `!!document.querySelector(${JSON.stringify(selector)})`);
}, label);

const popupFor = account => desktop.evaluate(({ BrowserWindow, session }, partition) => {
  const isolated = session.fromPartition(partition);
  const popup = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && !window.webContents.getURL().startsWith('file:') && window.webContents.session === isolated);
  if (!popup) return null;
  return { id: popup.webContents.id, url: popup.webContents.getURL(), visible: popup.isVisible(), title: popup.webContents.getTitle() };
}, account.partition);

const appFilesContain = async needle => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const appFiles = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath ?? directory, entry.name))
    .filter(file => /runtime\.jsonl$|(?:^|[\\/])(?:workspace|runtime|conversations?|tasks?|accounts?|sessions?|notifications?|shortcuts?)[^\\/]*\.(?:sqlite|sqlite3|db|json)(?:-(?:wal|shm))?$/i.test(file));
  for (const file of appFiles) {
    const buffer = await readFile(file).catch(() => Buffer.alloc(0));
    if (buffer.includes(Buffer.from(needle))) return file;
  }
  return undefined;
};

const profileValue = (account, url, expression) => desktop.evaluate(async ({ session, webContents }, { partition, url, expression }) => {
  const isolated = session.fromPartition(partition);
  const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.getURL().startsWith(url));
  if (!contents) return null;
  return contents.mainFrame.executeJavaScript(expression);
}, { partition: account.partition, url, expression });

try {
  desktop = await bounded(electron.launch({ args: ['--no-sandbox', bootstrap], env }), 'Electron launch', 30000);
  desktopPid = desktop.process()?.pid;
  shellPage = await bounded(desktop.firstWindow(), 'First window');
  shellPage.setDefaultTimeout(15000);
  await bounded(shellPage.waitForFunction(() => !!window.workspace), 'Workspace bridge');

  const first = await rpc('accounts.create', { name: 'OAuth primary' }); primaryAccount = first;
  await until(async () => (await rpc('browser.inspect', { accountId: first.id })).editor, 'Primary account did not load');
  const second = await rpc('accounts.create', { name: 'OAuth secondary' });
  await until(async () => (await rpc('browser.inspect', { accountId: second.id })).editor, 'Secondary account did not load');
  await rpc('accounts.switch', { id: second.id });
  const secondHome = await selectedWebContents(second);
  await scriptIn(second, secondHome.id, "localStorage.setItem('partition-marker','secondary-only'); document.cookie='partition_marker=secondary; path=/';");
  await rpc('accounts.switch', { id: first.id });

  const lockedNav = await rpc('browser.navigate', { accountId: first.id, url: 'https://chatgpt.com/c/locked-queue' });
  await waitTask(lockedNav);
  const lockedTask = await rpc('tasks.create', { accountId: first.id, current: true, input: { type: 'prompt', prompt: 'HOLD:keep queue locked', submit: true }, background: true });
  await until(async () => !!(await rpc('tasks.get', { id: lockedTask.id })).submittedAt, 'Locked queue task did not submit');
  const lockedPage = (await rpc('workspace.status')).pages.find(page => page.accountId === first.id && page.url === 'https://chatgpt.com/c/locked-queue');
  assert.ok(lockedPage?.locked, 'Queue task locks only its target conversation page');

  const { page: oauthHome, contents: oauthHomeContents } = await openNewConversationContents(first, 'New OAuth page');
  await waitSelector(first, oauthHomeContents.id, '#google-login', 'Google login button did not become ready');
  await clickSelector(first, oauthHomeContents.id, '#google-login');
  await until(async () => (await contentsById(first, oauthHomeContents.id))?.url.startsWith('https://auth.openai.com/'), 'ChatGPT login click did not navigate to OpenAI auth');
  await clickSelector(first, oauthHomeContents.id, '#continue-google');
  await until(async () => (await contentsById(first, oauthHomeContents.id))?.url.startsWith('https://accounts.google.com/'), 'OpenAI auth did not navigate to Google');
  await waitSelector(first, oauthHomeContents.id, '#account-choice', 'Google account choice did not become ready');
  await clickSelector(first, oauthHomeContents.id, '#account-choice');
  await until(async () => (await contentsById(first, oauthHomeContents.id))?.url.startsWith('https://chatgpt.com/'), 'Google account choice did not return to ChatGPT');
  await until(async () => (await rpc('browser.inspect', { accountId: first.id, pageId: oauthHome.id })).readiness === 'ready', 'OAuth page did not return to ready ChatGPT');
  assert.equal((await rpc('tasks.get', { id: lockedTask.id })).status, 'running', 'Independent OAuth page must not stop the running queue');

  const { page: pendingGooglePage, contents: pendingGoogleContents } = await openNewConversationContents(first, 'Pending Google tab');
  await desktop.evaluate(({ session, webContents }, { partition, id }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
    if (!contents) throw new Error('Missing pending Google page');
    void contents.loadURL('https://accounts.google.com/o/oauth2/v2/auth?pending=1&redirect_uri=' + encodeURIComponent('https://auth.openai.com/callback')).catch(() => {});
  }, { partition: first.partition, id: pendingGoogleContents.id });
  await until(async () => (await contentsById(first, pendingGoogleContents.id))?.url.startsWith('https://accounts.google.com/'), 'Pending Google page did not load');
  await until(async () => await scriptIn(first, pendingGoogleContents.id, "!!document.querySelector('#account-choice')"), 'Pending Google page DOM did not become interactive');
  const pendingGoogleBefore = await contentsById(first, pendingGoogleContents.id);
  await new Promise(resolve => setTimeout(resolve, 1800));
  const pendingGoogleAfter = await contentsById(first, pendingGoogleContents.id);
  assert.equal(pendingGoogleAfter?.id, pendingGoogleBefore.id, 'Ready Google OAuth page with a pending iframe must not be replaced');
  assert.equal(pendingGoogleAfter?.url.startsWith('https://accounts.google.com/'), true, 'Ready Google OAuth page with a pending iframe must stay on Google');
  await clickSelector(first, pendingGoogleContents.id, '#account-choice');
  await until(async () => (await contentsById(first, pendingGoogleContents.id))?.url.startsWith('https://chatgpt.com/'), 'Pending Google page account click did not complete OAuth');

  const { page: pendingMainPage, contents: pendingMainContents } = await openNewConversationContents(first, 'Pending main tab');
  await desktop.evaluate(({ session, webContents }, { partition, id }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
    if (!contents) throw new Error('Missing pending main page');
    void contents.loadURL('https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=' + encodeURIComponent('https://auth.openai.com/callback')).catch(() => {});
  }, { partition: first.partition, id: pendingMainContents.id });
  await until(async () => (await contentsById(first, pendingMainContents.id))?.url.startsWith('https://accounts.google.com/'), 'Pending main Google page did not load');
  await waitSelector(first, pendingMainContents.id, '#account-choice', 'Pending main Google page must finish its original document load');
  const chatCallbackUrl = 'https://chatgpt.com/?code=syntheticsecret&state=pending-main';
  await startPendingMainNavigationById(first, pendingMainContents.id, chatCallbackUrl);
  await until(async () => {
    const pendingMain = await contentsById(first, pendingMainContents.id);
    return !!pendingMain?.loading && pendingMain.waitingResponse && pendingMain.loadingMainFrame;
  }, 'Real callback navigation must wait for a main-frame response');
  await until(async () => {
    const page = (await rpc('workspace.status')).pages.find(page => page.id === pendingMainPage.id);
    const restored = await selectedWebContents(first);
    return !!page && page.url === chatCallbackUrl && !!restored && restored.id !== pendingMainContents.id && restored.url === chatCallbackUrl && !restored.loading;
  }, 'Pending ChatGPT callback navigation should recreate the same tab at the requested target rather than the old Google URL');
  const pendingMainRestored = (await rpc('workspace.status')).pages.find(page => page.id === pendingMainPage.id);
  assert.equal(pendingMainRestored?.url.startsWith('https://accounts.google.com/'), false,
    'Pending ChatGPT callback navigation must not restore the old Google URL');
  assert.equal((await rpc('workspace.status')).page?.id, pendingMainPage.id, 'Callback recovery preserves the selected tab');
  assert.equal((await rpc('tasks.get', { id: lockedTask.id })).status, 'running', 'Callback recovery preserves the sibling queue');

  const apiCallbackUrl = 'https://chatgpt.com/api/auth/callback?code=syntheticsecret&state=leak-check';
  const { page: callbackLeakPage, contents: callbackLeakContents } = await openNewConversationContents(first, 'Callback leak tab');
  await desktop.evaluate(({ session, webContents }, { partition, id, url }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
    if (!contents) throw new Error('Missing callback leak page');
    void contents.loadURL(url).catch(() => {});
  }, { partition: first.partition, id: callbackLeakContents.id, url: apiCallbackUrl });
  await until(async () => (await contentsById(first, callbackLeakContents.id))?.url.startsWith('https://chatgpt.com/api/auth/callback'), 'ChatGPT callback URL did not stay visible for leak check');

  const { page: reloadAuthPage, contents: reloadAuthContents } = await openNewConversationContents(first, 'Reload auth tab');
  await desktop.evaluate(({ session, webContents }, { partition, id }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
    if (!contents) throw new Error('Missing reload auth page');
    void contents.loadURL('https://auth.openai.com/login?reload=1').catch(() => {});
  }, { partition: first.partition, id: reloadAuthContents.id });
  await until(async () => (await contentsById(first, reloadAuthContents.id))?.url.startsWith('https://auth.openai.com/'), 'Reload auth page did not reach auth');
  await rpc('browser.select', { accountId: first.id, pageId: reloadAuthPage.id });
  await rpc('browser.control', { accountId: first.id, action: 'reload' });
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal((await contentsById(first, reloadAuthContents.id))?.url.startsWith('https://auth.openai.com/'), true, 'Manual reload on OAuth page must preserve the current OAuth URL');

  await rpc('browser.select', { accountId: first.id, pageId: lockedPage.id });
  const lockedContents = await webContentsFor(first, 'https://chatgpt.com/c/locked-queue');
  await desktop.evaluate(({ session, webContents }, { partition, id }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
    if (!contents) throw new Error('Missing locked contents');
    void contents.loadURL('https://auth.openai.com/login?connection=google&return_to=https%3A%2F%2Fchatgpt.com%2Fc%2Flocked-queue').catch(() => {});
  }, { partition: first.partition, id: lockedContents.id });
  await until(async () => (await contentsById(first, lockedContents.id))?.url.startsWith('https://auth.openai.com/'), 'Locked page did not reach auth');
  await clickSelector(first, lockedContents.id, '#continue-google');
  await until(async () => (await contentsById(first, lockedContents.id))?.url.startsWith('https://accounts.google.com/'), 'Locked auth page could not click through to Google');
  await waitSelector(first, lockedContents.id, '#account-choice', 'Locked Google account choice did not become ready');
  await clickSelector(first, lockedContents.id, '#account-choice');
  await until(async () => (await contentsById(first, lockedContents.id))?.url.startsWith('https://chatgpt.com/'), 'Locked page OAuth did not return to ChatGPT');
  const lockedAfterOAuth = (await rpc('workspace.status')).pages.find(page => page.id === lockedPage.id);
  assert.ok(lockedAfterOAuth?.locked, 'Locked task remains attached after manual OAuth returns to ChatGPT');

  const { page: popupPage, contents: popupContents } = await openNewConversationContents(first, 'Popup tab');
  await waitSelector(first, popupContents.id, '#popup-login', 'Popup login button did not become ready');
  await clickSelector(first, popupContents.id, '#popup-login');
  await until(async () => !!await popupFor(first), 'OAuth popup was not created');
  await until(async () => (await popupFor(first))?.url.startsWith('https://accounts.google.com/'), 'OAuth popup did not load Google');
  let popup = await popupFor(first);
  assert.equal(popup.visible, true, 'OAuth popup must remain visible while another conversation is locked');
  await waitSelector(first, popup.id, '#account-choice', 'Popup Google account choice did not become ready');
  await clickSelector(first, popup.id, '#account-choice');
  await until(async () => { const current = await popupFor(first); return !current || current.url.startsWith('https://auth.openai.com/callback') || current.url.startsWith('https://chatgpt.com/'); }, 'Popup Google account choice did not proceed');

  const { page: postPage, contents: postContents } = await openNewConversationContents(first, 'POST tab');
  await desktop.evaluate(({ session, webContents }, { partition, id }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
    if (!contents) throw new Error('Missing POST test page');
    void contents.loadURL('https://auth.openai.com/login?post=1').catch(() => {});
  }, { partition: first.partition, id: postContents.id });
  await until(async () => (await contentsById(first, postContents.id))?.url.startsWith('https://auth.openai.com/'), 'POST test did not reach auth');
  await clickSelector(first, postContents.id, '#post-callback-button');
  await until(async () => (await contentsById(first, postContents.id))?.url.startsWith('https://chatgpt.com/'), 'POST callback did not return to ChatGPT');
  assert.ok(await desktop.evaluate(() => globalThis.oauthRequests.some(request => request.method === 'POST' && request.url.startsWith('https://auth.openai.com/callback'))), 'OAuth callback POST was not observed');

  const { page: externalPage, contents: externalContents } = await openNewConversationContents(first, 'External test tab');
  await waitSelector(first, externalContents.id, '#external-link', 'External link button did not become ready');
  await clickSelector(first, externalContents.id, '#external-link');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await contentsById(first, externalContents.id)).url.startsWith('https://chatgpt.com/'), true, 'Untrusted external navigation must stay inside ChatGPT page');
  assert.equal(await desktop.evaluate(() => globalThis.oauthRequests.some(request => request.url.startsWith('https://evil.example/'))), false, 'Untrusted external host must not load in the account partition');
  assert.equal(await desktop.evaluate(() => globalThis.externalOpenAttempts.some(item => item.kind === 'openExternal')), false, 'Cancelled external confirmation must not open the system browser');

  const secondaryMarker = await profileValue(second, 'https://chatgpt.com/', "localStorage.getItem('partition-marker')");
  assert.equal(secondaryMarker, 'secondary-only', 'OAuth flow must not mutate another account partition');
  assert.equal(await profileValue(second, 'https://accounts.google.com/', "localStorage.getItem('google-selected-account')"), null, 'Google selection stays inside the OAuth account partition');

  const leakedFile = await appFilesContain('syntheticsecret');
  assert.equal(leakedFile, undefined, 'Synthetic OAuth code must not be persisted to app DB or runtime logs');

  await desktop.evaluate(({ session, webContents }, { partition, id }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
    if (contents && !contents.isDestroyed()) void contents.executeJavaScript('window.fixtureFinish && window.fixtureFinish()');
  }, { partition: first.partition, id: lockedContents.id });
  passed = true;
  console.log(JSON.stringify({ pendingNavigationEvents: await desktop.evaluate(() => globalThis.pendingNavigationEvents) }));
  console.log('OAuth interaction passed: queued sibling pages stay locked, independent and locked OAuth pages accept mouse account selection, popup login remains visible, callback POST returns, external hosts are denied, and account partitions remain isolated.');
} catch (error) {
  const diagnostic = await desktop?.evaluate(({ BrowserWindow, session, webContents }, partition) => {
    const isolated = partition ? session.fromPartition(partition) : null;
    return { requests: globalThis.oauthRequests?.slice(-30), externalOpenAttempts: globalThis.externalOpenAttempts,
      pendingNavigationEvents: globalThis.pendingNavigationEvents,
      accountWebContents: isolated ? webContents.getAllWebContents().filter(item => item.session === isolated).map(item => ({ id: item.id, type: item.getType(), url: item.getURL(), title: item.getTitle(), loading: item.isLoading(), destroyed: item.isDestroyed() })) : [],
      windows: BrowserWindow.getAllWindows().map(window => ({ id: window.webContents.id, url: window.webContents.getURL(), visible: window.isVisible(), destroyed: window.isDestroyed(), title: window.webContents.getTitle() })) };
  }, primaryAccount?.partition).catch(error => ({ error: String(error) }));
  console.error(JSON.stringify(diagnostic, null, 2));
  throw error;
} finally {
  try { if (desktop) await bounded(desktop.close(), 'Fixture shutdown', 10000); }
  catch { if (desktopPid) { try { process.kill(desktopPid); } catch {} } }
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root);
  assert.ok(path.basename(target).startsWith('.test-oauth-interaction-'));
  await rm(target, { recursive: true, force: true });
  if (!passed) process.exitCode = 1;
}
