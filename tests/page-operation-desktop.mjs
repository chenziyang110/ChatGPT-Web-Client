import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

// Exercise the production serialization and Electron exception boundary in a
// disposable, offline renderer. Never use an existing account or profile.
const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-page-operation-'));
const bundle = path.join(directory, 'adapter.cjs');
const bootstrap = path.join(directory, 'main.cjs');
const url = 'https://chatgpt.com/c/diagnostic-fixture';
await build({ entryPoints: ['src/main/adapters/ChatGPTAdapter.ts'], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'] });
const fixture = '<!doctype html><html><head><title>Offline DOM diagnostics</title></head><body><main><div id="prompt-textarea" contenteditable="true" role="textbox" style="min-height:40px"></div><button data-testid="send-button">Send</button></main></body></html>';
await writeFile(bootstrap, `const { app, BrowserWindow, session } = require('electron');
globalThis.fixtureAdapter = require(${JSON.stringify(bundle)});
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async () => {
 session.defaultSession.protocol.handle('https', () => new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html' } }));
 const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
 await win.loadURL(${JSON.stringify(url)});
});`);
let desktop;
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ args: [bootstrap], env });
  const page = await desktop.firstWindow();
  await page.waitForSelector('#prompt-textarea');
  async function execute(operation, raw = false) {
    return desktop.evaluate(async ({ BrowserWindow }, { bundle, operation, raw }) => {
      const adapter = globalThis.fixtureAdapter;
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const result = await contents.executeJavaScript(adapter.pageOperationScript(operation), true);
      return raw ? result : adapter.pageOperationResult(result);
    }, { bundle, operation, raw });
  }
  const guard = { url, anchor: '[]' };
  const diagnostic = await execute({ kind: 'diagnose' });
  assert.deepEqual(diagnostic.dom, { editorTag: 'div', contentEditable: true, visibleEditorCount: 1,
    draftLineLengths: [0], editorBlocks: [],
    sendVisible: true, sendEnabled: true, stopVisible: false, streamingVisible: false, ariaBusyVisible: false,
    messageCount: 0, lastRole: null, lastTurnTerminal: false });
  await page.evaluate(() => {
    window.fixtureSends = 0;
    document.querySelector('[data-testid="send-button"]').onclick = () => window.fixtureSends++;
    document.querySelector('#prompt-textarea').focus = () => { throw new TypeError('PRIVATE_PROMPT_DO_NOT_PERSIST'); };
  });
  const failure = await execute({ ...guard, kind: 'fill', value: 'test' }, true);
  assert.equal(failure.ok, false);
  assert.match(failure.error, /PAGE_SCRIPT_FAILED \[stage=focus_editor; error=TypeError\]/);
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_PROMPT/);
  await assert.rejects(execute({ ...guard, kind: 'fill', value: 'test' }), /stage=focus_editor/);
  await page.evaluate(() => { delete document.querySelector('#prompt-textarea').focus; });
  const prompt = '中文测试第一行\n第二行';
  assert.deepEqual(await execute({ ...guard, kind: 'fill', value: prompt }), { prepared: true });
  assert.equal(await page.locator('#prompt-textarea').innerText(), prompt);
  const draft = await execute({ ...guard, kind: 'fill', value: 'Do not overwrite' }, true);
  assert.match(draft.error, /DRAFT_CONFLICT.*stage=check_draft/);
  assert.equal(await page.locator('#prompt-textarea').innerText(), prompt);
  await page.evaluate(() => { document.querySelector('[data-testid="send-button"]').disabled = true; });
  const unavailable = await execute({ ...guard, kind: 'send', value: prompt }, true);
  assert.match(unavailable.error, /SEND_UNAVAILABLE.*stage=verify_send/);
  assert.equal(await page.evaluate(() => window.fixtureSends), 0);
  await page.evaluate(() => { document.querySelector('[data-testid="send-button"]').disabled = false; });
  assert.deepEqual(await execute({ ...guard, kind: 'check_send', value: prompt }), { ready: true });
  assert.equal(await page.evaluate(() => window.fixtureSends), 0);
  assert.deepEqual(await execute({ ...guard, kind: 'send', value: prompt }), { clicked: true });
  assert.equal(await page.evaluate(() => window.fixtureSends), 1);
  // Observed on live ChatGPT: two <p> blocks produce an extra innerText newline.
  // Deliberate blank lines, soft breaks, and human edits must stay distinguishable.
  await page.evaluate(() => {
    document.querySelector('#prompt-textarea').innerHTML = '<p>中文测试第一行</p><p>第二行</p>';
  });
  assert.equal(await page.locator('#prompt-textarea').innerText(), '中文测试第一行\n\n第二行');
  assert.equal((await execute({ kind: 'inspect' })).draft, prompt);
  assert.deepEqual(await execute({ ...guard, kind: 'check_send', value: prompt }), { ready: true });
  await page.evaluate(() => {
    document.querySelector('#prompt-textarea').innerHTML = '<p>中文测试第一行</p><p><br class="ProseMirror-trailingBreak"></p><p>第二行<br>软换行<br class="ProseMirror-trailingBreak"></p>';
  });
  assert.equal((await execute({ kind: 'inspect' })).draft, '中文测试第一行\n\n第二行\n软换行');
  assert.match((await execute({ ...guard, kind: 'check_send', value: prompt }, true)).error, /DRAFT_CHANGED/);
  await page.evaluate(() => { document.querySelector('#prompt-textarea').innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>'; });
  assert.equal((await execute({ kind: 'inspect' })).draft, '');
  await execute({ ...guard, kind: 'fill', value: prompt });
  assert.match((await execute({ ...guard, kind: 'clear', value: 'a different draft' }, true)).error, /DRAFT_CHANGED/);
  assert.equal((await execute({ kind: 'inspect' })).draft, prompt);
  assert.deepEqual(await execute({ ...guard, kind: 'clear', value: prompt }), { cleared: true });
  assert.equal((await execute({ kind: 'inspect' })).draft, '');
  await execute({ ...guard, kind: 'fill', value: prompt });
  const structure = await execute({ kind: 'diagnose' });
  assert.doesNotMatch(JSON.stringify(structure.dom), /中文测试|第二行/);
  await page.evaluate(() => {
    const stop = document.createElement('button'); stop.dataset.testid = 'stop-button'; document.body.append(stop);
  });
  assert.equal((await execute({ kind: 'diagnose' })).dom.stopVisible, true);
  const busy = await execute({ ...guard, kind: 'send', value: prompt }, true);
  assert.match(busy.error, /PAGE_CHANGED.*stage=verify_target/);
  assert.equal(await page.evaluate(() => window.fixtureSends), 1);
  // Replies scroll inside their own viewport, separately from sidebar history
  // and code blocks. Following must not click controls or disturb a draft.
  await page.evaluate(() => {
    document.body.innerHTML = `<aside style="height:120px;overflow-y:auto"><div style="height:900px">Sidebar</div></aside>
      <main><div id="conversation" style="height:240px;overflow-y:auto;scroll-behavior:smooth">
      <article><div data-message-author-role="user" style="height:400px">Earlier message</div></article>
      <article><div data-message-author-role="assistant" style="min-height:600px">Latest reply
      <pre style="height:80px;overflow:auto"><code style="display:block;height:300px">Code</code></pre></div></article></div>
      <textarea id="prompt-textarea">Untouched draft</textarea><button id="jump">Down</button></main>`;
    document.querySelector('aside').scrollTop = 30;
    document.querySelector('pre').scrollTop = 25;
    document.querySelector('#prompt-textarea').focus();
    window.fixtureClicks = 0;
    document.querySelector('#jump').onclick = () => window.fixtureClicks++;
  });
  const scrollState = () => page.evaluate(() => {
    const el = document.querySelector('#conversation');
    return { top: el.scrollTop, remaining: el.scrollHeight - el.clientHeight - el.scrollTop,
      sidebar: document.querySelector('aside').scrollTop, code: document.querySelector('pre').scrollTop,
      draft: document.querySelector('#prompt-textarea').value, focus: document.activeElement.id, clicks: window.fixtureClicks };
  });
  const original = await scrollState();
  assert.equal(original.top, 0);
  assert.ok(original.remaining > 500);
  assert.deepEqual(await execute({ kind: 'follow_latest', url }), { scrolled: true });
  const followed = await scrollState();
  assert.ok(followed.remaining <= 1, 'Nested conversation immediately follows the latest reply, even with smooth scrolling CSS');
  for (const key of ['sidebar', 'code', 'draft', 'focus', 'clicks']) assert.equal(followed[key], original[key], key);
  await page.evaluate(() => { document.querySelector('[data-message-author-role="assistant"]').style.minHeight = '1000px'; });
  assert.ok((await scrollState()).remaining > 300);
  await execute({ kind: 'follow_latest', url });
  assert.ok((await scrollState()).remaining <= 1, 'Streaming growth follows on the next preview');
  await page.evaluate(() => document.querySelector('#conversation').scrollTo({ top: 0, behavior: 'instant' }));
  assert.match((await execute({ kind: 'follow_latest', url: url + '-other' }, true)).error, /TARGET_CHANGED/);
  assert.equal((await scrollState()).top, 0, 'A navigation race cannot scroll another conversation');
  await page.evaluate(() => { document.body.innerHTML = '<main><article><div data-message-author-role="assistant" style="height:2400px">Document scroll reply</div></article></main>'; });
  await execute({ kind: 'follow_latest', url });
  assert.ok(await page.evaluate(() => document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight - document.scrollingElement.scrollTop <= 1), 'Document scrolling is supported');
  await page.evaluate(() => { document.body.innerHTML = '<main style="height:2400px">No messages yet</main>'; window.scrollTo(0, 0); });
  assert.deepEqual(await execute({ kind: 'follow_latest', url }), { scrolled: false });
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'Pages without conversation messages do not move');
  console.log('Page operation desktop checks passed: safe exception transport, contenteditable input, draft/send guards, diagnostics and latest-reply scrolling without moving the sidebar, code blocks, draft or focus.');
} finally {
  await desktop?.close();
  const target = path.resolve(directory);
  if (path.dirname(target) !== root || !path.basename(target).startsWith('.test-page-operation-')) throw new Error('Unsafe test cleanup path');
  await rm(target, { recursive: true, force: true });
}
