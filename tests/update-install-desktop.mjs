import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

// Exercise the actual NSIS updater downloader with an isolated local feed.
// Only the final OS installer launch is replaced; never execute fixture bytes.
if (process.platform !== 'win32') { console.log('NSIS update integration runs on Windows.'); process.exit(0); }
const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-update-install-'));
const { version } = JSON.parse(await readFile('package.json','utf8'));
const next = version.split('.').map(Number); next[2]++;
const latest = next.join('.');
const filename = `ChatGPT-Web-Client-${latest}-win-${process.arch}.exe`;
const bytes = Buffer.alloc(256 * 1024, 17);
const info = { version:latest, files:[{url:filename,size:bytes.length,sha512:createHash('sha512').update(bytes).digest('base64')}] };
const requests=[]; let binaries=0;
const server=createServer((req,res)=>{
  requests.push({url:req.url,cookie:req.headers.cookie,authorization:req.headers.authorization});
  if(req.url?.split('?')[0]===`/latest-${process.arch}.yml`) { res.end(JSON.stringify(info)); return; }
  if(req.url?.split('?')[0]!==`/${filename}`) {res.writeHead(404).end();return;}
  const payload=++binaries===1?Buffer.alloc(bytes.length,18):bytes;
  res.writeHead(200,{'Content-Length':payload.length,'Content-Type':'application/octet-stream'});
  let offset=0;
  const timer=setInterval(()=>{res.write(payload.subarray(offset,offset+16384));offset+=16384;if(offset>=payload.length){clearInterval(timer);res.end();}},100);
  res.on('close',()=>clearInterval(timer));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const feed=`http://127.0.0.1:${server.address().port}/`;
const marker=path.join(directory,'installed.json');
const config=path.join(directory,'app-update.yml');
await writeFile(config,JSON.stringify({provider:'generic',url:feed,channel:`latest-${process.arch}`,updaterCacheDirName:path.basename(directory)}));
const bootstrap=path.join(directory,'fixture.cjs');
await writeFile(bootstrap,`const {app,Notification}=require('electron');
const fs=require('node:fs');
const updater=require('electron-updater/out/NsisUpdater');
const Original=updater.NsisUpdater;
Object.defineProperty(app,'isPackaged',{get:()=>true});
app.getVersion=()=>${JSON.stringify(version)};
app.setPath('cache',${JSON.stringify(path.join(directory,'cache'))});
Notification.isSupported=()=>false;
// Keep a live compositor for Playwright's actionability checks after tasks
// finish. Hiding the window can suspend animation frames on Windows runners.
app.on('browser-window-created',(_,win)=>{win.webContents.setBackgroundThrottling(false);win.setSkipTaskbar(true);win.setPosition(-20000,-20000);});
app.on('session-created',s=>s.protocol.handle('https',()=>new Response(${JSON.stringify(fixture)},{headers:{'Content-Type':'text/html'}})));
global.fetch=async url=>{if(url!=='https://api.github.com/repos/chenziyang110/ChatGPT-Web-Client/releases/latest')throw new Error('Unexpected update request');return new Response(JSON.stringify({tag_name:${JSON.stringify('v'+latest)}}));};
updater.NsisUpdater=class extends Original {
 constructor(options){
  if(options.url!==${JSON.stringify(`https://github.com/chenziyang110/ChatGPT-Web-Client/releases/download/v${latest}/`)})throw new Error('Unpinned update feed');
  super({...options,url:${JSON.stringify(feed)}});this.updateConfigPath=${JSON.stringify(config)};
 }
 quitAndInstall(silent,restart){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({silent,restart,autoInstall:this.autoInstallOnAppQuit,directory:this.installDirectory}));app.quit();}
};
require(${JSON.stringify(path.join(root,'dist-electron/main.cjs'))});`);
const env={...process.env,WORKSPACE_USER_DATA:directory,WORKSPACE_HIDDEN_PAGE_IDLE_MS:'3600000'};
delete env.ELECTRON_RUN_AS_NODE;delete env.WORKSPACE_DEV_URL;
let desktop, page;
try {
  const launch=()=>electron.launch({args:['--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows',bootstrap],env});
  desktop=await launch();
  page=await desktop.firstWindow();page.setDefaultTimeout(20000);await page.waitForFunction(()=>!!window.workspace);
  const rpc=(method,params={})=>page.evaluate(({method,params})=>window.workspace.call(method,params),{method,params});
  const until=async check=>{const end=Date.now()+25000;while(!await check()){assert.ok(Date.now()<end,'Update condition timed out');await new Promise(resolve=>setTimeout(resolve,100));}};
  await rpc('updates.configure',{enabled:false});
  await assert.rejects(rpc('updates.install'),/先完成/);
  const account=await rpc('accounts.create',{name:'Update survivor'});
  const task=await rpc('tasks.create',{accountId:account.id,new:true,input:{type:'prompt',prompt:'HOLD:keep running',submit:true}});
  await until(async()=>!!(await rpc('tasks.get',{id:task.id})).submittedAt);
  await page.getByRole('button',{name:/设置与集成/}).click();
  await page.getByRole('button',{name:'检查更新',exact:true}).click();
  await page.getByRole('button',{name:'下载更新',exact:true}).click();
  await page.getByRole('progressbar',{name:'更新下载进度'}).waitFor();
  await page.getByRole('button',{name:'重试下载',exact:true}).waitFor();
  assert.equal((await rpc('updates.status')).status,'error','Bad bytes cannot become installable');
  await page.getByRole('button',{name:'重试下载',exact:true}).click();
  await page.getByRole('button',{name:'安装并重启',exact:true}).waitFor();
  await page.getByRole('button',{name:'安装并重启',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'还有回复或任务正在进行'}).waitFor();
  await assert.rejects(readFile(marker),/ENOENT/);
  const target=(await rpc('workspace.status')).pages.find(p=>p.taskId===task.id);
  await desktop.evaluate(async({webContents},url)=>{await webContents.getAllWebContents().find(w=>w.getURL()===url).executeJavaScript('window.fixtureFinish()');},target.url);
  await until(async()=>(await rpc('tasks.get',{id:task.id})).status==='done');
  await rpc('queues.pause',{accountId:account.id,conversation:task.conversationId});
  const queued=await rpc('tasks.create',{accountId:account.id,conversation:task.conversationId,input:{type:'prompt',prompt:'Saved for after update',submit:true}});
  const closed=desktop.waitForEvent('close');
  await page.getByRole('button',{name:'安装并重启',exact:true}).click();
  await closed;
  const install=JSON.parse(await readFile(marker,'utf8'));
  assert.equal(install.silent,true);assert.equal(install.restart,true);assert.equal(install.autoInstall,false);
  assert.ok(path.isAbsolute(install.directory));
  assert.equal(binaries,2);
  assert.ok(requests.every(r=>!r.cookie&&!r.authorization),'Download requests do not use account credentials');
  desktop=await launch();page=await desktop.firstWindow();await page.waitForFunction(()=>!!window.workspace);
  assert.equal((await rpc('accounts.list'))[0].name,'Update survivor');
  assert.equal((await rpc('tasks.get',{id:queued.id})).status,'pending');
  assert.equal((await rpc('queues.status')).find(q=>q.conversationId===task.conversationId).paused,true);
  console.log('Update install integration passed: native downloader, progress, SHA-512 rejection/retry, explicit restart, busy-task guard, saved account/queue and credential isolation. Final installer launch is stubbed.');
} catch(error) {
  console.error({requests,binaries,state:await page?.evaluate(()=>window.workspace.call('updates.status')).catch(()=>null)});
  throw error;
} finally {
  await desktop?.close();await new Promise(resolve=>server.close(resolve));
  const target=path.resolve(directory);assert.equal(path.dirname(target),root);assert.ok(path.basename(target).startsWith('.test-update-install-'));
  await rm(target,{recursive:true,force:true});
}
