export const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT fixture</title><style>[data-message-author-role] { white-space: pre-wrap; }</style></head>
<body><main><h1>Fixture conversation</h1><textarea id="prompt-textarea"></textarea>
<button data-testid="send-button">Send</button><div id="messages"></div></main>
<script>
const historyKey = () => 'fixture-history:' + location.pathname;
let messages = JSON.parse(localStorage.getItem(historyKey()) || '[]');
function render() {
 const container = document.querySelector('#messages'); container.replaceChildren();
 for (const message of messages) {
  const turn = document.createElement('article'); const text = document.createElement('div');
  text.dataset.messageAuthorRole = message.role; text.dataset.messageId = message.id; text.textContent = message.text;
  turn.append(text);
  if (message.role === 'assistant' && message.finished) { const copy = document.createElement('button'); copy.dataset.testid = 'copy-turn-action-button'; copy.textContent = 'Copy'; turn.append(copy); }
  container.append(turn);
 }
 localStorage.setItem(historyKey(), JSON.stringify(messages));
}
render();
if (location.pathname === '/' && localStorage.getItem('fixture-delay-editor')) {
 localStorage.removeItem('fixture-delay-editor');
 const editor = document.querySelector('#prompt-textarea'); editor.id = 'pending-composer'; editor.hidden = true;
 setTimeout(() => { editor.id = 'prompt-textarea'; editor.hidden = false; }, 1600);
}
document.querySelector('[data-testid="send-button"]').onclick = () => {
 const composer = document.querySelector('#prompt-textarea');
 const value = composer instanceof HTMLTextAreaElement ? composer.value : composer.innerText;
 if (document.querySelector('[data-testid="stop-button"]')) throw new Error('Sent while generating');
 window.fixtureSendCount = (window.fixtureSendCount || 0) + 1;
 if (location.pathname === '/') { history.pushState({}, '', '/c/' + crypto.randomUUID()); messages = []; }
 if (composer instanceof HTMLTextAreaElement) composer.value = ''; else composer.textContent = '';
 messages.push({ role: 'user', id: crypto.randomUUID(), text: value });
 messages.push({ role: 'assistant', id: crypto.randomUUID(), text: 'Fixture reply: ' + value, finished: false });
 const stop = document.createElement('button'); stop.dataset.testid = 'stop-button'; stop.textContent = 'Stop'; document.querySelector('main').append(stop); render();
 window.fixtureFinish = () => { messages.at(-1).finished = true; stop.remove(); render(); };
 window.fixtureFail = () => {
  stop.remove(); messages.pop(); render();
  const card = document.createElement('div'); card.id = 'fixture-reply-error';
  card.innerHTML = 'Unusual activity has been detected from your device. Try again later. (fixture-id) <button>重试</button>';
  document.querySelector('#messages').append(card);
 };
 if (!window.fixtureHold && !value.startsWith('HOLD:')) setTimeout(() => window.fixtureFinish(), window.fixtureDelay || 200);
};</script></body></html>`;
