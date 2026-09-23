import { useEffect, useState } from 'react';
import type { WindowState, WorkspaceBridge } from '../../shared/types';
import { Icon, Logo } from './Icon';

export function Titlebar({ bridge, onError }: { bridge: WorkspaceBridge; onError: (error: string) => void }) {
  const [state, setState] = useState<WindowState>({ maximized: false, fullscreen: false, focused: true });
  useEffect(() => {
    let active = true;
    const update = () => { void bridge.call<WindowState>('window.state').then(next => { if (active) setState(next); }).catch(() => {}); };
    update();
    const off = bridge.onChange(update);
    return () => { active = false; off(); };
  }, [bridge]);
  const control = (action: string) => { void bridge.call('window.control', { action }).catch(error => onError(String(error.message))); };
  const expanded = state.maximized || state.fullscreen;
  return <header className={`titlebar ${state.focused ? '' : 'unfocused'}`}>
    <div className="titlebar-brand"><Logo /><span>ChatGPT <b>Workspace</b></span></div>
    <div className="window-controls" aria-label="窗口控制">
      <button title="最小化" aria-label="最小化窗口" onClick={() => control('minimize')}><Icon name="minimize" size={14} /></button>
      <button title={expanded ? '还原' : '最大化'} aria-label={expanded ? '还原窗口' : '最大化窗口'} onClick={() => control('maximize')}><Icon name={expanded ? 'restore' : 'maximize'} size={13} /></button>
      <button className="window-close" title="隐藏到托盘，队列继续运行" aria-label="隐藏到系统托盘" onClick={() => control('close')}><Icon name="close" size={16} /></button>
    </div>
  </header>;
}
