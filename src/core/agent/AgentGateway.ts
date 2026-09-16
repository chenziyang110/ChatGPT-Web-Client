export interface AgentTask {
  id: string;
  prompt: string;
  status: 'pending' | 'running' | 'done';
}

export class AgentGateway {
  private tasks: AgentTask[] = [];

  createTask(prompt: string) {
    const task: AgentTask = {
      id: crypto.randomUUID(),
      prompt,
      status: 'pending'
    };

    this.tasks.push(task);
    return task;
  }

  listTasks() {
    return this.tasks;
  }
}
