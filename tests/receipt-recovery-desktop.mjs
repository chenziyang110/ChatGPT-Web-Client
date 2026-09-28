import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

// Isolated offline renderer: lose the composer after a confirmed send, then
// restore the same persisted remote history on reload. Never intercept a real profile.
const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-receipt-recovery-'));
const fixture = `<!doctype html><title>Receipt recovery</title><main><div id="turns"></div>
<textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></main><script>
const key=location.pathname;let history=JSON.parse(sessionStorage.getItem(key)||'[]');
const turns=document.querySelector('#turns'), editor=document.querySelector('textarea');
function render(){turns.replaceChildren();for(const [i,text] of history.entries()){
 const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.dataset.messageId='u'+i;user.textContent=text;turns.append(user);
 const article=document.createElement('article');article.innerHTML='<div data-message-author-role="assistant" data-message-id="a'+i+'">Reply '+i+'</div><button data-testid="copy-turn-action-button">Copy</button>';turns.append(article);
}}
render();window.loads=Number(sessionStorage.getItem(key+'loads')||0)+1;sessionStorage.setItem(key+'loads',window.loads);
document.querySelector('[data-testid="send-button"]').onclick=()=>{
 const value=editor.value;if(!value)return;history.push(value);sessionStorage.setItem(key,JSON.stringify(history));editor.value='';render();
 if(history.length===1)setTimeout(()=>document.querySelector('main').replaceChildren(),1200);
};
</script>`;
const bootstrap = path.join(directory, 'main.cjs');
await writeFile(bootstrap, `const {app,Notification}=require('electron');Notification.isSupported=()=>false;
app.on('browser-window-created',(_,w)=>w.on('show',()=>w.hide()));
app.on('session-created',s=>s.protocol.handle('https',()=>new Response(${JSON.stringify(fixture)},{headers:{'Content-Type':'text/html'}})));
require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop;
try {
  desktop = await electron.launch({ args: [bootstrap], env });
  const ui = await desktop.firstWindow(); await ui.waitForFunction(() => !!window.workspace);
  const rpc = (method, params = {}) => ui.evaluate(({method,params})=>window.workspace.call(method,params),{method,params});
  const account = await rpc('accounts.create', {name:'Receipt recovery'});
  const conversation = await rpc('conversations.register',{accountId:account.id,url:'https://chatgpt.com/c/receipt-recovery'});
  const add = prompt => rpc('tasks.create',{accountId:account.id,conversation:conversation.id,background:true,prepareTimeoutMs:3000,
    input:{type:'prompt',prompt,submit:true}});
  const head = await add('first'); const next = await add('next');
  const deadline = Date.now()+60000;
  while((await rpc('tasks.get',{id:next.id})).status!=='done'){
    assert.ok(Date.now()<deadline,'Queue did not recover a blank page after sending');
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  const recovered = await rpc('tasks.get',{id:head.id});
  assert.equal(recovered.status,'done'); assert.ok(recovered.submittedAt); assert.equal(recovered.retryCount,1);
  const page = desktop.windows().find(p=>p.url().endsWith('/receipt-recovery'));
  assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem(location.pathname))),['first','next']);
  assert.equal(await page.evaluate(()=>window.loads),2,'Recovery must reload once and preserve the receipt');
  console.log('Receipt recovery passed: blank post-send page reloads, original reply completes, FIFO continues without duplicate sends.');
} finally {
  await desktop?.close();
  assert.equal(path.dirname(path.resolve(directory)),root); assert.ok(path.basename(directory).startsWith('.test-receipt-recovery-'));
  await rm(directory,{recursive:true,force:true});
}
