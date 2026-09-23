import type { Account, ConversationNotice, WorkspaceState } from '../../shared/types';
import { Icon } from './Icon';
export function accountActivity(state: WorkspaceState | undefined, accountId: string) {
  const notices = state?.notifications.filter(item => item.accountId === accountId) ?? [];
  return { count: notices.filter(item => item.unread).length, running: notices.some(item => item.running) || !!state?.tasks.some(task => task.accountId === accountId && task.status === 'running' && task.input.type === 'prompt' && task.input.submit && ['send_intent', 'submitted', 'generating'].includes(task.phase ?? '')) };
}
export function ReplyBadge({ account, count, onClick }: { account: Account; count: number; onClick: () => void }) {
  return count > 0 ? <button className="reply-badge" title={`${count} 个会话有未读回复，点击查看`} aria-label={`${account.name}，${count} 个会话有未读回复`} onClick={onClick}>
    <Icon name="chat" size={19} /><span>{count > 99 ? '99+' : count}</span>
  </button> : null;
}
export function nextUnreadNotice(notices: ConversationNotice[], accountId: string): ConversationNotice | undefined {
  return notices.filter(item => item.accountId === accountId && item.unread && !item.running)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];
}
