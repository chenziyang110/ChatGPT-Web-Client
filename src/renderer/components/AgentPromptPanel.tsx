import { useEffect, useRef, useState } from 'react';
import type { AgentHandoff, AgentPromptTarget, WorkspaceBridge, WorkspaceState } from '../../shared/types';
import { Select } from './Select';
import { friendlyError } from '../errors';
export function AgentPromptPanel({ bridge, state, initial, action, busy, notifyError }: { bridge: WorkspaceBridge; state?: WorkspaceState; initial: AgentPromptTarget; busy: boolean; notifyError: (message: string) => void;
  action: (method: string, params?: Record<string, unknown>, after?: () => void) => Promise<void> }) {
  const [accountId, setAccountId] = useState(initial.accountId);
  const [choice, setChoice] = useState(initial.conversation ?? (initial.pageId ? '__page' : initial.url ? '__url' : initial.current ? '__current' : '__account'));
  const selectionKey = JSON.stringify([accountId, choice, initial.url, initial.pageId]);
  const [resolved, setResolved] = useState<{ key: string; value: AgentHandoff }>();
  const handoff = resolved?.key === selectionKey ? resolved.value : undefined;
  const pinned = useRef<{ key: string; target: AgentPromptTarget } | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const counter = useRef(0);
  const conversations = state?.conversations.filter(item => item.accountId === accountId && item.binding !== 'uncertain') ?? [];
  useEffect(() => {
    const ticket = ++counter.current;
    setResolved(undefined); setCopied(false);
    const params = pinned.current?.key === selectionKey ? { ...pinned.current.target }
      : { accountId, ...(choice === '__page' ? { pageId: initial.pageId } : choice === '__current' ? { current: true } : choice === '__url' ? { url: initial.url } : choice === '__account' ? {} : { conversation: choice }) };
    void bridge.call<AgentHandoff>('agent.prompt', params).then(value => { if (counter.current === ticket) {
      pinned.current = { key: selectionKey, target: value.target };
      setResolved({ key: selectionKey, value });
    } }, error => {
      if (counter.current === ticket) notifyError(String(error.message));
    });
    return () => { counter.current++; };
  }, [bridge, selectionKey, state?.api.enabled, notifyError]);
  async function copy() {
    if (!handoff) return;
    setCopying(true);
    try {
      // Copy the resolved target from the preview, never resolve "current" a second time.
      await bridge.call('agent.prompt.copy', { ...handoff.target }); setCopied(true);
    } catch (error) { notifyError(error instanceof Error ? error.message : String(error)); }
    finally { setCopying(false); }
  }
  return <div className="agent-prompt-panel">
    <p className="agent-intro">复制给 Agent，让它通过网页 ChatGPT 获取回答。</p>
    <div className="target-fields"><label>协作账号<Select label="协作账号" value={accountId} disabled={copying}
      options={state?.accounts.map(account => ({ value: account.id, label: account.name })) ?? []}
      onValueChange={id => { setAccountId(id); setChoice('__account'); }} /></label>
      <label>协作范围<Select label="协作范围" value={choice} disabled={copying} onValueChange={setChoice}
        options={[{ value: '__account', label: '新建会话' }, { value: '__current', label: '当前会话' },
          ...(initial.pageId && accountId === initial.accountId ? [{ value: '__page', label: '此标签页' }] : []),
          ...(initial.url ? [{ value: '__url', label: '选中的会话' }] : []),
          ...conversations.map(item => ({ value: item.id, label: item.title }))]} /></label></div>
    {!state?.api.enabled && <div className="agent-service-note"><span>使用前需启用本地服务</span><button className="secondary" disabled={busy} onClick={() => void action('settings.api', { enabled: true })}>启用服务</button></div>}
    {state?.api.error && <p role="alert" className="error-text">{friendlyError(state.api.error)}</p>}
    <p className="hint">使用网页当前模型，请提前选好。</p>
    {handoff && <><details className="agent-prompt-details"><summary>查看提示词与说明</summary>
      <div className="agent-target-label">{handoff.accountName} · {handoff.targetName}</div>
      <textarea aria-label="Agent 协作提示词" className="agent-prompt-preview" readOnly value={handoff.prompt} spellCheck={false} />
      <p className="hint">Agent 需能访问本机服务。提示词不含登录凭据或服务令牌。</p>
      {handoff.helpUrl && <p className="hint agent-help-url">使用说明：<code>{handoff.helpUrl}</code></p>}
      </details>
      <div className="agent-copy-footer"><span role="status" title={`${handoff.accountName} · ${handoff.targetName}`}>{copied ? '已复制，粘贴给 Agent 即可' : `目标：${handoff.targetName}`}</span><button className="primary" disabled={copying} onClick={() => void copy()}>{copying ? '复制中…' : '复制 Agent 提示词'}</button></div></>}
  </div>;
}
