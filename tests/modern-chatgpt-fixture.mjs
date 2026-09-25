// Offline regression fixture derived from DOM inspected on live ChatGPT,
// 2026-09-25. Deliberately has no prompt-textarea, data-testid send/stop,
// data-message-author-role, or article. Never intercept a real user profile.
export const modernFixture = `<!doctype html><html><head><meta charset="utf-8"><title>Modern DOM fixture</title></head>
<body><main><div id="turns"></div><form data-chatgpt-composer>
<div contenteditable="true" role="textbox" data-composer-markdown aria-label="询问 ChatGPT" style="min-height:40px"></div>
<button type="button" aria-label="开始语音">Voice</button></form></main>
<script>
const form=document.querySelector('form'),editor=form.querySelector('[contenteditable]'),turns=document.querySelector('#turns');
let busy=false; let unmounted=[]; window.sent=[]; window.clicks=0;
function control(){const old=form.querySelector('button');old.remove();const b=document.createElement('button');b.type=busy?'button':editor.innerText.trim()?'submit':'button';b.setAttribute('aria-label',busy?'停止':editor.innerText.trim()?'发送':'开始语音');b.textContent=b.getAttribute('aria-label');form.append(b);}
editor.addEventListener('input',()=>setTimeout(control,600));
if(location.pathname.includes('retry')&&!sessionStorage.getItem('fill-recovered'))editor.focus=()=>{sessionStorage.setItem('fill-recovered','yes');throw new TypeError('transient focus failure')};
form.onsubmit=e=>{e.preventDefault();window.clicks++;const text=editor.innerText.trim();if(!text||busy)return;
if(text==='ignored-click'&&window.clicks===1)return;
for(const item of unmounted)item.parent.prepend(item.node);unmounted=[];
busy=true;window.sent.push(text);editor.textContent='';control();
const id=crypto.randomUUID(),turn=document.createElement('div');turn.dataset.turnKey=id;
const user=document.createElement('div');user.dataset.chatgptSearchUnitKey='turn:'+id+':0:user';user.dataset.chatgptSearchMessageIds=id;
const bubble=document.createElement('div');bubble.dataset.userMessageBubble='true';bubble.textContent=text;user.append(bubble);turn.append(user);turns.append(turn);
if(location.pathname==='/'){history.replaceState({},'', '/c/local-chatgpt%3A11111111-1111-4111-8111-111111111111');setTimeout(()=>history.replaceState({},'', '/c/modern-bound'),800);}
setTimeout(()=>{busy=false;control();if(text==='无法思考'||text==='interrupted'){const p=document.createElement('div');p.textContent=text==='interrupted'?'连接已中断。正在等待完整回复':'无法思考';turn.append(p);return;}
if(text==='stopped')return;
if(text==='virtualized-stopped'){
  turns.replaceChildren();return;
}
const reply=document.createElement('div'),replyId=crypto.randomUUID();reply.dataset.chatgptSearchUnitKey='turn:'+id+':2:assistant';reply.dataset.chatgptSearchMessageIds=replyId+' '+replyId;
const heading=document.createElement('h4');heading.dataset.conversationRole='assistant';heading.textContent='ChatGPT 说：';reply.append(heading);
const body=document.createElement('div');body.dataset.chatgptSelectionMessageId=replyId;body.textContent='Reply: '+text;reply.append(body);turn.append(reply);
const actions=document.createElement('div');actions.className='turn-action-controls';actions.innerHTML='<button aria-label="复制">Copy</button>';turn.append(actions);
if(text==='virtualized-long-reply'){
  // Real ChatGPT observed after a long answer: only its assistant unit remains.
  turns.querySelectorAll('[data-chatgpt-search-unit-key$=":user"]').forEach(node=>{unmounted.push({parent:node.parentElement,node});node.remove()});
}
},1000);
};
</script></body></html>`;
