import { useEffect, useState } from 'react';
import type { WorkspaceBridge } from '../../shared/types';
import type { UpdateState } from '../../shared/updates';

export function Updates({ bridge, compact = false }: { bridge?: WorkspaceBridge; compact?: boolean }) {
  const [state, setState] = useState<UpdateState>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const refresh = () => { void bridge.call<UpdateState>('updates.status').then(s => { if (active) setState(s); }).catch(() => {}); };
    refresh(); const off = bridge.onChange(refresh);
    return () => { active = false; off(); };
  }, [bridge]);
  const call = async (method: string, params = {}) => {
    setError('');
    try { await bridge?.call(method, params); } catch { setError('操作失败，请稍后重试。'); }
  };
  if (!state) return null;
  if (compact) return state.status === 'available' ? <button className="nav" onClick={() => void call('updates.open')}>发现新版 {state.latest} ↗</button> : null;
  return <div className="card setting-card">
    <h3>版本与更新</h3><p>当前版本 {state.current}</p>
    <label><input type="checkbox" checked={state.enabled} onChange={e => void call('updates.configure', { enabled: e.target.checked })} /> 自动检查新版本</label>
    <p className="hint">启动后及每 6 小时查询 GitHub 正式版本。仅发送常规网络请求，不上传账号、对话或登录信息。下载后手动安装，不会自动重启。</p>
    <p role="status">{state.status === 'checking' ? '正在检查…' : state.status === 'available' ? `新版本 ${state.latest} 已发布` : state.status === 'current' ? '当前已是最新正式版本' : state.status === 'error' ? '暂时无法检查更新，请检查网络后重试。' : '尚未检查更新'}</p>
    <button disabled={state.status === 'checking'} onClick={() => void call('updates.check')}>检查更新</button>{' '}
    <button onClick={() => void call('updates.open')}>前往官方下载 ↗</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
