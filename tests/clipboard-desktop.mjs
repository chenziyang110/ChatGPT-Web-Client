import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fixture } from './chatgpt-fixture.mjs';

const directory = await mkdtemp(path.resolve('.test-clipboard-'));
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const { app } = require('electron');
app.on('session-created', isolated => isolated.protocol.handle('https', () => new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html' } })));
require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});
`);

let desktop;
let previousClipboard = '';
try {
  const env = { ...process.env, WORKSPACE_USER_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WORKSPACE_DEV_URL;
  desktop = await electron.launch({ args: ['--no-sandbox', bootstrap], env });
  const shell = await desktop.firstWindow();
  shell.setDefaultTimeout(15000);
  await shell.waitForFunction(() => !!window.workspace);
  const rpc = (method, params = {}) => shell.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params });

  const account = await rpc('accounts.create', { name: 'Clipboard' });
  await shell.waitForFunction(async id => {
    const state = await window.workspace.call('workspace.status');
    return state.pages.some(page => page.accountId === id && page.url.startsWith('https://chatgpt.com') && !page.loading);
  }, account.id);
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await desktop.evaluate(({ session, webContents }, partition) => webContents.getAllWebContents()
      .some(item => item.session === session.fromPartition(partition) && item.getURL().startsWith('https://chatgpt.com')), account.partition);
    if (ready) break;
    assert.ok(attempt < 99, 'Account WebContents did not become ready');
    await shell.waitForTimeout(50);
  }

  previousClipboard = await desktop.evaluate(({ clipboard }) => clipboard.readText());
  const marker = `ChatGPT copy ${Date.now()}`;
  const copyResult = await desktop.evaluate(async ({ BrowserWindow, session, webContents }, { partition, marker }) => {
    const isolated = session.fromPartition(partition);
    const contents = webContents.getAllWebContents().find(item => item.session === isolated && item.getURL().startsWith('https://chatgpt.com'));
    if (!contents) throw new Error('Account WebContents missing');
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.focus();
    contents.focus();
    return contents.executeJavaScript(`navigator.clipboard.writeText(${JSON.stringify(marker)}).then(() => 'copied', error => error.name + ': ' + error.message)`, true);
  }, { partition: account.partition, marker });

  assert.equal(copyResult, 'copied', `ChatGPT must be allowed to write to the clipboard; got ${copyResult}`);
} finally {
  if (desktop) {
    await desktop.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard).catch(() => {});
    await desktop.close().catch(() => {});
  }
  await rm(directory, { recursive: true, force: true });
}

console.log('Clipboard integration passed: ChatGPT can copy text through the web clipboard API.');
