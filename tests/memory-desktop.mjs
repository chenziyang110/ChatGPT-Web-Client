import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fixture } from './chatgpt-fixture.mjs';

const directory = await mkdtemp(path.resolve('.test-memory-'));
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const { app } = require('electron');
app.on('session-created', isolated => isolated.protocol.handle('https', () => new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html' } })));
require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});
`);

let desktop;
try {
  const env = { ...process.env, WORKSPACE_USER_DATA: directory, WORKSPACE_PAGE_IDLE_MS: '100', WORKSPACE_HIDDEN_PAGE_IDLE_MS: '100' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WORKSPACE_DEV_URL;
  desktop = await electron.launch({ args: ['--no-sandbox', bootstrap], env });
  const shell = await desktop.firstWindow();
  shell.setDefaultTimeout(15000);
  await shell.waitForFunction(() => !!window.workspace);
  const rpc = (method, params = {}) => shell.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params });
  const waitTask = async task => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const current = await rpc('tasks.get', { id: task.id });
      if (!['pending', 'running'].includes(current.status)) {
        assert.equal(current.status, 'done', current.error);
        return current;
      }
      await shell.waitForTimeout(50);
    }
    assert.fail('Task did not finish');
  };
  const livePages = account => desktop.evaluate(({ session, webContents }, partition) => webContents.getAllWebContents()
    .filter(contents => contents.session === session.fromPartition(partition) && contents.getURL().startsWith('https://chatgpt.com'))
    .map(contents => ({ url: contents.getURL(), backgroundThrottling: contents.backgroundThrottling })), account.partition);
  const waitForLiveCount = async (account, count) => {
    const deadline = Date.now() + 10000;
    while ((await livePages(account)).length !== count) {
      assert.ok(Date.now() < deadline, `Expected ${count} live account pages`);
      await shell.waitForTimeout(100);
    }
  };

  const account = await rpc('accounts.create', { name: 'Memory' });
  await waitTask(await rpc('browser.navigate', { accountId: account.id, url: 'https://chatgpt.com/c/one' }));
  await waitTask(await rpc('browser.navigate', { accountId: account.id, url: 'https://chatgpt.com/c/two' }));
  let state = await rpc('workspace.status');
  assert.equal(state.pages.filter(page => page.accountId === account.id).length, 3, 'Open tabs remain represented');
  const first = state.pages.find(page => page.url === 'https://chatgpt.com/c/one');
  assert.ok(first);

  await waitForLiveCount(account, 1);
  assert.equal((await livePages(account))[0].backgroundThrottling, true, 'Account pages allow Chromium background throttling');
  state = await rpc('workspace.status');
  assert.equal(state.pages.filter(page => page.accountId === account.id).length, 3, 'Sleeping tabs remain available');

  const visiblePage = state.pages.find(page => page.accountId === account.id && page.selected);
  assert.ok(visiblePage);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await waitForLiveCount(account, 0);
  assert.equal((await rpc('workspace.status')).pages.find(page => page.id === visiblePage.id)?.sleeping, true,
    'A safe selected page hibernates while the native window is hidden');
  await desktop.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await waitForLiveCount(account, 1);
  assert.equal((await rpc('workspace.status')).page.url, visiblePage.url, 'Showing the window restores the selected page');

  await rpc('browser.select', { accountId: account.id, pageId: first.id });
  await shell.waitForFunction(async ({ accountId, pageId }) => {
    const current = await window.workspace.call('workspace.status');
    return current.pages.find(page => page.accountId === accountId && page.id === pageId)?.selected && current.page?.url === 'https://chatgpt.com/c/one';
  }, { accountId: account.id, pageId: first.id });
  await waitForLiveCount(account, 1);

  const selected = (await rpc('workspace.status')).pages.find(page => page.accountId === account.id && page.selected);
  await desktop.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].contentView.children[0].webContents;
    await contents.executeJavaScript("document.querySelector('textarea').value = 'Keep this draft'; document.querySelector('textarea').dispatchEvent(new Event('input', { bubbles: true }))");
  });
  await shell.waitForTimeout(2000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await shell.waitForTimeout(500);
  assert.equal((await livePages(account)).length, 1, 'A hidden selected page with a draft stays resident');
  await desktop.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  const second = (await rpc('workspace.status')).pages.find(page => page.url === 'https://chatgpt.com/c/two');
  await rpc('browser.select', { accountId: account.id, pageId: second.id });
  await waitForLiveCount(account, 2);
  await rpc('browser.select', { accountId: account.id, pageId: selected.id });
  const draft = await desktop.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]
    .contentView.children[0].webContents.executeJavaScript("document.querySelector('textarea').value"));
  assert.equal(draft, 'Keep this draft', 'A background tab with a draft stays resident');

  await desktop.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]
    .contentView.children[0].webContents.executeJavaScript("document.querySelector('textarea').remove()"));
  await shell.waitForTimeout(2000);
  await rpc('browser.select', { accountId: account.id, pageId: second.id });
  await shell.waitForTimeout(2000);
  assert.equal((await livePages(account)).length, 2, 'A verification or unavailable page without an editor stays resident');
} finally {
  if (desktop) await desktop.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}

console.log('Memory lifecycle passed: idle tabs sleep, restore on selection, and drafts stay resident.');
