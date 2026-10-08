// Structural schemas inspected on authenticated ChatGPT Work and Your dot,
// 2026-09-30. Home deliberately forgets the mode when the document reloads.
export const surfaceFixture = `<!doctype html><meta charset="utf-8"><title>Surface fixture</title>
<main><nav id="modes"></nav><div id="turns"></div><div id="composer"></div>
<button aria-label="Pause your dot" id="agent">Pause your dot</button>
<span data-slot="thread-summary-panel-item-leading" id="dot-work"><div data-codex-pet-state="idle"></div></span>
<div class="typing-indicator" data-visible="false" role="status"></div></main><script>
const dot=location.pathname.startsWith('/dots/'), key=location.pathname;
let work=!dot&&location.pathname.includes('/c/work-'),history=JSON.parse(localStorage.getItem(key)||'[]');
let waiting=dot&&history.length===1, canonical=history.length>0, clicks=Number(localStorage.getItem(key+':clicks')||'0');
let working=dot&&localStorage.getItem(key+':working')==='true';
const turns=document.querySelector('#turns'),host=document.querySelector('#composer');
host.innerHTML=dot?'<div data-codex-composer-root><div data-composer-markdown contenteditable="true" role="textbox" aria-label="消息"></div><button type="button" aria-label="发送" disabled aria-disabled="true">Send</button></div>':'<form data-composer-placement="home"><div data-composer-markdown contenteditable="true" role="textbox"></div><button type="submit" aria-label="发送" disabled>Send</button></form>';
const root=host.firstElementChild,editor=root.querySelector('[contenteditable]'),send=root.querySelector('button');
function updateMode(){if(dot)return;editor.setAttribute('aria-label',work?'使用 ChatGPT Work':'询问 ChatGPT');if(location.pathname!=='/')return;
document.querySelector('#modes').innerHTML='<button type="button" aria-pressed="'+!work+'">聊天</button><button type="button" aria-pressed="'+work+'">工作</button>';
document.querySelectorAll('#modes button').forEach((b,i)=>b.onclick=()=>{work=!!i;updateMode()});}
function row(id,role,text,terminal=true){if(dot){const a=document.createElement('article');a.className='message-row'+(role==='user'?' self':'');a.dataset.messageId=id;
const body=document.createElement('div');body.className='message-body';body.dataset.messageId=id;body.dataset.markdownTextStyle='assistant-message';body.textContent=text;a.append(body);
if(role==='assistant'&&terminal){const actions=document.createElement('div');actions.className='message-inline-actions--orbit';actions.innerHTML='<button data-action="reply" aria-label="回复">Reply</button>';a.append(actions);}turns.append(a);
}else{const a=document.createElement('div');a.dataset.turnKey=id;const body=document.createElement('div');body.dataset.chatgptSearchUnitKey=id+':'+role;body.dataset.chatgptSearchMessageIds=id;body.textContent=text;a.append(body);
if(role==='assistant'){const actions=document.createElement('div');actions.className='turn-action-controls';actions.innerHTML='<button aria-label="复制">Copy</button>';a.append(actions);}turns.append(a);}}
function render(){turns.replaceChildren();if(dot)row('proactive','assistant','Earlier agent activity');history.forEach((text,i)=>{row((dot&&canonical?'remote-':'')+'u'+i,'user',text);if(!waiting||i<history.length-1)row('a'+i,'assistant','Reply: '+text)});
if(dot&&history.at(-1)==='error-then-work'){const error=document.createElement('div');error.dataset.testid='conversation-error';error.textContent='Dot work failed';turns.append(error);}
document.querySelector('[data-codex-pet-state]').setAttribute('data-codex-pet-state',working?'running':'idle');}
function control(){send.disabled=!editor.innerText.trim();send.setAttribute('aria-disabled',String(send.disabled));}
editor.oninput=()=>setTimeout(control,400);
const submit=()=>{clicks++;localStorage.setItem(key+':clicks',String(clicks));const text=editor.innerText.trim();if(!text)return;if(dot&&text==='ignored-click'&&clicks===1)return;
if(!dot&&location.pathname==='/'){if(!work)throw Error('Work silently fell back to Chat');history=[];history.push(text);localStorage.setItem('/c/work-bound',JSON.stringify(history));window.history.replaceState({},'', '/c/work-bound');}
else{history.push(text);localStorage.setItem(location.pathname,JSON.stringify(history));}
editor.textContent='';waiting=dot&&history.length===1;working=dot&&['ack-then-work','error-then-work'].includes(text);if(working){waiting=false;localStorage.setItem(key+':working','true')}control();render();
if(dot&&!canonical)setTimeout(()=>{canonical=true;render()},600);};
if(dot)send.onclick=submit;else root.onsubmit=e=>{e.preventDefault();submit()};
window.finishReply=()=>{waiting=false;render()};window.startWork=()=>{working=true;localStorage.setItem(key+':working','true');render()};window.finishWork=()=>{working=false;localStorage.setItem(key+':working','false');render()};window.sent=()=>history;window.mode=()=>dot?'dot':work?'work':'chat';updateMode();control();render();
</script>`;
