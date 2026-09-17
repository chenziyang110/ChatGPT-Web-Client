import assert from 'node:assert/strict';
import test from 'node:test';

import { BOSS_KEY_ACCELERATOR, registerBossKey, type BossKeyWindow } from '../src/main/bossKey';

class WindowStub implements BossKeyWindow {
  destroyed = false;
  visible = true;
  minimized = false;
  hidden = 0;
  shown = 0;
  restored = 0;
  focused = 0;
  children: WindowStub[] = [];
  isDestroyed(): boolean { return this.destroyed; }
  isVisible(): boolean { return this.visible; }
  isMinimized(): boolean { return this.minimized; }
  hide(): void { this.visible = false; this.hidden++; }
  show(): void { this.visible = true; this.shown++; }
  restore(): void { this.minimized = false; this.restored++; }
  focus(): void { this.focused++; }
  getChildWindows(): WindowStub[] { return this.children; }
}

test('global boss key hides all visible windows, then restores the app to the foreground', () => {
  const window = new WindowStub();
  const popup = new WindowStub();
  window.children.push(popup);
  let accelerator = ''; let callback = () => {};
  const unregistered: string[] = [];
  const registration = registerBossKey({
    register(value, handler) { accelerator = value; callback = handler; return true; },
    unregister(value) { unregistered.push(value); }
  }, window);

  assert.equal(accelerator, BOSS_KEY_ACCELERATOR);
  assert.equal(accelerator, 'CommandOrControl+Shift+S');
  callback();
  assert.equal(window.visible, false);
  assert.equal(popup.visible, false);

  window.minimized = true;
  callback();
  assert.equal(window.visible, true);
  assert.equal(window.minimized, false);
  assert.equal(window.restored, 1);
  assert.equal(window.focused, 1);
  assert.equal(popup.visible, true);

  registration.dispose();
  assert.deepEqual(unregistered, [BOSS_KEY_ACCELERATOR]);
});

test('failed registration and destroyed windows remain safe', () => {
  const window = new WindowStub();
  let callback = () => {}; let unregisters = 0;
  const registration = registerBossKey({
    register(_value, handler) { callback = handler; return false; },
    unregister() { unregisters++; }
  }, window);
  assert.equal(registration.registered, false);
  window.destroyed = true;
  callback();
  assert.equal(window.hidden, 0);
  registration.dispose();
  assert.equal(unregisters, 0);
});
