export interface Account { id: string; name: string; partition: string; createdAt: number }
export interface SessionState { accountId: string; url: string; updatedAt: number }
export type TaskInput =
  | { type: 'navigate'; url: string }
  | { type: 'snapshot' }
  | { type: 'fill'; selector: string; text: string }
  | { type: 'click'; selector: string }
  | { type: 'prompt'; prompt: string; submit: boolean };
export interface AgentTask {
  id: string; accountId: string; input: TaskInput;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  createdAt: number; updatedAt: number; result?: unknown; error?: string;
}
export interface PageState {
  url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string;
}
export interface WorkspaceState {
  accounts: Account[]; activeAccountId: string | null; page: PageState | null; tasks: AgentTask[];
  api: { enabled: boolean; endpoint: string | null; discoveryFile: string; error?: string };
}
export interface WorkspaceBridge {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onChange(listener: () => void): () => void;
}
