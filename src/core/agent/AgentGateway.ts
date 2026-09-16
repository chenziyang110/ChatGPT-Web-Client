import { createHash, randomUUID } from 'node:crypto';
import { Database } from '../storage/Database';
import { AppError, chatUrl, record, text } from '../validation';
import { taskAttention } from './TaskAttention';
import { canClearTask } from '../../shared/taskHistory';
import type { AccountQueue, AgentTask, Conversation, TaskInput, TaskPhase } from '../../shared/types';
export type { AgentTask } from '../../shared/types';
const queueKey = (accountId: string, conversationId?: string) => conversationId ? `${accountId}:conversation:${conversationId}` : accountId;
export interface ExecutionContext {
  task(): AgentTask;
  stage(phase: TaskPhase, timeoutMs?: number): void;
  intent(): void;
  submitted(messageId?: string): void;
  progress?(response: string, url?: string): void;
}
export type TaskExecutor = (accountId: string, input: TaskInput, signal: AbortSignal, context: ExecutionContext) => Promise<unknown>;
export interface TaskOptions {
  conversationId?: string; targetUrl?: string; idempotencyKey?: string; requestHash?: string;
  replyTimeoutMs?: number; prepareTimeoutMs?: number; idleTimeoutMs?: number;
}
interface RequestRecord { accountId: string; hash: string; taskId: string; task?: AgentTask }
export const requestHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function parseTask(value: unknown): TaskInput {
  const input = record(value);
  switch (input.type) {
    case 'navigate': return { type: 'navigate', url: chatUrl(input.url) };
    case 'snapshot': return { type: 'snapshot' };
    case 'click': return { type: 'click', selector: text(input.selector, 'Selector', 1000) };
    case 'fill':
      if (typeof input.text !== 'string' || input.text.length > 32000) throw new AppError('Text must be at most 32000 characters');
      return { type: 'fill', selector: text(input.selector, 'Selector', 1000), text: input.text };
    case 'prompt':
      if (input.submit !== undefined && typeof input.submit !== 'boolean') throw new AppError('submit must be a boolean');
      return { type: 'prompt', prompt: text(input.prompt, 'Prompt', 32000), submit: input.submit === true };
    default: throw new AppError('Unknown task type');
  }
}
function duration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1000 || value > 3600000) throw new AppError('Timeout must be between 1000 and 3600000 milliseconds');
  return value;
}
export class AgentGateway {
  private readonly running = new Map<string, { id: string; controller: AbortController; promise: Promise<void> }>();
  private stopped = false;
  private scheduled = false;
  private readonly dispatched = new Map<string, number>();
  private dispatchSequence = 0;
  private readonly waiters = new Set<(id?: string) => void>();
  wait(id: string, timeoutMs = 25000, afterUpdatedAt?: number, updates = false): Promise<AgentTask> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 25000) throw new AppError('Wait timeout must be 0–25000 milliseconds');
    if (afterUpdatedAt !== undefined && (!Number.isSafeInteger(afterUpdatedAt) || afterUpdatedAt < 0)) throw new AppError('Invalid task update timestamp');
    if (typeof updates !== 'boolean') throw new AppError('updates must be a boolean');
    const ready = (task: AgentTask) => (updates || !['pending', 'running'].includes(task.status)) && task.updatedAt !== afterUpdatedAt;
    const initial = this.get(id);
    if (this.stopped || !timeoutMs || ready(initial)) return Promise.resolve(initial);
    if (this.waiters.size >= 128) throw new AppError('Too many task waiters', 429);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (task?: AgentTask, error?: unknown) => { clearTimeout(timer); this.waiters.delete(check); if (error) reject(error); else resolve(task!); };
      const check = (changedId?: string) => {
        if (changedId !== undefined && changedId !== id) return;
        try { const task = this.get(id); if (this.stopped || ready(task)) finish(task); } catch (error) { finish(undefined, error); }
      };
      timer = setTimeout(() => { try { finish(this.get(id)); } catch (error) { finish(undefined, error); } }, timeoutMs);
      this.waiters.add(check);
    });
  }
  constructor(private readonly db: Database, private readonly execute: TaskExecutor, private readonly changed: () => void, private readonly concurrency = 2) {
    for (const request of db.records<RequestRecord>('request_keys')) {
      if (request.task?.idempotencyKey) db.write('request_keys', `${request.accountId}:${request.task.idempotencyKey}`, { accountId: request.accountId, hash: request.hash, taskId: request.task.id });
    }
    const legacy = db.get<AgentTask[]>('tasks');
    if (legacy) db.transaction(() => {
      for (const task of [...legacy].reverse()) if (!db.read('tasks', task.id)) db.write('tasks', task.id, task);
      db.delete('tasks');
    });
    for (let task of this.listTasks()) {
      if (!task.conversationId && task.targetUrl) {
        const target = db.records<Conversation>('conversations').find(item => item.accountId === task.accountId && item.url === task.targetUrl);
        if (target) task = this.update(task.id, { conversationId: target.id }, false);
      }
      if (task.status === 'blocked') this.update(task.id, { status: 'waiting_user', attention: taskAttention(task.error ?? '') }, false);
      if (task.status === 'uncertain' && !task.resolvedAt && !task.attention) this.update(task.id, { attention: taskAttention(task.error ?? '', true) }, false);
      if (!['pending', 'running'].includes(task.status)) continue;
      if (!task.conversationId && !task.targetUrl) this.update(task.id, { status: 'failed', error: 'Legacy task has no fixed conversation; it was not replayed' }, false);
      else {
        this.update(task.id, task.sendIntentAt
          ? { status: 'uncertain', attention: taskAttention('Application stopped after send intent', true), error: 'Application stopped after send intent. Check the conversation; do not resend automatically.' }
          : { status: 'pending', phase: 'queued', error: 'Restored paused; resume this account to continue.' }, false);
        this.setQueue(task.accountId, true, '应用重启后已暂停，请核对会话再继续', false, task.conversationId);
      }
    }
    // Old releases paused an entire account on one conversation error. Preserve
    // the affected task's pause without carrying that accidental global block forward.
    for (const queue of db.records<AccountQueue>('account_queues')) {
      if (queue.conversationId || !queue.paused || !['任务需要处理，请检查错误后继续', '发送或回复结果不确定，请核对会话', '消息可能已发送，请核对后继续'].includes(queue.reason ?? '')) continue;
      const unresolved = this.listTasks().filter(task => task.accountId === queue.accountId && (['pending', 'running', 'waiting_user', 'blocked'].includes(task.status) || task.status === 'uncertain' && !task.resolvedAt));
      if (!unresolved.length || unresolved.some(task => !task.conversationId)) continue;
      for (const task of unresolved.filter(task => task.status === 'waiting_user' || task.status === 'uncertain')) {
        this.setQueue(task.accountId, true, queue.reason, false, task.conversationId);
      }
      this.setQueue(queue.accountId, false, undefined, false);
    }
  }
  listTasks(): AgentTask[] { return this.db.records<AgentTask>('tasks').reverse(); }
  get(id: string): AgentTask {
    const task = this.db.read<AgentTask>('tasks', id);
    if (!task) throw new AppError('Task not found', 404);
    return task;
  }
  queues(): AccountQueue[] {
    const stored = this.db.records<AccountQueue>('account_queues');
    const ids = new Set([...this.listTasks().map(task => task.accountId), ...stored.map(queue => queue.accountId)]);
    const summaries = [...ids].map(accountId => {
      const own = this.db.read<AccountQueue>('account_queues', accountId);
      const paused = stored.find(queue => queue.accountId === accountId && queue.paused);
      const runningTaskIds = [...this.running.values()].filter(slot => this.get(slot.id).accountId === accountId).map(slot => slot.id);
      return { ...own, accountId, paused: own?.paused || !!paused, reason: own?.reason ?? paused?.reason, runningTaskId: runningTaskIds[0], runningTaskIds };
    });
    return [...summaries, ...stored.filter(queue => queue.conversationId).map(queue => ({ ...queue, runningTaskId: this.running.get(queueKey(queue.accountId, queue.conversationId))?.id }))];
  }
  runningAccounts(): string[] { return [...new Set([...this.running.values()].map(slot => this.get(slot.id).accountId))]; }
  lockedTasks(): AgentTask[] {
    const active = new Set([...this.running.values()].map(slot => slot.id));
    return this.listTasks().filter(task => active.has(task.id) || task.attention && !task.resolvedAt && ['waiting_user', 'uncertain'].includes(task.status) &&
      (this.db.read<AccountQueue>('account_queues', queueKey(task.accountId, task.conversationId))?.control ?? this.db.read<AccountQueue>('account_queues', task.accountId)?.control) !== 'human');
  }
  lockedAccounts(): string[] { return [...new Set(this.lockedTasks().map(task => task.accountId))]; }
  isRunning(accountId: string, conversationId?: string): boolean {
    return [...this.running.values()].some(slot => { const task = this.get(slot.id); return task.accountId === accountId && (!conversationId || task.conversationId === conversationId); });
  }
  private setQueue(accountId: string, paused: boolean, reason?: string, notify = true, conversationId?: string): AccountQueue {
    const key = queueKey(accountId, conversationId);
    const queue: AccountQueue = { ...this.db.read<AccountQueue>('account_queues', key), accountId, conversationId, paused, reason };
    this.db.write('account_queues', key, queue);
    if (notify) this.changed();
    return queue;
  }
  pause(accountId: string, conversationId?: string): AccountQueue { return this.setQueue(accountId, true, '队列已暂停；正在执行的任务会继续', true, conversationId); }
  async takeover(accountId: string, conversationId?: string): Promise<AccountQueue> {
    this.setQueue(accountId, true, '已人工接管；继续前请核对页面', true, conversationId);
    const selected = [...this.running.values()].filter(slot => { const task = this.get(slot.id); return task.accountId === accountId && (!conversationId || task.conversationId === conversationId); });
    for (const active of selected) {
      const task = this.get(active.id);
      active.controller.abort(new Error('Human takeover'));
      this.update(task.id, { status: task.sendIntentAt ? 'uncertain' : 'waiting_user',
        attention: taskAttention('Human takeover', !!task.sendIntentAt, true), error: 'Human takeover' });
    }
    await Promise.all(selected.map(active => active.promise));
    for (const queue of this.db.records<AccountQueue>('account_queues').filter(queue => queue.accountId === accountId && (!conversationId || queue.conversationId === conversationId))) {
      this.db.write('account_queues', queueKey(accountId, queue.conversationId), { ...queue, paused: true, control: 'human' });
    }
    this.changed();
    return this.db.read<AccountQueue>('account_queues', queueKey(accountId, conversationId))!;
  }
  async decide(id: string, token: string, choice: string): Promise<AgentTask> {
    const task = this.get(id);
    if (!task.attention || task.attention.id !== token || task.resolvedAt) throw new AppError('STALE_DECISION: 任务状态已更新，请查看最新选项', 409);
    if (!task.attention.choices.some(item => item.id === choice)) throw new AppError('INVALID_CHOICE: 此选项不适用于当前任务', 409);
    if (choice === 'takeover') { await this.takeover(task.accountId, task.conversationId); return this.get(id); }
    if (this.isRunning(task.accountId, task.conversationId)) throw new AppError('请等待自动操作停止后再选择', 409);
    if (choice === 'retry') {
      if (task.sendIntentAt || task.status !== 'waiting_user') throw new AppError('消息可能已发送，不能重试', 409);
      if (this.listTasks().some(other => other.id !== id && queueKey(other.accountId, other.conversationId) === queueKey(task.accountId, task.conversationId) && other.status === 'uncertain' && !other.resolvedAt)) throw new AppError('REVIEW_REQUIRED: 请先核对该账号可能已发送的消息', 409);
      this.update(id, { status: 'pending', phase: 'queued', error: undefined, attention: undefined }, false);
      this.setQueue(task.accountId, false, undefined, false, task.conversationId);
      this.changed(); this.schedule();
    } else if (choice === 'cancel') this.cancel(id);
    else if (choice === 'acknowledge') this.update(id, { resolvedAt: Date.now(), attention: undefined });
    return this.get(id);
  }
  resume(accountId: string, acknowledged = false, conversationId?: string): AccountQueue {
    if (this.isRunning(accountId, conversationId)) throw new AppError('Wait for the current task to finish or take over first', 409);
    if (this.listTasks().some(task => task.accountId === accountId && (!conversationId || task.conversationId === conversationId) && task.status === 'waiting_user')) throw new AppError('USER_DECISION_REQUIRED: 请在客户端选择如何处理等待中的任务', 409);
    const uncertain = this.listTasks().filter(task => task.accountId === accountId && (!conversationId || task.conversationId === conversationId) && task.status === 'uncertain' && !task.resolvedAt);
    if (uncertain.length && !acknowledged) throw new AppError('REVIEW_REQUIRED: A message may already have been sent. Inspect the conversation and acknowledge before resuming; it will not be resent.', 409);
    this.db.transaction(() => {
      for (const task of uncertain) this.update(task.id, { resolvedAt: Date.now(), attention: undefined }, false);
      for (const task of this.listTasks().filter(task => task.accountId === accountId && (!conversationId || task.conversationId === conversationId) && task.status === 'blocked' && !task.sendIntentAt)) {
        this.update(task.id, { status: 'pending', phase: 'queued', error: undefined }, false);
      }
      for (const queue of this.db.records<AccountQueue>('account_queues').filter(queue => queue.accountId === accountId && (!conversationId || queue.conversationId === conversationId))) this.setQueue(accountId, false, undefined, false, queue.conversationId);
      this.setQueue(accountId, false, undefined, false, conversationId);
    });
    this.changed(); this.schedule();
    return this.db.read<AccountQueue>('account_queues', queueKey(accountId, conversationId))!;
  }
  findRequest(accountId: string, key: string | undefined, hash: string): AgentTask | undefined {
    if (!key) return;
    text(key, 'Idempotency key', 120);
    const existing = this.db.read<RequestRecord>('request_keys', `${accountId}:${key}`);
    if (!existing) return;
    if (existing.hash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT: key was already used for different input', 409);
    const task = this.db.read<AgentTask>('tasks', existing.taskId);
    if (!task) throw new AppError(`REQUEST_ALREADY_HANDLED: task ${existing.taskId} history was cleared; it will not be submitted again`, 409);
    return task;
  }
  createTask(accountId: string, value: unknown, options: TaskOptions = {}): AgentTask {
    if (this.stopped) throw new AppError('Runtime is stopping', 503);
    const input = parseTask(value);
    const hash = options.requestHash ?? requestHash({ input, ...options, idempotencyKey: undefined });
    const duplicate = this.findRequest(accountId, options.idempotencyKey, hash);
    if (duplicate) return duplicate;
    const tasks = this.listTasks();
    if (tasks.filter(task => ['pending', 'running', 'blocked', 'waiting_user'].includes(task.status)).length >= 30) throw new AppError('Task queue is full', 429);
    const now = Date.now();
    const task: AgentTask = { id: randomUUID(), accountId, input, ...options, requestHash: hash, status: 'pending', phase: 'queued',
      replyTimeoutMs: duration(options.replyTimeoutMs, 600000), prepareTimeoutMs: duration(options.prepareTimeoutMs, 60000), idleTimeoutMs: duration(options.idleTimeoutMs, 600000),
      createdAt: now, updatedAt: now };
    this.db.transaction(() => {
      task.seq = (this.db.get<number>('taskSequence') ?? 0) + 1;
      this.db.set('taskSequence', task.seq);
      this.persist(task);
      const history = this.listTasks();
      for (const old of [...history].reverse()) {
        if (this.listTasks().length <= 200) break;
        if (['done', 'failed', 'cancelled'].includes(old.status) && ![...this.running.values()].some(slot => slot.id === old.id)) this.db.remove('tasks', old.id);
      }
    });
    this.changed(); this.schedule();
    return task;
  }
  private persist(task: AgentTask): void {
    this.db.write('tasks', task.id, task);
    if (task.idempotencyKey) this.db.write('request_keys', `${task.accountId}:${task.idempotencyKey}`, { accountId: task.accountId, hash: task.requestHash, taskId: task.id });
  }
  private update(id: string, patch: Partial<AgentTask>, notify = true): AgentTask {
    const previous = this.get(id);
    const task = { ...previous, ...patch, updatedAt: Math.max(Date.now(), previous.updatedAt + 1) };
    this.persist(task);
    for (const waiter of [...this.waiters]) waiter(id);
    if (notify) this.changed();
    return task;
  }
  cancel(id: string): AgentTask {
    const task = this.get(id);
    if (!['pending', 'running', 'blocked', 'waiting_user'].includes(task.status)) return task;
    const active = this.running.get(queueKey(task.accountId, task.conversationId));
    if (active?.id === id) active.controller.abort(new Error('Task cancelled'));
    if (task.sendIntentAt) {
      this.setQueue(task.accountId, true, '消息可能已发送，请核对后继续', true, task.conversationId);
      return this.update(id, { status: 'uncertain', attention: taskAttention('Cancelled after send', true), error: 'Local waiting cancelled; the page may still be generating. This message will not be resent.' });
    }
    return this.update(id, { status: 'cancelled', attention: undefined, error: 'Cancelled before send intent' });
  }
  hasActiveTasks(accountId: string): boolean {
    return this.isRunning(accountId) || this.listTasks().some(task => task.accountId === accountId && (['pending', 'running', 'blocked', 'waiting_user'].includes(task.status) || (task.status === 'uncertain' && !task.resolvedAt)));
  }
    clearFinishedHistory(): number {
      const activeIds = new Set([...this.running.values()].map(slot => slot.id));
      const removable = this.listTasks().filter(task => canClearTask(task) && !activeIds.has(task.id));
      this.db.transaction(() => { for (const task of removable) this.db.remove('tasks', task.id); });
      this.changed();
      return removable.length;
    }
    removeHistory(accountId?: string): void {
    if (this.runningAccounts().some(id => !accountId || id === accountId) || this.listTasks().some(task => (!accountId || task.accountId === accountId) && (['pending', 'running', 'blocked', 'waiting_user'].includes(task.status) || (task.status === 'uncertain' && !task.resolvedAt)))) {
      throw new AppError('Resolve or cancel active tasks before clearing history', 409);
    }
    for (const task of this.listTasks()) if (!accountId || task.accountId === accountId) this.db.remove('tasks', task.id);
    if (accountId) {
      this.db.removeWhere('account_queues', 'accountId', accountId);
      this.db.removeWhere('request_keys', 'accountId', accountId);
    }
    this.changed();
  }
  private schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  private pump(): void {
    while (!this.stopped && this.running.size < this.concurrency) {
      const tasks = this.listTasks();
      const pending = [...tasks].reverse().filter(task => task.status === 'pending' && !this.running.has(queueKey(task.accountId, task.conversationId)) && !this.db.read<AccountQueue>('account_queues', task.accountId)?.paused && !this.db.read<AccountQueue>('account_queues', queueKey(task.accountId, task.conversationId))?.paused &&
        !tasks.some(other => queueKey(other.accountId, other.conversationId) === queueKey(task.accountId, task.conversationId) && (other.status === 'waiting_user' || other.status === 'uncertain' && !other.resolvedAt)));
      const accounts = [...new Set(pending.map(task => task.accountId))];
      if (!accounts.length) return;
      const nextAccount = accounts.sort((a, b) => (this.dispatched.get(a) ?? 0) - (this.dispatched.get(b) ?? 0))[0];
      const task = pending.find(item => item.accountId === nextAccount)!;
      const controller = new AbortController();
      const slot = { id: task.id, controller, promise: Promise.resolve() };
      const key = queueKey(task.accountId, task.conversationId);
      this.running.set(key, slot);
      this.db.write('account_queues', key, { ...(this.db.read<AccountQueue>('account_queues', key) ?? { accountId: task.accountId, conversationId: task.conversationId, paused: false }), control: 'agent' });
      this.dispatched.set(task.accountId, ++this.dispatchSequence);
      slot.promise = this.run(task, controller);
    }
  }
  private async run(task: AgentTask, controller: AbortController): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    const stage = (phase: TaskPhase, timeoutMs?: number) => {
      controller.signal.throwIfAborted();
      if (timeoutMs !== undefined) { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error(`${phase} timed out`)), timeoutMs); }
      this.update(task.id, { phase });
    };
    const context: ExecutionContext = {
      task: () => this.get(task.id), stage,
      intent: () => { controller.signal.throwIfAborted(); this.update(task.id, { phase: 'send_intent', sendIntentAt: Date.now() }); },
      submitted: messageId => { controller.signal.throwIfAborted(); this.update(task.id, { phase: 'submitted', submittedAt: Date.now(), submittedMessageId: messageId }); },
      progress: (response, url) => {
        controller.signal.throwIfAborted();
        const progress = { response: response.slice(0, 64000), url };
        const current = this.get(task.id).progress;
        if (current?.response !== progress.response || current?.url !== url) this.update(task.id, { progress });
      }
    };
    this.update(task.id, { status: 'running', error: undefined });
    try {
      stage('preparing', task.prepareTimeoutMs);
      const result = await this.execute(task.accountId, task.input, controller.signal, context);
      controller.signal.throwIfAborted();
      if (this.get(task.id).status === 'running') this.update(task.id, { status: 'done', phase: 'completed', result });
    } catch (error) {
      const current = this.get(task.id);
      if (current.status === 'running') {
        const uncertain = !!current.sendIntentAt;
        const message = error instanceof Error ? error.message : String(error);
        this.update(task.id, { status: uncertain ? 'uncertain' : 'waiting_user', attention: taskAttention(message, uncertain), error: message });
        this.setQueue(task.accountId, true, uncertain ? '发送或回复结果不确定，请核对会话' : '任务需要处理，请检查错误后继续', true, task.conversationId);
      }
    } finally {
      clearTimeout(timer!);
      this.running.delete(queueKey(task.accountId, task.conversationId));
      this.changed(); this.schedule();
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const waiter of [...this.waiters]) waiter();
    for (const task of this.listTasks()) if (['pending', 'running'].includes(task.status)) this.setQueue(task.accountId, true, '应用关闭，队列已暂停', false, task.conversationId);
    for (const active of this.running.values()) active.controller.abort(new Error('Application is stopping'));
    await Promise.all([...this.running.values()].map(slot => slot.promise));
  }
}
