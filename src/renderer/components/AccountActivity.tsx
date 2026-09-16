import type { Account, ConversationNotice, WorkspaceState } from '../../shared/types';
import { Icon } from './Icon';
export function accountActivity(state: WorkspaceState | undefined, accountId: string) {
  const notices = state?.notifications.filter(item => item.accountId === accountId) ?? [];
  return { count: notices.filter(item => item.unread).length, running: notices.some(item => item.running) || !!state?.tasks.some(task => task.accountId === accountId && task.status === 'running' && task.input.type === 'prompt' && task.input.submit && ['send_intent', 'submitted', 'generating'].includes(task.phase ?? '')) };
}
export function ReplyBadge({ account, count, onClick }: { account: Account; count: number; onClick: () => void }) {
  return count > 0 ? <button className="reply-badge" title={`${count} 个会话待处理`} aria-label={`${account.name}，${count} 个会话待处理`} onClick={onClick}>
    <Icon name="chat" size={19} /><span>{count > 99 ? '99+' : count}</span>
  </button> : null;
}
export function NotificationList({ account, notices, busy, action, opened }: { account: Account; notices: ConversationNotice[]; busy: boolean;
  action: (method: string, params?: Record<string, unknown>, after?: () => void) => Promise<void>; opened: () => void }) {
  const unread = notices.filter(item => item.accountId === account.id && item.unread).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  return <div className="notification-list"><p>「{account.name}」有 {unread.length} 个会话待处理。查看会话或标记后消除对应气泡。</p>
    {!unread.length && <div className="notification-empty"><Icon name="check" size={26} /><p>全部处理完了</p></div>}
    {unread.map(item => <article className="notification-item" key={item.id}>
      <div><strong>{item.title}</strong>{item.running && <span className="conversation-spinner" aria-label="会话运行中" />}<small>{new Date(item.completedAt!).toLocaleString()}</small></div>
      <div className="notification-actions"><button className="text-button" disabled={busy} onClick={() => void action('notifications.read', { accountId: account.id, id: item.id, token: item.token })}>标记已处理</button>
        <button className="secondary" disabled={busy || item.running} onClick={() => void action('notifications.open', { accountId: account.id, id: item.id, token: item.token }, opened)}>查看会话</button></div>
    </article>)}
  </div>;
}
