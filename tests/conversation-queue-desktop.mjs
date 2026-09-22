import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

// Owned offline fixture in an isolated profile. Keep its native window hidden so
// it cannot be mistaken for the user's real ChatGPT page.
const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-conversation-queue-'));
const bootstrap = path.join(directory, 'fixture.cjs');
const queueFixture=fixture.replace('for (const message of messages) {','for (const message of messages.slice(window.fixtureVisibleFrom ?? 0)) {');
assert.notEqual(queueFixture,fixture);
await writeFile(bootstrap, `const {app,Notification}=require('electron');
Notification.isSupported=()=>false;
app.on('browser-window-created',(_,win)=>{ win.webContents.setBackgroundThrottling(false); win.on('show',()=>win.hide()); });
app.on('session-created',s=>s.protocol.handle('https',()=>new Response(${JSON.stringify(queueFixture)},{headers:{'Content-Type':'text/html'}})));
require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory, WORKSPACE_HIDDEN_PAGE_IDLE_MS: '3600000' };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop, diagnosticPage;
try {
  desktop = await electron.launch({ args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', bootstrap], env });
  const page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
  diagnosticPage = page;
  await page.waitForFunction(() => !!window.workspace);
  const rpc = (method, params = {}) => page.evaluate(({method,params})=>window.workspace.call(method,params),{method,params});
  async function until(check) { const end=Date.now()+30000; while(!await check()) { assert.ok(Date.now()<end,'Queue condition timed out'); await new Promise(resolve=>setTimeout(resolve,100)); } }
  const script = (url,code) => desktop.evaluate(async ({webContents},{url,code}) => {
    const contents=webContents.getAllWebContents().find(item=>item.getURL()===url); if(!contents)throw new Error('Fixture page not found'); return contents.executeJavaScript(code);
  },{url,code});
  const account = await rpc('accounts.create',{name:'队列测试账号'});
  await until(async()=> (await rpc('browser.inspect',{accountId:account.id})).editor);
  const initialPage=(await rpc('workspace.status')).page.id;
  await page.getByRole('button',{name:'会话队列',exact:true}).click();
  const panel=page.getByRole('complementary',{name:'会话队列'});
  await panel.getByRole('button',{name:'暂停后续',exact:true}).click();
  const conversation=(await rpc('workspace.status')).pages.find(p=>p.id===initialPage).conversationId;
  assert.ok(conversation);
  const composer=panel.getByLabel('下一条消息',{exact:true});
  const keyboardTasks=async()=>{
    // The mutating dispatcher is serialized; this read acts as a fence for
    // previously dispatched tasks.create calls before checking task history.
    await rpc('conversations.get',{accountId:account.id,conversation});
    return rpc('tasks.list');
  };
  await composer.press('Enter');
  assert.equal((await keyboardTasks()).length,0,'Empty Enter does not queue a task');
  await composer.fill('键盘第一行');
  await composer.press('Shift+Enter');
  await page.keyboard.insertText('第二行');
  assert.equal(await composer.inputValue(),'键盘第一行\n第二行');
  assert.equal((await keyboardTasks()).length,0,'Shift+Enter only inserts a newline');
  await composer.evaluate(el=>{
    el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
    el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
    el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}));
    el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true}));
  });
  assert.equal((await keyboardTasks()).length,0,'IME confirmation and held Enter never submit');
  assert.equal(await panel.isVisible(),true,'IME Escape does not close the panel');
  for(const key of ['Enter','Control+Enter','Meta+Enter']){
    const prompt=key==='Enter'?'键盘第一行\n第二行':`快捷键 ${key}`;
    await composer.fill(prompt);
    await composer.press(key);
    await until(async()=>await composer.inputValue()==='');
    assert.equal(await composer.evaluate(el=>el===document.activeElement),true,'Composer keeps focus for the next message');
    const matches=(await keyboardTasks()).filter(t=>t.input.prompt===prompt);
    assert.equal(matches.length,1,`${key} queues exactly one message`);
    const item=matches[0];
    await rpc('tasks.removeQueued',{accountId:account.id,conversation,id:item.id,expectedUpdatedAt:item.updatedAt});
  }
  const add = async text => { await panel.getByLabel('下一条消息',{exact:true}).fill(text); await panel.getByRole('button',{name:'加入队列',exact:true}).click(); await until(async()=> await panel.getByLabel('下一条消息',{exact:true}).inputValue()===''); };
  await add('HOLD:第一条'); await add('第二条'); await add('第三条');
  await add('移除这条');
  await panel.getByRole('button',{name:'第 4 条更多操作',exact:true}).click();
  await panel.locator('.cq-item').last().getByRole('button',{name:'移除',exact:true}).click();
  await until(async()=> await panel.locator('.cq-item').count()===3);
  await panel.getByRole('button',{name:'第 2 条更多操作',exact:true}).click();
  await panel.getByRole('button',{name:'编辑',exact:true}).press('Escape');
  assert.equal(await panel.getByRole('group',{name:'第 2 条操作',exact:true}).count(),0);
  assert.equal(await panel.isVisible(),true,'Escape first closes the item actions');
  await panel.getByRole('button',{name:'第 2 条更多操作',exact:true}).click();
  await panel.locator('.cq-item').nth(1).getByRole('button',{name:'编辑',exact:true}).click();
  await panel.getByLabel('编辑排队消息').fill('放弃这次编辑');
  await panel.getByLabel('编辑排队消息').press('Escape');
  assert.equal(await panel.getByLabel('编辑排队消息').count(),0);
  assert.equal(await panel.locator('.cq-message summary').nth(1).textContent(),'第二条');
  assert.equal(await panel.isVisible(),true,'Cancelling an edit keeps the panel open');
  await panel.getByRole('button',{name:'第 2 条更多操作',exact:true}).click();
  await panel.locator('.cq-item').nth(1).getByRole('button',{name:'编辑',exact:true}).click();
  await panel.getByLabel('编辑排队消息').fill('编辑后的第二条\n保留换行');
  await panel.getByLabel('编辑排队消息').press('Control+Enter');
  await panel.getByRole('button',{name:'第 3 条更多操作',exact:true}).click();
  await panel.getByRole('button',{name:'上移第 3 条',exact:true}).click();
  await until(async()=> (await panel.locator('.cq-message summary').allTextContents()).join('|')==='HOLD:第一条|第三条|编辑后的第二条\n保留换行');
  const queued=(await rpc('workspace.status')).tasks.filter(task=>task.status==='pending');
  assert.ok(queued.every(task=>task.idleTimeoutMs===3600000 && task.replyTimeoutMs===3600000 && task.background));
  await panel.getByLabel('下一条消息',{exact:true}).fill('会话 A 尚未入队的草稿');
  await rpc('browser.newConversation',{accountId:account.id});
  await until(async()=> (await rpc('browser.inspect',{accountId:account.id})).editor);
  await until(async()=> await panel.getByLabel('下一条消息',{exact:true}).inputValue()==='');
  await panel.getByLabel('下一条消息',{exact:true}).fill('会话 B 的草稿');
  await rpc('browser.select',{accountId:account.id,pageId:initialPage});
  await until(async()=> await panel.getByLabel('下一条消息',{exact:true}).inputValue()==='会话 A 尚未入队的草稿');
  await composer.press('Escape');
  await panel.waitFor({state:'detached'});
  await page.getByRole('button',{name:/^会话队列/}).click();
  await until(async()=> await panel.getByLabel('下一条消息',{exact:true}).inputValue()==='会话 A 尚未入队的草稿');
  // Verify layout changes resize the real native slot, and narrow mode hides it.
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,940));
  await until(async()=>await panel.evaluate(e=>e.getBoundingClientRect().width)===320);
  const wide=await page.evaluate(()=>({browser:document.querySelector('.browser-slot').getBoundingClientRect().toJSON(),panel:document.querySelector('.conversation-queue').getBoundingClientRect().toJSON()}));
  assert.ok(wide.browser.right<=wide.panel.left);
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(900,700));
  await until(async()=> await page.locator('.browser-slot').evaluate(e=>e.getBoundingClientRect().width)===0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,940));
  await panel.getByRole('button',{name:'恢复队列',exact:true}).click();
  await until(async()=> (await rpc('tasks.get',{id:queued.at(-1).id})).submittedAt);
  const first=queued.find(task=>task.input.prompt==='HOLD:第一条');
  const live=(await rpc('workspace.status')).pages.find(p=>p.conversationId===conversation);
  const otherPage=(await rpc('workspace.status')).pages.find(p=>p.accountId===account.id&&p.id!==initialPage);
  await rpc('queues.pause',{accountId:account.id,conversation});
  await rpc('queues.resume',{accountId:account.id,conversation});
  await rpc('queues.pause',{accountId:account.id,conversation});
  await rpc('browser.select',{accountId:account.id,pageId:otherPage.id});
  await script(live.url,'window.fixtureFinish()');
  await until(async()=> (await rpc('tasks.get',{id:first.id})).status==='done');
  assert.equal(await script(live.url,'window.fixtureSendCount'),1);
  assert.equal((await rpc('workspace.status')).tasks.filter(t=>t.conversationId===conversation&&t.status==='pending').length,2);
  await rpc('queues.resume',{accountId:account.id,conversation});
  await until(async()=> (await rpc('workspace.status')).tasks.filter(t=>t.conversationId===conversation).every(t=>['done','cancelled'].includes(t.status)));
  assert.equal((await rpc('workspace.status')).page.id,otherPage.id,'Background follow-up never takes the selected page');
  assert.equal(await script(live.url,'window.fixtureSendCount'),3);
  const sent=await script(live.url,"[...document.querySelectorAll('[data-message-author-role=user]')].map(el=>el.innerText)");
  assert.deepEqual(sent,['HOLD:第一条','第三条','编辑后的第二条\n保留换行']);
  // Existing manual response: pausing a claimed waiting item stops it before send.
  await script(live.url,"window.fixtureHold=true; document.querySelector('#prompt-textarea').value='人工上一轮'; document.querySelector('[data-testid=send-button]').click()");
  const waiting=await rpc('tasks.create',{accountId:account.id,conversation,input:{type:'prompt',prompt:'手动回复之后',submit:true},idleTimeoutMs:3600000,replyTimeoutMs:3600000,background:true});
  await until(async()=> (await rpc('tasks.get',{id:waiting.id})).phase==='waiting_idle');
  await rpc('queues.pause',{accountId:account.id,conversation});
  await until(async()=> (await rpc('tasks.get',{id:waiting.id})).status==='pending');
  await script(live.url,'window.fixtureFinish(); window.fixtureHold=false');
  assert.equal(await script(live.url,'window.fixtureSendCount'),4);
  await rpc('queues.resume',{accountId:account.id,conversation});
  await until(async()=> (await rpc('tasks.get',{id:waiting.id})).status==='done');
  assert.equal(await script(live.url,'window.fixtureSendCount'),5);
  // ChatGPT can navigate between conversations inside the same tab. Unqueued
  // drafts follow the conversation identity, not just the page's local ID.
  await rpc('browser.select',{accountId:account.id,pageId:initialPage});
  await until(async()=> await panel.getByLabel('下一条消息',{exact:true}).inputValue()==='会话 A 尚未入队的草稿');
  const anotherUrl='https://chatgpt.com/c/queue-other-draft';
  await script(live.url,`history.pushState({},'',${JSON.stringify(anotherUrl)})`);
  await until(async()=> (await rpc('workspace.status')).pages.find(p=>p.id===initialPage).url===anotherUrl);
  await until(async()=> await panel.getByLabel('下一条消息',{exact:true}).isEnabled() && await panel.getByLabel('下一条消息',{exact:true}).inputValue()==='');
  await panel.getByLabel('下一条消息',{exact:true}).fill('同一标签内另一会话的草稿');
  await script(anotherUrl,`history.pushState({},'',${JSON.stringify(live.url)})`);
  await until(async()=> await panel.getByLabel('下一条消息',{exact:true}).inputValue()==='会话 A 尚未入队的草稿');
  // A real webpage can unmount old DOM nodes after confirming the new send.
  // Remove an odd number so the visible history starts with an assistant turn,
  // while the fixture's underlying conversation remains unchanged.
  const virtualized=await rpc('tasks.create',{accountId:account.id,conversation,input:{type:'prompt',prompt:'HOLD:历史节点收起后仍能确认回复',submit:true},background:true});
  await until(async()=> (await rpc('tasks.get',{id:virtualized.id})).submittedAt);
  const before=await script(live.url,"document.querySelectorAll('[data-message-author-role]').length");
  const after=await script(live.url,"window.fixtureVisibleFrom=3; render(); window.fixtureFinish(); document.querySelectorAll('[data-message-author-role]').length");
  assert.equal(after,before-3);
  await until(async()=> (await rpc('tasks.get',{id:virtualized.id})).status==='done');
  assert.equal((await rpc('tasks.get',{id:virtualized.id})).result.response,'Fixture reply: HOLD:历史节点收起后仍能确认回复');
  assert.equal(await script(live.url,'window.fixtureSendCount'),6,'History window changes never resend');
  console.log('Conversation queue desktop passed: keyboard/IME, target binding, per-conversation drafts, edit/reorder, pause/resume, responsive bounds, background FIFO, manual-turn waiting and virtualized historical DOM after acknowledgement.');
} catch (error) {
  console.error(await diagnosticPage?.evaluate(() => ({ panel: document.querySelector('.conversation-queue')?.textContent, buttons: [...document.querySelectorAll('.conversation-queue button')].map(b=>({text:b.textContent,disabled:b.disabled})), width:innerWidth })).catch(()=>null));
  throw error;
} finally {
  await desktop?.close();
  const target=path.resolve(directory);
  assert.equal(path.dirname(target),root); assert.ok(path.basename(target).startsWith('.test-conversation-queue-'));
  await rm(target,{recursive:true,force:true});
}
