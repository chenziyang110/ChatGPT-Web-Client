import { app, dialog, ipcMain } from 'electron';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AccountManager } from '../core/account/AccountManager';
import { SessionManager } from '../core/session/SessionManager';
import { Database } from '../core/storage/Database';
import { AgentGateway } from '../core/agent/AgentGateway';
import { LocalApi } from '../core/agent/LocalApi';
import { Workspace } from '../core/Workspace';
import { AppError, record, text } from '../core/validation';
import { BrowserRuntime } from './BrowserRuntime';
import { createWindow } from './window';

app.setName('ChatGPT-Web-Client');
if (process.env.WORKSPACE_USER_DATA) app.setPath('userData', path.resolve(process.env.WORKSPACE_USER_DATA));
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else void app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  chmodSync(userData, 0o700);
  const db = new Database(path.join(userData, 'workspace.sqlite'));
  const accounts = new AccountManager(db);
  const sessions = new SessionManager(db);
  const win = createWindow(sessions);
  const changed = () => { if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('workspace:changed'); };
  const browser = new BrowserRuntime(win, accounts, sessions, changed);
  const tasks = new AgentGateway(db, (id, input, signal) => browser.execute(id, input, signal), changed);
  const discoveryFile = path.join(userData, 'agent-runtime.json');
  let apiError: string | undefined;
  let stopping = false;
  let stopped = false;
  const workspace: Workspace = new Workspace(accounts, tasks, browser, changed, () => ({
    enabled: api.endpoint !== null, endpoint: api.endpoint, discoveryFile, error: apiError
  }));
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
    if (stopping || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url !== trustedUrl) throw new AppError('Untrusted IPC sender', 403);
    const name = text(method, 'Method', 80);
    const params = record(value);
    if (JSON.stringify(params).length > 65536) throw new AppError('Request too large', 413);
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
  if (activeId) { accounts.activate(activeId); browser.activate(activeId); }
}).catch(error => {
  dialog.showErrorBox('ChatGPT Web Client could not start', error instanceof Error ? error.message : String(error));
  app.exit(1);
});
