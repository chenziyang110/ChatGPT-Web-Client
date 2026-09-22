import type { AgentTask } from './types';

export const idleTimeoutCopy = {
  title: '此任务此前等待超时，尚未发送',
  detail: '当时自动任务等待目标页面空闲超时，现已暂停。这是该任务上次执行的结果，不是当前网页的实时状态，也不影响其他会话。可以重试此任务，或取消不再需要的任务。',
};

// Also clarify persisted notices created by older versions, without changing their decision token.
export function taskAttentionCopy(task: AgentTask) {
  const attention = task.attention?.kind === 'review_send' && task.submittedAt && task.submittedMessageId
    ? { ...task.attention, title: '消息已发送，回复需核对', detail: '已确认问题出现在目标会话中，但客户端确认回复的过程被中断。请核对网页结果；此任务不会重发。' }
    : task.attention?.kind === 'page' && !task.sendIntentAt && task.error?.includes('waiting_idle timed out')
      ? { ...task.attention, ...idleTimeoutCopy } : task.attention;
  return attention ? { ...attention, choices: attention.choices.map(choice =>
    choice.id === 'takeover' ? { ...choice, label: '接管' } : choice) } : undefined;
}
