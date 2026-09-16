import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fixture } from './chatgpt-fixture.mjs';

const directory = await mkdtemp(path.resolve('.test-reply-route-'));
const bootstrap = path.join(directory, 'fixture.cjs');
const routed = fixture.replace("let messages = JSON.parse(localStorage.getItem(historyKey()) || '[]');", "let messages = location.pathname === '/' ? [] : JSON.parse(localStorage.getItem(historyKey()) || '[]');").replace("history.pushState({}, '', '/c/' + crypto.randomUUID()); messages = [];", `
 const newPath = '/c/' + crypto.randomUUID();
 history.pushState({}, '', '/?model=pro'); messages = [];
 setTimeout(() => history.replaceState({}, '', '/c/WEB:' + crypto.randomUUID()), 100);
 setTimeout(() => history.replaceState({}, '', newPath + '/?model=pro#reply'), 900);
 setTimeout(() => history.replaceState({}, '', newPath), 1400);
`).replace('text.textContent = message.text;', `
 if (message.role === 'user') {
   const body = document.createElement('div'); body.dataset.testid = 'collapsible-user-message-content'; body.textContent = message.text;
   const toggle = document.createElement('button'); toggle.dataset.testid = 'collapsible-user-message-toggle'; toggle.textContent = '展开';
   text.append(body, toggle);
   setTimeout(() => { toggle.textContent = '收起'; }, 800);
 } else text.textContent = message.text;
`).replace("if (!window.fixtureHold && !value.startsWith('HOLD:')) setTimeout(() => window.fixtureFinish(), window.fixtureDelay || 200);", `
 const fullReply = 'Fixture reply: ' + value;
 messages.at(-1).text = 'Fixture'; render();
 setTimeout(() => { messages.at(-1).text = 'Fixture reply: '; render(); }, 600);
 setTimeout(() => { messages.at(-1).text = fullReply; render(); window.fixtureFinish(); }, 1600);
`);
assert.notEqual(routed, fixture);
await writeFile(bootstrap, `const {app}=require('electron');app.on('session-created',s=>s.protocol.handle('https',()=>new Response(${JSON.stringify(routed)},{headers:{'Content-Type':'text/html'}})));require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop;
try {
  desktop = await electron.launch({ args: ['--no-sandbox', bootstrap], env });
  const page = await desktop.firstWindow(); await page.waitForFunction(() => !!window.workspace);
  const rpc = (method, params = {}) => page.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params });
  const account = await rpc('accounts.create', { name: 'Reply routing' });
  const params = { accountId: account.id, new: true, idempotencyKey: 'first-send-route', input: { type: 'prompt', prompt: 'Recover normal first-send routing', submit: true } };
  const task = await rpc('tasks.create', params);
  const deadline = Date.now() + 20000;
  let current;
  do {
    assert.ok(Date.now() < deadline, 'Reply did not complete');
    await new Promise(resolve => setTimeout(resolve, 150));
    current = await rpc('tasks.get', { id: task.id });
  } while (['pending', 'running'].includes(current.status));
  assert.equal(current.status, 'done', current.error);
  assert.equal(current.result.response, 'Fixture reply: ' + params.input.prompt);
  assert.match(current.result.url, /^https:\/\/chatgpt.com\/c\/[\w-]+$/);
  assert.ok(current.submittedAt);
  assert.equal((await rpc('conversations.get', { accountId: account.id, conversation: task.conversationId })).url, current.result.url);
  assert.equal((await rpc('tasks.create', params)).id, task.id);
  assert.equal(await desktop.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url).executeJavaScript('window.fixtureSendCount'), current.result.url), 1);
  await rpc('settings.api', { enabled: true });
  const handoff = await rpc('agent.prompt', { accountId: account.id });
  const questionFile = path.join(directory, 'stream question.txt'); await writeFile(questionFile, '中文流式测试');
  const args = handoff.commands.create.map(arg => arg === 'QUESTION_FILE' ? questionFile : arg === 'REQUEST_UUID' ? 'go-stream-test' : arg);
  assert.match(args[0], /chatgpt-agent(?:\.exe)?$/);
  const events = []; let errors = ''; let pending = ''; let firstDeltaAt; let doneAt;
  const child = spawn(args[0], [...args.slice(1), '--stream'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', value => { errors += value; });
  child.stdout.on('data', value => {
    pending += value;
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'); const line = pending.slice(0, end); pending = pending.slice(end + 1);
      const event = JSON.parse(line); events.push(event);
      if (event.event === 'delta') firstDeltaAt ??= Date.now(); if (event.event === 'done') doneAt = Date.now();
    }
  });
  const timeout = setTimeout(() => child.kill(), 25000);
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); clearTimeout(timeout);
  assert.equal(exit, 0, errors); assert.ok(firstDeltaAt < doneAt - 2000, 'Reply must stream before completion');
  assert.ok(events.filter(event => event.event === 'delta').length >= 2, 'Multiple incremental output events');
  const done = events.at(-1); assert.equal(done.event, 'done'); assert.equal(done.result.response, 'Fixture reply: 中文流式测试');
  assert.equal(await desktop.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url).executeJavaScript('window.fixtureSendCount'), done.result.url), 1);
  const resume = spawn(args[0], ['--data-dir', directory, 'resume', done.taskId], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let resumed = ''; resume.stdout.setEncoding('utf8'); resume.stdout.on('data', value => { resumed += value; });
  assert.equal(await new Promise(resolve => resume.on('close', resolve)), 0);
  assert.equal(JSON.parse(resumed).result.response, done.result.response);
  assert.equal((await rpc('tasks.list')).length, 2, 'Resume must not create another task');
  console.log('Reply routing and native Agent desktop passed: optimistic routes, streaming, resume and pinned CLI.');
} finally {
  if (desktop) await desktop.close();
  assert.ok(directory.startsWith(path.resolve('.') + path.sep + '.test-reply-route-'));
  await rm(directory, { recursive: true, force: true });
}
