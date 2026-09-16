import { useEffect, useState } from 'react';
import type { ShortcutAction, ShortcutConfig, WorkspaceBridge } from '../../shared/types';
import { defaultShortcuts, shortcutActions, shortcutLabels, shortcutText } from '../../shared/shortcuts';
export function ShortcutEditor({ bridge, config, busy, action }: { bridge: WorkspaceBridge; config?: ShortcutConfig; busy: boolean;
  action: (method: string, params?: Record<string, unknown>, after?: () => void) => Promise<void> }) {
  const [draft, setDraft] = useState(config ?? defaultShortcuts(bridge.platform));
  const [recording, setRecording] = useState<ShortcutAction>();
  const [saved, setSaved] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const signature = JSON.stringify(config);
  useEffect(() => { if (config) setDraft(config); }, [signature]);
  useEffect(() => () => { void bridge.call('settings.shortcuts.capture', { active: false }).catch(() => {}); }, [bridge]);
  const capture = (active: boolean) => { void bridge.call('settings.shortcuts.capture', { active }).catch(error => setCaptureError(String(error.message))); };
  function row(key: ShortcutAction) {
    return <div className="shortcut-row" key={key}><label htmlFor={`shortcut-${key}`}>{shortcutLabels[key]}</label>
      <input id={`shortcut-${key}`} className="shortcut-recorder" readOnly disabled={busy} value={recording === key ? '按下组合键…' : shortcutText(draft[key])}
        onFocus={() => { setRecording(key); capture(true); }} onBlur={() => { setRecording(undefined); capture(false); }}
        onKeyDown={event => {
          if (event.key === 'Tab') return;
          event.preventDefault(); event.stopPropagation();
          if (event.key === 'Escape') { event.currentTarget.blur(); return; }
          if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key) || event.nativeEvent.isComposing || event.repeat) return;
          if (!event.ctrlKey && !event.metaKey && !event.altKey) { setCaptureError('请同时按住 Ctrl、Command 或 Alt'); return; }
          setDraft({ ...draft, [key]: { code: event.code.replace(/^Numpad([0-9])$/, 'Digit$1'), control: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey } });
          setSaved(false); setCaptureError(''); event.currentTarget.blur();
        }} />
      <button className="text-button" disabled={busy || !draft[key]} onClick={() => { setDraft({ ...draft, [key]: null }); setSaved(false); }} aria-label={`清除${shortcutLabels[key]}快捷键`}>清除</button>
    </div>;
  }
  return <div className="card setting-card shortcut-editor"><h3>键盘快捷键</h3><p>点击组合键后按下新按键。清除后停用该项，保存后立即生效。</p>
    {shortcutActions.slice(0, 3).map(row)}
    <details className="account-shortcut-details"><summary>直接切换账号</summary>{shortcutActions.slice(3).map(row)}</details>
    {captureError && <p role="alert" className="error-text">{captureError}</p>}
    <div className="shortcut-actions"><button className="secondary" disabled={busy} onClick={() => void action('settings.shortcuts.reset', {}, () => { setSaved(true); setDraft(defaultShortcuts(bridge.platform)); })}>恢复默认</button>
      <button className="primary" disabled={busy || JSON.stringify(draft) === signature} onClick={() => void action('settings.shortcuts.save', { shortcuts: draft }, () => setSaved(true))}>保存快捷键</button>
      {saved && <span role="status">已保存</span>}</div>
    <p className="hint">在客户端和账号网页内生效。账号按侧栏顺序切换；打开弹窗时暂停。快捷键提示仅显示在本页。</p>
  </div>;
}
