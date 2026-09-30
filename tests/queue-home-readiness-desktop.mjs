import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { modernFixture } from './modern-chatgpt-fixture.mjs';

// The real homepage's composer hydrates after document load. A failed first
// queue-target check must recover without a click, refresh, or duplicate binding.
const root = path.resolve('.');
const homeFixture = modernFixture.replace('<form data-chatgpt-composer>', '<form data-composer-placement="home">')
  .replace('aria-label="询问 ChatGPT"', 'aria-label="使用 ChatGPT Work"');
assert.notEqual(homeFixture,modernFixture);
const directory = await mkdtemp(path.join(root, '.test-queue-home-readiness-'));
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const {app,Notification}=require('electron');
Notification.isSupported=()=>false;
app.on('browser-window-created',(_,win)=>{win.webContents.setBackgroundThrottling(false);win.on('show',()=>win.hide())});
app.on('session-created',s=>s.protocol.handle('https',()=>new Response(${JSON.stringify(homeFixture)},{headers:{'Content-Type':'text/html'}})));
require(${JSON.stringify(path.join(root,'dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory, WORKSPACE_HIDDEN_PAGE_IDLE_MS: '3600000' };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop;
try {
  desktop = await electron.launch({ args: [bootstrap], env });
  const ui = await desktop.firstWindow(); ui.setDefaultTimeout(12000);
  await ui.waitForFunction(() => !!window.workspace);
  const rpc = (method, params = {}) => ui.evaluate(({method,params}) => window.workspace.call(method,params), {method,params});
  const until = async (check, message, timeout = 12000) => {
    const end = Date.now() + timeout;
    while (!await check()) { assert.ok(Date.now() < end, message); await new Promise(resolve => setTimeout(resolve,100)); }
  };
  // Record the actual native view while selected. Two tabs can share the same
  // home URL and account, so URL/profile lookup alone is ambiguous.
  const fixtureContents = new Map();
  const pageScript = async (pageId, code) => {
    const state = await rpc('workspace.status');
    const target = state.pages.find(p => p.id === pageId);
    const partition = state.accounts.find(a => a.id === target.accountId).partition;
    if (!fixtureContents.has(pageId)) {
      assert.equal(state.page.id,pageId,'An unrecorded fixture tab must be selected first');
      const id = await desktop.evaluate(({BrowserWindow},{partition}) => {
        const shell = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:'));
        const child = shell.contentView.children.find(view => view.webContents?.getURL().startsWith('https://chatgpt.com/'));
        if (!child) throw Error('Selected native fixture view missing');
        return child.webContents.id;
      }, {partition});
      fixtureContents.set(pageId,id);
    }
    return desktop.evaluate(async ({webContents,session},{id,url,partition,code}) => {
      const page = webContents.fromId(id);
      if (!page || page.getURL() !== url || page.session !== session.fromPartition(partition)) throw Error('Account fixture page changed');
      return page.executeJavaScript(code);
    }, {id:fixtureContents.get(pageId),url:target.url,partition,code});
  };
  const a = await rpc('accounts.create', {name:'Delayed homepage'});
  await until(async () => (await rpc('browser.inspect',{accountId:a.id})).editor, 'Fixture composer did not load');
  const aPage = (await rpc('workspace.status')).page.id;
  await pageScript(aPage, 'document.querySelector("[contenteditable]").hidden=true');
  await ui.getByRole('button',{name:'会话队列',exact:true}).click();
  const panel = ui.getByRole('complementary',{name:'会话队列'});
  const composer = panel.getByLabel('下一条消息',{exact:true});
  await until(async () => !!await panel.locator('.cq-error').count(), 'Initial not-ready check was not exercised');
  assert.equal(await composer.isEnabled(),false);
  await pageScript(aPage, 'document.querySelector("[contenteditable]").hidden=false');
  await until(() => composer.isEnabled(), 'Homepage queue never recovered after composer hydration');
  assert.equal(await panel.locator('.cq-error').count(),0);
  const target = (await rpc('workspace.status')).pages.find(p => p.id === aPage).conversationId;
  assert.ok(target);
  await composer.fill('homepage-first'); await composer.press('Enter');
  await composer.fill('homepage-second'); await composer.press('Control+Enter');
  await until(async () => (await rpc('tasks.list')).filter(t => t.conversationId === target && t.status === 'done').length === 2, 'Homepage FIFO did not complete',45000);
  assert.equal((await rpc('conversations.list',{accountId:a.id})).length,1, 'Retries created duplicate new conversations');
  assert.deepEqual(await pageScript(aPage,'window.sent'),['homepage-first','homepage-second']);
  // Switch away while target resolution is retrying. Its old callback must not
  // bind the second account's panel or leak either account's unqueued draft.
  await panel.getByRole('button',{name:'关闭队列面板'}).click();
  await rpc('browser.newConversation',{accountId:a.id});
  const aNew = (await rpc('workspace.status')).page.id;
  await until(async () => (await rpc('browser.inspect',{accountId:a.id,pageId:aNew})).editor, 'Second homepage did not load');
  await pageScript(aNew,'document.querySelector("[contenteditable]").hidden=true');
  await ui.getByRole('button',{name:'会话队列',exact:true}).click();
  await until(async () => !!await panel.locator('.cq-error').count(), 'Account-switch retry was not exercised');
  const b = await rpc('accounts.create',{name:'Other homepage'});
  await until(async () => /Other homepage/.test(await panel.locator('.cq-header').textContent()) && await composer.isEnabled(), 'Other account queue did not initialize');
  await composer.fill('Other account draft');
  await pageScript(aNew,'document.querySelector("[contenteditable]").hidden=false');
  await new Promise(resolve => setTimeout(resolve,2600));
  assert.equal(await composer.inputValue(),'Other account draft');
  assert.match(await panel.locator('.cq-header').textContent(),/Other homepage/);
  const bPage = (await rpc('workspace.status')).page;
  assert.notEqual(bPage.conversationId,target);
  await rpc('accounts.switch',{id:a.id});
  await until(async () => await composer.isEnabled() && await composer.inputValue() === '', 'Returning account retained the wrong draft');
  const aNewBound = (await rpc('workspace.status')).pages.find(p => p.id === aNew).conversationId;
  assert.notEqual(aNewBound,bPage.conversationId);
  await rpc('accounts.switch',{id:b.id});
  await until(async () => await composer.inputValue() === 'Other account draft', 'Other account draft was lost');
  // Home model query parameters are UI choices, not a different conversation.
  // Temporary chats remain unsupported and must not get a persistent queue.
  await panel.getByRole('button',{name:'关闭队列面板'}).click();
  await rpc('browser.newConversation',{accountId:b.id});
  const modelPage = (await rpc('workspace.status')).page.id;
  await until(async () => (await rpc('browser.inspect',{accountId:b.id,pageId:modelPage})).editor, 'Model homepage did not load');
  await pageScript(modelPage,'history.replaceState({},"","/?temporary-chat=true")');
  await ui.getByRole('button',{name:'会话队列',exact:true}).click();
  await until(async () => !!await panel.locator('.cq-error').count(), 'Temporary homepage must not get a queue');
  assert.equal(await composer.isEnabled(),false);
  assert.equal((await rpc('conversations.list',{accountId:b.id})).length,1);
  await pageScript(modelPage,'history.replaceState({},"","/?model=gpt-pro")');
  await until(() => composer.isEnabled(), 'Normal model homepage never got a queue');
  assert.equal((await rpc('conversations.list',{accountId:b.id})).length,2);
  await composer.fill('model-homepage'); await composer.press('Enter');
  await until(async () => (await rpc('tasks.list')).some(t => t.input.prompt === 'model-homepage' && t.status === 'done'), 'Model homepage did not send',45000);
  assert.deepEqual(await pageScript(modelPage,'window.sent'),['model-homepage']);
  console.log('Homepage queue passed: failed initial check automatically recovers, modern composer/Enter/FIFO binds once, retry cancellation/account drafts stay isolated, model queries work and temporary chats stay guarded.');
} finally {
  await desktop?.close();
  if (path.dirname(directory)!==root || !path.basename(directory).startsWith('.test-queue-home-readiness-')) throw Error('Unsafe cleanup');
  await rm(directory,{recursive:true,force:true});
}
