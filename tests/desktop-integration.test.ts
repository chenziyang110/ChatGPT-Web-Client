import assert from 'node:assert/strict';
import test from 'node:test';

import { notifyConversationCompleted, registerTray, type DesktopWindow, type TrayMenuItem } from '../src/main/DesktopIntegration';
import type { ConversationNotice } from '../src/shared/types';

class WindowStub implements DesktopWindow {
  destroyed = false;
  visible = false;
  minimized = true;
  restored = 0;
  shown = 0;
  hidden = 0;
  focused = 0;
  isDestroyed(): boolean { return this.destroyed; }
  isVisible(): boolean { return this.visible; }
  isMinimized(): boolean { return this.minimized; }
  restore(): void { this.minimized = false; this.restored++; }
  show(): void { this.visible = true; this.shown++; }
  hide(): void { this.visible = false; this.hidden++; }
  focus(): void { this.focused++; }
}

test('tray click restores the window and its menu can show, hide and quit', () => {
  const window = new WindowStub(); let clicked = () => {}; let destroyed = 0; let quit = 0; let menu: TrayMenuItem[] = [];
  const registration = registerTray({
    setToolTip(value) { assert.equal(value, 'ChatGPT Web Client'); },
    setContextMenu(value) { menu = value as TrayMenuItem[]; },
    on(event, listener) { if (event === 'click') clicked = listener; },
    destroy() { destroyed++; }
  }, items => items, window, () => { quit++; });

  clicked();
  assert.equal(window.restored, 1); assert.equal(window.shown, 1); assert.equal(window.focused, 1);
  menu.find(item => item.label === '隐藏到托盘')?.click?.();
  assert.equal(window.hidden, 1);
  menu.find(item => item.label === '显示主窗口')?.click?.();
  assert.equal(window.shown, 2);
  menu.find(item => item.label === '退出')?.click?.();
  assert.equal(quit, 1);
  registration.dispose(); assert.equal(destroyed, 1);
});

test('completion uses a native notification and clicking it opens the exact conversation', () => {
  const notice: ConversationNotice = { id: 'account:chat', accountId: 'account', url: 'https://chatgpt.com/c/chat',
    title: 'A very useful answer', running: false, unread: true, token: 'token', completedAt: 1 };
  let options: { title: string; body: string; silent: boolean } | undefined; let click = () => {}; let shown = 0; let opened: ConversationNotice | undefined;
  const emitted = notifyConversationCompleted({
    supported: () => true,
    create(value) { options = value; return { once(event, listener) { if (event === 'click') click = listener; }, show() { shown++; } }; }
  }, notice, 'Work', value => { opened = value; });

  assert.equal(emitted, true); assert.equal(shown, 1);
  assert.deepEqual(options, { title: 'ChatGPT 回复完成', body: 'Work · A very useful answer', silent: false });
  click(); assert.equal(opened, notice);
});

test('unsupported native notifications fail closed without constructing one', () => {
  let created = 0;
  const emitted = notifyConversationCompleted({ supported: () => false, create() { created++; throw new Error('not supported'); } },
    { id: 'a:c', accountId: 'a', url: 'https://chatgpt.com/c/c', title: 'Chat', running: false, unread: true }, 'A', () => {});
  assert.equal(emitted, false); assert.equal(created, 0);
});
