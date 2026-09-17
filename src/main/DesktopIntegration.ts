import type { ConversationNotice } from '../shared/types';

export interface DesktopWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  hide(): void;
  focus(): void;
}

export interface TrayMenuItem {
  label?: string;
  type?: 'separator';
  click?: () => void;
}

interface TrayHandle {
  setToolTip(value: string): void;
  setContextMenu(menu: unknown): void;
  on(event: 'click', listener: () => void): unknown;
  destroy(): void;
}

interface NativeNotificationHandle {
  once(event: 'click', listener: () => void): unknown;
  show(): void;
}

interface NativeNotificationFactory {
  supported(): boolean;
  create(options: { title: string; body: string; silent: boolean }): NativeNotificationHandle;
}

export function revealWindow(window: DesktopWindow): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function registerTray(tray: TrayHandle, buildMenu: (items: TrayMenuItem[]) => unknown,
  window: DesktopWindow, quit: () => void): { dispose(): void } {
  const show = () => revealWindow(window);
  tray.setToolTip('ChatGPT Web Client');
  tray.setContextMenu(buildMenu([
    { label: '显示主窗口', click: show },
    { label: '隐藏到托盘', click: () => { if (!window.isDestroyed()) window.hide(); } },
    { type: 'separator' },
    { label: '退出', click: quit }
  ]));
  tray.on('click', show);
  let disposed = false;
  return { dispose() { if (!disposed) tray.destroy(); disposed = true; } };
}

export function notifyConversationCompleted(factory: NativeNotificationFactory, notice: ConversationNotice,
  accountName: string, open: (notice: ConversationNotice) => void): boolean {
  if (!factory.supported()) return false;
  const account = accountName.replace(/\s+/g, ' ').trim().slice(0, 80) || 'ChatGPT';
  const conversation = notice.title.replace(/\s+/g, ' ').trim().slice(0, 120) || '会话';
  try {
    const notification = factory.create({ title: 'ChatGPT 回复完成', body: `${account} · ${conversation}`, silent: false });
    notification.once('click', () => open(notice));
    notification.show();
    return true;
  } catch { return false; }
}
