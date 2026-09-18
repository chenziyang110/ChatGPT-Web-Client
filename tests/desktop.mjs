import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Exercises actual Electron sessions/IPC/SQLite. All remote pages are served
// by a deterministic HTTPS protocol fixture; no credentials or live ChatGPT.
import { fixture } from './chatgpt-fixture.mjs';
const directory = await mkdtemp(path.resolve('.test-desktop-'));
await mkdir('test-results', { recursive: true });
const bootstrap = path.join(directory, 'fixture.cjs');
await writeFile(bootstrap, `const { app } = require('electron');
app.on('session-created', isolated => isolated.protocol.handle('https', () => new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html' } })));
require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});
`);
let desktop;
let page;
let cleanExit = false;
const errors = [];
async function launch(scale = 1) {
  const env = { ...process.env, WORKSPACE_USER_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WORKSPACE_DEV_URL;
  desktop = await electron.launch({ args: ['--no-sandbox', `--force-device-scale-factor=${scale}`, bootstrap], env });
  // --no-sandbox is ONLY used by this disposable CI harness; production keeps it enabled.
  desktop.process().stderr.on('data', buffer => errors.push(buffer.toString()));
  page = await desktop.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.workspace);
}
async function waitForState(predicate, argument) {
  const deadline = Date.now() + 15000;
  while (!await page.evaluate(predicate, argument)) {
    assert.ok(Date.now() < deadline, 'Workspace state did not reach expected condition');
    await new Promise(resolve => setTimeout(resolve, 80));
  }
}
async function rpc(method, params = {}) { return page.evaluate(({ method, params }) => window.workspace.call(method, params), { method, params }); }
async function waitTask(task) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const next = await rpc('tasks.get', { id: task.id });
    if (!['pending', 'running'].includes(next.status)) { assert.equal(next.status, 'done', next.error); return next; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Task did not finish');
}
async function accountScript(account, script) {
  const selectedUrl = (await rpc('workspace.status')).pages.find(item => item.accountId === account.id && item.selected)?.url;
  return desktop.evaluate(async ({ session, webContents }, { account, script, selectedUrl }) => {
    const wc = webContents.getAllWebContents().find(item => item.session === session.fromPartition(account.partition) && item.getURL() === selectedUrl);
    return wc.executeJavaScript(script);
  }, { account, script, selectedUrl });
}
async function terminalTask(task, status) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const current = await rpc('tasks.get', { id: task.id });
    if (current.status === status) return current;
    if (['done', 'failed', 'blocked', 'waiting_user', 'uncertain', 'cancelled'].includes(current.status)) assert.equal(current.status, status, current.error);
    await page.waitForTimeout(100);
  }
  throw new Error('Expected task status: ' + status);
}
async function profileState(account, write = false) {
  return desktop.evaluate(async ({ session, webContents }, { account, write }) => {
    const isolated = session.fromPartition(account.partition);
    const wc = webContents.getAllWebContents().find(wc => wc.session === isolated && wc.getURL().startsWith('https://chatgpt.com'));
    if (!wc) throw new Error('Account WebContents missing');
    if (write) {
      await isolated.cookies.set({ url: 'https://chatgpt.com', name: 'isolation-test', value: account.name, expirationDate: Date.now() / 1000 + 3600 });
      await wc.executeJavaScript(`localStorage.setItem('isolation-test', ${JSON.stringify(account.name)})`);
      await isolated.cookies.flushStore();
    }
    return { cookies: await isolated.cookies.get({ name: 'isolation-test' }),
      storage: await wc.executeJavaScript("localStorage.getItem('isolation-test')"),
      bridge: await wc.executeJavaScript('typeof window.workspace'), preferences: wc.getLastWebPreferences() };
  }, { account, write });
}
async function checkBrowserBounds() {
  await desktop.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMinimized()) win.restore();
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize()[0] > 0)) break;
    await page.waitForTimeout(50);
  }
  await page.waitForFunction(() => document.querySelector('.browser-slot')?.getBoundingClientRect().width > 0);
  const expected = await page.locator('.browser-slot').evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    const { actual, size } = await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { actual: win.contentView.children[0]?.getBounds(), size: win.getContentSize() };
    });
    // Windows can round CSS and native DIP sizes differently at fractional scaling.
    // Only accept a one-DIP difference where the slot meets the native window edge.
    if (actual && actual.x === expected.x && actual.y === expected.y &&
      ['width', 'height'].every((axis, index) => actual[axis] === expected[axis] ||
        (Math.abs(actual[axis] - expected[axis]) <= 1 && actual[axis] + actual[index ? 'y' : 'x'] === size[index]))) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const actual = await desktop.evaluate(({ BrowserWindow }) => ({ bounds: BrowserWindow.getAllWindows()[0].contentView.children[0]?.getBounds(), size: BrowserWindow.getAllWindows()[0].getContentSize() }));
  assert.fail(`Embedded account page must match the renderer slot after resize: ${JSON.stringify({ expected, actual })}`);
}
async function shortcut(keyCode, modifiers, remote = false) {
  await desktop.evaluate(async ({ BrowserWindow }, { keyCode, modifiers, remote }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const contents = remote ? win.contentView.children[0].webContents : win.webContents;
    win.focus();
    contents.focus();
    if (remote) await contents.executeJavaScript("document.querySelector('textarea').focus()");
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }, { keyCode, modifiers, remote });
}
async function activeAccount(id) {
  await waitForState(async id => (await window.workspace.call('workspace.status')).activeAccountId === id, id);
  await page.waitForFunction(id => document.querySelector('.account-row.selected .account')?.getAttribute('aria-current') === 'true' &&
    document.querySelector('.focus-account')?.getAttribute('data-value') === id, id);
  await checkBrowserBounds();
}
const mod = process.platform === 'darwin' ? 'meta' : 'control';
async function captureWorkspace(file) {
  const images = await desktop.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const view = win.contentView.children[0];
    if (!view?.getVisible()) throw new Error('Account view must be visible in workspace mode');
    return { shell: (await win.capturePage()).toDataURL(), account: (await view.webContents.capturePage()).toDataURL() };
  });
  // Electron's window capture can omit child surfaces; retain their capture too.
  await writeFile(file, Buffer.from(images.shell.split(',')[1], 'base64'));
  await writeFile(file.replace('.png', '-account.png'), Buffer.from(images.account.split(',')[1], 'base64'));
}
try {
  await launch();
  await page.getByRole('button', { name: '创建第一个账号', exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.brand-logo')].every(image => image.complete && image.naturalWidth > 0));
  await page.screenshot({ path: 'test-results/welcome.png', animations: 'disabled' });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
  await page.waitForFunction(() => innerWidth === 900);
  const compactCta = await page.getByRole('button', { name: '创建第一个账号', exact: true }).boundingBox();
  assert.ok(compactCta && compactCta.y + compactCta.height < 640, 'First-account action must stay visible at minimum window size');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'test-results/welcome-compact.png', animations: 'disabled' });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
  await page.waitForFunction(() => innerWidth === 1440);
  assert.equal(await page.locator('.titlebar').evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region')), 'drag');
  assert.equal(await page.locator('.window-controls').evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region')), 'no-drag');
  // On small macOS CI displays an oversized normal window is reported maximized.
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
  await page.waitForFunction(() => innerWidth === 900);
  await page.getByRole('button', { name: '最大化窗口', exact: true }).click();
  await page.getByRole('button', { name: '还原窗口', exact: true }).waitFor();
  assert.equal((await rpc('window.state')).maximized, true);
  await page.getByRole('button', { name: '还原窗口', exact: true }).click();
  await page.getByRole('button', { name: '最大化窗口', exact: true }).waitFor();
  await page.getByRole('button', { name: '最小化窗口', exact: true }).click();
  for (let i = 0; i < 30 && !await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), true);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await assert.rejects(() => rpc('window.control', { action: 'execute' }), /Unknown window action/);
  await assert.rejects(() => rpc('ui.bounds', { x: -1, y: 0, width: 1, height: 1 }), /Invalid browser bounds/);
  await page.getByRole('button', { name: '创建第一个账号', exact: true }).click();
  await page.getByLabel('账号名称', { exact: true }).fill('Personal');
  await page.screenshot({ path: 'test-results/create-account.png', animations: 'disabled' });
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByRole('heading', { name: 'Personal', exact: true }).waitFor();
  assert.equal(await page.locator('.account-list').innerText().then(text => /Ctrl|⌘|Alt\+/.test(text)), false, 'Account rows do not display shortcut hints');
  assert.equal(await page.getByRole('button', { name: '专注模式', exact: true }).getAttribute('title'), '进入专注模式');
  let state = await rpc('workspace.status');
  const personal = state.accounts[0];
  await waitForState(async id => (await window.workspace.call('workspace.status')).pages.some(p => p.accountId === id && p.url.startsWith('https://chatgpt.com')), personal.id);
  await waitTask(await rpc('tasks.create', { accountId: personal.id, input: { type: 'snapshot' } }));
  await checkBrowserBounds();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680));
  await page.waitForFunction(() => innerWidth === 1000);
  await checkBrowserBounds();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const compactCapture = await desktop.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
  await writeFile('test-results/workspace-compact.png', Buffer.from(compactCapture.split(',')[1], 'base64'));
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
  await page.waitForFunction(() => innerWidth === 1440);
  await checkBrowserBounds();
  const first = await profileState(personal, true);
  assert.equal(first.bridge, 'undefined');
  assert.equal(first.preferences.nodeIntegration, false);
  assert.equal(first.preferences.contextIsolation, true);
  assert.equal(first.preferences.sandbox, true);
  const work = await rpc('accounts.create', { name: 'Work' });
  await waitForState(async id => (await window.workspace.call('workspace.status')).pages.some(p => p.accountId === id && p.url.startsWith('https://chatgpt.com')), work.id);
  await waitTask(await rpc('tasks.create', { accountId: work.id, input: { type: 'snapshot' } }));
  const second = await profileState(work);
  assert.equal(second.storage, null);
  assert.deepEqual(second.cookies, []);
  await profileState(work, true);
  assert.equal((await profileState(personal)).storage, 'Personal');
  const draft = await waitTask(await rpc('tasks.create', { accountId: work.id, url: 'https://chatgpt.com/c/work', input: { type: 'prompt', prompt: 'Draft only' } }));
  assert.equal(draft.result.prepared, true);
  const blockedDraft = await rpc('tasks.create', { accountId: work.id, current: true, input: { type: 'prompt', prompt: 'Hello', submit: true } });
  const needsChoice = await terminalTask(blockedDraft, 'waiting_user');
  assert.equal(needsChoice.attention.kind, 'draft');
  await assert.rejects(() => rpc('queues.resume', { accountId: work.id }), /USER_DECISION_REQUIRED/);
  await page.locator('.attention-banner').getByRole('button', { name: '选择如何处理' }).click();
  await page.getByRole('heading', { name: '网页里有尚未处理的草稿' }).waitFor();
  await page.screenshot({ path: 'test-results/task-decision.png', animations: 'disabled' });
  await page.getByRole('dialog').getByRole('button', { name: '接管', exact: true }).click();
  await waitForState(async () => !(await window.workspace.call('workspace.status')).lockedAccountIds.length);
  await checkBrowserBounds();
  assert.equal(await accountScript(work, 'window.fixtureSendCount || 0'), 0);
  await accountScript(work, "document.querySelector('textarea').value = ''");
  await page.locator('.attention-banner').getByRole('button', { name: '交还 Agent 并继续', exact: true }).click();
  const submitted = await waitTask(blockedDraft);
  assert.equal(submitted.result.response, 'Fixture reply: Hello');
  await rpc('queues.pause', { accountId: work.id });
  const beforeDiagnostics = (await rpc('tasks.list')).length;
  const readyPage = await rpc('browser.inspect', { accountId: work.id });
  assert.equal(readyPage.readiness, 'ready');
  await accountScript(work, "document.querySelector('textarea').id = 'pending-composer'; const gate = document.createElement('input'); gate.type = 'hidden'; gate.id = 'cf-chl-widget-test_response'; document.body.append(gate)");
  const verificationPage = await rpc('browser.inspect', { accountId: work.id });
  assert.equal(verificationPage.readiness, 'verification_required');
  assert.equal(verificationPage.draft, undefined, 'Diagnostics do not return draft content');
  await accountScript(work, "document.querySelector('#cf-chl-widget-test_response').remove(); const login = document.createElement('button'); login.dataset.testid = 'login-button'; document.body.append(login)");
  assert.equal((await rpc('browser.inspect', { accountId: work.id })).readiness, 'login_required');
  await accountScript(work, "document.title = '请稍候…'");
  assert.equal((await rpc('browser.inspect', { accountId: work.id })).readiness, 'verification_required', 'The observed verification title remains diagnostic after its widget disappears');
  await accountScript(work, "document.title = 'ChatGPT fixture'");
  await accountScript(work, "document.querySelector('[data-testid=login-button]').remove(); document.querySelector('textarea').id = 'prompt-textarea'");
  assert.equal((await rpc('tasks.list')).length, beforeDiagnostics);
  assert.equal((await rpc('queues.status')).find(queue => queue.accountId === work.id).paused, true, 'Diagnostics cannot resume a queue');
  const pinned = await rpc('tasks.create', { accountId: work.id, current: true, idempotencyKey: 'pinned', input: { type: 'prompt', prompt: 'Pinned target', submit: true } });
  await accountScript(work, "history.pushState({}, '', '/c/moved')");
  await rpc('queues.resume', { accountId: work.id });
  assert.equal((await waitTask(pinned)).result.url, 'https://chatgpt.com/c/work');
  const newParams = { accountId: work.id, new: true, alias: 'daily', idempotencyKey: 'new-once', input: { type: 'prompt', prompt: 'New conversation', submit: true } };
  await accountScript(work, "localStorage.setItem('fixture-delay-editor', '1')");
  const fresh = await rpc('tasks.create', newParams);
  assert.equal((await rpc('tasks.create', newParams)).id, fresh.id);
  const follow = await rpc('tasks.create', { accountId: work.id, conversation: fresh.conversationId, input: { type: 'prompt', prompt: 'Follow up', submit: true } });
  const freshResult = await waitTask(fresh);
  const followResult = await waitTask(follow);
  assert.equal(freshResult.result.url, followResult.result.url);
  assert.equal(followResult.result.response, 'Fixture reply: Follow up');
  assert.equal(await accountScript(work, 'window.fixtureSendCount'), 2);
  await accountScript(work, 'window.fixtureHold = true');
  const held = await rpc('tasks.create', { accountId: work.id, conversation: fresh.conversationId, input: { type: 'prompt', prompt: 'Held reply', submit: true } });
  const waiting = await rpc('tasks.create', { accountId: work.id, conversation: fresh.conversationId, input: { type: 'prompt', prompt: 'After held', submit: true } });
  const independent = await rpc('tasks.create', { accountId: personal.id, new: true, input: { type: 'prompt', prompt: 'Independent', submit: true } });
  await waitTask(independent);
  assert.equal((await rpc('tasks.get', { id: held.id })).status, 'running');
  assert.equal((await rpc('tasks.get', { id: waiting.id })).status, 'pending');
  await accountScript(work, "document.querySelector('[data-testid=stop-button]').remove()");
  await page.waitForTimeout(3500);
  assert.equal((await rpc('tasks.get', { id: held.id })).status, 'running', 'Stable text without a completion control is not completion');
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible()), false, 'Running account page stays locked');
  await page.locator('.preview-canvas img').waitFor();
  const previewImage = await rpc('browser.preview', { accountId: work.id });
  assert.match(previewImage.image, /^data:image\/jpeg;base64,/);
  await page.locator('.preview-canvas').click();
  await page.keyboard.type('must not reach the page');
  assert.equal(await accountScript(work, "document.querySelector('textarea').value"), '');
  await accountScript(work, "document.querySelector('h1').textContent = 'Preview updated while locked'");
  const updatedPreview = await rpc('browser.preview', { accountId: work.id });
  assert.notEqual(updatedPreview.image, previewImage.image, 'Preview captures live updates while page stays hidden');
  await page.screenshot({ path: 'test-results/agent-live-preview.png', animations: 'disabled' });
  await shortcut('T', [mod, 'alt']);
  await terminalTask(held, 'uncertain');
  await waitForState(async id => !(await window.workspace.call('workspace.status')).lockedAccountIds.includes(id), work.id);
  assert.equal((await rpc('tasks.get', { id: held.id })).status, 'uncertain');
  await assert.rejects(() => rpc('queues.resume', { accountId: work.id }), /REVIEW_REQUIRED/);
  await accountScript(work, 'window.fixtureFinish(); window.fixtureHold = false');
  await rpc('queues.resume', { accountId: work.id, acknowledged: true });
  await waitTask(waiting);
  assert.equal(await accountScript(work, 'window.fixtureSendCount'), 4, 'Uncertain task was not sent twice');
  await accountScript(work, "window.fixtureHold = true; document.querySelector('textarea').value = 'Manual turn'; document.querySelector('[data-testid=send-button]').click()");
  const afterManual = await rpc('tasks.create', { accountId: work.id, current: true, input: { type: 'prompt', prompt: 'After manual', submit: true } });
  await page.waitForTimeout(1500);
  await page.getByRole('status', { name: 'Work 会话运行中', exact: true }).waitFor();
  assert.equal((await rpc('tasks.get', { id: afterManual.id })).phase, 'waiting_idle');
  assert.equal(await accountScript(work, 'window.fixtureSendCount'), 5);
  await accountScript(work, 'window.fixtureFinish(); window.fixtureHold = false');
  await waitTask(afterManual);
  assert.equal(await accountScript(work, 'window.fixtureSendCount'), 6);
  await waitForState(async () => (await window.workspace.call('notifications.list')).filter(item => item.unread).length === 3);
  assert.equal((await rpc('notifications.list', { accountId: work.id })).filter(item => item.unread).length, 2, 'Repeated replies in one conversation count once');
  await page.getByRole('button', { name: 'Work，2 个会话待处理', exact: true }).click();
  await page.getByRole('heading', { name: '待处理会话', exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/conversation-notifications.png', animations: 'disabled' });
  await page.locator('.notification-item').filter({ hasText: 'ChatGPT fixture' }).getByRole('button', { name: '查看会话', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('dialog'));
  await page.getByRole('button', { name: 'Work，1 个会话待处理', exact: true }).waitFor();
  assert.equal((await rpc('workspace.status')).page.url, 'https://chatgpt.com/c/work');
  await page.getByRole('button', { name: 'Work，1 个会话待处理', exact: true }).click();
  await page.getByRole('button', { name: '标记已处理', exact: true }).click();
  await page.getByText('全部处理完了', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  assert.equal(await page.locator('.account-row').filter({ hasText: 'Work' }).locator('.reply-badge').count(), 0);
  // A manual turn alone (no gateway task) must also generate an unread receipt.
  await accountScript(work, "window.fixtureHold = true; document.querySelector('textarea').value = 'Manual notification'; document.querySelector('[data-testid=send-button]').click()");
  await page.getByRole('status', { name: 'Work 会话运行中', exact: true }).waitFor();
  await rpc('accounts.switch', { id: personal.id });
  await accountScript(work, 'window.fixtureFinish(); window.fixtureHold = false');
  await page.getByRole('button', { name: 'Work，1 个会话待处理', exact: true }).waitFor();
  await rpc('accounts.switch', { id: work.id });
  await accountScript(work, "document.querySelector('textarea').value = 'Hello'");
  await page.getByRole('button', { name: '专注模式', exact: true }).click();
  await page.locator('.app.focus-mode').waitFor();
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  assert.equal(await page.locator('.topbar').isVisible(), false);
  await checkBrowserBounds();
  await shortcut('1', [mod, 'alt'], true);
  await activeAccount(personal.id);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.isFocused()), true, 'Switching from an account page keeps keyboard focus in the new page');
  await shortcut('Left', [mod, 'alt'], true);
  await activeAccount(work.id);
  await shortcut('Right', [mod, 'alt']);
  await activeAccount(personal.id);
  await shortcut('2', [mod, 'alt']);
  await activeAccount(work.id);
  await shortcut('9', [mod, 'alt'], true);
  await page.waitForTimeout(100);
  assert.equal((await rpc('workspace.status')).activeAccountId, work.id, 'Missing numbered accounts are ignored');
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.executeJavaScript("document.querySelector('textarea').value")), 'Hello', 'Switching preserves the draft');
  const accountSelect = page.getByRole('combobox', { name: '切换账号', exact: true });
  await accountSelect.click();
  await page.getByRole('listbox').waitFor();
  for (let i = 0; i < 30 && await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible()); i++) await page.waitForTimeout(50);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible()), false, 'Native view must not cover the custom menu');
  await page.screenshot({ path: 'test-results/account-select.png', animations: 'disabled' });
  await page.getByRole('option', { name: 'Personal', exact: true }).click();
  await activeAccount(personal.id);
  await page.getByRole('button', { name: 'Agent 协作', exact: true }).click();
  await page.getByRole('combobox', { name: '协作账号', exact: true }).click();
  await page.getByRole('option', { name: 'Work', exact: true }).click();
  await page.getByRole('combobox', { name: '协作范围', exact: true }).click();
  await page.getByRole('listbox').waitFor();
  await page.screenshot({ path: 'test-results/agent-select.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').isVisible(), true, 'Escape closes the menu without closing its parent dialog');
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await accountSelect.focus();
  await accountSelect.press('ArrowDown');
  await page.getByRole('listbox').waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option');
  await page.keyboard.press('End');
  await page.waitForFunction(() => document.activeElement?.textContent === 'Work');
  await page.keyboard.press('Enter');
  await activeAccount(work.id);
  await accountSelect.click();
  await page.getByRole('listbox').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.classList.contains('focus-account'));
  assert.equal((await rpc('workspace.status')).activeAccountId, work.id);
  await accountSelect.click();
  await page.getByRole('option', { name: 'Personal', exact: true }).click();
  await activeAccount(personal.id);
  const largeSize = await desktop.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    const size = { width: Math.max(900, Math.min(1920, area.width)), height: Math.max(640, Math.min(1080, area.height)) };
    BrowserWindow.getAllWindows()[0].setSize(size.width, size.height);
    return size;
  });
  await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, largeSize);
  await checkBrowserBounds();
  const focusSlot = await page.locator('.browser-slot').boundingBox();
  assert.equal(focusSlot.x, 0);
  const tabsHeight = await page.locator('.conversation-tabs').evaluateAll(elements => elements[0]?.getBoundingClientRect().height ?? 0);
  assert.ok(focusSlot.y <= 80 + tabsHeight && focusSlot.width === largeSize.width && focusSlot.height >= largeSize.height - 80 - tabsHeight);
  await captureWorkspace('test-results/focus-1080p.png');
  await shortcut('F', [mod, 'shift'], true);
  await page.waitForFunction(() => !document.querySelector('.focus-mode'));
  await checkBrowserBounds();
  await captureWorkspace('test-results/workspace-1080p.png');
  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  await page.getByLabel('账号名称', { exact: true }).fill('Unsaved account');
  await shortcut('2', [mod, 'alt']);
  await shortcut('F', [mod, 'shift']);
  await page.waitForTimeout(100);
  assert.equal((await rpc('workspace.status')).activeAccountId, personal.id, 'Account shortcuts are paused during a modal');
  assert.equal(await page.locator('.app.focus-mode').count(), 0);
  assert.equal(await page.getByLabel('账号名称', { exact: true }).inputValue(), 'Unsaved account');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await waitTask(await rpc('browser.navigate', { accountId: personal.id, url: 'https://chatgpt.com/c/restored' }));
  await rpc('accounts.switch', { id: personal.id });
  const beforeHandoffState = await rpc('workspace.status');
  const beforeHandoff = { tasks: beforeHandoffState.tasks.length, conversations: beforeHandoffState.conversations.length };
  assert.equal(beforeHandoffState.api.enabled, false);
  await page.getByRole('button', { name: 'Agent 协作', exact: true }).click();
  const preview = page.getByLabel('Agent 协作提示词', { exact: true });
  await preview.waitFor({ state: 'attached' });
  assert.equal(await preview.isVisible(), false, 'Prompt details are collapsed by default');
  await page.getByText('查看提示词与说明', { exact: true }).click();
  await preview.waitFor();
  await page.getByText('查看提示词与说明', { exact: true }).click();
  assert.match(await preview.inputValue(), /https:\/\/chatgpt.com\/c\/restored/);
  assert.match(await preview.inputValue(), new RegExp(personal.id));
  await page.getByText('使用前需启用本地服务', { exact: true }).waitFor();
  assert.equal((await rpc('conversations.list')).length, beforeHandoff.conversations, 'Generating does not reserve a new consultation');
  // Capture the real trusted IPC's clipboard call without replacing the user's clipboard.
  await desktop.evaluate(({ clipboard }) => {
    globalThis.fixtureClipboardWrite = clipboard.writeText;
    clipboard.writeText = text => { globalThis.fixtureClipboardText = text; };
  });
  try {
    // The current page can move after preview: copying must retain the displayed target.
    await accountScript(personal, "history.pushState({}, '', '/c/moved-after-preview')");
    await page.getByRole('button', { name: '复制 Agent 提示词', exact: true }).click();
    await page.getByText('已复制，粘贴给 Agent 即可', { exact: true }).waitFor();
    const copied = await desktop.evaluate(() => globalThis.fixtureClipboardText);
    assert.equal(copied, await preview.inputValue());
    assert.match(copied, /https:\/\/chatgpt.com\/c\/restored/);
    assert.doesNotMatch(copied, /moved-after-preview/);
  } finally {
    await desktop.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.fixtureClipboardWrite; });
    await accountScript(personal, "history.pushState({}, '', '/c/restored')");
  }
  assert.equal((await rpc('workspace.status')).api.enabled, false, 'Copying must not enable the service');
  assert.equal((await rpc('tasks.list')).length, beforeHandoff.tasks, 'Generating and copying must not send tasks');
  assert.equal((await rpc('conversations.list')).some(item => item.binding === 'new'), false, 'Copying does not reserve a new consultation');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
  await page.waitForFunction(() => innerWidth === 1440);
  await page.screenshot({ path: 'test-results/agent-prompt.png', animations: 'disabled' });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
  await page.waitForFunction(() => innerWidth === 900);
  const copyBounds = await page.getByRole('button', { name: '复制 Agent 提示词', exact: true }).boundingBox();
  assert.ok(copyBounds && copyBounds.y >= 0 && copyBounds.y + copyBounds.height <= 640, 'Copy action remains visible at minimum window size');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'test-results/agent-prompt-compact.png', animations: 'disabled' });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
  await page.waitForFunction(() => innerWidth === 1440);
  await page.getByRole('button', { name: '启用服务', exact: true }).click();
  await waitForState(async () => (await window.workspace.call('workspace.status')).api.enabled);
  const helpState = await rpc('workspace.status');
  const helpResponse = await fetch(helpState.api.endpoint + '/help.html');
  assert.equal(helpResponse.status, 200);
  assert.match(await helpResponse.text(), /waiting_user/);
  await page.waitForFunction(() => /http:\/\/127.0.0.1:\d+\/help.html/.test(document.querySelector('.agent-prompt-preview')?.value ?? ''));
  assert.match(await preview.inputValue(), /http:\/\/127.0.0.1:\d+\/help.html/);
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '管理 Work', exact: true }).click();
  await page.getByRole('button', { name: '生成 Agent 提示词', exact: true }).click();
  await preview.waitFor({ state: 'attached' });
  assert.equal(await page.getByRole('combobox', { name: '协作账号', exact: true }).getAttribute('data-value'), work.id);
  assert.equal(await page.getByRole('combobox', { name: '协作范围', exact: true }).getAttribute('data-value'), '__account');
  assert.match(await preview.inputValue(), /new:true/);
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  assert.equal((await rpc('workspace.status')).api.enabled, true);
  await page.getByRole('button', { name: /任务中心/ }).click();
  await page.getByRole('heading', { name: '任务', exact: true }).waitFor();
  await page.getByRole('combobox', { name: '执行账号', exact: true }).click();
  await page.getByRole('option', { name: 'Work', exact: true }).click();
  await page.getByRole('combobox', { name: '目标会话', exact: true }).click();
  await page.locator(`.ui-select-item[data-value="${fresh.conversationId}"]`).click();
  await page.getByRole('button', { name: '给 Agent 的提示词', exact: true }).click();
  await preview.waitFor({ state: 'attached' });
  assert.equal(await page.getByRole('combobox', { name: '协作账号', exact: true }).getAttribute('data-value'), work.id);
  assert.equal(await page.getByRole('combobox', { name: '协作范围', exact: true }).getAttribute('data-value'), fresh.conversationId);
  assert.match(await preview.inputValue(), new RegExp(fresh.conversationId));
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.locator('.queue-card').filter({ hasText: 'Work' }).getByRole('button', { name: '暂停队列', exact: true }).click();
  await page.getByLabel('提示词', { exact: true }).fill('Queued from UI');
  await page.getByLabel('发送给 ChatGPT 并等待回复', { exact: true }).check();
  await page.getByRole('button', { name: '加入发送队列', exact: true }).click();
  await page.getByRole('button', { name: /提示词 Queued from UI/ }).waitFor();
  const uiQueued = (await rpc('tasks.list')).find(task => task.input.prompt === 'Queued from UI');
  assert.equal(uiQueued.accountId, work.id); assert.equal(uiQueued.conversationId, fresh.conversationId); assert.equal(uiQueued.status, 'pending');
  await page.locator('.task').filter({ hasText: 'Queued from UI' }).getByRole('button', { name: '取消', exact: true }).click();
  for (let i = 0; i < 30 && await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0]?.getVisible()); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible()), false);
  await page.screenshot({ path: 'test-results/tasks.png', animations: 'disabled' });
  await page.getByRole('button', { name: /设置与集成/ }).click();
  assert.equal(await desktop.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+S')), true,
    'The global boss key is registered with Electron');
  const bossKey = page.getByLabel('老板键（全局）', { exact: true });
  assert.equal(await bossKey.inputValue(), process.platform === 'darwin' ? '⌘+Shift+S' : 'Ctrl+Shift+S');
  assert.equal(await bossKey.isDisabled(), true, 'The global boss key is fixed and cannot conflict with local shortcuts');
  await page.getByRole('button', { name: '清除上一个账号快捷键', exact: true }).click();
  await page.getByRole('button', { name: '保存快捷键', exact: true }).click();
  await page.getByText('已保存', { exact: true }).waitFor();
  assert.equal((await rpc('settings.shortcuts.get')).previous, null);
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await waitForState(async () => (await window.workspace.call('settings.shortcuts.get')).previous?.code === 'ArrowLeft');
  await page.getByLabel('专注模式', { exact: true }).focus();
  await page.waitForTimeout(100);
  await page.getByLabel('专注模式', { exact: true }).press(process.platform === 'darwin' ? 'Meta+Shift+K' : 'Control+Shift+K');
  await page.getByRole('button', { name: '保存快捷键', exact: true }).click();
  await page.getByText('已保存', { exact: true }).waitFor();
  assert.equal((await rpc('settings.shortcuts.get')).focus.code, 'KeyK');
  await shortcut('F', [mod, 'shift']);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.settings-page').isVisible(), true, 'Old binding stops working immediately');
  await page.screenshot({ path: 'test-results/settings.png', animations: 'disabled' });
  await page.getByText('命令行快速开始', { exact: true }).click();
  assert.equal(await page.locator('.integration-details').getAttribute('open'), '');
  await shortcut('K', [mod, 'shift']);
  await page.locator('.app.focus-mode').waitFor();
  await checkBrowserBounds();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
  await page.waitForFunction(() => innerWidth === 900);
  await checkBrowserBounds();
  await desktop.close();
  await launch(1.25);
  await page.locator('.app.focus-mode').waitFor();
  assert.equal((await rpc('settings.shortcuts.get')).focus.code, 'KeyK');
  assert.equal((await rpc('notifications.list', { accountId: work.id })).filter(item => item.unread).length, 1, 'Unread survives restart');
  await checkBrowserBounds();
  assert.equal(await page.evaluate(() => devicePixelRatio), 1.25);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'test-results/focus-125-percent.png', animations: 'disabled' });
  await page.getByRole('button', { name: '退出专注', exact: true }).click();
  await checkBrowserBounds();
  state = await rpc('workspace.status');
  assert.equal(state.activeAccountId, personal.id);
  assert.equal(state.accounts.length, 2);
  await waitTask(await rpc('tasks.create', { accountId: personal.id, input: { type: 'snapshot' } }));
  assert.equal((await rpc('workspace.status')).page.url, 'https://chatgpt.com/c/restored');
  assert.equal((await profileState(personal)).storage, 'Personal');
  assert.equal((await profileState(personal)).cookies[0].value, 'Personal');
  // Execute the generated handoff as an external Agent against real Electron's
  // offline browser fixture, including actual CLI/HTTP and the response adapter.
  // Reproduce the observed modern editor: visible contenteditable DIV plus hidden textarea.
  await accountScript(personal, "const oldEditor = document.querySelector('#prompt-textarea'); oldEditor.removeAttribute('id'); oldEditor.hidden = true; const editor = document.createElement('div'); editor.id = 'prompt-textarea'; editor.contentEditable = 'true'; editor.setAttribute('role','textbox'); editor.style.minHeight = '42px'; oldEditor.before(editor)");
  assert.equal((await rpc('browser.inspect', { accountId: personal.id })).editor, true);
  const consultation = await rpc('agent.prompt', { accountId: personal.id, current: true });
  const questionFile = path.join(directory, 'agent question.txt');
  await writeFile(questionFile, '请分析问题并给出验证步骤。\r\n仅使用本地测试页面。', 'utf8');
  const invoke = promisify(execFile);
  const createArgs = consultation.commands.create.map(arg => arg === 'QUESTION_FILE' ? questionFile : arg === 'REQUEST_UUID' ? 'desktop-agent-consultation' : arg);
  const created = JSON.parse((await invoke(createArgs[0] === 'node' ? process.execPath : createArgs[0], createArgs.slice(1), { timeout: 30000 })).stdout);
  const waitArgs = consultation.commands.wait.map(arg => arg === 'TASK_ID' ? created.id : arg);
  const advice = JSON.parse((await invoke(waitArgs[0] === 'node' ? process.execPath : waitArgs[0], waitArgs.slice(1), { timeout: 40000 })).stdout);
  assert.equal(advice.status, 'done');
  assert.equal(advice.accountId, personal.id);
  assert.equal(advice.result.url, 'https://chatgpt.com/c/restored');
  assert.equal(advice.result.response, 'Fixture reply: 请分析问题并给出验证步骤。\n仅使用本地测试页面。');
  await rpc('accounts.remove', { id: personal.id, confirmName: 'Personal' });
  state = await rpc('workspace.status');
  assert.equal(state.activeAccountId, work.id);
  assert.equal((await rpc('notifications.list', { accountId: work.id })).filter(item => item.unread).length, 1);
  assert.equal((await rpc('notifications.list')).some(item => item.accountId === personal.id), false, 'Deleting an account clears only its receipts');
  assert.equal(state.accounts.length, 1);
  const deletedCookies = await desktop.evaluate(({ session }, partition) => session.fromPartition(partition).cookies.get({}), personal.partition);
  assert.deepEqual(deletedCookies, []);
  await rpc('settings.api', { enabled: false });
  await page.screenshot({ path: 'test-results/workspace.png', animations: 'disabled' });
  const exited = new Promise(resolve => desktop.process().once('exit', resolve));
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  const closeTimeout = setTimeout(() => { desktop.process().kill(); }, 10000);
  const exitCode = await exited;
  clearTimeout(closeTimeout);
  assert.equal(exitCode, 0, 'Custom close button must shut down cleanly');
  desktop = undefined;
  cleanExit = true;
  assert.equal(errors.some(message => /database is not open|Uncaught Exception|Uncaught ReferenceError|Untrusted IPC sender/i.test(message)), false, errors.join('\n'));
  console.log('Desktop integration passed: scoped Agent handoff preview/copy and service toggle, configurable shortcuts, background manual/task reply notifications, per-conversation counts, open/read and restart persistence, pinned queues, takeover, UI, isolation and shutdown.');
} finally {
  if (!cleanExit) {
    if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/failure.png' }).catch(() => {});
    console.error(errors.join('\n'));
  }
  if (desktop) await desktop.close().catch(() => {});
  assert.ok(directory.startsWith(path.resolve('.') + path.sep + '.test-desktop-'));
  await rm(directory, { recursive: true, force: true });
}
