import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-custom-link-'));
const bootstrap = path.join(directory, 'fixture.cjs');
const mainEntry = process.env.WORKSPACE_TEST_MAIN_CJS || path.join(root, 'dist-electron/main.cjs');
const callbackUrl = 'http://127.0.0.1:39123/callback';
const secret = 'syntheticsecret-custom-link';
const authStartUrl = 'https://auth.example/start?redirect_uri=' + encodeURIComponent(callbackUrl) + '&state=custom-state&scope=openid';
const duplicateRedirectUrl = 'https://auth.example/start?redirect_uri=' + encodeURIComponent(callbackUrl) + '&redirect_uri=' + encodeURIComponent('http://127.0.0.1:39124/callback');

const chatPage = `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT custom link fixture</title></head><body>
<main><h1>ChatGPT fixture</h1><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><button id="external-after-stable">External after stable</button><div id="messages"></div></main>
<script>
const historyKey = () => 'custom-link-history:' + location.pathname;
let messages = JSON.parse(localStorage.getItem(historyKey()) || '[]');
function render(){ const box=document.querySelector('#messages'); box.replaceChildren(); for(const message of messages){ const article=document.createElement('article'); const div=document.createElement('div'); div.dataset.messageAuthorRole=message.role; div.dataset.messageId=message.id; div.textContent=message.text; article.append(div); if(message.role==='assistant'&&message.finished){ const copy=document.createElement('button'); copy.dataset.testid='copy-turn-action-button'; copy.textContent='Copy'; article.append(copy); } box.append(article); } localStorage.setItem(historyKey(), JSON.stringify(messages)); }
render();
document.querySelector('#external-after-stable').onclick=()=>{ location.href='https://evil.example/after-stable'; };
document.querySelector('[data-testid="send-button"]').addEventListener('click', () => { const composer=document.querySelector('#prompt-textarea'); const value=composer.value; window.fixtureSendCount=(window.fixtureSendCount||0)+1; composer.value=''; messages.push({role:'user',id:crypto.randomUUID(),text:value}); messages.push({role:'assistant',id:crypto.randomUUID(),text:'Fixture reply: '+value,finished:false}); const stop=document.createElement('button'); stop.dataset.testid='stop-button'; stop.textContent='Stop'; document.querySelector('main').append(stop); render(); window.fixtureFinish=()=>{messages.at(-1).finished=true; stop.remove(); render();}; if(!value.startsWith('HOLD:')) setTimeout(()=>window.fixtureFinish(),80); });
</script></body></html>`;

const authPage = `<!doctype html><html><head><meta charset="utf-8"><title>Custom Auth fixture</title></head><body><main>
<h1>Custom Auth</h1><p id="current-url"></p>
<button id="google">Google</button><button id="callback-ok">Callback OK</button><button id="chatgpt-fragment">ChatGPT fragment callback</button><button id="callback-wrong-port">Wrong callback port</button><button id="callback-wrong-path">Wrong callback path</button><button id="blank-popup">Blank popup</button><button id="external-https">External HTTPS</button>
<script>
const params = new URL(location.href).searchParams;
const callback = params.get('redirect_uri') || ${JSON.stringify(callbackUrl)};
document.querySelector('#current-url').textContent = location.href;
if (params.get('title_secret') === '1') document.title = 'Auth title ${secret}';
localStorage.setItem('auth-marker','primary-auth'); document.cookie='auth_marker=primary; path=/';
document.querySelector('#google').onclick=()=>{ location.href='https://accounts.google.com/o/oauth2/v2/auth?redirect_uri='+encodeURIComponent(callback)+'&state=from-auth'; };
document.querySelector('#callback-ok').onclick=()=>{ location.href=callback+'?code=${secret}&state=from-auth'; };
document.querySelector('#chatgpt-fragment').onclick=()=>{ location.href='https://chatgpt.com/#access_token=${secret}&state=fragment-state'; };
document.querySelector('#callback-wrong-port').onclick=()=>{ location.href='http://127.0.0.1:39124/callback?code=${secret}&state=wrong-port'; };
document.querySelector('#callback-wrong-path').onclick=()=>{ location.href='http://127.0.0.1:39123/wrong?code=${secret}&state=wrong-path'; };
document.querySelector('#blank-popup').onclick=()=>{ const popup=window.open('about:blank','custom-link-blank'); popup.document.write('<!doctype html><title>Blank Popup</title><h1 id="popup-ready">Blank Popup</h1><script>document.body.dataset.processType=typeof process;document.body.dataset.requireType=typeof require;document.body.dataset.workspaceType=typeof window.workspace;<\\/script>'); popup.document.close(); };
document.querySelector('#external-https').onclick=()=>{ location.href='https://evil.example/external-before-chatgpt'; };
</script></main></body></html>`;

const googlePage = `<!doctype html><html><head><meta charset="utf-8"><title>Google fixture</title></head><body><main>
<h1>Choose an account</h1><button id="account-choice" data-email="fixture@example.com">fixture@example.com</button>
<script>localStorage.setItem('google-marker','primary-google'); document.querySelector('#account-choice').addEventListener('click',()=>{ const redirect=new URL(location.href).searchParams.get('redirect_uri') || ${JSON.stringify(callbackUrl)}; location.href=redirect+'?code=${secret}&state='+encodeURIComponent(new URL(location.href).searchParams.get('state')||'google'); });</script>
</main></body></html>`;

const callbackPage = `<!doctype html><html><head><meta charset="utf-8"><title>Loopback callback fixture</title></head><body><main><h1>Loopback Callback</h1><script>document.title='Loopback title ${secret}'; localStorage.setItem('callback-url', location.href); setTimeout(()=>{ location.href='https://chatgpt.com/'; }, 25);</script></main></body></html>`;

await writeFile(bootstrap, `const { app, Notification, dialog, shell } = require('electron');
Notification.isSupported = () => false;
globalThis.customLinkRequests = [];
globalThis.customLinkExternalAttempts = [];
dialog.showMessageBox = async (_window, options) => { globalThis.customLinkExternalAttempts.push({ kind: 'dialog', message: options.message, detail: options.detail }); return { response: 0 }; };
shell.openExternal = async url => { globalThis.customLinkExternalAttempts.push({ kind: 'openExternal', url }); };
app.on('browser-window-created', (_, win) => { win.webContents.setBackgroundThrottling(false); win.setSkipTaskbar(true); if (process.platform === 'win32') win.setPosition(-20000, -20000); });
app.on('session-created', isolated => {
  const handler = async request => {
    const url = new URL(request.url); globalThis.customLinkRequests.push({ url: request.url, method: request.method });
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '39123' && url.pathname === '/callback') return new Response(${JSON.stringify(callbackPage)}, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
    if (url.hostname === 'chatgpt.com') return new Response(${JSON.stringify(chatPage)}, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
    if (url.hostname === 'auth.example') return new Response(${JSON.stringify(authPage)}, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
    if (url.hostname === 'accounts.google.com') return new Response(${JSON.stringify(googlePage)}, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
    return new Response('<!doctype html><title>External fixture</title><h1 id="external-loaded">External loaded</h1>', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  };
  isolated.protocol.handle('https', handler);
  isolated.protocol.handle('http', handler);
});
require(${JSON.stringify(mainEntry)});`);

const env = { ...process.env, WORKSPACE_USER_DATA: directory, WORKSPACE_HIDDEN_PAGE_IDLE_MS: '3600000', WORKSPACE_PAGE_IDLE_MS: '3600000', WORKSPACE_PAGE_LOAD_TIMEOUT_MS: '600' };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;

let desktop;
let shellPage;
let desktopPid;
let passed = false;

function bounded(promise, label, ms = 20000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (!await check()) { assert.ok(Date.now() < deadline, label); await pause(100); }
};
const appFiles = async () => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath ?? directory, entry.name))
    .filter(file => /runtime\.jsonl$|(?:^|[\\/])(?:workspace|runtime|conversations?|tasks?|accounts?|sessions?|notifications?|shortcuts?)[^\\/]*\.(?:sqlite|sqlite3|db|json)(?:-(?:wal|shm))?$/i.test(file));
};
const appFilesContain = async needle => {
  for (const file of await appFiles()) {
    const buffer = await readFile(file).catch(() => Buffer.alloc(0));
    if (buffer.includes(Buffer.from(needle))) return file;
  }
  return undefined;
};

async function launch() {
  desktop = await bounded(electron.launch({ args: ['--no-sandbox', bootstrap], env }), 'Electron launch', 30000);
  desktopPid = desktop.process()?.pid;
  shellPage = await bounded(desktop.firstWindow(), 'First window');
  shellPage.setDefaultTimeout(15000);
  await bounded(shellPage.waitForFunction(() => !!window.workspace), 'Workspace bridge');
}
const rpc = (method, params = {}) => bounded(shellPage.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params }), method);
const waitTask = task => until(async () => {
  const current = await rpc('tasks.get', { id: task.id });
  assert.ok(!['failed', 'blocked', 'waiting_user', 'uncertain'].includes(current.status), current.error ?? current.status);
  return current.status === 'done';
}, `Task ${task.id} did not finish`);
const contentsById = (account, id) => desktop.evaluate(({ session, webContents }, { partition, id }) => {
  const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
  if (!contents || contents.isDestroyed()) return null;
  return { id: contents.id, url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading() };
}, { partition: account.partition, id });
const scriptIn = (account, id, script) => desktop.evaluate(({ session, webContents }, { partition, id, script }) => {
  const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
  if (!contents || contents.isDestroyed()) throw new Error(`Missing WebContents ${id}`);
  return contents.mainFrame.executeJavaScript(script);
}, { partition: account.partition, id, script });
const waitSelector = (account, id, selector, label = `Selector ${selector} did not become ready`) => until(async () => {
  const contents = await contentsById(account, id);
  if (!contents || contents.loading) return false;
  return await scriptIn(account, id, `!!document.querySelector(${JSON.stringify(selector)})`);
}, label);
const clickSelector = (account, id, selector) => desktop.evaluate(async ({ app, BrowserWindow, session, webContents }, { partition, id, selector }) => {
  const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
  if (!contents || contents.isDestroyed()) throw new Error(`Missing WebContents ${id}`);
  const rect = await contents.mainFrame.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: el.textContent }; })()`);
  if (!rect) throw new Error(`Missing selector ${selector} at ${contents.getURL()}`);
  // Focus the existing visible native host; showing a hidden popup here would
  // hide a runtime visibility failure and weaken the real interaction test.
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
const currentContents = async account => {
  await rpc('browser.inspect', { accountId: account.id }).catch(() => undefined);
  const state = await rpc('workspace.status');
  const page = state.page?.accountId === account.id ? state.page
    : state.pages.find(item => item.accountId === account.id && item.selected) ?? state.pages.find(item => item.accountId === account.id);
  assert.ok(page?.id, 'No selected page');
  // Workspace page IDs are UUIDs, unlike native WebContents IDs. Find the
  // attached account view so two tabs with the same URL cannot select each other.
  const attached = await desktop.evaluate(({ BrowserWindow, session }, partition) => {
    const isolated = session.fromPartition(partition);
    const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().startsWith('file:'));
    const view = window?.contentView.children.find(view => view.webContents && !view.webContents.isDestroyed() && view.webContents.session === isolated);
    if (!view) return null;
    return { id: view.webContents.id, url: view.webContents.getURL(), title: view.webContents.getTitle(), loading: view.webContents.isLoading() };
  }, account.partition);
  assert.ok(attached, 'Selected account page should be attached to the main window');
  return attached;
};
const requestCount = pattern => desktop.evaluate((_, pattern) => globalThis.customLinkRequests.filter(item => item.url.includes(pattern)).length, pattern);
const externalAttempts = () => desktop.evaluate(() => globalThis.customLinkExternalAttempts);
const externalAttemptCount = async pattern => (await externalAttempts()).filter(item => JSON.stringify(item).includes(pattern)).length;
const profileValue = (account, urlPrefix, expression) => desktop.evaluate(({ session, webContents }, { partition, urlPrefix, expression }) => {
  const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.getURL().startsWith(urlPrefix));
  if (!contents || contents.isDestroyed()) return null;
  return contents.mainFrame.executeJavaScript(expression);
}, { partition: account.partition, urlPrefix, expression });
const popupFor = account => desktop.evaluate(({ BrowserWindow, session }, partition) => {
  const isolated = session.fromPartition(partition);
  const popup = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && !window.webContents.getURL().startsWith('file:') && window.webContents.session === isolated);
  if (!popup) return null;
  return { id: popup.webContents.id, url: popup.webContents.getURL(), title: popup.webContents.getTitle(), visible: popup.isVisible() };
}, account.partition);
const expectReject = async (method, params, message) => {
  await assert.rejects(() => rpc(method, params), error => {
    assert.match(String(error?.message ?? error), message);
    return true;
  });
};
const openCustomLink = async (account, url, selector, label) => {
  const page = await rpc('browser.openLink', { accountId: account.id, url });
  await until(async () => (await rpc('workspace.status')).page?.id === page.id, `${label} custom-link tab was not selected`);
  let contents;
  await until(async () => {
    contents = await currentContents(account);
    return !!contents && contents.url.startsWith(new URL(url).origin);
  }, `${label} custom-link WebContents did not attach`);
  await waitSelector(account, contents.id, selector, `${label} custom-link page did not become ready`);
  return { page, contents };
};

try {
  await launch();
  const primary = await rpc('accounts.create', { name: 'Custom link primary' });
  await until(async () => (await rpc('browser.inspect', { accountId: primary.id })).editor, 'Primary account did not load');
  const secondary = await rpc('accounts.create', { name: 'Custom link secondary' });
  await until(async () => (await rpc('browser.inspect', { accountId: secondary.id })).editor, 'Secondary account did not load');
  await rpc('accounts.switch', { id: secondary.id });
  const secondaryHome = await currentContents(secondary);
  await scriptIn(secondary, secondaryHome.id, "localStorage.setItem('partition-marker','secondary-only'); document.cookie='partition_marker=secondary; path=/';");
  await rpc('accounts.switch', { id: primary.id });

  const lockedNav = await rpc('browser.navigate', { accountId: primary.id, url: 'https://chatgpt.com/c/running-custom-link-queue' });
  await waitTask(lockedNav);
  const lockedTask = await rpc('tasks.create', { accountId: primary.id, current: true, input: { type: 'prompt', prompt: 'HOLD:keep queue running during auth', submit: true }, background: true });
  await until(async () => !!(await rpc('tasks.get', { id: lockedTask.id })).submittedAt, 'Locked queue task did not submit');
  const lockedBefore = await rpc('tasks.get', { id: lockedTask.id });
  assert.equal(lockedBefore.status, 'running', 'Fixture queue task should be running before opening a custom link');
  const stateBeforeOpen = await rpc('workspace.status');
  const primaryPagesBeforeOpen = stateBeforeOpen.pages.filter(page => page.accountId === primary.id).length;

  const addressInput = shellPage.locator('.page-url input, input[placeholder*="链接"], input[title*="新标签页"]').first();
  await addressInput.waitFor({ state: 'visible' });
  await addressInput.fill(authStartUrl);
  await addressInput.press('Enter');
  await until(async () => (await rpc('workspace.status')).pages.filter(page => page.accountId === primary.id).length === primaryPagesBeforeOpen + 1,
    'Address bar Enter did not open a new custom-link tab');
  let authContents = await currentContents(primary);
  await until(async () => (authContents = await currentContents(primary)).url.startsWith('https://auth.example/start'), 'Custom link did not load auth.example');
  let authPageId = (await rpc('workspace.status')).page.id;
  await waitSelector(primary, authContents.id, '#google', 'Custom auth controls did not become ready');
  assert.equal((await rpc('tasks.get', { id: lockedTask.id })).status, 'running', 'Opening a custom link must not alter an independent running queue');

  const primaryAuthMarker = await scriptIn(primary, authContents.id, "localStorage.getItem('auth-marker')");
  assert.equal(primaryAuthMarker, 'primary-auth', 'Primary profile stores auth fixture state');
  const secondaryAuthState = await desktop.evaluate(async ({ session }, partition) => {
    const cookies = await session.fromPartition(partition).cookies.get({ url: 'https://auth.example/' });
    return { cookies: cookies.map(cookie => cookie.name) };
  }, secondary.partition);
  assert.deepEqual(secondaryAuthState.cookies, [], 'Custom link state stays isolated from the second account profile');
  assert.equal(await profileValue(secondary, 'https://chatgpt.com/', "localStorage.getItem('partition-marker')"), 'secondary-only', 'Second account ChatGPT storage survives primary custom-link browsing');

  await expectReject('browser.openLink', { accountId: primary.id, url: 'http://auth.example/start' }, /https/);
  await expectReject('browser.openLink', { accountId: primary.id, url: 'https://user:pass@auth.example/start' }, /https|链接/);
  await expectReject('browser.openLink', { accountId: primary.id, url: 'javascript:alert(1)' }, /https|链接/);
  await expectReject('browser.openLink', { accountId: primary.id, url: 'file:///C:/secret.txt' }, /https|链接/);
  await expectReject('browser.openLink', { accountId: primary.id, url: 'https://auth.example/' + 'x'.repeat(17000) }, /1–16384|链接/);
  await expectReject('browser.openLink', { accountId: primary.id, url: duplicateRedirectUrl }, /redirect_uri|授权/);

  await clickSelector(primary, authContents.id, '#callback-wrong-port');
  await pause(400);
  assert.equal(await requestCount('127.0.0.1:39124/callback'), 0, 'Wrong loopback port must be blocked before it reaches the network layer');
  assert.ok((await contentsById(primary, authContents.id)).url.startsWith('https://auth.example/'), 'Wrong loopback port keeps the custom-link tab on auth page');
  await clickSelector(primary, authContents.id, '#callback-wrong-path');
  await pause(400);
  assert.equal(await requestCount('127.0.0.1:39123/wrong'), 0, 'Wrong loopback path must be blocked before it reaches the network layer');
  assert.ok((await contentsById(primary, authContents.id)).url.startsWith('https://auth.example/'), 'Wrong loopback path keeps the custom-link tab on auth page');

  await clickSelector(primary, authContents.id, '#blank-popup');
  await until(async () => !!await popupFor(primary), 'Blank popup did not open');
  const popup = await popupFor(primary);
  await until(async () => await scriptIn(primary, popup.id,
    "!!document.querySelector('#popup-ready') && !!document.body && ['processType', 'requireType', 'workspaceType'].every(key => Object.prototype.hasOwnProperty.call(document.body.dataset, key))"),
  'Blank popup DOM and security markers did not become ready');
  const popupSecurity = await scriptIn(primary, popup.id, "({ processType: document.body.dataset.processType, requireType: document.body.dataset.requireType, workspaceType: document.body.dataset.workspaceType })");
  assert.deepEqual(popupSecurity, { processType: 'undefined', requireType: 'undefined', workspaceType: 'undefined' }, 'Blank custom-link popup runs without Node, require, or workspace IPC');

  await clickSelector(primary, authContents.id, '#external-https');
  await until(async () => (await contentsById(primary, authContents.id))?.url.startsWith('https://evil.example/external-before-chatgpt') ?? false,
    'Custom-link mode should permit HTTPS auth-provider hops before ChatGPT is reached');
  await desktop.evaluate(({ session, webContents }, { partition, id, url }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
    if (!contents || contents.isDestroyed()) throw new Error('Missing auth tab after external hop');
    void contents.loadURL(url).catch(() => {});
  }, { partition: primary.partition, id: authContents.id, url: authStartUrl });
  await waitSelector(primary, authContents.id, '#google', 'Custom auth page did not reload after external hop');

  const titleLeakUrl = authStartUrl + '&title_secret=1';
  const { page: titleLeakPage, contents: titleLeakContents } = await openCustomLink(primary, titleLeakUrl, '#callback-ok', 'Title-secret');
  await until(async () => (await contentsById(primary, titleLeakContents.id))?.title.includes(secret), 'Auth page title did not include the synthetic secret');
  await pause(300);
  assert.ok(await appFilesContain(secret) === undefined, 'Auth page title containing a secret must not be persisted by tab storage or runtime logs');
  await clickSelector(primary, titleLeakContents.id, '#callback-ok');
  await until(async () => (await contentsById(primary, titleLeakContents.id))?.url.startsWith('https://chatgpt.com/'), 'Title-secret loopback callback did not return to ChatGPT');
  await waitSelector(primary, titleLeakContents.id, '#prompt-textarea', 'Title-secret callback did not become stable ChatGPT');
  assert.ok(await appFilesContain(secret) === undefined, 'Loopback callback title containing a secret must not be persisted by tab storage or runtime logs');
  await rpc('browser.closePage', { accountId: primary.id, pageId: titleLeakPage.id });
  await rpc('browser.select', { accountId: primary.id, pageId: authPageId });
  authContents = await currentContents(primary);
  await waitSelector(primary, authContents.id, '#google', 'Original auth tab was not ready after title-secret regression');

  const { page: fragmentPage, contents: fragmentContents } = await openCustomLink(primary, authStartUrl, '#chatgpt-fragment', 'Fragment-token');
  await clickSelector(primary, fragmentContents.id, '#chatgpt-fragment');
  await until(async () => (await contentsById(primary, fragmentContents.id))?.url.startsWith('https://chatgpt.com/#access_token='), 'Fragment-token ChatGPT callback did not load');
  await waitSelector(primary, fragmentContents.id, '#external-after-stable', 'Fragment-token ChatGPT page did not expose test navigation');
  assert.ok(await appFilesContain(secret) === undefined, 'ChatGPT fragment token must not be persisted before the page becomes stable');
  await clickSelector(primary, fragmentContents.id, '#external-after-stable');
  await until(async () => (await contentsById(primary, fragmentContents.id))?.url.startsWith('https://evil.example/after-stable'),
    'ChatGPT URL with token fragment must keep temporary custom-link navigation until a stable ChatGPT page commits');
  await desktop.evaluate(({ session, webContents }, { partition, id }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
    if (!contents || contents.isDestroyed()) throw new Error('Missing fragment token page');
    void contents.loadURL('https://chatgpt.com/').catch(() => {});
  }, { partition: primary.partition, id: fragmentContents.id });
  await waitSelector(primary, fragmentContents.id, '#external-after-stable', 'Fragment-token stable ChatGPT page did not reload');
  const fragmentExternalAttempts = await externalAttemptCount('evil.example/after-stable');
  await clickSelector(primary, fragmentContents.id, '#external-after-stable');
  await until(async () => await externalAttemptCount('evil.example/after-stable') > fragmentExternalAttempts,
    'Stable ChatGPT page after the fragment callback did not handle this external navigation');
  assert.ok((await contentsById(primary, fragmentContents.id)).url.startsWith('https://chatgpt.com/'),
    'A stable ChatGPT page after a fragment-token callback must revoke temporary custom-link navigation');
  await rpc('browser.closePage', { accountId: primary.id, pageId: fragmentPage.id });
  await rpc('browser.closePage', { accountId: primary.id, pageId: authPageId }).catch(() => undefined);
  const reopenedAuth = await openCustomLink(primary, authStartUrl, '#google', 'Main success auth');
  authPageId = reopenedAuth.page.id;
  authContents = reopenedAuth.contents;

  await clickSelector(primary, authContents.id, '#google');
  await until(async () => (await contentsById(primary, authContents.id))?.url.startsWith('https://accounts.google.com/') ?? false, 'Auth page did not navigate to Google');
  await waitSelector(primary, authContents.id, '#account-choice', 'Google account chooser did not become ready');
  await clickSelector(primary, authContents.id, '#account-choice');
  await until(async () => (await contentsById(primary, authContents.id))?.url.startsWith('https://chatgpt.com/') ?? false, 'Exact loopback callback did not return to ChatGPT');
  await waitSelector(primary, authContents.id, '#prompt-textarea', 'ChatGPT did not become ready after loopback callback');
  assert.ok(await appFilesContain(secret) === undefined, 'Authorization callback secret must not be written to runtime storage or logs');
  assert.ok(await appFilesContain(authStartUrl) === undefined, 'Custom authorization link must not be written to runtime storage or logs');

  const strictExternalAttempts = await externalAttemptCount('evil.example/after-stable');
  await clickSelector(primary, authContents.id, '#external-after-stable');
  await until(async () => await externalAttemptCount('evil.example/after-stable') > strictExternalAttempts,
    'Strict-mode external handling did not record this navigation attempt');
  const afterStrict = await contentsById(primary, authContents.id);
  assert.ok(afterStrict.url.startsWith('https://chatgpt.com/'), 'After returning to stable ChatGPT, the tab must restore strict ChatGPT-only navigation');
  const attempts = await externalAttempts();
  assert.ok(attempts.some(item => JSON.stringify(item).includes('evil.example/after-stable')), 'Strict-mode external navigation should be routed to external handling');

  const stableState = await rpc('workspace.status');
  const selectedBeforeRestart = stableState.page;
  assert.ok(stableState.pages.some(page => page.accountId === primary.id && page.id === selectedBeforeRestart.id), 'Custom-link tab remains part of the primary account before restart');
  assert.equal((await rpc('tasks.get', { id: lockedTask.id })).status, 'running', 'Queue task remains running before restart persistence check');
  await desktop.evaluate(async ({ session, webContents }, { partition, url }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.getURL() === url);
    if (!contents || contents.isDestroyed()) throw new Error('Missing locked queue page before restart');
    await contents.mainFrame.executeJavaScript('window.fixtureFinish?.()');
  }, { partition: primary.partition, url: 'https://chatgpt.com/c/running-custom-link-queue' });
  await waitTask(lockedTask);

  await bounded(desktop.evaluate(({ app }) => app.quit()), 'App quit before restart', 5000).catch(() => undefined);
  await bounded(desktop.close(), 'Close before restart', 15000).catch(() => undefined);
  desktop = undefined; shellPage = undefined;
  await launch();
  await until(async () => (await rpc('workspace.status')).accounts.length >= 2, 'Accounts did not restore after restart');
  const restored = await rpc('workspace.status');
  assert.ok(restored.accounts.some(account => account.id === primary.id), 'Primary account restores after restart');
  assert.ok(restored.accounts.some(account => account.id === secondary.id), 'Secondary account restores after restart');
  assert.ok(restored.pages.some(page => page.accountId === primary.id), 'Primary account tabs restore after restart');
  assert.ok(restored.pages.every(page => !page.url.includes(secret) && !page.url.includes('auth.example/start')), 'Persisted tabs must not keep custom-link secrets or auth URLs');
  assert.ok(await appFilesContain(secret) === undefined, 'Restarted profile storage must not contain callback secret');

  passed = true;
  console.log('Custom link desktop passed: address-bar links open isolated auth tabs, permit only expected auth hops/callbacks, sandbox popups, preserve queues, restore strict mode, and avoid persisting secrets.');
} finally {
  try { if (desktop) await bounded(desktop.close(), 'Fixture shutdown', 10000); }
  catch { if (desktopPid) process.kill(desktopPid); }
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root); assert.ok(path.basename(target).startsWith('.test-custom-link-'));
  for (let attempt = 0; attempt < 10; attempt++) {
    try { await rm(target, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 9) console.warn('Fixture data cleanup delayed:', error.code); else await pause(300); }
  }
  if (!passed) process.exitCode = 1;
}
