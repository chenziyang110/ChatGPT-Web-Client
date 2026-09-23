import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

// Isolated offline pages; never send test prompts through the user's profile.
const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-preview-'));
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const {app,Notification}=require('electron');
Notification.isSupported=()=>false;
// Windows needs a painted surface for capturePage; keep this fixture outside
// the desktop instead of hiding its window (which can suppress all frames).
app.on('browser-window-created',(_,win)=>{win.webContents.setBackgroundThrottling(false);win.setSkipTaskbar(true);if(process.platform==='win32')win.setPosition(-20000,-20000);});
app.on('session-created',s=>s.protocol.handle('https',()=>new Response(${JSON.stringify(fixture)},{headers:{'Content-Type':'text/html'}})));
require(${JSON.stringify(path.join(root,'dist-electron/main.cjs'))});`);
const env = {...process.env,WORKSPACE_USER_DATA:directory,WORKSPACE_HIDDEN_PAGE_IDLE_MS:'3600000'};
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop, page;
function bounded(promise,label) {
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),12000);})]).finally(()=>clearTimeout(timer));
}
try {
  desktop = await electron.launch({args:['--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows',bootstrap],env});
  page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
  await page.waitForFunction(()=>!!window.workspace);
  const rpc=(method,params={})=>bounded(page.evaluate(({method,params})=>window.workspace.call(method,params),{method,params}),method);
  async function until(check) { const end=Date.now()+20000; while(!await check()) { assert.ok(Date.now()<end,'Preview condition timed out'); await new Promise(resolve=>setTimeout(resolve,100)); } }
  const account=await rpc('accounts.create',{name:'自动跟随离线测试'});
  await until(async()=> (await rpc('browser.inspect',{accountId:account.id})).editor);
  const original=(await rpc('workspace.status')).page;
  const task=await rpc('tasks.create',{accountId:account.id,new:true,input:{type:'prompt',prompt:'HOLD:自动跟随预览',submit:true}});
  await until(async()=> (await rpc('tasks.get',{id:task.id})).submittedAt);
  const target=(await rpc('workspace.status')).pages.find(p=>p.taskId===task.id);
  assert.ok(target?.locked && target.selected);
  // A newly locked view may not have a compositor frame yet (UnknownVizError
  // on Linux). Wait for the normal preview retry loop to present its first frame.
  const script=code=>bounded(desktop.evaluate(async({webContents,session},{code,url,partition})=>{
    const contents=webContents.getAllWebContents().find(w=>w.getURL()===url && w.session===session.fromPartition(partition));
    if(!contents)throw new Error('Preview fixture missing'); return contents.executeJavaScript(code);
  },{code,url:target.url,partition:account.partition}),'Fixture script');
  await page.locator('.preview-canvas img').waitFor();
  await script(`const viewport=document.querySelector('#messages');
    viewport.style.cssText='height:240px;overflow-y:auto;scroll-behavior:smooth';
    viewport.lastElementChild.style.minHeight='1400px';
    viewport.scrollTo({top:0,behavior:'instant'});`);
  const atBottom=()=>script("(()=>{const el=document.querySelector('#messages');return el.scrollTop>0 && el.scrollHeight-el.clientHeight-el.scrollTop<=1})()");
  await until(atBottom);
  await script("document.querySelector('#messages').lastElementChild.style.minHeight='2200px'");
  await until(atBottom);
  await rpc('browser.preview',{accountId:account.id,pageId:target.id});
  assert.equal(await script('window.fixtureSendCount'),1,'Following never sends another message');
  await script("const marker=document.createElement('div');marker.id='frame-marker';marker.style.cssText='position:fixed;top:0;left:0;width:140px;height:140px;background:red;z-index:99999';document.body.append(marker)");
  const firstFrame=await rpc('browser.preview',{accountId:account.id,pageId:target.id});
  const other=await rpc('accounts.create',{name:'切换预览测试'});
  await until(async()=> (await rpc('browser.inspect',{accountId:other.id})).editor);
  await rpc('accounts.switch',{id:other.id});
  await script("document.querySelector('#frame-marker').style.background='blue'");
  await new Promise(resolve=>setTimeout(resolve,3200));
  await rpc('accounts.switch',{id:account.id});
  await until(async()=>{
    const frame=await rpc('browser.preview',{accountId:account.id,pageId:target.id});
    return !!frame?.image && frame.image!==firstFrame.image;
  });
  const beforeStall=await page.locator('.preview-canvas img').getAttribute('src');
  await desktop.evaluate(({webContents,session},{url,partition})=>{
    const contents=webContents.getAllWebContents().find(w=>w.getURL()===url && w.session===session.fromPartition(partition));
    if(!contents)throw new Error('Preview fixture missing');
    const capture=contents.capturePage.bind(contents);
    let once=true;
    contents.capturePage=(...args)=>{
      if(once){once=false;return new Promise(()=>{});}
      return capture(...args);
    };
  },{url:target.url,partition:account.partition});
  await script("document.querySelector('#frame-marker').style.background='green'");
  await until(async()=> (await page.locator('.preview-canvas img').getAttribute('src'))!==beforeStall);
  const beforeStale=await page.locator('.preview-canvas img').getAttribute('src');
  await desktop.evaluate(async({webContents,session},{url,partition})=>{
    const contents=webContents.getAllWebContents().find(w=>w.getURL()===url && w.session===session.fromPartition(partition));
    if(!contents)throw new Error('Preview fixture missing');
    const capture=contents.capturePage.bind(contents);
    const stale=await capture(undefined,{stayHidden:true,stayAwake:true});
    contents.fixtureWoke=false;
    contents.capturePage=(rect,options)=>{
      if(options?.stayHidden)return Promise.resolve(stale);
      contents.fixtureWoke=true;
      return capture(rect,options);
    };
  },{url:target.url,partition:account.partition});
  await script("document.querySelector('#frame-marker').style.background='yellow';document.querySelector('[data-message-author-role=assistant]').textContent+=' Continued reply content.'");
  await until(async()=> (await page.locator('.preview-canvas img').getAttribute('src'))!==beforeStale);
  assert.equal(await desktop.evaluate(({webContents,session},{url,partition})=>webContents.getAllWebContents()
    .find(w=>w.getURL()===url && w.session===session.fromPartition(partition))?.fixtureWoke,
  {url:target.url,partition:account.partition}),true,'Stale frames wake the hidden page for a fresh capture');
  await rpc('browser.select',{accountId:account.id,pageId:original.id});
  await script("document.querySelector('#messages').scrollTo({top:0,behavior:'instant'})");
  // Wait longer than two preview intervals to catch a leaked follow timer.
  await new Promise(resolve=>setTimeout(resolve,2200));
  assert.equal(await script("document.querySelector('#messages').scrollTop"),0,'Inactive previews preserve position');
  await rpc('browser.select',{accountId:account.id,pageId:target.id});
  await until(atBottom);
  await rpc('queues.takeover',{accountId:account.id,conversation:task.conversationId});
  await until(async()=> !(await rpc('workspace.status')).pages.find(p=>p.id===target.id).locked);
  await script("document.querySelector('#messages').scrollTo({top:0,behavior:'instant'})");
  assert.equal(await rpc('browser.preview',{accountId:account.id,pageId:target.id}),null);
  assert.equal(await script("document.querySelector('#messages').scrollTop"),0,'Takeover stops automatic following');
  console.log('Preview desktop passed: automatic following as replies grow, inactive-page isolation, resume on selection, no extra sends and no following after takeover.');
} catch(error) {
  console.error('Preview failure:',error);
  console.error(await bounded(page?.evaluate(async()=>({preview:document.querySelector('.agent-preview')?.textContent,
    image:!!document.querySelector('.preview-canvas img'),pages:(await window.workspace.call('workspace.status')).pages})),'Failure state').catch(()=>null));
  throw error;
} finally {
  await bounded(desktop?.close(),'Fixture shutdown');
  const target=path.resolve(directory);
  assert.equal(path.dirname(target),root); assert.ok(path.basename(target).startsWith('.test-preview-'));
  await rm(target,{recursive:true,force:true});
}
