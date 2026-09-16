import type { AgentTask, TaskChoice } from '../../shared/types';
import { taskAttentionCopy } from '../../shared/taskAttentionCopy';
export function TaskDecision({ task, busy, choose }: { task: AgentTask; busy: boolean; choose: (choice: TaskChoice) => void }) {
  const attention = taskAttentionCopy(task);
  if (!attention) return <p>任务状态已更新。</p>;
  return <div className="task-decision"><h3>{attention.title}</h3><p>{attention.detail}</p>
    <p className="hint">{task.sendIntentAt ? '网页可能仍在生成回复。核对后结束本地任务，不会重新发送。' : '仅需手动处理这个任务的目标页面时，才需要接管。其他会话可以继续使用。'}</p>
    <div className="decision-actions">{attention.choices.map(choice => <button key={choice.id} disabled={busy} className={choice.id === 'takeover' ? 'primary' : 'secondary'} onClick={() => choose(choice.id)}>{choice.label}</button>)}</div>
    {task.error && <details><summary>查看诊断详情</summary><pre>{task.error}</pre></details>}
  </div>;
}
