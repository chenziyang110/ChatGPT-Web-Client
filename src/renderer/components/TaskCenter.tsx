import { useRef, useState, type FormEvent } from 'react';
import type { AgentPromptTarget, AgentTask, WorkspaceState } from '../../shared/types';
import { Icon } from './Icon';
import { Select } from './Select';
import { taskAttentionCopy } from '../../shared/taskAttentionCopy';
import { canClearTask } from '../../shared/taskHistory';
import { QueueOverview } from './QueueOverview';
import { LONG_REPLY_TIMEOUT_MS } from '../../shared/conversationQueue';
export const statusLabels = { pending: '等待中', running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消', blocked: '需要处理', waiting_user: '等待你的选择', uncertain: '待核对' };
export const phaseLabels = { queued: '已排队', preparing: '准备页面', waiting_idle: '等待上一轮结束', preparing_prompt: '填写提示词', send_intent: '正在发送', submitted: '已发送，等待回复', generating: '等待回复', completed: '已完成' };
const taskLabels = { prompt: '提示词', snapshot: '页面快照', navigate: '页面导航', fill: '填写内容', click: '点击元素' };
type Action = (method: string, params?: Record<string, unknown>, after?: () => void) => Promise<void>;
export function TaskCenter({ state, busy, action, inspect, takeover, agentPrompt, openQueue }: {
  state?: WorkspaceState; busy: boolean; action: Action; inspect: (task: AgentTask) => void; takeover: (accountId: string, conversationId?: string) => void;
  agentPrompt: (target: AgentPromptTarget) => void;
  openQueue: (accountId: string, conversationId: string) => void;
}) {
  const [selectedAccount, setSelectedAccount] = useState('');
  const [conversation, setConversation] = useState('current');
  const [prompt, setPrompt] = useState('');
  const [submit, setSubmit] = useState(false);
  const [alias, setAlias] = useState('');
  const request = useRef<{ signature: string; key: string } | undefined>(undefined);
  const accountId = state?.accounts.some(account => account.id === selectedAccount) ? selectedAccount : state?.activeAccountId ?? '';
  const conversations = state?.conversations.filter(item => item.accountId === accountId) ?? [];
  const clearableCount = state?.tasks.filter(canClearTask).length ?? 0;
  const target = conversation === 'new' ? { new: true, alias: alias || undefined } : conversation === 'current' ? { current: true } : { conversation };
  function create(event: FormEvent) {
    event.preventDefault();
    const params = { accountId, ...target, input: { type: 'prompt', prompt, submit }, replyTimeoutMs: LONG_REPLY_TIMEOUT_MS, idleTimeoutMs: LONG_REPLY_TIMEOUT_MS, background: true };
    const signature = JSON.stringify(params);
    if (request.current?.signature !== signature) request.current = { signature, key: crypto.randomUUID() };
    void action('tasks.create', { ...params, idempotencyKey: request.current.key }, () => { setPrompt(''); request.current = undefined; });
  }
  return <section className="content tasks-page">
    <div className="page-heading"><div><h2>任务</h2></div>
      <button className="secondary" disabled={!accountId || busy} onClick={() => void action('tasks.create', { accountId, input: { type: 'snapshot' } })}><Icon name="snapshot" size={16} /> 读取页面快照</button></div>
    {state && <QueueOverview state={state} open={openQueue} />}
    <div className="queue-list">{state?.accounts.map(account => {
      const queue = state.queues.find(item => item.accountId === account.id);
      const active = state.tasks.find(task => task.id === queue?.runningTaskId);
      const waiting = state.tasks.find(task => task.accountId === account.id && task.attention && !task.resolvedAt);
      return <div className="card queue-card" key={account.id}>
        <div><strong>{account.name}</strong><span className={`status ${queue?.paused ? 'blocked' : active ? 'running' : 'done'}`}>{queue?.paused ? '已暂停' : active ? phaseLabels[active.phase ?? 'preparing'] : '就绪'}</span>
          {queue?.reason ? <p>{queue.reason}</p> : state.tasks.some(task => task.accountId === account.id && task.status === 'pending') && <p>{state.tasks.filter(task => task.accountId === account.id && task.status === 'pending').length} 个任务排队中</p>}
        </div>
        <div className="queue-actions"><button className="secondary" disabled={busy} onClick={() => takeover(account.id)}>接管页面</button>
          {waiting ? <button className="primary" onClick={() => inspect(waiting)}>选择如何处理</button> : queue?.paused ? <button className="primary" disabled={busy} onClick={() => void action('queues.resume', { accountId: account.id })}>恢复此账号全部队列</button>
            : <button className="secondary" disabled={busy} onClick={() => void action('queues.pause', { accountId: account.id })}>暂停此账号全部队列</button>}</div>
      </div>;
    })}</div>
    <form className="card composer" onSubmit={create}>
      <div className="target-fields"><label>执行账号<Select label="执行账号" value={accountId} placeholder="请先添加账号"
        options={state?.accounts.map(account => ({ value: account.id, label: account.name })) ?? []}
        onValueChange={id => { setSelectedAccount(id); setConversation('current'); }} /></label>
        <label>目标会话<Select label="目标会话" value={conversation} onValueChange={setConversation}
          options={[{ value: 'current', label: '当前会话' }, { value: 'new', label: '创建新会话' },
            ...conversations.map(item => ({ value: item.id, label: `${item.title}${item.binding === 'new' ? '（待首次发送）' : ''}` }))]} /></label>
        {conversation === 'new' && <label>会话别名<input value={alias} maxLength={60} placeholder="可选，例如：日报" onChange={event => setAlias(event.target.value)} /></label>}
      </div>
      <label htmlFor="task-prompt"><Icon name="chat" size={17} /> 提示词</label>
      <textarea id="task-prompt" placeholder="输入提示词…" value={prompt} maxLength={32000} onChange={event => setPrompt(event.target.value)} disabled={!accountId} />
      <div className="composer-footer"><label className="check"><input type="checkbox" aria-label="发送给 ChatGPT 并等待回复" checked={submit} onChange={event => setSubmit(event.target.checked)} />发送并等待回复</label>
        <button className="primary" disabled={!accountId || !prompt.trim() || busy || (conversation === 'new' && !submit)}>{submit ? '加入发送队列' : '填入草稿'} <Icon name="send" size={16} /></button></div>
      {conversation === 'new' && !submit && <p className="hint">新会话需要勾选“发送并等待回复”。</p>}
      <details className="task-help"><summary>使用说明</summary><p>不勾选发送时，只填入草稿。当前会话在入队时固定，仅支持普通个人对话；新会话在首次发送后绑定。</p><p>已有草稿会暂停任务，请接管处理后继续。同一会话依次执行，最多两个自动任务同时运行。</p></details>
    </form>
    <div className="agent-entry card"><strong>Agent 协作</strong>
      <button className="secondary" aria-label="给 Agent 的提示词" disabled={!accountId || busy} onClick={() => agentPrompt({ accountId, ...(conversation === 'current' ? { current: true } : conversation === 'new' ? {} : { conversation }) })}>生成提示词</button></div>
    <div className="list-heading"><h3>最近任务 <span>{state?.tasks.length ?? 0}</span></h3>
      <button className="text-button clear-history" aria-label="清理已结束的任务记录" title={clearableCount ? `清理 ${clearableCount} 条已结束记录，保留运行中和待处理任务` : '暂无可清理记录，运行中和待处理任务会保留'} disabled={busy || !clearableCount} onClick={() => void action('tasks.clear')}><Icon name="trash" size={17} />清理记录</button></div>
    {!state?.tasks.length ? <div className="card empty-tasks"><h3>暂无任务</h3><p>选择账号和会话，添加第一个任务。</p></div>
      : <div className="task-list">{state.tasks.map(task => <div className="card task" key={task.id}>
        <div className={`task-icon ${task.status}`}><Icon name={task.input.type === 'prompt' ? 'chat' : 'terminal'} size={20} /></div>
        <button className="task-summary" onClick={() => inspect(task)}><strong>{taskLabels[task.input.type]}</strong>
          <span>{task.input.type === 'prompt' ? task.input.prompt : task.input.type === 'navigate' ? task.input.url : task.input.type === 'snapshot' ? '读取页面可见文本' : task.input.selector}</span>
          <small>{state.accounts.find(account => account.id === task.accountId)?.name ?? '已删除账号'} · {state.conversations.find(item => item.id === task.conversationId)?.title ?? task.targetUrl} · {new Date(task.createdAt).toLocaleString()}</small>
          {task.attention ? <small>{taskAttentionCopy(task)?.title}</small> : task.error && <small className="error-text">{task.error}</small>}</button>
        {(task.status === 'running' || task.attention) && <button className="text-button" onClick={() => takeover(task.accountId, task.conversationId)}>接管此会话</button>}<span className={`status ${task.status}`}>{task.status === 'running' ? phaseLabels[task.phase ?? 'preparing'] : statusLabels[task.status]}</span>
        {['pending', 'running', 'blocked', 'waiting_user'].includes(task.status) && <button className="text-button" disabled={busy} onClick={() => void action('tasks.cancel', { id: task.id })}>取消</button>}
      </div>)}</div>}
  </section>;
}
