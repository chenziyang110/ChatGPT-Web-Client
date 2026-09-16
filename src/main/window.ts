import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { SessionManager } from '../core/session/SessionManager';
import { bindShortcuts } from './shortcuts';
import type { ShortcutSettings } from '../core/settings/ShortcutSettings';
export function createWindow(sessions: SessionManager, shortcuts: ShortcutSettings): BrowserWindow {
  const saved = sessions.restoreWindow();
  const display = screen.getPrimaryDisplay().workArea;
  let bounds = { x: saved?.x, y: saved?.y, width: Math.max(900, Math.min(saved?.width ?? 1440, display.width)),
    height: Math.max(640, Math.min(saved?.height ?? 940, display.height)) };
  if (bounds.x !== undefined && bounds.y !== undefined && !screen.getAllDisplays().some(({ workArea }) =>
    bounds.x! + bounds.width > workArea.x && bounds.x! < workArea.x + workArea.width &&
    bounds.y! + bounds.height > workArea.y && bounds.y! < workArea.y + workArea.height)) {
    bounds = { ...bounds, x: undefined, y: undefined };
  }
  const win = new BrowserWindow({ ...bounds, minWidth: 900, minHeight: 640, show: false,
    title: 'ChatGPT Web Client', backgroundColor: '#f8f9f5', frame: false,
    icon: path.join(__dirname, '../dist/brand/workspace.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webviewTag: false, partition: 'persist:workspace-ui' } });
  win.setMenu(null);
  bindShortcuts(win.webContents, win, shortcuts);
  win.once('ready-to-show', () => { if (saved?.maximized) win.maximize(); win.show(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  return win;
}
