import type { ShortcutAction, ShortcutBinding, ShortcutConfig, WorkspaceShortcut } from './types';
export const shortcutActions: ShortcutAction[] = ['focus', 'takeover', 'previous', 'next', 'account1', 'account2', 'account3', 'account4', 'account5', 'account6', 'account7', 'account8', 'account9'];
export const shortcutLabels: Record<ShortcutAction, string> = { focus: '专注模式', takeover: '接管当前会话', previous: '上一个账号', next: '下一个账号',
  account1: '第 1 个账号', account2: '第 2 个账号', account3: '第 3 个账号', account4: '第 4 个账号', account5: '第 5 个账号', account6: '第 6 个账号', account7: '第 7 个账号', account8: '第 8 个账号', account9: '第 9 个账号' };
export function defaultShortcuts(platform: string): ShortcutConfig {
  return Object.fromEntries(shortcutActions.map(action => [action, { control: platform !== 'darwin', meta: platform === 'darwin',
    alt: action !== 'focus', shift: action === 'focus', code: action === 'focus' ? 'KeyF' : action === 'takeover' ? 'KeyT' : action === 'previous' ? 'ArrowLeft' : action === 'next' ? 'ArrowRight' : `Digit${action.slice(-1)}` }])) as ShortcutConfig;
}
export function bindingKey(binding: ShortcutBinding): string {
  return `${+binding.control}${+binding.meta}${+binding.alt}${+binding.shift}:${binding.code.replace(/^Numpad([0-9])$/, 'Digit$1')}`;
}
export function shortcutText(binding: ShortcutBinding | null): string {
  if (!binding) return '未设置';
  const key = binding.code.replace(/^Key|^Digit/, '').replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓');
  return [binding.control && 'Ctrl', binding.meta && '⌘', binding.alt && 'Alt', binding.shift && 'Shift', key].filter(Boolean).join('+');
}
export function shortcutCommand(action: ShortcutAction): WorkspaceShortcut {
  return action === 'focus' || action === 'takeover' ? { type: action } : action === 'previous' || action === 'next' ? { type: 'cycle', direction: action === 'previous' ? -1 : 1 } : { type: 'account', index: Number(action.slice(-1)) - 1 };
}
