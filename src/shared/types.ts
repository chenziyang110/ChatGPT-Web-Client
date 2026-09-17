export interface Account { id: string; name: string; alias?: string; partition: string; createdAt: number }
export interface Conversation {
  id: string; accountId: string; alias?: string; title: string; url?: string;
  remoteId?: string; binding: 'new' | 'bound' | 'uncertain'; createdAt: number; updatedAt: number;
}
export type TaskPhase = 'queued' | 'preparing' | 'waiting_idle' | 'preparing_prompt' | 'send_intent' | 'submitted' | 'generating' | 'completed';
export interface AccountQueue { accountId: string; conversationId?: string; runningTaskIds?: string[]; paused: boolean; reason?: string; runningTaskId?: string; control?: 'agent' | 'human' }
export type TaskChoice = 'retry' | 'takeover' | 'cancel' | 'acknowledge';
export interface TaskAttention {
  id: string; kind: 'verification' | 'login' | 'draft' | 'page' | 'manual_takeover' | 'review_send' | 'other';
  title: string; detail: string; choices: Array<{ id: TaskChoice; label: string }>;
}
export interface BrowserPreview { accountId: string; pageId?: string; image: string; capturedAt: number }
export interface BrowserPage { id: string; accountId: string; conversationId?: string; url: string; title: string; selected: boolean; locked: boolean; sleeping?: boolean; taskId?: string }
export interface SessionState { accountId: string; url: string; updatedAt: number }
export type TaskInput =
  | { type: 'navigate'; url: string }
  | { type: 'snapshot' }
  | { type: 'fill'; selector: string; text: string }
  | { type: 'click'; selector: string }
  | { type: 'prompt'; prompt: string; submit: boolean };
export interface AgentTask {
  id: string; accountId: string; input: TaskInput;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'blocked' | 'waiting_user' | 'uncertain';
  attention?: TaskAttention;
  conversationId?: string; targetUrl?: string; phase?: TaskPhase; seq?: number;
  idempotencyKey?: string; requestHash?: string; sendIntentAt?: number; submittedAt?: number; resolvedAt?: number;
  submittedMessageId?: string;
  progress?: { response: string; url?: string };
  replyTimeoutMs?: number; prepareTimeoutMs?: number; idleTimeoutMs?: number;
  createdAt: number; updatedAt: number; result?: unknown; error?: string;
}
export interface TaskResponse {
  taskId: string; state: 'reading' | 'done' | 'unavailable'; reason?: string;
  result?: { response: string; url?: string; conversationId?: string };
}
export interface PageState {
  id?: string; conversationId?: string;
  url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string;
}
export interface ConversationNotice {
  id: string; accountId: string; url: string; title: string; running: boolean;
  unread: boolean; token?: string; completedAt?: number;
}
export type BrowserReadiness = 'ready' | 'loading' | 'verification_required' | 'login_required' | 'not_open' | 'unavailable';
export interface BrowserDiagnostics {
  accountId: string; url: string; title: string; readiness: BrowserReadiness;
  editor: boolean; draftLength: number; busy: boolean; documentReady?: string; suggestion: string;
}
export type ShortcutAction = 'focus' | 'takeover' | 'previous' | 'next' | `account${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
export interface ShortcutBinding { code: string; control: boolean; meta: boolean; alt: boolean; shift: boolean }
export type ShortcutConfig = Record<ShortcutAction, ShortcutBinding | null>;
export interface WorkspaceState {
  notifications: ConversationNotice[]; shortcuts: ShortcutConfig;
  accounts: Account[]; activeAccountId: string | null; page: PageState | null; tasks: AgentTask[];
  conversations: Conversation[]; queues: AccountQueue[]; lockedAccountIds: string[]; pages: BrowserPage[];
  api: { enabled: boolean; endpoint: string | null; discoveryFile: string; error?: string };
}
export interface WorkspaceBridge {
  platform: string;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onChange(listener: () => void): () => void;
  onShortcut(listener: (shortcut: WorkspaceShortcut) => void): () => void;
}
export type WorkspaceShortcut = { type: 'focus' } | { type: 'takeover' } | { type: 'account'; index: number } | { type: 'cycle'; direction: -1 | 1 };
export interface WindowState { maximized: boolean; fullscreen: boolean; focused: boolean }
export interface BrowserBounds { x: number; y: number; width: number; height: number }
export interface AgentPromptTarget { accountId: string; conversation?: string; url?: string; current?: boolean; pageId?: string }
export interface AgentHandoff {
  scope: 'account' | 'conversation'; accountName: string; targetName: string; target: AgentPromptTarget;
  apiEnabled: boolean; helpUrl?: string; prompt: string;
  createRequest: { method: 'tasks.create'; params: Record<string, unknown> };
  commands?: { create: string[]; wait: string[]; followup: string[] };
}
