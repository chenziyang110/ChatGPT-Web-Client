import type { AgentTask } from './types';

export function canClearTask(task: AgentTask): boolean {
  return ['done', 'failed', 'cancelled'].includes(task.status) || (task.status === 'uncertain' && !!task.resolvedAt);
}
