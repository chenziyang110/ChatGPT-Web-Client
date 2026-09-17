export const BOSS_KEY_ACCELERATOR = 'CommandOrControl+Shift+S';

export interface BossKeyWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  hide(): void;
  show(): void;
  restore(): void;
  focus(): void;
  getChildWindows(): BossKeyWindow[];
}

interface GlobalShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export function registerBossKey(registrar: GlobalShortcutRegistrar, window: BossKeyWindow): { registered: boolean; dispose(): void } {
  const hiddenChildren = new Set<BossKeyWindow>();
  const toggle = () => {
    if (window.isDestroyed()) return;
    if (window.isVisible() && !window.isMinimized()) {
      hiddenChildren.clear();
      for (const child of window.getChildWindows()) {
        if (!child.isDestroyed() && child.isVisible()) { hiddenChildren.add(child); child.hide(); }
      }
      window.hide();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    for (const child of hiddenChildren) if (!child.isDestroyed()) child.show();
    hiddenChildren.clear();
  };
  const registered = registrar.register(BOSS_KEY_ACCELERATOR, toggle);
  let disposed = false;
  return { registered, dispose() {
    if (registered && !disposed) registrar.unregister(BOSS_KEY_ACCELERATOR);
    disposed = true;
  } };
}
