import type { AgentTask } from './types';

export const LONG_REPLY_TIMEOUT_MS = 60 * 60 * 1000;
export const taskOrder = (task: AgentTask): number => task.queueOrder ?? task.seq ?? task.createdAt;
export const orderedTasks = (tasks: AgentTask[]): AgentTask[] => [...tasks].sort((a, b) => taskOrder(a) - taskOrder(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
export const isQueueTask = (task: AgentTask): boolean => ['pending', 'running', 'waiting_user', 'blocked'].includes(task.status) || task.status === 'uncertain' && !task.resolvedAt;
