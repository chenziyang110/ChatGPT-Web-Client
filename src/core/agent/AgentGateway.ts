import { randomUUID } from 'node:crypto';
import { Database } from '../storage/Database';
import { AppError, chatUrl, record, text } from '../validation';
import type { AgentTask, TaskInput } from '../../shared/types';
export type { AgentTask } from '../../shared/types';
export type TaskExecutor = (accountId: string, input: TaskInput, signal: AbortSignal) => Promise<unknown>;

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

export class AgentGateway {
  private controller?: AbortController;
  private running?: string;
  private stopped = false;
  private pumping?: Promise<void>;
  constructor(private readonly db: Database, private readonly execute: TaskExecutor, private readonly changed: () => void) {
    // Never replay a potentially submitted prompt or click after a crash.
    const recovered = this.listTasks().map(task => ['pending', 'running'].includes(task.status)
      ? { ...task, status: 'failed' as const, error: 'Application stopped before completion; task was not replayed', updatedAt: Date.now() } : task);
    this.db.set('tasks', recovered);
  }
  listTasks(): AgentTask[] { return this.db.get<AgentTask[]>('tasks') ?? []; }
  get(id: string): AgentTask {
    const task = this.listTasks().find(task => task.id === id);
    if (!task) throw new AppError('Task not found', 404);
    return task;
  }
  createTask(accountId: string, value: unknown): AgentTask {
    if (this.stopped) throw new AppError('Runtime is stopping', 503);
    const input = parseTask(value);
    const tasks = this.listTasks();
    if (tasks.filter(task => ['pending', 'running'].includes(task.status)).length >= 30) throw new AppError('Task queue is full', 429);
    const now = Date.now();
    const task: AgentTask = { id: randomUUID(), accountId, input, status: 'pending', createdAt: now, updatedAt: now };
    const history = [task, ...tasks];
    while (history.length > 200) {
      const index = history.findLastIndex(item => item.id !== this.running && !['pending', 'running'].includes(item.status));
      if (index < 0) break;
      history.splice(index, 1);
    }
    this.db.set('tasks', history);
    this.changed();
    queueMicrotask(() => { if (!this.pumping) this.pumping = this.pump().finally(() => { this.pumping = undefined; }); });
    return task;
  }
  cancel(id: string): AgentTask {
    const task = this.get(id);
    if (!['pending', 'running'].includes(task.status)) return task;
    if (this.running === id) this.controller?.abort();
    return this.update(id, { status: 'cancelled', error: 'Cancelled; actions already performed cannot be undone' });
  }
  hasActiveTasks(accountId: string): boolean {
    return this.listTasks().some(task => task.accountId === accountId && (task.id === this.running || ['pending', 'running'].includes(task.status)));
  }
  removeHistory(accountId?: string): void {
    if (this.listTasks().some(task => (!accountId || task.accountId === accountId) && (task.id === this.running || ['pending', 'running'].includes(task.status)))) {
      throw new AppError('Cancel active tasks before clearing history', 409);
    }
    this.db.set('tasks', accountId ? this.listTasks().filter(task => task.accountId !== accountId) : []);
    this.changed();
  }
  private update(id: string, patch: Partial<AgentTask>): AgentTask {
    const task = { ...this.get(id), ...patch, updatedAt: Date.now() };
    this.db.set('tasks', this.listTasks().map(item => item.id === id ? task : item));
    this.changed();
    return task;
  }
  private async pump(): Promise<void> {
    while (!this.stopped) {
      const task = this.listTasks().findLast(task => task.status === 'pending');
      if (!task) return;
      this.running = task.id;
      const controller = new AbortController();
      this.controller = controller;
      this.update(task.id, { status: 'running' });
      const timer = setTimeout(() => controller.abort(new Error('Task timed out after 120 seconds')), 120000);
      try {
        const result = await this.execute(task.accountId, task.input, controller.signal);
        controller.signal.throwIfAborted();
        if (this.get(task.id).status === 'running') this.update(task.id, { status: 'done', result });
      } catch (error) {
        if (this.get(task.id).status === 'running') this.update(task.id, { status: 'failed', error: error instanceof Error ? error.message : 'Task failed' });
      } finally {
        clearTimeout(timer);
        this.controller = undefined;
        this.running = undefined;
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const task of this.listTasks()) if (['pending', 'running'].includes(task.status)) this.cancel(task.id);
    await this.pumping;
  }
}
