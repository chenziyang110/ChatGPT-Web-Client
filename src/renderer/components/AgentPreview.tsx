import { useEffect, useState } from 'react';
import type { BrowserPreview, WorkspaceBridge } from '../../shared/types';

export function AgentPreview({ bridge, accountId, pageId }: { bridge: WorkspaceBridge; accountId: string; pageId?: string }) {
  const [preview, setPreview] = useState<BrowserPreview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    setPreview(null); setError('');
    const capture = async () => {
      try {
        const next = await bridge.call<BrowserPreview | null>('browser.preview', { accountId, pageId });
        if (!stopped) { setPreview(next); setError(''); }
      } catch { if (!stopped) setError('预览暂时不可用，任务状态仍会更新'); }
      finally { if (!stopped) timer = setTimeout(() => void capture(), 1000); }
    };
    void capture();
    return () => { stopped = true; clearTimeout(timer); };
  }, [bridge, accountId, pageId]);
  return <div className="agent-preview">
    <div className="preview-canvas" aria-label="Agent 网页只读预览">
      {preview?.accountId === accountId && preview?.pageId === pageId ? <img draggable={false} alt="Agent 当前操作的网页，只读预览" src={preview.image} /> : <p>{error || '正在获取网页画面…'}</p>}
    </div>
    {error && <div className="preview-caption" role="status">{error}</div>}
  </div>;
}
