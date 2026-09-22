import { AccountManager } from './account/AccountManager';
import { AgentGateway, parseTask, requestHash } from './agent/AgentGateway';
import { ConversationManager, conversationUrl } from './conversation/ConversationManager';
import type { ConversationNotifications } from './notifications/ConversationNotifications';
import type { ShortcutSettings } from './settings/ShortcutSettings';
import { defaultShortcuts } from '../shared/shortcuts';
import { buildAgentPrompt } from './agent/AgentPrompt';
import { AppError, HOME_URL, chatUrl, identifier, text } from './validation';
import type { AgentTask, BrowserDiagnostics, BrowserPage, Conversation, PageState, TaskChoice, TaskResponse, WorkspaceState } from '../shared/types';
export interface BrowserAdapter {
  activate(id: string, pageId?: string): void;
  pages?(): BrowserPage[];
  closePage?(accountId: string, pageId: string): void;
  remove(id: string): Promise<void>;
  navigate(id: string, url: unknown): Promise<void>;
  control(id: string, action: string): void;
  page(): PageState | null;
  url?(accountId: string): string | undefined;
  inspect?(accountId: string, pageId?: string): Promise<BrowserDiagnostics>;
  response?(task: AgentTask, url?: string): Promise<TaskResponse>;
  queueTarget?(accountId: string, pageId: string): Promise<Conversation>;
  openConversation?(accountId: string, conversationId: string): void;
}
export class Workspace {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly accounts: AccountManager, readonly tasks: AgentGateway,
    private readonly browser: BrowserAdapter, private readonly changed: () => void,
    private readonly apiState: () => WorkspaceState['api'], readonly conversations: ConversationManager,
    private readonly notifications?: ConversationNotifications, private readonly shortcuts?: ShortcutSettings,
    private readonly agentCliPath?: string) {}
  state(): WorkspaceState {
    for (const account of this.accounts.list()) {
      const url = this.browser.url?.(account.id);
      if (url && !this.tasks.isRunning(account.id)) {
        try { this.conversations.register(account.id, url); } catch { /* Only supported personal conversation URLs are indexed. */ }
      }
    }
    return { notifications: this.notifications?.list() ?? [], shortcuts: this.shortcuts?.get() ?? defaultShortcuts(process.platform),
      accounts: this.accounts.list(), activeAccountId: this.accounts.activeId(), page: this.browser.page(),
      tasks: this.tasks.listTasks(), conversations: this.conversations.list(), queues: this.tasks.queues(), pages: this.browser.pages?.() ?? [], lockedAccountIds: this.tasks.lockedAccounts(), api: this.apiState() };
  }
  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'browser.inspect') {
      const account = this.accounts.resolve(params.accountId);
      if (!this.browser.inspect) throw new AppError('Browser diagnostics unavailable', 503);
      return this.browser.inspect(account.id, params.pageId === undefined ? undefined : identifier(params.pageId));
    }
    if (method === 'agent.prompt') return Promise.resolve(this.agentPrompt(params));
    if (method === 'workspace.status') return Promise.resolve(this.state());
    if (method === 'accounts.list') return Promise.resolve(this.accounts.list());
    if (method === 'tasks.list') return Promise.resolve(this.tasks.listTasks());
    if (method === 'tasks.get') return Promise.resolve(this.tasks.get(identifier(params.id)));
    if (method === 'tasks.wait') return this.tasks.wait(identifier(params.id), params.timeoutMs as number | undefined, params.afterUpdatedAt as number | undefined, params.updates as boolean | undefined);
    if (method === 'tasks.response') {
      const task = this.tasks.get(identifier(params.id));
      if (task.status === 'done') return Promise.resolve({ taskId: task.id, state: 'done', result: task.result });
      if (task.status !== 'uncertain' || !task.sendIntentAt || task.input.type !== 'prompt' || !task.input.submit || task.resolvedAt) return Promise.resolve({ taskId: task.id, state: 'unavailable', reason: '此任务不需要恢复读取' });
      if (!this.browser.response) throw new AppError('Reply reader unavailable', 503);
      return this.browser.response(task, params.url === undefined ? undefined : conversationUrl(params.url).url);
    }
    if (method === 'conversations.list') return Promise.resolve(this.conversations.list(params.accountId ? this.accounts.resolve(params.accountId).id : undefined));
    if (method === 'queues.status') return Promise.resolve(this.tasks.queues());
    if (method === 'notifications.list') return Promise.resolve(this.notifications?.list(params.accountId ? this.accounts.resolve(params.accountId).id : undefined) ?? []);
    if (method === 'settings.shortcuts.get') return Promise.resolve(this.shortcuts?.get());
    const next = this.queue.then(() => this.mutate(method, params));
    this.queue = next.catch(() => undefined);
    return next;
  }
  private agentPrompt(params: Record<string, unknown>) {
    const account = this.accounts.resolve(params.accountId);
    if (params.current !== undefined && typeof params.current !== 'boolean') throw new AppError('current must be a boolean');
    if ([params.conversation !== undefined, params.url !== undefined, params.current === true, params.pageId !== undefined].filter(Boolean).length > 1) throw new AppError('请选择一个会话目标');
    let target: { accountId: string; conversation?: string; url?: string } = { accountId: account.id };
    let name = '新咨询会话';
    if (params.conversation !== undefined) {
      const conversation = this.conversations.get(account.id, params.conversation);
      if (conversation.binding === 'uncertain') throw new AppError('该会话的首次发送结果待核对，请先处理');
      target = { ...target, conversation: conversation.id }; name = conversation.title;
    } else if (params.url !== undefined || params.current || params.pageId !== undefined) {
      const page = params.pageId === undefined ? undefined : this.browser.pages?.().find(item => item.id === identifier(params.pageId) && item.accountId === account.id);
      if (params.pageId !== undefined && !page) throw new AppError('目标标签页已关闭，请重新选择', 409);
      const current = page ? page.url : this.browser.url?.(account.id) ?? (this.accounts.activeId() === account.id ? this.browser.page()?.url : undefined);
      const value = params.url ?? current;
      if (!value || value === 'about:blank') throw new AppError('目标页面正在加载，请稍后再复制', 409);
      if (params.url === undefined && value === HOME_URL) {
        name = '新会话';
      } else {
        const url = conversationUrl(value).url;
        target = { ...target, url }; name = this.conversations.list(account.id).find(item => item.url === url)?.title ?? url;
      }
    }
    const api = this.apiState();
    return buildAgentPrompt(account, target, name, { discoveryFile: api.discoveryFile, apiEnabled: api.enabled, endpoint: api.endpoint, cliPath: this.agentCliPath });
  }
  // User choices are invoked only by trusted desktop IPC, never by external agents.
  decideTask(params: Record<string, unknown>): Promise<unknown> {
    const id = identifier(params.id), token = identifier(params.token);
    if (!['retry', 'takeover', 'cancel', 'acknowledge'].includes(String(params.choice))) throw new AppError('Invalid choice');
    const next = this.queue.then(() => this.tasks.decide(id, token, params.choice as TaskChoice));
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async mutate(method: string, params: Record<string, unknown>): Promise<unknown> {
    let result: unknown;
    switch (method) {
      case 'settings.shortcuts.save': result = this.shortcuts?.save(params.shortcuts); break;
      case 'settings.shortcuts.reset': result = this.shortcuts?.reset(); break;
      case 'notifications.read': result = this.notifications?.read(this.accounts.resolve(params.accountId).id, params.id, params.token); break;
      case 'notifications.open': {
        const account = this.accounts.resolve(params.accountId);
        if (!this.notifications) throw new AppError('Notifications unavailable');
        const notice = this.notifications.get(account.id, params.id);
        this.accounts.activate(account.id);
        await this.browser.navigate(account.id, notice.url);
        if (this.browser.url?.(account.id) !== notice.url) throw new AppError('会话页面未能打开，通知已保留', 409);
        result = this.notifications.read(account.id, notice.id, params.token); break;
      }
      case 'browser.select': {
        const account = this.accounts.resolve(params.accountId);
        this.browser.activate(account.id, identifier(params.pageId)); this.accounts.activate(account.id); result = this.browser.page(); break;
      }
      case 'browser.closePage': {
        const account = this.accounts.resolve(params.accountId);
        this.browser.closePage?.(account.id, identifier(params.pageId)); result = { closed: true }; break;
      }
      case 'accounts.create': {
        const account = this.accounts.create(params.name);
        this.accounts.activate(account.id); this.browser.activate(account.id); result = account; break;
      }
      case 'accounts.rename': result = this.accounts.rename(this.accounts.resolve(params.id).id, params.name); break;
      case 'accounts.alias': result = this.accounts.setAlias(this.accounts.resolve(params.id).id, params.alias); break;
      case 'accounts.switch': {
        const account = this.accounts.activate(this.accounts.resolve(params.id).id); this.browser.activate(account.id); result = account; break;
      }
      case 'accounts.remove': {
        const account = this.accounts.resolve(params.id);
        if (params.confirmName !== account.name) throw new AppError('Account name confirmation does not match');
        if (this.tasks.isRunning(account.id)) throw new AppError('此账号正在执行任务，请先点击“接管”，等待自动操作停止后再删除', 409);
        const accountTasks = this.tasks.listTasks().filter(task => task.accountId === account.id);
        if (accountTasks.some(task => task.status === 'uncertain' && !task.resolvedAt || task.sendIntentAt && ['pending', 'running', 'blocked', 'waiting_user'].includes(task.status))) {
          throw new AppError('此账号有可能已经发送的消息，请先在任务中心核对并结束对应任务，再删除账号', 409);
        }
        // The exact-name deletion confirmation includes discarding unsent work.
        // Validate every blocker first so a refused deletion never cancels tasks.
        for (const task of accountTasks) if (['pending', 'blocked', 'waiting_user'].includes(task.status)) this.tasks.cancel(task.id);
        await this.browser.remove(account.id);
        this.tasks.removeHistory(account.id);
        this.conversations.removeAccount(account.id);
        this.notifications?.removeAccount(account.id);
        this.accounts.remove(account.id);
        const next = this.accounts.activeId();
        if (next) this.browser.activate(next);
        result = { removed: true }; break;
      }
      case 'browser.navigate': {
        const account = this.accounts.resolve(params.accountId);
        const url = chatUrl(params.url);
        let conversationId: string | undefined;
        try { conversationId = this.conversations.register(account.id, url).id; } catch { /* Home opens independently. */ }
        result = this.tasks.createTask(account.id, { type: 'navigate', url }, { targetUrl: url, conversationId }); break;
      }
      case 'browser.control': {
        const account = this.accounts.resolve(params.accountId);
        if (typeof params.action !== 'string') throw new AppError('Missing browser action');
        this.browser.control(account.id, params.action); result = { ok: true }; break;
      }
      case 'conversations.register': result = this.conversations.register(this.accounts.resolve(params.accountId).id, params.url, params.alias); break;
      case 'conversations.create': result = this.conversations.create(this.accounts.resolve(params.accountId).id, params.alias); break;
      case 'conversations.get': result = this.conversations.get(this.accounts.resolve(params.accountId).id, params.conversation); break;
      case 'conversations.forPage': {
        if (!this.browser.queueTarget) throw new AppError('会话队列不可用', 503);
        result = await this.browser.queueTarget(this.accounts.resolve(params.accountId).id, identifier(params.pageId)); break;
      }
      case 'conversations.open': {
        const account = this.accounts.resolve(params.accountId);
        const conversation = this.conversations.get(account.id, params.conversation);
        if (!this.browser.openConversation) throw new AppError('会话页面不可用', 503);
        this.browser.openConversation(account.id, conversation.id); this.accounts.activate(account.id); result = this.browser.page(); break;
      }
      case 'queues.pause': { const account = this.accounts.resolve(params.accountId); result = this.tasks.pause(account.id, params.conversation === undefined ? undefined : this.conversations.get(account.id, params.conversation).id); break; }
      case 'queues.resume': {
        if (params.acknowledged !== undefined && typeof params.acknowledged !== 'boolean') throw new AppError('acknowledged must be a boolean');
        const account = this.accounts.resolve(params.accountId);
        result = this.tasks.resume(account.id, params.acknowledged === true, params.conversation === undefined ? undefined : this.conversations.get(account.id, params.conversation).id); break;
      }
      case 'queues.takeover': { const account = this.accounts.resolve(params.accountId); result = await this.tasks.takeover(account.id, params.conversation === undefined ? undefined : this.conversations.get(account.id, params.conversation).id); break; }
      case 'tasks.create': {
        const accountId = this.accounts.resolve(params.accountId).id;
        const input = parseTask(params.input);
        if (params.new !== undefined && typeof params.new !== 'boolean') throw new AppError('new must be a boolean');
        if (params.current !== undefined && typeof params.current !== 'boolean') throw new AppError('current must be a boolean');
        if ([params.conversation !== undefined, params.url !== undefined, params.new === true, params.current === true].filter(Boolean).length > 1) throw new AppError('Choose only one conversation, URL, current or new target');
        const key = params.idempotencyKey === undefined ? undefined : text(params.idempotencyKey, 'Idempotency key', 120);
        const hash = requestHash({ accountId, input, conversation: params.conversation ?? null, url: params.url ?? null, new: params.new === true,
          current: params.current === true, alias: params.alias ?? null, replyTimeoutMs: params.replyTimeoutMs ?? null,
          ...(params.idleTimeoutMs !== undefined ? { idleTimeoutMs: params.idleTimeoutMs } : {}),
          ...(params.background !== undefined ? { background: params.background } : {}) });
        const duplicate = this.tasks.findRequest(accountId, key, hash);
        if (duplicate) { result = duplicate; break; }
        let conversationId: string | undefined;
        let createdConversation: string | undefined;
        if (params.replyTimeoutMs !== undefined && (typeof params.replyTimeoutMs !== 'number' || !Number.isInteger(params.replyTimeoutMs) || params.replyTimeoutMs < 1000 || params.replyTimeoutMs > 3600000)) throw new AppError('replyTimeoutMs must be 1000–3600000');
        if (params.idleTimeoutMs !== undefined && (typeof params.idleTimeoutMs !== 'number' || !Number.isInteger(params.idleTimeoutMs) || params.idleTimeoutMs < 1000 || params.idleTimeoutMs > 3600000)) throw new AppError('idleTimeoutMs must be 1000–3600000');
        if (params.background !== undefined && typeof params.background !== 'boolean') throw new AppError('background must be a boolean');
        const currentUrl = this.browser.url?.(accountId) ?? (this.accounts.activeId() === accountId ? this.browser.page()?.url : undefined);
        let targetUrl = currentUrl;
        if (params.conversation !== undefined) conversationId = this.conversations.get(accountId, params.conversation).id;
        else if (params.url !== undefined) conversationId = this.conversations.register(accountId, params.url).id;
        else if (params.new === true) {
          if (input.type !== 'prompt' || !input.submit) throw new AppError('A new conversation requires an explicitly submitted prompt');
          conversationId = createdConversation = this.conversations.create(accountId, params.alias).id;
        } else if (input.type !== 'navigate' && this.browser.pages?.().find(page => page.accountId === accountId && page.selected)?.conversationId) {
          conversationId = this.browser.pages!().find(page => page.accountId === accountId && page.selected)!.conversationId;
        } else if (input.type === 'prompt') {
          if (!currentUrl) throw new AppError('Select a conversation or explicitly create a new one');
          conversationId = this.conversations.register(accountId, currentUrl).id;
        }
        if (input.type === 'navigate') {
          if (conversationId) throw new AppError('Navigation tasks use their URL as the target');
          targetUrl = input.url;
        }
        if (!conversationId && targetUrl) {
          try { conversationId = this.conversations.register(accountId, targetUrl).id; } catch { /* Non-conversation page. */ }
        }
        if (conversationId) {
          targetUrl = this.conversations.get(accountId, conversationId).url;
          if (!targetUrl && this.tasks.listTasks().some(task => task.conversationId === conversationId && task.sendIntentAt && task.status === 'uncertain')) throw new AppError('NEW_CHAT_UNRESOLVED: register the actual conversation URL before adding more tasks', 409);
        }
        if (!conversationId && !targetUrl) throw new AppError('No page available for this account');
        try { result = this.tasks.createTask(accountId, input, { conversationId, targetUrl, idempotencyKey: key, requestHash: hash,
          replyTimeoutMs: params.replyTimeoutMs as number | undefined, idleTimeoutMs: params.idleTimeoutMs as number | undefined, background: params.background as boolean | undefined }); }
        catch (error) { if (createdConversation) this.conversations.remove(createdConversation); throw error; }
        break;
      }
      case 'tasks.cancel': result = this.tasks.cancel(identifier(params.id)); break;
      case 'tasks.edit': {
        const account = this.accounts.resolve(params.accountId);
        const conversation = this.conversations.get(account.id, params.conversation);
        result = this.tasks.edit(account.id, conversation.id, identifier(params.id), params.expectedUpdatedAt, params.prompt); break;
      }
      case 'tasks.removeQueued': {
        const account = this.accounts.resolve(params.accountId);
        const conversation = this.conversations.get(account.id, params.conversation);
        result = this.tasks.removeQueued(account.id, conversation.id, identifier(params.id), params.expectedUpdatedAt); break;
      }
      case 'queues.reorder': {
        const account = this.accounts.resolve(params.accountId);
        const conversation = this.conversations.get(account.id, params.conversation);
        result = this.tasks.reorder(account.id, conversation.id, params.items); break;
      }
      case 'tasks.clear': result = { cleared: true, count: this.tasks.clearFinishedHistory() }; break;
      default: throw new AppError('Unknown method', 404);
    }
    this.changed();
    return result;
  }
  async settled(): Promise<void> { await this.queue; }
}
