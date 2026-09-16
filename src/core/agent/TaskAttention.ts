import { randomUUID } from 'node:crypto';
import type { TaskAttention } from '../../shared/types';
import { idleTimeoutCopy } from '../../shared/taskAttentionCopy';
export function taskAttention(error: string, sent = false, takeover = false): TaskAttention {
  const entry: Pick<TaskAttention, 'kind' | 'title' | 'detail'> = sent ? {
    kind: 'review_send', title: '消息可能已发送，需要你核对', detail: '请查看网页中的实际结果。此任务不会重发，网页可能仍在生成回答。'
  } : takeover ? { kind: 'manual_takeover', title: '你已接管，任务等待继续', detail: '自动操作已停止，原任务还未发送。处理好页面后，可以继续同一个任务。' }
    : /VERIFICATION_REQUIRED/.test(error) ? { kind: 'verification', title: '网页需要验证', detail: '先接管并完成该账号的网页验证，再选择继续。问题已保留。' }
    : /LOGIN_REQUIRED/.test(error) ? { kind: 'login', title: '这个账号需要登录', detail: '先接管并在网页登录，再选择继续。问题已保留。' }
    : /DRAFT_CONFLICT|DRAFT_CHANGED/.test(error) ? { kind: 'draft', title: '网页里有尚未处理的草稿', detail: '草稿会保留。你可以接管处理草稿，再继续任务，也可以取消这个任务。' }
    : /waiting_idle timed out/.test(error) ? { kind: 'page', ...idleTimeoutCopy }
    : /COMPOSER_NOT_READY|SEND_UNAVAILABLE|PAGE_UNSUPPORTED|PAGE_CHANGED|TARGET_CHANGED/.test(error) ? { kind: 'page', title: '此任务上次未能操作目标页面', detail: '这是自动任务上次执行时的检查结果，不代表当前网页不能手动操作。问题尚未发送。可以重试；若目标页面有草稿，请先接管处理。' }
    : { kind: 'other', title: '任务需要你的选择', detail: '自动操作已暂停，问题尚未发送。请检查页面后继续，或取消这个任务。' };
  return { id: randomUUID(), ...entry, choices: sent
    ? [{ id: 'takeover', label: '接管' }, { id: 'acknowledge', label: '已核对，结束此任务' }]
    : [{ id: 'takeover', label: '接管' }, { id: 'retry', label: entry.kind === 'page' ? '再试一次' : '处理好了，继续' }, { id: 'cancel', label: '取消任务' }] };
}
