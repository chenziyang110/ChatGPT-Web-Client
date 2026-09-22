import { useEffect, useState } from 'react';
import type { WorkspaceBridge } from '../../shared/types';
import type { UpdateState } from '../../shared/updates';

export function Updates({ bridge, compact = false, openSettings }: { bridge?: WorkspaceBridge; compact?: boolean; openSettings?: () => void }) {
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
    try { await bridge?.call(method, params); }
    catch (error) { setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '操作失败，请稍后重试。'); }
  };
  if (!state) return null;
  const native = state.installMode === 'in-app';
  const busy = ['checking', 'downloading', 'installing'].includes(state.status);
  const download = native && !!state.latest && ['available', 'error'].includes(state.status);
  const status = state.status === 'checking' ? '正在检查…'
    : state.status === 'downloading' ? `正在下载 ${state.progress ?? 0}%`
    : state.status === 'downloaded' ? `新版 ${state.latest} 已准备好`
    : state.status === 'installing' ? '正在安装，即将重启…'
    : state.status === 'available' ? `发现新版本 ${state.latest}`
    : state.status === 'current' ? '当前已是最新正式版本'
    : state.status === 'error' ? state.error ?? '暂时无法检查更新，请稍后重试。' : '尚未检查更新';
  if (compact) {
    if (state.status === 'downloaded') return <button className="nav" onClick={openSettings}>新版已就绪 · {state.latest}</button>;
    if (state.status === 'downloading' || state.status === 'installing') return <span className="nav" role="status">{status}</span>;
    if (state.status === 'available') return <button className="nav" onClick={openSettings}>更新到 {state.latest}</button>;
    return error ? <p className="hint" role="alert">{error}</p> : null;
  }
  return <div className="card setting-card">
    <h3>版本与更新</h3><p>当前版本 {state.current}</p>
    <label><input type="checkbox" checked={state.enabled} onChange={e => void call('updates.configure', { enabled: e.target.checked })} /> 自动检查新版本</label>
    <p className="hint">{native ? '下载完成后，点击安装并重启。账号、会话和排队消息会保留。' : state.installMode === 'development' ? '开发运行中，请使用正式安装版体验软件内更新。' : '此安装方式请下载新版覆盖安装，账号和会话会保留。'}</p>
    <p role="status">{status}</p>
    {state.status === 'downloading' && <progress aria-label="更新下载进度" max={100} value={state.progress ?? 0} />}
    <div className="update-actions">
    {download && <button className="primary" onClick={() => void call('updates.download')}>{state.status === 'error' ? '重试下载' : '下载更新'}</button>}
    {state.status === 'downloaded' && <button className="primary" onClick={() => void call('updates.install')}>安装并重启</button>}
    {state.status === 'downloading' && <button onClick={() => void call('updates.cancel')}>取消下载</button>}
    <button disabled={busy || state.status === 'downloaded'} onClick={() => void call('updates.check')}>检查更新</button>
    <button onClick={() => void call('updates.open')}>前往官方下载 ↗</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
