import type { BrowserWindow, WebContents } from 'electron';
import type { ShortcutSettings } from '../core/settings/ShortcutSettings';

// Listen in both the local UI and account pages without exposing IPC to websites.
export function bindShortcuts(contents: WebContents, window: BrowserWindow, settings: ShortcutSettings): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing) return;
    if (settings.capturing && contents === window.webContents) return;
    const shortcut = settings.match(input);
    if (!shortcut || window.isDestroyed() || window.webContents.isDestroyed()) return;
    event.preventDefault();
    window.webContents.send('workspace:shortcut', shortcut);
  });
}
