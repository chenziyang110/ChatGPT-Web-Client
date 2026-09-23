import { randomUUID } from 'node:crypto';
import { BrowserWindow, WebContentsView, session, dialog, shell, type WebContents } from 'electron';
import { AccountManager } from '../core/account/AccountManager';
import { SessionManager } from '../core/session/SessionManager';
import { AppError, HOME_URL, chatUrl, isAccountNavigation, isChatUrl } from '../core/validation';
import type { AgentTask, BrowserBounds, BrowserDiagnostics, BrowserPreview, BrowserPage, Conversation, PageState, TaskInput, TaskResponse } from '../shared/types';
import { bindShortcuts } from './shortcuts';
import { ChatGPTAdapter, pageOperationScript, pageOperationResult, replyPageUrl, type Page } from './adapters/ChatGPTAdapter';
import { ReplyReader } from './adapters/ReplyReader';
import { ConversationActivityObserver, type ActivitySnapshot, type ConversationNotifications } from '../core/notifications/ConversationNotifications';
import type { ShortcutSettings } from '../core/settings/ShortcutSettings';
import type { ExecutionContext } from '../core/agent/AgentGateway';
import type { ConversationManager } from '../core/conversation/ConversationManager';
import { allowChatGptClipboardWrite } from './permissions';

interface PageOwner {
  accountId: string;
  conversationId?: string;
  url: string;
  title: string;
  lastUrl?: string;
  idleSince: number;
  hasDraft: boolean;
  busy: boolean;
  hibernationReady: boolean;
  activityKey?: string;
}

const DEFAULT_PAGE_IDLE_MS = 60_000;
const DEFAULT_HIDDEN_PAGE_IDLE_MS = 15_000;
const MONITOR_INTERVAL_MS = 1_500;
const PREVIEW_TIMEOUT_MS = 5_000;

function pageIdleMs(): number {
  const value = Number(process.env.WORKSPACE_PAGE_IDLE_MS);
  return Number.isSafeInteger(value) && value >= 100 && value <= 60 * 60 * 1000 ? value : DEFAULT_PAGE_IDLE_MS;
}

function hiddenPageIdleMs(): number {
  const value = Number(process.env.WORKSPACE_HIDDEN_PAGE_IDLE_MS);
  return Number.isSafeInteger(value) && value >= 100 && value <= 60 * 60 * 1000 ? value : DEFAULT_HIDDEN_PAGE_IDLE_MS;
}

export class BrowserRuntime {
  private readonly views = new Map<string, WebContentsView>();
  private readonly errors = new Map<string, string>();
  private readonly popups = new Map<string, Set<BrowserWindow>>();
  private activeId: string | null = null;
  private locks: AgentTask[] = [];
  private readonly owners = new Map<string, PageOwner>();
  private readonly selected = new Map<string, string>();
  private readonly restoredTabAccounts = new Set<string>();
  private readonly taskPages = new Map<string, string>();
  private readonly replyReader = new ReplyReader();
  private visible = true;
  private closing = false;
  private readonly configured = new Set<string>();
  private bounds?: BrowserBounds;
  private readonly observer: ConversationActivityObserver;
  private readonly observing = new Set<string>();
  private readonly previews = new Map<string, Promise<BrowserPreview | null>>();
  private readonly previewAwaken = new Set<string>();
  private readonly previewStale = new Set<string>();
  private readonly previewFrames = new Map<string, { activityKey?: string; image: string }>();
  private readonly redirectingDuplicates = new Set<string>();
  private readonly monitor: ReturnType<typeof setInterval>;
  private readonly idlePageMs = pageIdleMs();
  private readonly hiddenIdlePageMs = hiddenPageIdleMs();
  private backgroundedAt?: number;
  constructor(private readonly window: BrowserWindow, private readonly accounts: AccountManager,
    private readonly sessions: SessionManager, private readonly changed: () => void, private readonly conversations: ConversationManager,
    private readonly shortcuts: ShortcutSettings, private readonly notifications: ConversationNotifications) {
    for (const account of accounts.list()) {
      const saved = sessions.restoreTabs(account.id);
      if (!saved) continue;
      this.restoredTabAccounts.add(account.id);
      for (const tab of saved.pages) {
        if (this.owners.has(tab.id)) continue;
        let conversationId: string | undefined;
        if (tab.conversationId) {
          try { this.conversations.get(account.id, tab.conversationId); conversationId = tab.conversationId; }
          catch { /* An old conversation record must not prevent restoring its tab. */ }
        }
        this.owners.set(tab.id, { accountId: account.id, conversationId, url: tab.url, title: tab.title,
          idleSince: Date.now(), hasDraft: false, busy: false, hibernationReady: false });
      }
      const selected = saved.selectedId && this.owners.get(saved.selectedId)?.accountId === account.id ? saved.selectedId :
        [...this.owners].find(([, owner]) => owner.accountId === account.id)?.[0];
      if (selected) this.selected.set(account.id, selected);
    }
    window.on('resize', () => this.layout());
    this.observer = new ConversationActivityObserver(notifications, true);
    this.monitor = setInterval(() => {
      for (const [id, view] of this.views) void this.observe(id, view).finally(() => this.hibernateIfIdle(id, view));
    }, MONITOR_INTERVAL_MS);
    const visibilityChanged = () => this.updateVisibility();
    window.on('hide', visibilityChanged).on('show', visibilityChanged)
      .on('minimize', visibilityChanged).on('restore', visibilityChanged).on('focus', visibilityChanged);
  }
  private title(id: string, url: string, fallback: string): string {
    return this.conversations.list(id).find(item => item.url === url)?.alias ?? fallback;
  }
  private saveTabs(accountId: string): void {
    if (this.closing) return;
    this.restoredTabAccounts.add(accountId);
    this.sessions.saveTabs(accountId, { selectedId: this.selected.get(accountId),
      pages: [...this.owners].filter(([, owner]) => owner.accountId === accountId).map(([id, owner]) => ({
        id, url: isChatUrl(owner.url) ? owner.url : HOME_URL, title: owner.title, conversationId: owner.conversationId
      })) });
  }
  private async observe(id: string, view: WebContentsView): Promise<void> {
    const contents = view.webContents;
    if (this.closing || this.observing.has(id) || contents.isDestroyed() || contents.isLoading()) return;
    const owner = this.owners.get(id); if (!owner) return;
    if (this.redirectingDuplicates.has(id)) return;
    const url = contents.getURL();
    if (owner.lastUrl && owner.lastUrl !== url) this.observer.disconnected(owner.accountId, owner.lastUrl);
    owner.lastUrl = url; owner.url = url;
    if (!isChatUrl(url)) { owner.hibernationReady = false; return; }
    this.observing.add(id);
    try {
      const snapshot = pageOperationResult<ActivitySnapshot>(await contents.executeJavaScript(pageOperationScript({ kind: 'activity' })));
      if (this.closing || this.views.get(id) !== view || contents.isDestroyed() || contents.getURL() !== url) return;
      snapshot.title = this.title(owner.accountId, snapshot.url, snapshot.title);
      const activityKey = JSON.stringify([snapshot.url, snapshot.busy, snapshot.hasDraft, snapshot.user?.id,
        snapshot.assistant?.id, snapshot.assistant?.text.length, snapshot.lastRole]);
      if (owner.activityKey !== activityKey) owner.idleSince = Date.now();
      Object.assign(owner, { url: snapshot.url, title: snapshot.title || owner.title, hasDraft: !!snapshot.hasDraft,
        busy: snapshot.busy, hibernationReady: snapshot.editor && !snapshot.error, activityKey });
      this.observer.observe(owner.accountId, snapshot);
      this.markViewed(id, snapshot.url);
    } catch {
      owner.hibernationReady = false;
      if (!this.closing && this.views.get(id) === view) this.observer.disconnected(owner.accountId, url);
    }
    finally { this.observing.delete(id); }
  }
  private configureSession(partition: string): void {
    if (this.configured.has(partition)) return;
    const isolated = session.fromPartition(partition);
    isolated.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
      allowChatGptClipboardWrite(permission, requestingOrigin, details.isMainFrame));
    isolated.setPermissionRequestHandler((_contents, permission, callback, details) => {
      const requestingUrl = 'requestingUrl' in details ? details.requestingUrl : '';
      const isMainFrame = 'isMainFrame' in details && details.isMainFrame;
      callback(allowChatGptClipboardWrite(permission, requestingUrl, isMainFrame));
    });
    isolated.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ title: 'Save ChatGPT download', defaultPath: item.getFilename() });
    });
    this.configured.add(partition);
  }
  private async external(url: string): Promise<void> {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || this.window.isDestroyed()) return;
      const answer = await dialog.showMessageBox(this.window, { type: 'question', title: 'Open external link?',
        message: `Open ${parsed.hostname} in your default browser?`, detail: url.slice(0, 2048),
        buttons: ['Cancel', 'Open browser'], defaultId: 0, cancelId: 0 });
      if (answer.response === 1) await shell.openExternal(parsed.href);
    } catch { /* Invalid or unavailable external destinations are not opened. */ }
  }
  private secure(contents: WebContents, accountId: string, partition: string): void {
    contents.on('before-input-event', event => { if (this.isLocked(accountId)) event.preventDefault(); });
    contents.on('before-mouse-event', event => { if (this.isLocked(accountId)) event.preventDefault(); });
    contents.on('will-navigate', (event, url) => {
      if (!isAccountNavigation(url)) { event.preventDefault(); void this.external(url); }
    });
    contents.on('will-redirect', (event, url) => { if (!isAccountNavigation(url)) event.preventDefault(); });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (!isAccountNavigation(url)) { void this.external(url); return { action: 'deny' }; }
      return { action: 'allow', overrideBrowserWindowOptions: {
        width: 560, height: 760, parent: this.window, autoHideMenuBar: true,
        webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, preload: undefined }
      } };
    });
    contents.on('did-create-window', popup => {
      const windows = this.popups.get(accountId) ?? new Set<BrowserWindow>();
      windows.add(popup); this.popups.set(accountId, windows);
      this.secure(popup.webContents, accountId, partition);
      if (this.isLocked(accountId)) popup.hide();
      popup.on('closed', () => windows.delete(popup));
    });
  }
  private savePage(id: string, url: string): void {
    const owner = this.owners.get(id); if (!owner) return;
    if (this.redirectingDuplicates.has(id) && url !== owner.url) return;
    const target = replyPageUrl(url);
    if (target && target !== HOME_URL && !this.redirectingDuplicates.has(id)) {
      const registered = this.conversations.list(owner.accountId).find(item => item.url === target);
      const duplicates = [...this.owners].filter(([otherId, other]) => otherId !== id && !this.redirectingDuplicates.has(otherId) &&
        other.accountId === owner.accountId && (Boolean(registered && other.conversationId === registered.id) || replyPageUrl(other.url) === target));
      const duplicate = duplicates.find(([otherId]) => this.locks.some(task => this.taskPage(task) === otherId)) ?? duplicates[0];
      if (duplicate) {
        const previous = owner.conversationId ? this.conversations.get(owner.accountId, owner.conversationId) : undefined;
        const fallback = previous?.url && previous.url !== target ? previous.url : replyPageUrl(owner.url);
        owner.url = fallback && fallback !== target ? fallback : HOME_URL;
        if (previous?.url === target) owner.conversationId = undefined;
        this.redirectingDuplicates.add(id);
        if (this.selected.get(owner.accountId) === id) {
          if (this.accounts.activeId() === owner.accountId) this.activate(owner.accountId, duplicate[0]);
          else this.selected.set(owner.accountId, duplicate[0]);
        }
        this.saveTabs(owner.accountId);
        const contents = this.views.get(id)?.webContents;
        if (contents && !contents.isDestroyed()) void contents.loadURL(owner.url).catch(() => {
          if (this.views.get(id)?.webContents === contents) this.destroyView(id);
        }).finally(() => { this.redirectingDuplicates.delete(id); this.changed(); });
        else this.redirectingDuplicates.delete(id);
        return;
      }
    }
    owner.url = url;
    if (this.selected.get(owner.accountId) === id) this.sessions.save(owner.accountId, url);
    // A manually opened ordinary conversation is indexed for the same queue key.
    if (!owner.conversationId) {
      try { owner.conversationId = this.conversations.register(owner.accountId, url).id; } catch { /* Home and project pages remain independent tabs. */ }
    } else {
      const conversation = this.conversations.get(owner.accountId, owner.conversationId);
      if (conversation.binding === 'new' && !this.isLocked(id)) {
        try { this.conversations.bind(owner.accountId, conversation.id, url); } catch { /* Wait for an ordinary stable conversation URL. */ }
      }
      if (conversation.url && conversation.url !== url && !this.isLocked(id)) {
        try { owner.conversationId = this.conversations.register(owner.accountId, url).id; } catch { owner.conversationId = undefined; }
      }
    }
    this.saveTabs(owner.accountId);
  }
  private createView(accountId: string, url: string, conversationId?: string): string {
    if ([...this.owners.values()].filter(owner => owner.accountId === accountId).length >= 20) throw new AppError('此账号已打开 20 个会话，请关闭不再使用的会话后继续', 409);
    const id = randomUUID();
    this.accounts.get(accountId);
    this.owners.set(id, { accountId, conversationId, url, title: '新会话', idleSince: Date.now(),
      hasDraft: false, busy: false, hibernationReady: false });
    this.openView(id);
    this.saveTabs(accountId);
    return id;
  }
  private openView(id: string): WebContentsView {
    const existing = this.views.get(id);
    if (existing && !existing.webContents.isDestroyed()) return existing;
    const owner = this.owners.get(id);
    if (!owner) throw new AppError('会话页面不存在', 404);
    const account = this.accounts.get(owner.accountId);
    this.configureSession(account.partition);
    const view = new WebContentsView({ webPreferences: { partition: account.partition,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, backgroundThrottling: true } });
    view.setBounds({ x: 0, y: 0, width: Math.max(1, Math.round(this.bounds?.width ?? 1000)), height: Math.max(1, Math.round(this.bounds?.height ?? 700)) });
    this.views.set(id, view);
    bindShortcuts(view.webContents, this.window, this.shortcuts);
    this.secure(view.webContents, id, account.partition);
    const update = () => { if (!view.webContents.isDestroyed()) { this.layout(); this.changed(); } };
    view.webContents.on('did-start-loading', () => { owner.hibernationReady = false; this.errors.delete(id); update(); });
    view.webContents.on('did-stop-loading', () => { owner.title = view.webContents.getTitle() || owner.title; this.saveTabs(owner.accountId); update(); });
    view.webContents.on('page-title-updated', (_event, title) => { owner.title = title || owner.title; this.saveTabs(owner.accountId); update(); });
    const save = (url: string) => { if (!this.closing && this.views.has(id) && isChatUrl(url)) this.savePage(id, url); update(); };
    view.webContents.on('did-navigate', (_event, url) => save(url));
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) save(url); });
    view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { this.errors.set(id, `${description} (${code})`); update(); }
    });
    view.webContents.on('render-process-gone', (_event, details) => {
      if (this.views.get(id) === view) this.errors.set(id, `Page stopped: ${details.reason}. Reload to continue.`);
      update();
    });
    void view.webContents.loadURL(owner.url).catch(() => { /* did-fail-load reports the error to the UI. */ });
    return view;
  }
  private pageId(accountId: string): string | undefined { return this.selected.get(accountId); }
  private taskPage(task: AgentTask): string | undefined {
    const assigned = this.taskPages.get(task.id);
    if (assigned && this.owners.has(assigned)) return assigned;
    const target = task.conversationId ? this.conversations.get(task.accountId, task.conversationId).url : task.targetUrl;
    return [...this.owners].find(([id, owner]) => owner.accountId === task.accountId &&
      (task.conversationId ? owner.conversationId === task.conversationId || !!target && owner.url === target : owner.url === target))?.[0];
  }
  private isLocked(id: string): boolean {
    const owner = this.owners.get(id); if (!owner) return false;
    return this.locks.some(task => task.accountId === owner.accountId && (this.taskPage(task) === id || !!task.conversationId && task.conversationId === owner.conversationId));
  }
  pages(): BrowserPage[] {
    return [...this.owners].map(([id, owner]) => {
      const contents = this.views.get(id)?.webContents;
      const live = contents && !contents.isDestroyed();
      return { id, accountId: owner.accountId, conversationId: owner.conversationId,
        url: live ? contents.getURL() || owner.url : owner.url, title: live ? contents.getTitle() || owner.title : owner.title,
        selected: this.selected.get(owner.accountId) === id, locked: this.isLocked(id), sleeping: !live,
        taskId: this.locks.find(task => this.taskPage(task) === id)?.id };
    });
  }
  activate(accountId: string, pageId?: string): void {
    this.accounts.get(accountId);
    if (pageId && this.owners.get(pageId)?.accountId !== accountId) throw new AppError('会话页面不属于此账号', 404);
    const id = pageId ?? this.pageId(accountId) ?? this.createView(accountId,
      this.restoredTabAccounts.has(accountId) ? HOME_URL : this.sessions.restore(accountId)?.url ?? HOME_URL);
    const restoreFocus = !!(this.activeId && this.views.get(this.activeId)?.webContents.isFocused());
    for (const windows of this.popups.values()) for (const popup of windows) popup.hide();
    if (this.activeId && this.activeId !== id && this.views.has(this.activeId)) {
      const previous = this.owners.get(this.activeId); if (previous) previous.idleSince = Date.now();
      this.window.contentView.removeChildView(this.views.get(this.activeId)!);
    }
    const view = this.openView(id);
    this.owners.get(id)!.idleSince = Date.now();
    this.selected.set(accountId, id); this.activeId = id;
    this.saveTabs(accountId);
    if (!this.window.contentView.children.includes(view)) this.window.contentView.addChildView(view);
    for (const popup of this.popups.get(id) ?? []) { if (!this.isLocked(id) && this.visible) popup.show(); }
    if (isChatUrl(view.webContents.getURL())) this.sessions.save(accountId, view.webContents.getURL());
    this.layout();
    if (restoreFocus && this.visible && !this.isLocked(id)) view.webContents.focus();
    this.changed();
  }
  select(accountId: string, pageId: string): void { this.activate(accountId, pageId); }
  async queueTarget(accountId: string, pageId: string): Promise<Conversation> {
    const owner = this.owners.get(pageId);
    if (!owner || owner.accountId !== accountId) throw new AppError('会话页面已关闭或不属于此账号', 404);
    const contents = this.openView(pageId).webContents;
    if (contents.isLoading()) throw new AppError('页面正在加载，请稍后打开队列', 409);
    const url = contents.getURL();
    if (owner.conversationId) {
      const existing = this.conversations.get(accountId, owner.conversationId);
      if (this.isLocked(pageId) || existing.url === url || existing.binding !== 'bound' && url === HOME_URL) return existing;
    }
    let conversation: Conversation;
    if (url === HOME_URL) {
      const page = pageOperationResult<Page>(await contents.executeJavaScript(pageOperationScript({ kind: 'inspect' })));
      if (contents.isDestroyed() || contents.getURL() !== url || this.owners.get(pageId) !== owner || page.busy || page.messages.length || !page.editor) throw new AppError('请等待网页生成会话地址后再打开队列', 409);
      conversation = this.conversations.create(accountId);
    } else conversation = this.conversations.register(accountId, url);
    owner.conversationId = conversation.id;
    this.saveTabs(accountId);
    this.changed();
    return conversation;
  }
  openConversation(accountId: string, conversationId: string): void {
    const conversation = this.conversations.get(accountId, conversationId);
    const existing = [...this.owners].find(([, owner]) => owner.accountId === accountId && (owner.conversationId === conversationId || !!conversation.url && owner.url === conversation.url));
    this.activate(accountId, existing?.[0] ?? this.createView(accountId, conversation.url ?? HOME_URL, conversationId));
  }
  closePage(accountId: string, pageId: string): void {
    if (this.owners.get(pageId)?.accountId !== accountId) throw new AppError('会话页面不存在', 404);
    if (this.isLocked(pageId)) throw new AppError('请先接管或结束此会话的任务，再关闭页面', 409);
    this.closeView(pageId);
    if (this.accounts.activeId() === accountId) this.activate(accountId);
    this.changed();
  }
  private backgrounded(): boolean { return !this.visible || !this.window.isVisible() || this.window.isMinimized(); }
  private markViewed(id: string, url?: string): void {
    const view = this.views.get(id); const owner = this.owners.get(id);
    if (!view || !owner || this.activeId !== id || this.backgrounded() || !this.window.isFocused() || this.isLocked(id) || !view.getVisible()) return;
    this.notifications.viewed(owner.accountId, url ?? view.webContents.getURL());
  }
  private restoreSelectedView(): void {
    if (this.closing || this.activeId || this.backgrounded()) return;
    const accountId = this.accounts.activeId();
    const id = accountId ? this.selected.get(accountId) : undefined;
    if (accountId && id && this.owners.has(id) && !this.views.has(id)) this.activate(accountId, id);
  }
  private updateVisibility(): void {
    if (this.backgrounded()) this.backgroundedAt ??= Date.now();
    else { this.backgroundedAt = undefined; this.restoreSelectedView(); }
    this.layout();
  }
  setVisible(visible: boolean): void { this.visible = visible; this.updateVisibility(); }
  setBounds(bounds: BrowserBounds): void { this.bounds = bounds; this.layout(); }
  private layout(): void {
    if (!this.activeId || this.window.isDestroyed()) return;
    const view = this.views.get(this.activeId);
    if (!view) return;
    const [width, height] = this.window.getContentSize();
    const bounds = this.bounds;
    if (!bounds) { view.setVisible(false); return; }
    const x = Math.min(width, Math.round(bounds.x));
    const y = Math.min(height, Math.round(bounds.y));
    view.setBounds({ x, y, width: Math.max(0, Math.min(Math.round(bounds.width), width - x)),
      height: Math.max(0, Math.min(Math.round(bounds.height), height - y)) });
    view.setVisible(!this.isLocked(this.activeId) && !this.backgrounded() && bounds.width > 0 && bounds.height > 0 && !this.errors.has(this.activeId));
    this.markViewed(this.activeId);
  }
  page(): PageState | null {
    const contents = this.activeId ? this.views.get(this.activeId)?.webContents : undefined;
    if (!contents || contents.isDestroyed()) return null;
    return { id: this.activeId!, conversationId: this.owners.get(this.activeId!)?.conversationId, url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(),
      error: this.errors.get(this.activeId!) };
  }
  async response(task: AgentTask, url?: string): Promise<TaskResponse> {
    const bound = task.conversationId ? this.conversations.get(task.accountId, task.conversationId).url : task.targetUrl;
    if (bound && url && bound !== url) return { taskId: task.id, state: 'unavailable', reason: '指定地址与原任务不一致' };
    const id = url ? [...this.owners].find(([, owner]) => owner.accountId === task.accountId && replyPageUrl(owner.url) === url)?.[0] : this.taskPage(task);
    const contents = id && this.owners.get(id)?.accountId === task.accountId ? this.openView(id).webContents : undefined;
    if (!contents || contents.isDestroyed()) return { taskId: task.id, state: 'unavailable', reason: '请在原账号打开已发送的咨询页面，再用 resume TASK_ID --url 会话地址读取' };
    if (contents.isLoading()) return { taskId: task.id, state: 'reading' };
    const page = pageOperationResult<Page>(await contents.executeJavaScript(pageOperationScript({ kind: 'inspect' })));
    if (contents.isDestroyed() || contents.getURL() !== page.url) return { taskId: task.id, state: 'reading' };
    return this.replyReader.read(task, page, bound ?? url);
  }
  async inspect(accountId: string, pageId?: string): Promise<BrowserDiagnostics> {
    this.accounts.get(accountId);
    const id = pageId ?? this.pageId(accountId);
    if (id && this.owners.get(id)?.accountId !== accountId) throw new AppError('会话页面不属于此账号', 404);
    const contents = id ? this.openView(id).webContents : undefined;
    const base = { accountId, url: this.url(accountId) ?? HOME_URL, title: '', editor: false, draftLength: 0, busy: false };
    if (!contents || contents.isDestroyed()) return { ...base, readiness: 'not_open', suggestion: '请先在客户端打开此账号，再检查页面；队列未改变' };
    if (contents.isLoading()) return { ...base, readiness: 'loading', suggestion: '页面正在加载，请稍后再次诊断' };
    if (!isChatUrl(contents.getURL())) return { ...base, readiness: 'login_required', suggestion: '请在此账号页面完成登录' };
    try {
      const detail = pageOperationResult<Omit<BrowserDiagnostics, 'accountId' | 'suggestion'>>(await contents.executeJavaScript(pageOperationScript({ kind: 'diagnose' })));
      const suggestions = { ready: detail.draftLength ? '页面已有草稿，请由人类处理后再继续任务' : detail.busy ? '网页正在回复，请等待完成' : '输入框已就绪；暂停的队列仍需明确恢复',
        loading: '输入框尚未就绪，请稍后再次诊断', verification_required: '请在此账号网页完成验证后继续原任务，不要重复提交',
        login_required: '请在此账号网页完成登录', not_open: '请先打开此账号', unavailable: '页面不可用，请在客户端检查' };
      return { ...detail, accountId, suggestion: suggestions[detail.readiness] };
    } catch (error) {
      return { ...base, readiness: contents.isDestroyed() ? 'unavailable' : 'loading', suggestion: '页面正在切换或不可用，请稍后再次诊断',
        error: error instanceof Error && error.message.startsWith('PAGE_SCRIPT_FAILED') ? error.message : undefined };
    }
  }
  async preview(accountId: string, pageId?: string): Promise<BrowserPreview | null> {
    this.accounts.get(accountId);
    const id = pageId ?? this.pageId(accountId);
    if (!id) return null;
    if (this.owners.get(id)?.accountId !== accountId) throw new AppError('会话页面不属于此账号', 404);
    const contents = this.views.get(id)?.webContents;
    if (!this.isLocked(id) || !contents || contents.isDestroyed()) return null;
    const existing = this.previews.get(id);
    if (existing) return existing;
    const capture = (async () => {
      const url = contents.getURL();
      if (this.activeId === id && this.visible && !contents.isLoading() && isChatUrl(url)) {
        try {
          await contents.executeJavaScript(pageOperationScript({ kind: 'follow_latest', url }));
        } catch { /* Navigation can interrupt following; a later preview retries. */ }
      }
      if (!this.isLocked(id) || contents.isDestroyed() || contents.getURL() !== url) return null;
      const captured = await contents.capturePage(undefined, { stayHidden: !this.previewAwaken.has(id), stayAwake: true });
      if (!this.isLocked(id) || contents.isDestroyed() || contents.getURL() !== url || captured.isEmpty()) return null;
      const resized = captured.getSize().width > 1600 ? captured.resize({ width: 1600 }) : captured;
      return { accountId, pageId: id, image: `data:image/jpeg;base64,${resized.toJPEG(75).toString('base64')}`, capturedAt: Date.now() };
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = Promise.race([capture, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new AppError('预览画面更新超时，正在重试')), PREVIEW_TIMEOUT_MS);
    })]);
    this.previews.set(id, pending);
    try {
      const frame = await pending;
      if (frame) {
        const activityKey = this.owners.get(id)?.activityKey;
        const previous = this.previewFrames.get(id);
        const stale = !!previous && !!activityKey && activityKey !== previous.activityKey && frame.image === previous.image;
        if (stale) { this.previewStale.add(id); this.previewAwaken.add(id); }
        else if (!this.previewStale.has(id) || frame.image !== previous?.image) {
          this.previewStale.delete(id); this.previewAwaken.delete(id);
        }
        this.previewFrames.set(id, { activityKey, image: frame.image });
      }
      return frame;
    } catch (error) {
      if (this.views.get(id)?.webContents === contents && !contents.isDestroyed() && this.isLocked(id)) this.previewAwaken.add(id);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.previews.get(id) === pending) this.previews.delete(id);
    }
  }
  async hasBusyPage(): Promise<boolean> {
    for (const view of this.views.values()) {
      const contents = view.webContents;
      if (contents.isDestroyed() || !isChatUrl(contents.getURL())) continue;
      if (contents.isLoading()) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const busy = await Promise.race([
          contents.executeJavaScript(pageOperationScript({ kind: 'activity' })).then(value => pageOperationResult<ActivitySnapshot>(value).busy),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), 3000); })
        ]);
        if (busy) return true;
      } catch { return true; }
      finally { clearTimeout(timer); }
    }
    return false;
  }
  private async waitUntilLoaded(id: string): Promise<void> {
    const contents = this.views.get(id)!.webContents;
    const deadline = Date.now() + 30000;
    while (contents.isLoading()) {
      if (Date.now() >= deadline) throw new AppError('会话加载超时，请检查页面');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  async navigate(accountId: string, value: unknown): Promise<void> {
    const url = chatUrl(value);
    const existing = [...this.owners].find(([, owner]) => owner.accountId === accountId && owner.url === url)?.[0];
    const id = existing ?? this.createView(accountId, url);
    this.activate(accountId, id);
    await this.waitUntilLoaded(id);
  }
  async newConversation(accountId: string): Promise<void> {
    const id = this.createView(accountId, HOME_URL);
    this.activate(accountId, id);
    await this.waitUntilLoaded(id);
  }
  control(accountId: string, action: string): void {
    const id = this.pageId(accountId); if (!id) return;
    if (this.isLocked(id)) throw new AppError('请先接管当前会话');
    const contents = this.openView(id).webContents;
    if (action === 'reload') contents.reload();
    else if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (!['back', 'forward'].includes(action)) throw new AppError('Unknown browser action');
  }
  async remove(id: string): Promise<void> {
    const account = this.accounts.get(id);
    for (const [pageId, owner] of [...this.owners]) if (owner.accountId === id) this.closeView(pageId);
    const isolated = session.fromPartition(account.partition);
    // Close all web contents before wiping profile state so they cannot rewrite it.
    await isolated.closeAllConnections();
    await isolated.clearStorageData();
    await isolated.clearCache();
    await isolated.clearAuthCache();
    await isolated.clearCodeCaches({});
    isolated.flushStorageData();
    this.errors.delete(id);
  }
  private closeView(id: string): void {
    const owner = this.owners.get(id);
    this.redirectingDuplicates.delete(id);
    this.destroyView(id);
    this.owners.delete(id); this.errors.delete(id);
    for (const [taskId, pageId] of this.taskPages) if (pageId === id) this.taskPages.delete(taskId);
    if (owner && this.selected.get(owner.accountId) === id) {
      const next = [...this.owners].find(([, item]) => item.accountId === owner.accountId)?.[0];
      if (next) this.selected.set(owner.accountId, next); else this.selected.delete(owner.accountId);
    }
    if (owner) this.saveTabs(owner.accountId);
  }
  private destroyView(id: string): void {
    this.previews.delete(id);
    this.previewAwaken.delete(id);
    this.previewStale.delete(id);
    this.previewFrames.delete(id);
    const owner = this.owners.get(id);
    if (owner?.lastUrl) this.observer.disconnected(owner.accountId, owner.lastUrl);
    if (owner) { owner.lastUrl = undefined; owner.hibernationReady = false; owner.activityKey = undefined; }
    for (const popup of this.popups.get(id) ?? []) popup.destroy();
    this.popups.delete(id);
    const view = this.views.get(id);
    if (view) {
      if (this.activeId === id) { this.window.contentView.removeChildView(view); this.activeId = null; }
      this.views.delete(id);
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
  }
  private hibernateIfIdle(id: string, view: WebContentsView): void {
    const owner = this.owners.get(id);
    const active = this.activeId === id;
    const idleSince = active ? this.backgroundedAt : owner?.idleSince;
    const idleMs = active ? this.hiddenIdlePageMs : this.idlePageMs;
    if (!owner || this.views.get(id) !== view || active && !this.backgrounded() || this.isLocked(id) || this.redirectingDuplicates.has(id) || this.observing.has(id) ||
      owner.hasDraft || owner.busy || !owner.hibernationReady || !idleSince || Date.now() - idleSince < idleMs ||
      view.webContents.isDestroyed() || view.webContents.isLoading() || !isChatUrl(view.webContents.getURL())) return;
    this.destroyView(id);
    this.changed();
  }
  url(accountId: string): string | undefined {
    const id = this.pageId(accountId); const owner = id ? this.owners.get(id) : undefined;
    const contents = id ? this.views.get(id)?.webContents : undefined;
    // An opening tab must never inherit the previous tab's persisted destination.
    return contents && !contents.isDestroyed() ? contents.getURL() || owner?.url : owner?.url;
  }
  setLocked(tasks: AgentTask[]): void {
    this.locks = tasks;
    for (const taskId of this.taskPages.keys()) if (!tasks.some(task => task.id === taskId)) this.taskPages.delete(taskId);
    for (const id of this.previewFrames.keys()) if (!this.isLocked(id)) {
      this.previewFrames.delete(id); this.previewStale.delete(id); this.previewAwaken.delete(id);
    }
    if (this.activeId && this.isLocked(this.activeId) && this.views.get(this.activeId)?.webContents.isFocused()) this.window.webContents.focus();
    for (const [id, popups] of this.popups) for (const popup of popups) {
      if (this.isLocked(id) || !this.visible || this.activeId !== id) popup.hide(); else popup.show();
    }
    this.layout();
  }
  async execute(id: string, input: TaskInput, signal: AbortSignal, context: ExecutionContext): Promise<unknown> {
    const task = context.task();
    const conversation = task.conversationId ? this.conversations.get(id, task.conversationId) : undefined;
    let pageId = input.type === 'navigate' && input.url === HOME_URL ? undefined : this.taskPage(task);
    if (!pageId) pageId = this.createView(id, conversation?.url ?? (conversation ? HOME_URL : task.targetUrl) ?? HOME_URL, task.conversationId);
    else if (task.conversationId) this.owners.get(pageId)!.conversationId = task.conversationId;
    this.taskPages.set(task.id, pageId);
    this.saveTabs(id);
    if (!task.background) {
      this.selected.set(id, pageId);
      if (this.accounts.activeId() === id) this.activate(id, pageId);
    }
    const contents = this.openView(pageId).webContents;
    contents.setBackgroundThrottling(false);
    try {
      const result = await new ChatGPTAdapter(contents, signal, context, this.conversations,
        () => this.activeId === pageId && this.visible && !this.backgrounded() ? 250 : 2000).execute(input);
      signal.throwIfAborted();
      if (input.type === 'prompt' && input.submit && result && typeof result === 'object' && 'url' in result && 'replyToken' in result && typeof result.url === 'string' && typeof result.replyToken === 'string') {
        this.notifications.complete(id, result.url, this.title(id, result.url, contents.getTitle()), result.replyToken);
      }
      return result;
    }
    finally {
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(true);
      if (contents.isDestroyed()) {
        const active = this.activeId === pageId;
        this.closeView(pageId);
        if (active && !this.closing) this.activate(id);
      }
    }
  }
  close(): void { this.closing = true; clearInterval(this.monitor); for (const id of [...this.views.keys()]) this.closeView(id); }
}
