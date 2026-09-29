import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-queue-restart-'));
const externalTurn = process.argv.includes('--external-turn');
// Persist the remote conversation across real process restarts. Older history
// mounts on reload even though it was absent when the first send was recorded.
const fixture = `<!doctype html><main><div id="turns"></div><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></main><script>
const key=location.pathname, editor=document.querySelector('textarea'), turns=document.querySelector('#turns');
let history=JSON.parse(localStorage.getItem(key)||'[]'), busy=history.length===1;
const remounted=history.length>0;
if(remounted && history.length===1 && ${externalTurn}){history.push('External follow-up');localStorage.setItem(key,JSON.stringify(history));}
function render(){
 turns.replaceChildren();document.querySelector('[data-testid="stop-button"]')?.remove();
 if(remounted){const old=document.createElement('div');old.dataset.messageAuthorRole='user';old.dataset.messageId='older-not-in-receipt';old.textContent='Older history';turns.append(old);}
 history.forEach((text,i)=>{const u=document.createElement('div');u.dataset.messageAuthorRole='user';u.dataset.messageId='u'+i;u.textContent=text;turns.append(u);
 if(i<history.length-1||!busy){const a=document.createElement('article');a.innerHTML='<div data-message-author-role="assistant" data-message-id="a'+i+'">Reply '+i+'</div><button data-testid="copy-turn-action-button">Copy</button>';turns.append(a);}});
 if(busy){const b=document.createElement('button');b.dataset.testid='stop-button';b.textContent='Stop';document.querySelector('main').append(b);}
}
window.finishReply=()=>{busy=false;render();};
document.querySelector('[data-testid="send-button"]').onclick=()=>{if(!editor.value||busy)return;history.push(editor.value);localStorage.setItem(key,JSON.stringify(history));editor.value='';busy=history.length===1;render();};render();
</script>`;
const bootstrap=path.join(directory,'main.cjs');
await writeFile(bootstrap,`const {app,Notification}=require('electron');Notification.isSupported=()=>false;
app.on('browser-window-created',(_,w)=>w.on('show',()=>w.hide()));
app.on('session-created',s=>s.protocol.handle('https',()=>new Response(${JSON.stringify(fixture)},{headers:{'Content-Type':'text/html'}})));
require(${JSON.stringify(path.join(root,'dist-electron/main.cjs'))});`);
const env={...process.env,WORKSPACE_USER_DATA:directory};delete env.ELECTRON_RUN_AS_NODE;delete env.WORKSPACE_DEV_URL;
let desktop,shell;
const launch=async()=>{
 desktop=await electron.launch({args:[bootstrap],env});
 // Restored remote views can appear before the local application window.
 await until(async()=>!!(shell=desktop.windows().find(p=>p.url().startsWith('file:'))));
 await shell.waitForFunction(()=>!!window.workspace);
};
const rpc=(method,params={})=>shell.evaluate(({method,params})=>window.workspace.call(method,params),{method,params});
const until=async check=>{const end=Date.now()+30000;while(!await check()){assert.ok(Date.now()<end,'Restart did not recover');await new Promise(r=>setTimeout(r,150));}};
try{
 await launch();
 const account=await rpc('accounts.create',{name:'Restart queue'});
 const conversation=await rpc('conversations.register',{accountId:account.id,url:'https://chatgpt.com/c/restart'});
 const add=prompt=>rpc('tasks.create',{accountId:account.id,conversation:conversation.id,background:true,input:{type:'prompt',prompt,submit:true}});
 const first=await add('first'),next=await add('next');
 await until(async()=>!!(await rpc('tasks.get',{id:first.id})).submittedAt);
 const receipt=(await rpc('tasks.get',{id:first.id})).submittedMessageId;
 await desktop.close();await launch();
 await until(async()=>(await rpc('tasks.get',{id:first.id})).status==='running');
 await until(async()=>desktop.windows().some(p=>p.url().endsWith('/restart')));
 const page=desktop.windows().find(p=>p.url().endsWith('/restart'));
 await page.waitForFunction(()=>typeof window.finishReply==='function');
 const recoveryRetries=(await rpc('tasks.get',{id:first.id})).retryCount??0;
 // Waiting for genuine generation must not become a repeated recovery error.
 await new Promise(r=>setTimeout(r,7000));
 let restored=await rpc('tasks.get',{id:first.id});
 assert.equal(restored.status,'running',restored.error);assert.equal(restored.retryCount??0,recoveryRetries);
 assert.equal(restored.submittedMessageId,receipt);assert.equal((await rpc('tasks.get',{id:next.id})).sendIntentAt,undefined);
 await page.evaluate(()=>window.finishReply());
 await until(async()=>(await rpc('tasks.get',{id:next.id})).status==='done');
 assert.equal((await rpc('tasks.get',{id:first.id})).status,'done');
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem(location.pathname))),externalTurn?['first','External follow-up','next']:['first','next']);
 if(externalTurn){const result=(await rpc('tasks.get',{id:first.id})).result;assert.equal(result.responseUnavailable,true);assert.equal(result.response,undefined);assert.equal(result.completionReason,'idle_after_reply_correlation_lost');}
 console.log('Restart queue passed: busy reply resumes observation without retry or duplicate; next sends once after completion.');
}finally{await desktop?.close();assert.equal(path.dirname(directory),root);assert.ok(path.basename(directory).startsWith('.test-queue-restart-'));await rm(directory,{recursive:true,force:true});}
