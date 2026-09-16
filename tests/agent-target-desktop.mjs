import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

const directory = await mkdtemp(path.resolve('.test-agent-target-'));
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const {app}=require('electron');app.on('session-created',s=>s.protocol.handle('https',()=>new Response(${JSON.stringify(fixture)},{headers:{'Content-Type':'text/html'}})));require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop;
let page;
try {
  desktop = await electron.launch({ args: ['--no-sandbox', bootstrap], env });
  page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
  await page.waitForFunction(() => !!window.workspace);
  const rpc = (method, params = {}) => page.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params });
  const until = async check => {
    const deadline = Date.now() + 15000;
    while (!await check()) { assert.ok(Date.now() < deadline, 'Page did not settle'); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  const account = await rpc('accounts.create', { name: 'Target test' });
  await until(async () => { const state = await rpc('workspace.status'); return state.page?.url === 'https://chatgpt.com/' && !state.page.loading; });
  const original = (await rpc('workspace.status')).page.id;
  const navigateInPage = url => desktop.evaluate(async ({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find(item => item.getURL() === 'https://chatgpt.com/');
    if (!wc) throw new Error('Missing homepage: ' + webContents.getAllWebContents().map(item => item.getURL()).join(', '));
    await wc.executeJavaScript(`history.pushState({}, '', ${JSON.stringify(url)})`);
  }, url);
  await navigateInPage('/c/old');
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await until(async () => {
    const state = await rpc('workspace.status');
    return state.pages.length === 2 && state.page.url === 'https://chatgpt.com/' && !state.page.loading && !state.tasks.some(t => t.status === 'running');
  });
  const fresh = (await rpc('workspace.status')).page.id;
  assert.notEqual(fresh, original);
  await page.getByRole('button', { name: 'Agent 协作', exact: true }).click();
  const preview = page.getByLabel('Agent 协作提示词', { exact: true });
  await preview.waitFor({ state: 'attached' });
  assert.match(await preview.inputValue(), /new:true/);
  assert.doesNotMatch(await preview.inputValue(), /\/c\/old/);
  // A background selection change and service enable must not retarget the open handoff.
  await rpc('browser.select', { accountId: account.id, pageId: original });
  await page.getByRole('button', { name: '启用服务', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.agent-prompt-preview')?.value.includes('/help.html'));
  assert.match(await preview.inputValue(), /new:true/);
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await rpc('browser.select', { accountId: account.id, pageId: fresh });
  await navigateInPage('/c/fresh');
  await page.getByRole('button', { name: 'Agent 协作', exact: true }).click();
  await preview.waitFor({ state: 'attached' });
  assert.match(await preview.inputValue(), /https:\/\/chatgpt.com\/c\/fresh/);
  const expected = await preview.inputValue();
  await rpc('browser.select', { accountId: account.id, pageId: original });
  await desktop.evaluate(({ clipboard }) => {
    globalThis.savedWrite = clipboard.writeText;
    clipboard.writeText = text => { globalThis.copiedTarget = text; };
  });
  try {
    await page.getByRole('button', { name: '复制 Agent 提示词', exact: true }).click();
    await page.getByText('已复制，粘贴给 Agent 即可', { exact: true }).waitFor();
    assert.equal(await desktop.evaluate(() => globalThis.copiedTarget), expected);
  } finally { await desktop.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.savedWrite; }); }
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await rpc('browser.select', { accountId: account.id, pageId: fresh });
  await desktop.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find(item => item.getURL() === 'https://chatgpt.com/c/fresh');
    await wc.executeJavaScript("history.pushState({}, '', '/g/project/c/fresh')");
  });
  await page.getByRole('button', { name: 'Agent 协作', exact: true }).click();
  await preview.waitFor({ state: 'attached' });
  assert.equal(await page.getByRole('combobox', { name: '协作范围', exact: true }).getAttribute('data-value'), '__account');
  assert.match(await preview.inputValue(), /new:true/, 'A project page must still allow a fresh consultation');
  assert.equal(await page.locator('.toast').count(), 0, 'Opening collaboration on a project is not an error');
  await page.getByRole('combobox', { name: '协作范围', exact: true }).click();
  await page.getByRole('option', { name: '当前会话', exact: true }).click();
  const toast = page.locator('.toast');
  await toast.waitFor();
  assert.match(await toast.innerText(), /当前会话暂不支持 Agent 协作/);
  assert.doesNotMatch(await toast.innerText(), /Error|workspace:call|https:/);
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '新对话', exact: true }).waitFor();
  await until(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.some(view => view.getVisible())));
  const slot = await page.locator('.browser-slot').boundingBox();
  const bounds = await toast.boundingBox();
  assert.ok(bounds.y + bounds.height <= slot.y, 'Toast stays above native webpage, so it cannot be covered by it');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/friendly-toast.png', animations: 'disabled' });
  await toast.hover();
  await page.waitForTimeout(6200);
  assert.equal(await toast.isVisible(), true, 'Hover pauses dismissal');
  await page.mouse.move(10, 400);
  await toast.waitFor({ state: 'hidden', timeout: 8000 });
  assert.deepEqual(await page.locator('.browser-slot').boundingBox(), slot, 'Toast never resizes the webpage');
  await page.getByRole('button', { name: '专注模式', exact: true }).click();
  await page.getByRole('button', { name: 'Agent 协作', exact: true }).click();
  await preview.waitFor({ state: 'attached' });
  await page.getByRole('combobox', { name: '协作范围', exact: true }).click();
  await page.getByRole('option', { name: '当前会话', exact: true }).click();
  await toast.waitFor();
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await until(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.some(view => view.getVisible())));
  const focusSlot = await page.locator('.browser-slot').boundingBox();
  const focusToast = await toast.boundingBox();
  assert.ok(focusToast.y + focusToast.height <= focusSlot.y);
  await page.screenshot({ path: 'test-results/friendly-toast-focus.png', animations: 'disabled' });
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  assert.equal(await toast.count(), 0);
  assert.equal((await rpc('tasks.list')).filter(t => t.input.type === 'prompt').length, 0);
  console.log('Agent target desktop passed: pinned copy, project-to-new consultation, friendly toast, hover pause, auto/manual dismiss, stable native bounds, focus mode, no prompt sent.');
} catch (error) {
  if (page && !page.isClosed()) console.error(await page.locator('body').innerText());
  throw error;
} finally {
  if (desktop) await desktop.close();
  assert.ok(directory.startsWith(path.resolve('.') + path.sep + '.test-agent-target-'));
  await rm(directory, { recursive: true, force: true });
}
