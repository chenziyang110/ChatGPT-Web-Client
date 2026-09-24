import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './chatgpt-fixture.mjs';

const root = path.resolve('.');
const directory = await mkdtemp(path.join(root, '.test-slow-page-'));
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const { app, Notification } = require('electron');
Notification.isSupported = () => false;
globalThis.holdNextHome = false;
globalThis.heldHomes = 0;
app.on('browser-window-created', (_, win) => {
  win.setSkipTaskbar(true);
  if (process.platform === 'win32') win.setPosition(-20000, -20000);
});
app.on('session-created', isolated => isolated.protocol.handle('https', async request => {
  if (request.url === 'https://chatgpt.com/' && globalThis.holdNextHome) {
    globalThis.holdNextHome = false;
    globalThis.heldHomes++;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  return new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html' } });
}));
require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
const env = { ...process.env, WORKSPACE_USER_DATA: directory, WORKSPACE_PAGE_LOAD_TIMEOUT_MS: '800' };
delete env.ELECTRON_RUN_AS_NODE; delete env.WORKSPACE_DEV_URL;
let desktop, desktopPid;
function bounded(promise, label, ms = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })])
    .finally(() => clearTimeout(timer));
}
try {
  desktop = await electron.launch({ args: ['--no-sandbox', bootstrap], env });
  desktopPid = await desktop.evaluate(() => process.pid);
  const shell = await bounded(desktop.firstWindow(), 'First window');
  shell.setDefaultTimeout(10000);
  await shell.waitForFunction(() => !!window.workspace);
  const rpc = (method, params = {}) => bounded(shell.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params }), method);
  const until = async (check, label, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (!await check()) { assert.ok(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 80)); }
  };
  const first = await rpc('accounts.create', { name: 'Slow account' });
  await until(async () => (await rpc('browser.inspect', { accountId: first.id })).editor, 'First account did not load');
  const second = await rpc('accounts.create', { name: 'Ready account' });
  await until(async () => (await rpc('browser.inspect', { accountId: second.id })).editor, 'Second account did not load');
  await rpc('accounts.switch', { id: first.id });
  await desktop.evaluate(() => { globalThis.holdNextHome = true; });
  await shell.getByRole('button', { name: '新对话' }).click();
  await until(async () => (await rpc('workspace.status')).pages.filter(page => page.accountId === first.id).length === 2,
    'New tab did not appear', 1500);
  assert.equal(await desktop.evaluate(() => globalThis.heldHomes), 1, 'Fixture must delay the new page');
  await until(() => shell.locator('.account').filter({ hasText: 'Ready account' }).isEnabled(),
    'A slow web page must not disable account switching', 1500);
  await shell.locator('.account').filter({ hasText: 'Ready account' }).click();
  await until(async () => (await rpc('workspace.status')).activeAccountId === second.id,
    'Account switch was blocked by slow page', 1500);
  await shell.locator('.account').filter({ hasText: 'Slow account' }).click();
  await until(async () => !!(await rpc('workspace.status')).page?.error?.includes('网页加载时间过长'),
    'Slow page did not expose recovery');
  await shell.getByRole('button', { name: '恢复页面' }).waitFor({ state: 'visible' });
  await shell.getByRole('button', { name: '恢复页面' }).click();
  await until(async () => (await rpc('browser.inspect', { accountId: first.id })).editor &&
    !(await rpc('workspace.status')).page?.error, 'Recovery did not reload the original tab');
  const state = await rpc('workspace.status');
  assert.equal(state.pages.filter(page => page.accountId === first.id).length, 2, 'Recovery keeps existing tabs');
  assert.equal(state.activeAccountId, first.id);
  console.log('Slow page desktop passed: new tabs do not lock account switching and stalled loads offer recovery.');
} finally {
  try { if (desktop) await bounded(desktop.close(), 'Fixture shutdown', 10000); }
  catch { if (desktopPid) process.kill(desktopPid); }
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root); assert.ok(path.basename(target).startsWith('.test-slow-page-'));
  for (let attempt = 0; attempt < 10; attempt++) {
    try { await rm(target, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 9) console.warn('Fixture data cleanup delayed:', error.code); else await new Promise(resolve => setTimeout(resolve, 300)); }
  }
}
