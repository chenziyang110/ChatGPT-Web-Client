import { app, clipboard, dialog, ipcMain, shell } from 'electron';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AccountManager } from '../core/account/AccountManager';
import { SessionManager } from '../core/session/SessionManager';
import { ConversationManager } from '../core/conversation/ConversationManager';
import { ConversationNotifications } from '../core/notifications/ConversationNotifications';
import { ShortcutSettings } from '../core/settings/ShortcutSettings';
import { Database } from '../core/storage/Database';
import { AgentGateway } from '../core/agent/AgentGateway';
import { LocalApi } from '../core/agent/LocalApi';
import { Workspace } from '../core/Workspace';
import { AppError, identifier, record, text } from '../core/validation';
import { BrowserRuntime } from './BrowserRuntime';
import { createWindow } from './window';
import type { AgentHandoff } from '../shared/types';

import { UpdateChecker } from './UpdateChecker';
import { RELEASES_URL } from '../shared/updates';

app.setName('ChatGPT-Web-Client');
if (process.platform === 'win32') app.setAppUserModelId('com.chenziyang.chatgptwebclient');
if (process.env.WORKSPACE_USER_DATA) app.setPath('userData', path.resolve(process.env.WORKSPACE_USER_DATA));
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else void app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  chmodSync(userData, 0o700);
  const db = new Database(path.join(userData, 'workspace.sqlite'));
  let stopping = false;
  const accounts = new AccountManager(db);
  const sessions = new SessionManager(db);
  const conversations = new ConversationManager(db);
  const shortcuts = new ShortcutSettings(db);
  const win = createWindow(sessions, shortcuts);
  const changed = () => { if (!stopping && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('workspace:changed'); };
  const updates = new UpdateChecker(app.getVersion(), db.get<boolean>('autoCheckUpdates') !== false, changed);
  const checkUpdates = () => { if (app.isPackaged && updates.state.enabled && !stopping) void updates.check(); };
  const updateStart = setTimeout(checkUpdates, 10000);
  const updateTimer = setInterval(checkUpdates, 6 * 60 * 60 * 1000);
  win.webContents.on('did-start-loading', () => { shortcuts.capturing = false; });
  win.on('maximize', changed).on('unmaximize', changed)
    .on('enter-full-screen', changed).on('leave-full-screen', changed)
    .on('focus', changed).on('blur', changed);
  const notifications = new ConversationNotifications(db, changed);
  const browser = new BrowserRuntime(win, accounts, sessions, changed, conversations, shortcuts, notifications);
  const tasks = new AgentGateway(db, (id, input, signal, context) => browser.execute(id, input, signal, context), () => {
    browser.setLocked(tasks.lockedTasks()); changed();
  });
  const discoveryFile = path.join(userData, 'agent-runtime.json');
  let apiError: string | undefined;
  let stopped = false;
  const workspace: Workspace = new Workspace(accounts, tasks, browser, changed, () => ({
    enabled: api.endpoint !== null, endpoint: api.endpoint, discoveryFile, error: apiError
  }), conversations, notifications, shortcuts, process.platform === 'win32'
    ? path.join(app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '../dist-agent'), 'chatgpt-agent.exe')
    : app.isPackaged ? undefined : path.join(__dirname, 'cli.cjs'));
  const api: LocalApi = new LocalApi(discoveryFile, (method, params) => {
    if (stopping) throw new AppError('Runtime is stopping', 503);
    return workspace.call(method, params);
  });
  const rendererFile = path.join(__dirname, '../dist/index.html');
  const devUrl = !app.isPackaged && process.env.WORKSPACE_DEV_URL === 'http://127.0.0.1:5173'
    ? 'http://127.0.0.1:5173/' : undefined;
  const trustedUrl = devUrl ?? pathToFileURL(rendererFile).href;
  let apiChange: Promise<unknown> = Promise.resolve();
  ipcMain.handle('workspace:call', async (event, method: unknown, value: unknown) => {
    if (stopping) throw new AppError('Runtime is stopping', 503);
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url !== trustedUrl) throw new AppError('Untrusted IPC sender', 403);
    const name = text(method, 'Method', 80);
    const params = record(value);
    if (JSON.stringify(params).length > 65536) throw new AppError('Request too large', 413);
    // Window controls are available only to the trusted local renderer, never the HTTP API.
    if (name === 'updates.status') return { ...updates.state };
    if (name === 'updates.check') return updates.check();
    if (name === 'updates.open') { await shell.openExternal(RELEASES_URL); return null; }
    if (name === 'updates.configure') {
      if (typeof params.enabled !== 'boolean') throw new AppError('enabled must be a boolean');
      db.set('autoCheckUpdates', params.enabled); updates.setEnabled(params.enabled);
      if (params.enabled) checkUpdates();
      return { ...updates.state };
    }
    if (name === 'tasks.decide') return workspace.decideTask(params);
    if (name === 'browser.preview') return browser.preview(identifier(params.accountId), params.pageId === undefined ? undefined : identifier(params.pageId));
    if (name === 'agent.prompt.copy') {
      const handoff = await workspace.call('agent.prompt', params) as AgentHandoff;
      clipboard.writeText(handoff.prompt); return { copied: true };
    }
    if (name === 'settings.shortcuts.capture') {
      if (typeof params.active !== 'boolean') throw new AppError('active must be a boolean');
      shortcuts.capturing = params.active; return null;
    }
    if (name === 'window.state') return { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() };
    if (name === 'window.control') {
      if (params.action === 'minimize') win.minimize();
      else if (params.action === 'maximize') {
        if (win.isFullScreen()) win.setFullScreen(false);
        else if (win.isMaximized()) win.unmaximize();
        else win.maximize();
      } else if (params.action === 'close') setImmediate(() => { if (!win.isDestroyed()) win.close(); });
      else throw new AppError('Unknown window action');
      return null;
    }
    if (name === 'ui.bounds') {
      const values = ['x', 'y', 'width', 'height'].map(key => params[key]);
      if (!values.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 32768)) {
        throw new AppError('Invalid browser bounds');
      }
      const [x, y, width, height] = values as number[];
      browser.setBounds({ x, y, width, height });
      return null;
    }
    if (name === 'ui.visibility') {
      if (typeof params.visible !== 'boolean') throw new AppError('visible must be a boolean');
      browser.setVisible(params.visible); return null;
    }
    if (name === 'settings.api') {
      if (typeof params.enabled !== 'boolean') throw new AppError('enabled must be a boolean');
      const next = apiChange.then(async () => {
        apiError = undefined;
        try {
          if (params.enabled) await api.start(); else await api.stop();
          db.set('apiEnabled', params.enabled);
        } catch (error) {
          apiError = error instanceof Error ? error.message : 'Could not start the API';
          throw error;
        } finally { changed(); }
        return workspace.state().api;
      });
      apiChange = next.catch(() => undefined);
      return next;
    }
    return workspace.call(name, params);
  });
  // Remove stale discovery credentials even when the API was disabled after a crash.
  await api.stop();
  if (db.get<boolean>('apiEnabled')) {
    try { await api.start(); } catch (error) { apiError = error instanceof Error ? error.message : 'API startup failed'; }
  }
  app.on('second-instance', () => { if (!win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.on('activate', () => { if (!win.isDestroyed()) win.show(); });
  const shutdown = async () => {
    stopping = true;
    clearTimeout(updateStart); clearInterval(updateTimer);
    await apiChange;
    await api.stop();
    await workspace.settled();
    await tasks.stop();
    sessions.saveWindow({ ...win.getNormalBounds(), maximized: win.isMaximized() });
    browser.close();
    db.close();
    stopped = true;
    app.quit();
  };
  // Keep the native window alive until task execution and SQLite have shut down.
  win.on('close', event => {
    if (!stopped) { event.preventDefault(); if (!stopping) void shutdown(); }
  });
  app.on('before-quit', event => {
    if (!stopped) { event.preventDefault(); if (!stopping) void shutdown(); }
  });
  await win.loadURL(trustedUrl);
  const activeId = accounts.activeId() ?? accounts.list()[0]?.id;
  browser.setLocked(tasks.lockedTasks());
  if (activeId) { accounts.activate(activeId); browser.activate(activeId); }
}).catch(error => {
  dialog.showErrorBox('ChatGPT Web Client could not start', error instanceof Error ? error.message : String(error));
  app.exit(1);
});
