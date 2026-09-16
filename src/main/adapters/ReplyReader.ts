import type { AgentTask, TaskResponse } from '../../shared/types';
import { replyPageUrl, type Page } from './ChatGPTAdapter';

// Read-only recovery: match the submitted turn, then wait for a stable final answer.
export class ReplyReader {
  private readonly samples = new Map<string, { fingerprint: string; since: number }>();
  read(task: AgentTask, page: Page, expectedUrl?: string, now = Date.now()): TaskResponse {
    const unavailable = (reason: string): TaskResponse => { this.samples.delete(task.id); return { taskId: task.id, state: 'unavailable', reason }; };
    if (task.input.type !== 'prompt' || task.attention?.kind === 'manual_takeover') return unavailable('任务已接管或不是咨询任务');
    const url = replyPageUrl(page.url, !expectedUrl);
    if (!url || expectedUrl && url !== expectedUrl) return unavailable('会话地址不匹配，请在客户端核对；不会重新发送');
    const users = page.messages.filter(message => message.role === 'user');
    const own = users.at(-1);
    const normalize = (value: string) => value.replace(/\r\n?/g, '\n').trim();
    if (!own || normalize(own.text) !== normalize(task.input.prompt) ||
      (task.submittedMessageId ? own.id !== task.submittedMessageId : users.length !== 1)) return unavailable('无法确认原问题，请核对任务对应的会话');
    const last = page.messages.at(-1);
    const canonical = !url.includes('/c/WEB:') && url.includes('/c/');
    const answer = last?.role === 'assistant' && page.messages.indexOf(last) > page.messages.indexOf(own) ? last : undefined;
    const result = answer ? { response: answer.text.slice(0, 64000), url: canonical ? url : undefined, conversationId: task.conversationId } : undefined;
    const fingerprint = JSON.stringify([url, page.messages]);
    const finished = canonical && page.editor && !page.busy && !page.error && !page.draft.trim() && answer?.terminal && !!answer.text;
    const sample = this.samples.get(task.id);
    if (!finished || sample?.fingerprint !== fingerprint) this.samples.set(task.id, { fingerprint, since: now });
    if (this.samples.size > 128) this.samples.delete(this.samples.keys().next().value!);
    return { taskId: task.id, state: finished && sample?.fingerprint === fingerprint && now - sample.since >= 3000 ? 'done' : 'reading', result };
  }
}
