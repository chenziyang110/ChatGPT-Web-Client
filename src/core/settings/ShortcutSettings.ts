import type { Database } from '../storage/Database';
import { AppError, record } from '../validation';
import { bindingKey, defaultShortcuts, shortcutActions, shortcutCommand, shortcutLabels } from '../../shared/shortcuts';
import type { ShortcutBinding, ShortcutConfig, WorkspaceShortcut } from '../../shared/types';
export class ShortcutSettings {
  capturing = false;
  constructor(private readonly db: Database, private readonly platform = process.platform) {}
  get(): ShortcutConfig {
    const stored = this.db.get<Partial<ShortcutConfig>>('shortcuts');
    const defaults = defaultShortcuts(this.platform);
    if (!stored) return defaults;
    const next = { ...defaults, ...stored };
    for (const action of shortcutActions) {
      if (!(action in stored) && next[action] && Object.values(stored).some(binding => binding && bindingKey(binding) === bindingKey(next[action]!))) next[action] = null;
    }
    return next;
  }
  save(value: unknown): ShortcutConfig {
    const config = record(value); const next = {} as ShortcutConfig; const seen = new Map<string, string>();
    if (Object.keys(config).some(key => !shortcutActions.includes(key as keyof ShortcutConfig))) throw new AppError('未知快捷键操作');
    for (const action of shortcutActions) {
      if (config[action] === null) { next[action] = null; continue; }
      const binding = record(config[action]);
      if (typeof binding.code !== 'string' || !/^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|F([1-9]|1[0-2])|Home|End|PageUp|PageDown)$/.test(binding.code)) throw new AppError('请选择字母、数字、方向键或功能键');
      if (!['control', 'meta', 'alt', 'shift'].every(key => typeof binding[key] === 'boolean') || (!binding.control && !binding.meta && !binding.alt)) throw new AppError('快捷键至少包含 Ctrl、Command 或 Alt');
      const normalized: ShortcutBinding = { code: binding.code, control: binding.control as boolean, meta: binding.meta as boolean, alt: binding.alt as boolean, shift: binding.shift as boolean };
      const key = bindingKey(normalized);
      if (seen.has(key)) throw new AppError(`快捷键冲突：${seen.get(key)} 与 ${shortcutLabels[action]}`);
      seen.set(key, shortcutLabels[action]); next[action] = normalized;
    }
    this.db.set('shortcuts', next); return next;
  }
  reset(): ShortcutConfig { this.db.delete('shortcuts'); return this.get(); }
  match(input: ShortcutBinding): WorkspaceShortcut | undefined {
    const key = bindingKey(input); const config = this.get();
    const action = shortcutActions.find(action => config[action] && bindingKey(config[action]!) === key);
    return action ? shortcutCommand(action) : undefined;
  }
}
