import type { WorkspaceState } from '../../shared/types';
import { isQueueTask } from '../../shared/conversationQueue';
import { phaseLabels } from './TaskCenter';
import { Icon } from './Icon';

export function QueueOverview({ state, open }: { state: WorkspaceState; open: (accountId: string, conversationId: string) => void }) {
  return <div className="queue-overview">{state.accounts.map(account => {
    const conversations = state.conversations.filter(conversation => conversation.accountId === account.id && state.tasks.some(task => task.conversationId === conversation.id && isQueueTask(task)));
    if (!conversations.length) return null;
    return <section key={account.id} className="cq-account-group"><h3>{account.name}<span>{conversations.length} 个会话</span></h3>{conversations.map(conversation => {
      const tasks = state.tasks.filter(task => task.conversationId === conversation.id && isQueueTask(task));
      const active = tasks.find(task => task.status === 'running');
      const attention = tasks.find(task => task.attention && !task.resolvedAt);
      const paused = state.queues.some(queue => queue.accountId === account.id && (!queue.conversationId || queue.conversationId === conversation.id) && queue.paused);
      return <button className="card cq-overview-row" key={conversation.id} onClick={() => open(account.id, conversation.id)}><Icon name="chat" size={20} /><span><strong>{conversation.alias ?? state.pages.find(page => page.conversationId === conversation.id)?.title ?? conversation.title}</strong><small>{attention ? '需要处理' : paused ? '后续已暂停' : active ? phaseLabels[active.phase ?? 'preparing'] : '等待发送'} · {tasks.filter(task => !task.sendIntentAt).length} 条待发送</small></span><span>打开队列 →</span></button>;
    })}</section>;
  })}{!state.tasks.some(task => task.conversationId && isQueueTask(task)) && <div className="card empty-tasks"><h3>暂无排队会话</h3><p>在网页工具栏打开“会话队列”，提前安排下一步。</p></div>}</div>;
}
