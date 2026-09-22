import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Account, AgentTask, BrowserDiagnostics, BrowserPage, Conversation, WorkspaceBridge, WorkspaceState } from '../../shared/types';
import { isQueueTask, LONG_REPLY_TIMEOUT_MS, orderedTasks } from '../../shared/conversationQueue';
import { Icon } from './Icon';
import { phaseLabels } from './TaskCenter';
import { friendlyError } from '../errors';
import { taskAttentionCopy } from '../../shared/taskAttentionCopy';

export function queueText(task: AgentTask): string {
  return task.input.type === 'prompt' ? task.input.prompt : task.input.type === 'fill' ? task.input.text : task.input.type === 'navigate' ? '打开会话页面' : task.input.type === 'snapshot' ? '读取页面' : '网页操作';
}

export function ConversationQueue({ account, page, state, bridge, drafts, changeDraft, clearDraft, refresh, close, inspect, takeover }: {
  account: Account; page: BrowserPage; state: WorkspaceState; bridge: WorkspaceBridge; drafts: Record<string, string>;
  changeDraft: (key: string, text: string) => void; clearDraft: (key: string, text: string) => void; refresh: () => Promise<void>; close: () => void;
  inspect: (task: AgentTask) => void; takeover: (accountId: string, conversationId?: string) => void;
}) {
  const [target, setTarget] = useState<Conversation>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [diagnostic, setDiagnostic] = useState<BrowserDiagnostics>();
  const [editing, setEditing] = useState<{ id: string; version: number; text: string }>();
  const [menuId, setMenuId] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const pendingAction = useRef(false);
  const composing = useRef(false);
  const request = useRef<{ signature: string; key: string } | undefined>(undefined);
  const editor = useRef<HTMLTextAreaElement>(null);
  const loading = state.page?.id === page.id && state.page.loading;
  useEffect(() => {
    let disposed = false;
    setTarget(undefined); setError(''); setEditing(undefined); setMenuId(undefined);
    if (loading) return;
    bridge.call<Conversation>('conversations.forPage', { accountId: account.id, pageId: page.id })
      .then(value => { if (!disposed) setTarget(value); })
      .catch(reason => { if (!disposed) setError(friendlyError(String(reason.message))); });
    return () => { disposed = true; };
  }, [bridge, account.id, page.id, page.url, loading, attempt]);
  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const sample = async () => {
      try { const value = await bridge.call<BrowserDiagnostics>('browser.inspect', { accountId: account.id, pageId: page.id }); if (!disposed) setDiagnostic(value); }
      catch { if (!disposed) setDiagnostic(undefined); }
      if (!disposed) timer = setTimeout(sample, 2000);
    };
    void sample();
    return () => { disposed = true; clearTimeout(timer); };
  }, [bridge, account.id, page.id]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const conversation = state.conversations.find(item => item.id === target?.id) ?? target;
  useEffect(() => { if (conversation) editor.current?.focus(); }, [conversation?.id]);
  const draftKey = `${account.id}:${conversation?.id}`;
  const draft = conversation ? drafts[draftKey] ?? '' : '';
  const tasks = orderedTasks(state.tasks.filter(task => !!conversation && task.accountId === account.id && task.conversationId === conversation.id && isQueueTask(task)));
  const running = tasks.find(task => task.status === 'running');
  const waiting = tasks.filter(task => task.status === 'pending');
  const attention = tasks.find(task => task.attention && !task.resolvedAt);
  const attentionCopy = attention && taskAttentionCopy(attention);
  const accountQueue = state.queues.find(queue => queue.accountId === account.id && !queue.conversationId);
  const queue = state.queues.find(queue => queue.accountId === account.id && queue.conversationId === conversation?.id);
  const paused = !!(queue?.paused || accountQueue?.paused);
  const generating = !!running?.sendIntentAt || !!diagnostic?.busy;
  const count = tasks.filter(task => !task.sendIntentAt).length;
  const ready = !!conversation && diagnostic?.readiness === 'ready' && !diagnostic.busy && !diagnostic.draftLength && !tasks.length && !paused;
  const status = !conversation ? loading ? '页面加载中' : '检查会话' : attention ? '需要处理' : paused ? '已暂停' : running ? phaseLabels[running.phase ?? 'preparing'] : diagnostic?.busy ? '等待当前回复' : waiting.length ? '等待运行名额' : '就绪';
  const elapsed = running?.submittedAt ? Math.max(0, Math.floor((now - running.submittedAt) / 1000)) : undefined;
  const edited = editing && state.tasks.find(task => task.id === editing.id);
  const staleEdit = !!editing && (edited?.status !== 'pending' || edited.updatedAt !== editing.version);
  const compositionEvents = {
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; },
    onBlur: () => { composing.current = false; },
  };
  const isComposing = (event: KeyboardEvent<HTMLElement>) => composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  async function run(method: string, params: Record<string, unknown>, done?: () => void) {
    if (pendingAction.current) return;
    pendingAction.current = true; setBusy(true); setError(''); setMenuId(undefined);
    try { await bridge.call(method, params); done?.(); await refresh(); }
    catch (reason) { setError(friendlyError(reason instanceof Error ? reason.message : String(reason))); }
    finally { pendingAction.current = false; setBusy(false); }
  }
  function enqueue() {
    if (pendingAction.current || !conversation || !draft.trim()) return;
    const prompt = draft;
    const params = { accountId: account.id, conversation: conversation.id, input: { type: 'prompt', prompt, submit: true },
      replyTimeoutMs: LONG_REPLY_TIMEOUT_MS, idleTimeoutMs: LONG_REPLY_TIMEOUT_MS, background: true };
    const signature = JSON.stringify(params);
    if (request.current?.signature !== signature) request.current = { signature, key: crypto.randomUUID() };
    void run('tasks.create', { ...params, idempotencyKey: request.current.key }, () => { clearDraft(draftKey, prompt); request.current = undefined; editor.current?.focus(); });
  }
  function reorder(index: number, direction: number) {
    if (!conversation) return;
    const next = [...waiting]; [next[index], next[index + direction]] = [next[index + direction], next[index]];
    void run('queues.reorder', { accountId: account.id, conversation: conversation.id, items: next.map(task => ({ id: task.id, updatedAt: task.updatedAt })) });
  }
  function saveEdit() {
    if (!conversation || !editing || !editing.text.trim() || staleEdit || pendingAction.current) return;
    void run('tasks.edit', { accountId: account.id, conversation: conversation.id, id: editing.id, expectedUpdatedAt: editing.version, prompt: editing.text }, () => { setEditing(undefined); editor.current?.focus(); });
  }
  return <aside className="conversation-queue" aria-label="会话队列" onKeyDown={event => {
    if (event.key !== 'Escape' || isComposing(event)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.repeat || busy) return;
    if (menuId) {
      event.currentTarget.querySelector<HTMLButtonElement>(`[data-task-id="${menuId}"] .cq-icon-button`)?.focus();
      setMenuId(undefined);
    } else if (editing) { setEditing(undefined); editor.current?.focus(); }
    else close();
  }}>
    <header className="cq-header"><div><h2>待发送 <span>{count}</span></h2><p title={`${account.name} · ${conversation?.alias ?? page.title ?? '新会话'}`}>{account.name} · {conversation?.alias ?? page.title ?? '新会话'}</p></div>
      <button className="cq-icon-button" aria-label="关闭队列面板" title="关闭面板，队列继续运行" onClick={close}><Icon name="close" size={18} /></button></header>
    <div className={`cq-status ${attention ? 'needs-attention' : ''}`}>
      <span className={`cq-status-dot ${generating ? 'is-generating' : ''}`} /><span role="status">{status}</span>
      {elapsed !== undefined && <span className="cq-elapsed">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>}
      {!accountQueue?.paused && <button className="text-button" disabled={busy || !conversation || !!attention} title={paused ? '恢复后依次发送' : '当前回复继续，暂停后续发送'} onClick={() => void run(paused ? 'queues.resume' : 'queues.pause', { accountId: account.id, conversation: conversation!.id })}>{paused ? '恢复队列' : '暂停后续'}</button>}
    </div>
    {accountQueue?.paused && <p className="cq-warning">账号已暂停，请到任务中心恢复。</p>}
    {error && <div className="cq-error" role="alert">{error}{!target && <button className="text-button" onClick={() => setAttempt(value => value + 1)}>重新检查页面</button>}</div>}
    <div className="cq-list">
      {attention && <div className="cq-attention"><strong>{attentionCopy?.title}</strong><button className="text-button" onClick={() => inspect(attention)}>处理</button></div>}
      {running && <details className="cq-running"><summary>{running.sendIntentAt ? '当前消息' : '等待发送'} · {queueText(running)}</summary><p>{queueText(running)}</p>
        <button className="text-button" onClick={() => takeover(account.id, conversation?.id)}>接管此会话</button></details>}
      {!tasks.length && <p className="cq-empty">还没有排队消息</p>}
      <ol className="cq-items">{waiting.map((task, index) => <li className="cq-item" key={task.id} data-task-id={task.id}>
        <div className="cq-item-row"><span className="cq-order">{index + 1}</span>
        {editing?.id === task.id ? <div className="cq-edit"><textarea aria-label="编辑排队消息" autoFocus title="Ctrl / ⌘ + Enter 保存，Esc 取消" {...compositionEvents} maxLength={32000} value={editing.text} disabled={busy} onChange={event => setEditing({ ...editing, text: event.target.value })} onKeyDown={event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && !isComposing(event)) {
            event.preventDefault(); if (!event.repeat) saveEdit();
          }
        }} />
          <div className="cq-item-actions"><button className="text-button" disabled={busy} onClick={() => { setEditing(undefined); editor.current?.focus(); }}>取消编辑</button><button className="primary" title="Ctrl / ⌘ + Enter" disabled={busy || !editing.text.trim() || staleEdit} onClick={saveEdit}>保存修改</button></div></div>
          : <><details className="cq-message"><summary title="展开消息">{queueText(task)}</summary><p>{queueText(task)}</p></details>
            <button className="cq-icon-button" aria-label={`第 ${index + 1} 条更多操作`} aria-expanded={menuId === task.id} disabled={busy} onClick={() => setMenuId(menuId === task.id ? undefined : task.id)}><Icon name="more" size={17} /></button></>}
        </div>
        {menuId === task.id && <div className="cq-item-actions" role="group" aria-label={`第 ${index + 1} 条操作`}>
          {task.input.type === 'prompt' && <button className="text-button" disabled={busy} onClick={() => { setMenuId(undefined); setEditing({ id: task.id, version: task.updatedAt, text: queueText(task) }); }}>编辑</button>}
          <button className="text-button" aria-label={`上移第 ${index + 1} 条`} disabled={busy || index === 0} onClick={() => reorder(index, -1)}>上移</button>
          <button className="text-button" aria-label={`下移第 ${index + 1} 条`} disabled={busy || index === waiting.length - 1} onClick={() => reorder(index, 1)}>下移</button>
          <button className="text-button" disabled={busy} onClick={() => void run('tasks.removeQueued', { accountId: account.id, conversation: conversation!.id, id: task.id, expectedUpdatedAt: task.updatedAt })}>移除</button></div>}
      </li>)}</ol>
      {staleEdit && <div className="cq-error" role="alert">这条消息已开始或已被更新，未覆盖原内容。<textarea aria-label="保留的编辑内容" readOnly value={editing?.text} /><button className="text-button" onClick={() => setEditing(undefined)}>关闭编辑</button></div>}
    </div>
    <form className="cq-composer" onSubmit={event => { event.preventDefault(); enqueue(); }}>
      <textarea id="queue-draft" aria-label="下一条消息" aria-describedby="queue-keyboard-help" ref={editor} {...compositionEvents} placeholder="写下一条消息…" maxLength={32000} value={draft} disabled={!conversation} aria-busy={busy} onChange={event => changeDraft(draftKey, event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !isComposing(event)) {
          event.preventDefault(); if (!event.repeat) enqueue();
        }
      }} />
      <div className="cq-compose-footer"><span id="queue-keyboard-help" title={paused ? '恢复后依次发送' : ready ? '空闲时直接发送' : '回复结束后自动发送'}>Enter 发送 · Shift+Enter 换行</span><button className="primary" title="Enter 或 Ctrl / ⌘ + Enter" disabled={busy || !conversation || !draft.trim()}>{busy ? '处理中…' : ready ? '加入并发送' : '加入队列'}</button></div>
    </form>
  </aside>;
}
