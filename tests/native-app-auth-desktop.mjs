import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-native-app-auth-'));
const bootstrap = path.join(directory, 'fixture.cjs');
const mainEntry = process.env.WORKSPACE_TEST_MAIN_CJS || path.join(root, 'dist-electron/main.cjs');
const secret = 'syntheticsecret-native-app-auth';
const nativeUrl = name => name === 'declared-codex'
  ? 'codex://connector/oauth_callback?code=' + secret
  : 'codex://threads/new';
const requests = [];
const servers = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function callbackResponse(request, response) {
  const url = new URL(request.url, 'http://' + request.headers.host);
  requests.push(url.href);
  const mode = url.searchParams.get('mode') || 'button';
  const destination = url.searchParams.get('native_url') || nativeUrl(mode);
  if (url.pathname === '/auth/callback') {
    response.writeHead(302, { Location: mode === 'callback-redirect' ? destination
      : '/success?id_token=' + secret + '&mode=' + mode + '&native_url=' + encodeURIComponent(destination), 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  if (url.pathname === '/success' && mode === 'success-redirect') {
    response.writeHead(302, { Location: destination, 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><meta charset="utf-8"><title>Success ${secret}</title><h1>Authorization complete</h1>
    <button id="native">Open Codex</button><button id="native-popup">Open Codex popup</button>
    <button id="iframe-popup">Untrusted iframe popup</button><button id="iframe-top">Untrusted iframe top</button><button id="iframe-opaque">Opaque iframe popup</button>
    <script>
    const destination=${JSON.stringify(destination)};
    document.querySelector('#native').onclick=()=>{location.href=destination;};
    document.querySelector('#native-popup').onclick=()=>{window.open(destination);};
    for(const kind of ['popup','top','opaque']) document.querySelector('#iframe-'+kind).onclick=()=>{
      const frame=document.createElement('iframe');frame.id='evil-frame';
      if(kind==='opaque'){frame.sandbox='allow-scripts allow-popups';frame.srcdoc='<button id="iframe-native">Open Codex</button><script>document.querySelector("#iframe-native").onclick=()=>window.open('+JSON.stringify(destination)+');<\\/script>';}
      else frame.src='https://evil.example/iframe?kind='+kind+'&native_url='+encodeURIComponent(destination);
      document.body.append(frame);
    };
    if(${JSON.stringify(mode)}==='timer') setTimeout(()=>{location.href=destination;},60);
    </script>`);
}

async function listen(port) {
  const server = createServer(callbackResponse);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, resolve); });
  servers.push(server);
  return server.address().port;
}
let callbackPort;
try { callbackPort = await listen(1455); }
catch (error) { if (error.code !== 'EADDRINUSE') throw error; callbackPort = await listen(0); }
const fallbackPort = await listen(0);
const callbackUrl = (host = '127.0.0.1', port = callbackPort) => `http://${host}:${port}/auth/callback`;
const authUrl = (name, { host = 'auth.openai.com', callback = callbackUrl(), mode = 'button' } = {}) => {
  const url = new URL('https://' + host + '/oauth/authorize');
  if (callback) url.searchParams.set('redirect_uri', callback);
  url.searchParams.set('native_url', nativeUrl(name));
  url.searchParams.set('fixture_mode', mode);
  return url.href;
};

const chatPage = `<!doctype html><meta charset="utf-8"><title>ChatGPT native auth fixture</title><main>
<textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><button id="native">Open Codex</button><div id="messages"></div></main>
<script>
document.querySelector('#native').onclick=()=>{location.href=${JSON.stringify(nativeUrl('locked-task'))};};
const messages=[];
function render(){const box=document.querySelector('#messages');box.replaceChildren();for(const message of messages){const article=document.createElement('article');const content=document.createElement('div');content.dataset.messageAuthorRole=message.role;content.dataset.messageId=message.id;content.textContent=message.text;article.append(content);if(message.finished){const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';copy.textContent='Copy';article.append(copy);}box.append(article);}}
document.querySelector('[data-testid="send-button"]').onclick=()=>{const composer=document.querySelector('#prompt-textarea');const text=composer.value;composer.value='';messages.push({role:'user',id:crypto.randomUUID(),text});messages.push({role:'assistant',id:crypto.randomUUID(),text:'Fixture reply: '+text,finished:false});const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop';document.querySelector('main').append(stop);render();window.fixtureFinish=()=>{messages.at(-1).finished=true;stop.remove();render();};if(!text.startsWith('HOLD:'))setTimeout(()=>window.fixtureFinish(),80);};
</script>`;

const authPage = `<!doctype html><meta charset="utf-8"><title>Native Auth ${secret}</title><main><h1>Authorize Codex</h1>
<button id="callback">Continue authorization</button><button id="native">Open Codex directly</button><button id="native-popup">Open Codex popup</button>
<button id="auth-popup">Open authorization popup</button>
<button id="native-twice">Open twice</button><button id="native-redirect">Native HTTP redirect</button><button id="trusted-hop">OpenAI authorization hop</button>
<button id="untrusted">Untrusted HTTPS hop</button><button id="wrong-port">Wrong callback port</button><button id="wrong-path">Wrong callback path</button><button id="bad-scheme">Malicious scheme</button>
<button id="iframe-popup">Untrusted iframe popup</button><button id="iframe-top">Untrusted iframe top</button><button id="iframe-opaque">Opaque iframe popup</button>
<script>
const params=new URL(location.href).searchParams;
const destination=params.get('native_url')||${JSON.stringify(nativeUrl('direct'))};
const callback=params.get('redirect_uri')||${JSON.stringify(callbackUrl())};
localStorage.setItem('native-auth-marker','primary-only');document.cookie='native_auth_marker=primary; path=/';
document.querySelector('#native').onclick=()=>{location.href=destination;};
document.querySelector('#native-popup').onclick=()=>{window.open(destination);};
document.querySelector('#auth-popup').onclick=()=>{window.open('https://auth.openai.com/oauth/authorize?'+params.toString());};
document.querySelector('#native-twice').onclick=()=>{window.open(destination);window.open(destination);};
document.querySelector('#native-redirect').onclick=()=>{location.href='https://auth.openai.com/native-redirect?native_url='+encodeURIComponent(destination);};
document.querySelector('#callback').onclick=()=>{const target=new URL(callback);target.searchParams.set('code',${JSON.stringify(secret)});target.searchParams.set('mode',params.get('fixture_mode')||'button');target.searchParams.set('native_url',destination);location.href=target.href;};
document.querySelector('#trusted-hop').onclick=()=>{location.href='https://auth.openai.com/oauth/authorize?redirect_uri='+encodeURIComponent(${JSON.stringify(callbackUrl())})+'&native_url='+encodeURIComponent(destination);};
document.querySelector('#untrusted').onclick=()=>{location.href='https://evil.example/oauth/authorize?native_url='+encodeURIComponent(destination);};
document.querySelector('#wrong-port').onclick=()=>{location.href=${JSON.stringify(callbackUrl('127.0.0.1', fallbackPort))}+'?code='+${JSON.stringify(secret)};};
document.querySelector('#wrong-path').onclick=()=>{location.href=callback.replace('/auth/callback','/wrong')+'?code='+${JSON.stringify(secret)};};
document.querySelector('#bad-scheme').onclick=()=>{location.href='vscode://threads/new?state='+${JSON.stringify(secret)};};
for(const kind of ['popup','top','opaque'])document.querySelector('#iframe-'+kind).onclick=()=>{const frame=document.createElement('iframe');frame.id='evil-frame';const target=destination.startsWith('codex://connector/')?destination+'&fixture=iframe-'+kind:destination;if(kind==='opaque'){frame.sandbox='allow-scripts allow-popups';frame.srcdoc='<button id="iframe-native">Open Codex</button><script>document.querySelector("#iframe-native").onclick=()=>window.open('+JSON.stringify(target)+');<\\/script>';}else frame.src='https://evil.example/iframe?kind='+kind+'&native_url='+encodeURIComponent(target);document.body.append(frame);};
</script></main>`;

await writeFile(bootstrap, `const {app,Notification,dialog,shell}=require('electron');
Notification.isSupported=()=>false;
globalThis.nativeAuthAttempts=[];globalThis.nativeAuthMode='allow';globalThis.nativeAuthPending=[];globalThis.nativeAuthEvents=[];
app.on('web-contents-created',(_,contents)=>{
  contents.on('will-navigate',event=>{if(event.url.startsWith('codex:'))globalThis.nativeAuthEvents.push({kind:'navigate',url:event.url.split('?')[0],initiator:event.initiator?.origin});});
  const install=contents.setWindowOpenHandler.bind(contents);
  contents.setWindowOpenHandler=handler=>install(details=>{
    globalThis.nativeAuthEvents.push({kind:'window-open',url:details.url.split('?')[0],referrer:details.referrer.url.split('?')[0],document:contents.getURL().split('?')[0]});
    return handler(details);
  });
});
dialog.showMessageBox=async (_window,options)=>{
  globalThis.nativeAuthAttempts.push({kind:'dialog',options});
  if(options.type==='error')return{response:0};
  if(globalThis.nativeAuthMode==='hold')return new Promise(resolve=>globalThis.nativeAuthPending.push(resolve));
  return{response:globalThis.nativeAuthMode==='cancel'?0:1};
};
shell.openExternal=async url=>{globalThis.nativeAuthAttempts.push({kind:'openExternal',url});if(globalThis.nativeAuthMode==='error')throw new Error('Launch failed '+${JSON.stringify(secret)});};
app.on('browser-window-created',(_,win)=>{win.webContents.setBackgroundThrottling(false);win.setSkipTaskbar(true);if(process.platform==='win32')win.setPosition(-20000,-20000);});
app.on('session-created',isolated=>isolated.protocol.handle('https',async request=>{
  const url=new URL(request.url);
  if(url.hostname==='chatgpt.com')return new Response(${JSON.stringify(chatPage)},{headers:{'Content-Type':'text/html','Cache-Control':'no-store'}});
  if(url.pathname==='/native-redirect'&&url.hostname==='auth.openai.com')return new Response(null,{status:302,headers:{Location:url.searchParams.get('native_url')}});
  if(url.pathname==='/iframe'){
    const destination=url.searchParams.get('native_url');const kind=url.searchParams.get('kind');
    return new Response('<!doctype html><title>Untrusted iframe</title><button id="iframe-native">Open Codex</button><script>document.querySelector("#iframe-native").onclick=()=>{document.body.dataset.clicked="1";'+ (kind==='popup'?'window.open('+JSON.stringify(destination)+');':'top.location.href='+JSON.stringify(destination)+';')+'};</script>',{headers:{'Content-Type':'text/html'}});
  }
  return new Response(${JSON.stringify(authPage)},{headers:{'Content-Type':'text/html','Cache-Control':'no-store'}});
}));
require(${JSON.stringify(mainEntry)});`);

const env = { ...process.env, WORKSPACE_USER_DATA: directory, WORKSPACE_HIDDEN_PAGE_IDLE_MS: '3600000', WORKSPACE_PAGE_IDLE_MS: '3600000', WORKSPACE_PAGE_LOAD_TIMEOUT_MS: '800' };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop, shellPage, desktopPid;
let passed = false;
function bounded(promise, label, ms = 20000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
}
const until = async (check, label, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (!await check()) { assert.ok(Date.now() < deadline, label); await pause(80); }
};
const rpc = (method, params = {}) => bounded(shellPage.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params }), method);
const contentsById = (account, id) => desktop.evaluate(({ session, webContents }, { partition, id }) => {
  const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
  return !contents || contents.isDestroyed() ? null : { id, url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading() };
}, { partition: account.partition, id });
const scriptIn = (account, id, script) => desktop.evaluate(({ session, webContents }, { partition, id, script }) => {
  const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
  if (!contents || contents.isDestroyed()) throw new Error('Missing account WebContents ' + id);
  return contents.mainFrame.executeJavaScript(script);
}, { partition: account.partition, id, script });
const selectedContents = account => desktop.evaluate(({ BrowserWindow, session }, partition) => {
  const isolated = session.fromPartition(partition);
  const host = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().startsWith('file:'));
  const contents = host?.contentView.children.find(view => view.webContents && !view.webContents.isDestroyed() && view.webContents.session === isolated)?.webContents;
  return contents ? { id: contents.id, url: contents.getURL(), loading: contents.isLoading() } : null;
}, account.partition);
const ownedPopup = account => desktop.evaluate(({ BrowserWindow, session }, partition) => {
  const popup = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && !window.webContents.getURL().startsWith('file:') && window.webContents.session === session.fromPartition(partition));
  return popup ? { id: popup.webContents.id, url: popup.webContents.getURL(), visible: popup.isVisible() } : null;
}, account.partition);
const waitSelector = (account, id, selector) => until(async () => {
  const contents = await contentsById(account, id);
  return !!contents && !contents.loading && await scriptIn(account, id, `!!document.querySelector(${JSON.stringify(selector)})`);
}, 'Selector did not become ready: ' + selector);
const click = async (account, id, selector) => {
  await waitSelector(account, id, selector);
  await desktop.evaluate(async ({ app, BrowserWindow, session, webContents }, { partition, id, selector }) => {
    const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
    if (!contents || contents.isDestroyed()) throw new Error('Missing account WebContents ' + id);
    const rect = await contents.mainFrame.executeJavaScript(`(() => {const element=document.querySelector(${JSON.stringify(selector)});const r=element.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    const host = BrowserWindow.fromWebContents(contents) ?? BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.contentView.children.some(child => child.webContents === contents));
    if (!host || !host.isVisible()) throw new Error('Authorization page must have a visible native host');
    if (process.platform === 'darwin') app.focus({ steal: true });
    host.focus(); contents.focus();
    const deadline = Date.now() + 3000;
    while (!host.isFocused() || !contents.isFocused()) {
      if (Date.now() > deadline) throw new Error('Authorization page did not focus');
      host.focus(); contents.focus(); await new Promise(resolve => setTimeout(resolve, 25));
    }
    contents.sendInputEvent({ type: 'mouseMove', ...rect });
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...rect });
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...rect });
  }, { partition: account.partition, id, selector });
};
const attempts = () => desktop.evaluate(() => globalThis.nativeAuthAttempts);
const opens = async () => (await attempts()).filter(item => item.kind === 'openExternal');
const dialogs = async () => (await attempts()).filter(item => item.kind === 'dialog');
const setMode = mode => desktop.evaluate((_, mode) => { globalThis.nativeAuthMode = mode; }, mode);
const releasePrompt = () => desktop.evaluate(() => { for (const resolve of globalThis.nativeAuthPending.splice(0)) resolve({ response: 1 }); });
const closeAuth = (account, opened) => rpc('browser.closePage', { accountId: account.id, pageId: opened.page.id });
const openAuth = async (account, name, options) => {
  const page = await rpc('browser.openLink', { accountId: account.id, url: authUrl(name, options) });
  let contents;
  await until(async () => {
    contents = await selectedContents(account);
    return (await rpc('workspace.status')).page?.id === page.id && !!contents?.url.startsWith('https://');
  }, 'Custom authorization page did not attach: ' + name);
  await waitSelector(account, contents.id, '#native');
  return { page, contents };
};
const expectOpen = async (account, contents, selector, name) => {
  const before = (await opens()).length;
  await click(account, contents.id, selector);
  await until(async () => (await opens()).length === before + 1, 'Native application was not handed off: ' + name);
  assert.equal((await opens()).at(-1).url, nativeUrl(name));
  assert.ok(!(await contentsById(account, contents.id)).url.startsWith('codex:'), 'Codex URL must never replace the embedded account document');
};
const expectBlocked = async (account, contents, selector, label) => {
  const before = (await attempts()).length;
  const beforeEvents = await desktop.evaluate(() => globalThis.nativeAuthEvents.length);
  const beforeUrl = (await contentsById(account, contents.id)).url;
  await click(account, contents.id, selector);
  if (selector.startsWith('#iframe-')) {
    await until(() => desktop.evaluate(({ session, webContents }, { partition, id }) => {
      const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
      const frame = contents?.mainFrame.framesInSubtree.find(frame => frame.url.startsWith('https://evil.example/iframe') || frame.url === 'about:srcdoc');
      return frame?.executeJavaScript("!!document.querySelector('#iframe-native')").catch(() => false) ?? false;
    }, { partition: account.partition, id: contents.id }), 'Untrusted iframe did not become interactive');
    await desktop.evaluate(async ({ session, webContents }, { partition, id }) => {
      const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition(partition) && item.id === id);
      const frame = contents.mainFrame.framesInSubtree.find(frame => frame.url.startsWith('https://evil.example/iframe') || frame.url === 'about:srcdoc');
      // Execute in the real hostile frame with a user gesture so Chromium emits
      // the navigation. Coordinate input to an out-of-process iframe can miss
      // its compositor surface even after its DOM has loaded.
      await frame.executeJavaScript("document.querySelector('#iframe-native').click()", true);
    }, { partition: account.partition, id: contents.id });
  }
  await pause(350);
  if (selector.startsWith('#iframe-')) assert.ok(await desktop.evaluate(() => globalThis.nativeAuthEvents.length) > beforeEvents, label + ' must exercise a real Chromium native navigation event');
  assert.equal((await attempts()).length, before, label + ' must not prompt or launch an app');
  assert.equal((await contentsById(account, contents.id)).url, beforeUrl, label + ' must keep the current account page usable');
};
const waitTask = task => until(async () => {
  const current = await rpc('tasks.get', { id: task.id });
  assert.ok(!['failed', 'blocked', 'waiting_user', 'uncertain'].includes(current.status), current.error ?? current.status);
  return current.status === 'done';
}, 'Queue task did not finish');
const assertPrivateStorage = async () => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath ?? directory, entry.name))
    .filter(file => /runtime\.jsonl$|(?:^|[\\/])(?:workspace|runtime|conversations?|tasks?|accounts?|sessions?|notifications?|shortcuts?)[^\\/]*\.(?:sqlite|sqlite3|db|json)(?:-(?:wal|shm))?$/i.test(file));
  for (const file of files) assert.equal((await readFile(file)).includes(Buffer.from(secret)), false, 'Authorization secret leaked into ' + path.basename(file));
};

try {
  desktop = await bounded(electron.launch({ args: ['--no-sandbox', bootstrap], env }), 'Electron launch', 30000);
  desktopPid = desktop.process()?.pid;
  shellPage = await bounded(desktop.firstWindow(), 'First window');
  await bounded(shellPage.waitForFunction(() => !!window.workspace), 'Workspace bridge');
  const primary = await rpc('accounts.create', { name: 'Native auth primary' });
  await until(async () => (await rpc('browser.inspect', { accountId: primary.id })).editor, 'Primary account did not load');
  const secondary = await rpc('accounts.create', { name: 'Native auth secondary' });
  await until(async () => (await rpc('browser.inspect', { accountId: secondary.id })).editor, 'Secondary account did not load');
  await rpc('accounts.switch', { id: secondary.id });
  const secondaryHome = await selectedContents(secondary);
  await scriptIn(secondary, secondaryHome.id, "localStorage.setItem('partition-marker','secondary-only')");
  await rpc('accounts.switch', { id: primary.id });

  const navigation = await rpc('browser.navigate', { accountId: primary.id, url: 'https://chatgpt.com/c/native-auth-running-queue' });
  await waitTask(navigation);
  const lockedContents = await selectedContents(primary);
  const lockedTask = await rpc('tasks.create', { accountId: primary.id, current: true, input: { type: 'prompt', prompt: 'HOLD:queue survives native authorization', submit: true }, background: true });
  await until(async () => !!(await rpc('tasks.get', { id: lockedTask.id })).submittedAt, 'Queue task did not submit');
  await expectBlocked(primary, lockedContents, '#native', 'Native launch from a task-locked conversation');

  const direct = await openAuth(primary, 'direct');
  await expectOpen(primary, direct.contents, '#native', 'direct');
  assert.equal((await rpc('tasks.get', { id: lockedTask.id })).status, 'running', 'Authorization tab must preserve an independent running queue');
  const isolated = await desktop.evaluate(async ({ session }, partition) => (await session.fromPartition(partition).cookies.get({ url: 'https://auth.openai.com/' })).map(cookie => cookie.name), secondary.partition);
  assert.deepEqual(isolated, [], 'Native authorization cookies stay in their account profile');
  assert.equal(await scriptIn(secondary, secondaryHome.id, "localStorage.getItem('partition-marker')"), 'secondary-only');
  assert.ok(!(await rpc('workspace.status')).pages.find(page => page.id === direct.page.id).title.includes(secret), 'Workspace authorization titles must not expose credentials from the page title');
  await closeAuth(primary, direct);

  const popup = await openAuth(primary, 'popup');
  await expectOpen(primary, popup.contents, '#native-popup', 'popup');
  await closeAuth(primary, popup);
  const redirect = await openAuth(primary, 'trusted-redirect');
  await expectOpen(primary, redirect.contents, '#native-redirect', 'trusted-redirect');
  await closeAuth(primary, redirect);

  const popupOwner = await openAuth(primary, 'owned-popup');
  await click(primary, popupOwner.contents.id, '#auth-popup');
  let authPopup;
  await until(async () => { authPopup = await ownedPopup(primary); return !!authPopup?.visible && authPopup.url.startsWith('https://auth.openai.com/'); }, 'Visible isolated authorization popup did not open');
  await expectOpen(primary, authPopup, '#native', 'owned-popup');
  await closeAuth(primary, popupOwner);

  for (const [name, host, port, mode] of [
    ['loopback-button', '127.0.0.1', callbackPort, 'button'],
    ['localhost-timer', 'localhost', callbackPort, 'timer'],
    ['fallback-redirect', '127.0.0.1', fallbackPort, 'success-redirect'],
    ['callback-redirect', '127.0.0.1', callbackPort, 'callback-redirect'],
  ]) {
    const opened = await openAuth(primary, name, { callback: callbackUrl(host, port), mode });
    const before = (await opens()).length;
    await click(primary, opened.contents.id, '#callback');
    if (mode === 'button') {
      await until(async () => (await contentsById(primary, opened.contents.id))?.url.startsWith(`http://${host}:${port}/success`), 'Callback HTTP redirect did not reach the success document');
      assert.ok(!(await rpc('workspace.status')).page.title.includes(secret), 'Selected callback success page title must not expose credentials');
      await expectOpen(primary, opened.contents, '#native', name);
    } else {
      await until(async () => (await opens()).length === before + 1, 'Callback native continuation did not launch: ' + name);
      assert.equal((await opens()).at(-1).url, nativeUrl(name));
    }
    assert.ok(requests.some(value => value.startsWith(callbackUrl(host, port) + '?')), 'Declared callback must reach the actual loopback listener');
    await assertPrivateStorage();
    await closeAuth(primary, opened);
  }

  const discovered = await openAuth(primary, 'discovered', { host: 'custom.example', callback: '' });
  await click(primary, discovered.contents.id, '#trusted-hop');
  await until(async () => (await contentsById(primary, discovered.contents.id)).url.startsWith('https://auth.openai.com/'), 'Trusted authorization declaration did not load');
  await click(primary, discovered.contents.id, '#callback');
  await until(async () => (await contentsById(primary, discovered.contents.id)).url.startsWith('http://127.0.0.1:' + callbackPort + '/success'), 'Callback declaration from a trusted navigation was not retained');
  await expectOpen(primary, discovered.contents, '#native', 'discovered');
  await closeAuth(primary, discovered);

  const customCodex = await openAuth(primary, 'declared-codex', { host: 'custom.example', callback: 'codex://connector/oauth_callback' });
  await expectOpen(primary, customCodex.contents, '#native-popup', 'declared-codex');
  await expectBlocked(primary, customCodex.contents, '#iframe-popup', 'Untrusted iframe popup with a declared native callback');
  await scriptIn(primary, customCodex.contents.id, "document.querySelector('#evil-frame')?.remove()");
  await expectBlocked(primary, customCodex.contents, '#iframe-top', 'Untrusted iframe top navigation with a declared native callback');
  await scriptIn(primary, customCodex.contents.id, "document.querySelector('#evil-frame')?.remove()");
  await expectBlocked(primary, customCodex.contents, '#iframe-opaque', 'Opaque sandbox iframe popup with a declared native callback');
  await closeAuth(primary, customCodex);

  const cancel = await openAuth(primary, 'cancel');
  await setMode('cancel');
  const cancelOpens = (await opens()).length;
  const cancelDialogs = (await dialogs()).length;
  const cancelUrl = (await contentsById(primary, cancel.contents.id)).url;
  await click(primary, cancel.contents.id, '#native');
  await until(async () => (await dialogs()).length === cancelDialogs + 1, 'Canceled native handoff did not ask the user');
  await pause(200);
  assert.equal((await opens()).length, cancelOpens, 'Cancel must not launch Codex');
  assert.equal((await contentsById(primary, cancel.contents.id)).url, cancelUrl, 'Cancel keeps the authorization page usable');
  await setMode('allow');
  await expectOpen(primary, cancel.contents, '#native', 'cancel');
  await closeAuth(primary, cancel);

  const canceledRedirect = await openAuth(primary, 'canceled-redirect', { mode: 'success-redirect' });
  await setMode('cancel');
  const redirectRequests = requests.length;
  const redirectOpens = (await opens()).length;
  const redirectDialogs = (await dialogs()).length;
  await click(primary, canceledRedirect.contents.id, '#callback');
  await until(async () => (await dialogs()).length === redirectDialogs + 1, 'Redirected native handoff did not prompt before cancellation');
  await pause(1500);
  assert.equal((await opens()).length, redirectOpens, 'Canceled callback redirects must not launch Codex');
  assert.equal(requests.slice(redirectRequests).filter(value => new URL(value).pathname === '/auth/callback').length, 1, 'Recovery must not replay a canceled callback containing one-use credentials');
  assert.equal(requests.slice(redirectRequests).filter(value => new URL(value).pathname === '/success').length, 1, 'Recovery must not replay canceled success redirects');
  await setMode('allow');
  await closeAuth(primary, canceledRedirect);

  const failure = await openAuth(primary, 'launch-error');
  await setMode('error');
  const failureDialogs = (await dialogs()).length;
  await expectOpen(primary, failure.contents, '#native-popup', 'launch-error');
  await until(async () => (await dialogs()).length >= failureDialogs + 2, 'Failed application launch did not display a failure message');
  assert.ok((await dialogs()).at(-1).options.message, 'Launch failure must tell the user what happened');
  await setMode('allow');
  await expectOpen(primary, failure.contents, '#native-popup', 'launch-error');
  await closeAuth(primary, failure);

  const duplicate = await openAuth(primary, 'deduplicate');
  await setMode('hold');
  const duplicateDialogs = (await dialogs()).length;
  const duplicateOpens = (await opens()).length;
  const duplicateEvents = await desktop.evaluate(() => globalThis.nativeAuthEvents.filter(event => event.kind === 'window-open' && event.url.startsWith('codex:')).length);
  await click(primary, duplicate.contents.id, '#native-twice');
  await until(async () => (await dialogs()).length > duplicateDialogs, 'Concurrent handoffs did not show a prompt');
  await pause(150);
  assert.equal(await desktop.evaluate(() => globalThis.nativeAuthEvents.filter(event => event.kind === 'window-open' && event.url.startsWith('codex:')).length), duplicateEvents + 2, 'Deduplication must receive both actual Chromium popup attempts');
  assert.equal((await dialogs()).length, duplicateDialogs + 1, 'Concurrent identical native URLs must share one prompt');
  await releasePrompt();
  await until(async () => (await opens()).length === duplicateOpens + 1, 'Concurrent handoffs did not launch once');
  await setMode('allow');
  await closeAuth(primary, duplicate);

  const sharedOwner = await openAuth(primary, 'shared-popup-dedup');
  await click(primary, sharedOwner.contents.id, '#auth-popup');
  let sharedPopup;
  await until(async () => { sharedPopup = await ownedPopup(primary); return !!sharedPopup?.visible && sharedPopup.url.startsWith('https://auth.openai.com/'); }, 'Shared-page authorization popup did not open');
  await setMode('hold');
  const sharedDialogs = (await dialogs()).length;
  const sharedOpens = (await opens()).length;
  await click(primary, sharedOwner.contents.id, '#native');
  await until(async () => (await dialogs()).length > sharedDialogs, 'Shared-page native prompt did not open');
  await click(primary, sharedPopup.id, '#native');
  await pause(150);
  assert.equal((await dialogs()).length, sharedDialogs + 1, 'Main page and owned authorization popup must share one native prompt');
  await releasePrompt();
  await until(async () => (await opens()).length === sharedOpens + 1, 'Shared-page native requests did not launch once');
  await setMode('allow');
  await closeAuth(primary, sharedOwner);

  const staleTab = await openAuth(primary, 'stale-tab');
  await setMode('hold');
  const staleTabDialogs = (await dialogs()).length;
  const staleTabOpens = (await opens()).length;
  await click(primary, staleTab.contents.id, '#native');
  await until(async () => (await dialogs()).length > staleTabDialogs, 'Tab-switch handoff prompt did not open');
  const replacementTab = await openAuth(primary, 'replacement-tab');
  await releasePrompt();
  await pause(250);
  assert.equal((await opens()).length, staleTabOpens, 'A prompt approved after selecting another tab must not launch');
  const hiddenTabAttempts = (await attempts()).length;
  await scriptIn(primary, staleTab.contents.id, `location.href=${JSON.stringify(nativeUrl('hidden-tab'))}`);
  await pause(250);
  assert.equal((await attempts()).length, hiddenTabAttempts, 'Hidden tabs in the current account must not prompt or launch');
  await setMode('allow');
  await closeAuth(primary, staleTab);
  await closeAuth(primary, replacementTab);

  const stale = await openAuth(primary, 'stale');
  await setMode('hold');
  const staleDialogs = (await dialogs()).length;
  const staleOpens = (await opens()).length;
  await click(primary, stale.contents.id, '#native');
  await until(async () => (await dialogs()).length > staleDialogs, 'Stale handoff prompt did not open');
  await rpc('accounts.switch', { id: secondary.id });
  await releasePrompt();
  await pause(250);
  assert.equal((await opens()).length, staleOpens, 'A prompt approved after account switching must not launch');
  const backgroundAttempts = (await attempts()).length;
  await scriptIn(primary, stale.contents.id, `location.href=${JSON.stringify(nativeUrl('background'))}`);
  await pause(250);
  assert.equal((await attempts()).length, backgroundAttempts, 'Hidden account pages must not prompt or launch');
  await setMode('allow');
  await rpc('accounts.switch', { id: primary.id });
  await closeAuth(primary, stale);

  const wrong = await openAuth(primary, 'wrong-target');
  const requestsBefore = requests.length;
  await expectBlocked(primary, wrong.contents, '#wrong-port', 'Undeclared loopback port');
  await expectBlocked(primary, wrong.contents, '#wrong-path', 'Undeclared loopback path');
  await expectBlocked(primary, wrong.contents, '#bad-scheme', 'Undeclared native app scheme');
  assert.equal(requests.length, requestsBefore, 'Wrong callback destinations must be blocked before the network request');
  await click(primary, wrong.contents.id, '#untrusted');
  await until(async () => (await contentsById(primary, wrong.contents.id)).url.startsWith('https://evil.example/'), 'Untrusted fixture did not load');
  await expectBlocked(primary, wrong.contents, '#native', 'Untrusted HTTPS origin');
  await closeAuth(primary, wrong);

  const iframe = await openAuth(primary, 'iframe');
  await click(primary, iframe.contents.id, '#callback');
  await until(async () => (await contentsById(primary, iframe.contents.id)).url.startsWith('http://127.0.0.1:' + callbackPort + '/success'), 'Iframe test success page did not load');
  await expectBlocked(primary, iframe.contents, '#iframe-popup', 'Untrusted iframe popup from a trusted success page');
  await scriptIn(primary, iframe.contents.id, "document.querySelector('#evil-frame')?.remove()");
  await expectBlocked(primary, iframe.contents, '#iframe-top', 'Untrusted iframe top navigation from a trusted success page');
  await scriptIn(primary, iframe.contents.id, "document.querySelector('#evil-frame')?.remove()");
  await expectBlocked(primary, iframe.contents, '#iframe-opaque', 'Opaque sandbox iframe popup from a trusted success page');
  await closeAuth(primary, iframe);

  for (const item of await dialogs()) assert.equal(JSON.stringify(item.options).includes(secret), false, 'Dialog text must never expose authorization parameters or launcher errors');
  await assertPrivateStorage();
  assert.equal((await rpc('tasks.get', { id: lockedTask.id })).status, 'running', 'Queue must remain running after all authorization attempts');
  await scriptIn(primary, lockedContents.id, 'window.fixtureFinish?.()');
  await waitTask(lockedTask);
  passed = true;
  console.log('Native app authorization desktop passed: isolated callback/302/success handoffs, direct and popup launches, cancellation, retry, deduplication, visibility checks, blocked origins and private persistence.');
} finally {
  try { if (desktop) await bounded(desktop.close(), 'Fixture shutdown', 10000); }
  catch { if (desktopPid) process.kill(desktopPid); }
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root); assert.ok(path.basename(target).startsWith('.test-native-app-auth-'));
  for (let attempt = 0; attempt < 10; attempt++) {
    try { await rm(target, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 9) console.warn('Fixture cleanup delayed:', error.code); else await pause(300); }
  }
  if (!passed) process.exitCode = 1;
}
