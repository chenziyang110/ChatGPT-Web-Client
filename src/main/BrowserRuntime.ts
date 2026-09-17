import { randomUUID } from 'node:crypto';
import { BrowserWindow, WebContentsView, session, dialog, shell, type WebContents } from 'electron';
import { AccountManager } from '../core/account/AccountManager';
import { SessionManager } from '../core/session/SessionManager';
import { AppError, HOME_URL, chatUrl, isAccountNavigation, isChatUrl } from '../core/validation';
import type { AgentTask, BrowserBounds, BrowserDiagnostics, BrowserPreview, BrowserPage, PageState, TaskInput, TaskResponse } from '../shared/types';
import { bindShortcuts } from './shortcuts';
import { ChatGPTAdapter, pageOperation, replyPageUrl, type Page } from './adapters/ChatGPTAdapter';
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
const MONITOR_INTERVAL_MS = 1_500;

function pageIdleMs(): number {
  const value = Number(process.env.WORKSPACE_PAGE_IDLE_MS);
  return Number.isSafeInteger(value) && value >= 100 && value <= 60 * 60 * 1000 ? value : DEFAULT_PAGE_IDLE_MS;
}

export class BrowserRuntime {
  private readonly views = new Map<string, WebContentsView>();
  private readonly errors = new Map<string, string>();
  private readonly popups = new Map<string, Set<BrowserWindow>>();
  private activeId: string | null = null;
  private locks: AgentTask[] = [];
  private readonly owners = new Map<string, PageOwner>();
  private readonly selected = new Map<string, string>();
  private readonly taskPages = new Map<string, string>();
  private readonly replyReader = new ReplyReader();
  private visible = true;
  private closing = false;
  private readonly configured = new Set<string>();
  private bounds?: BrowserBounds;
  private readonly observer: ConversationActivityObserver;
  private readonly observing = new Set<string>();
  private readonly previews = new Map<string, Promise<BrowserPreview | null>>();
  private readonly monitor: ReturnType<typeof setInterval>;
  private readonly idlePageMs = pageIdleMs();
  constructor(private readonly window: BrowserWindow, private readonly accounts: AccountManager,
    private readonly sessions: SessionManager, private readonly changed: () => void, private readonly conversations: ConversationManager,
    private readonly shortcuts: ShortcutSettings, private readonly notifications: ConversationNotifications) {
    window.on('resize', () => this.layout());
    this.observer = new ConversationActivityObserver(notifications, true);
    this.monitor = setInterval(() => {
      for (const [id, view] of this.views) void this.observe(id, view).finally(() => this.hibernateIfIdle(id, view));
    }, MONITOR_INTERVAL_MS);
  }
  private title(id: string, url: string, fallback: string): string {
    return this.conversations.list(id).find(item => item.url === url)?.alias ?? fallback;
  }
  private async observe(id: string, view: WebContentsView): Promise<void> {
    const contents = view.webContents;
    if (this.closing || this.observing.has(id) || contents.isDestroyed() || contents.isLoading()) return;
    const owner = this.owners.get(id); if (!owner) return;
    const url = contents.getURL();
    if (owner.lastUrl && owner.lastUrl !== url) this.observer.disconnected(owner.accountId, owner.lastUrl);
    owner.lastUrl = url; owner.url = url;
    if (!isChatUrl(url)) { owner.hibernationReady = false; return; }
    this.observing.add(id);
    try {
      const snapshot = await contents.executeJavaScript(`(${pageOperation.toString()})({kind:'activity'})`) as ActivitySnapshot;
      if (this.closing || this.views.get(id) !== view || contents.isDestroyed() || contents.getURL() !== url) return;
      snapshot.title = this.title(owner.accountId, snapshot.url, snapshot.title);
      const activityKey = JSON.stringify([snapshot.url, snapshot.busy, snapshot.hasDraft, snapshot.user?.id,
        snapshot.assistant?.id, snapshot.assistant?.text.length, snapshot.lastRole]);
      if (owner.activityKey !== activityKey) owner.idleSince = Date.now();
      Object.assign(owner, { url: snapshot.url, title: snapshot.title || owner.title, hasDraft: !!snapshot.hasDraft,
        busy: snapshot.busy, hibernationReady: snapshot.editor && !snapshot.error, activityKey });
      this.observer.observe(owner.accountId, snapshot);
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
    owner.url = url;
    if (this.selected.get(owner.accountId) === id) this.sessions.save(owner.accountId, url);
    // A manually opened ordinary conversation is indexed for the same queue key.
    if (!owner.conversationId) {
      try { owner.conversationId = this.conversations.register(owner.accountId, url).id; } catch { /* Home and project pages remain independent tabs. */ }
    } else {
      const conversation = this.conversations.get(owner.accountId, owner.conversationId);
      if (conversation.url && conversation.url !== url && !this.isLocked(id)) {
        try { owner.conversationId = this.conversations.register(owner.accountId, url).id; } catch { owner.conversationId = undefined; }
      }
    }
  }
  private createView(accountId: string, url: string, conversationId?: string): string {
    if ([...this.owners.values()].filter(owner => owner.accountId === accountId).length >= 20) throw new AppError('此账号已打开 20 个会话，请关闭不再使用的会话后继续', 409);
    const id = randomUUID();
    this.accounts.get(accountId);
    this.owners.set(id, { accountId, conversationId, url, title: '新会话', idleSince: Date.now(),
      hasDraft: false, busy: false, hibernationReady: false });
    this.openView(id);
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
    view.webContents.on('did-stop-loading', () => { owner.title = view.webContents.getTitle() || owner.title; update(); });
    view.webContents.on('page-title-updated', (_event, title) => { owner.title = title || owner.title; update(); });
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
    const id = pageId ?? this.pageId(accountId) ?? this.createView(accountId, this.sessions.restore(accountId)?.url ?? HOME_URL);
    const restoreFocus = !!(this.activeId && this.views.get(this.activeId)?.webContents.isFocused());
    for (const windows of this.popups.values()) for (const popup of windows) popup.hide();
    if (this.activeId && this.activeId !== id && this.views.has(this.activeId)) {
      const previous = this.owners.get(this.activeId); if (previous) previous.idleSince = Date.now();
      this.window.contentView.removeChildView(this.views.get(this.activeId)!);
    }
    const view = this.openView(id);
    this.owners.get(id)!.idleSince = Date.now();
    this.selected.set(accountId, id); this.activeId = id;
    if (!this.window.contentView.children.includes(view)) this.window.contentView.addChildView(view);
    for (const popup of this.popups.get(id) ?? []) { if (!this.isLocked(id) && this.visible) popup.show(); }
    if (isChatUrl(view.webContents.getURL())) this.sessions.save(accountId, view.webContents.getURL());
    this.layout();
    if (restoreFocus && this.visible && !this.isLocked(id)) view.webContents.focus();
    this.changed();
  }
  select(accountId: string, pageId: string): void { this.activate(accountId, pageId); }
  closePage(accountId: string, pageId: string): void {
    if (this.owners.get(pageId)?.accountId !== accountId) throw new AppError('会话页面不存在', 404);
    if (this.isLocked(pageId)) throw new AppError('请先接管或结束此会话的任务，再关闭页面', 409);
    this.closeView(pageId);
    if (this.accounts.activeId() === accountId) this.activate(accountId);
    this.changed();
  }
  setVisible(visible: boolean): void { this.visible = visible; this.layout(); }
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
    view.setVisible(!this.isLocked(this.activeId) && this.visible && bounds.width > 0 && bounds.height > 0 && !this.errors.has(this.activeId));
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
    const page = await contents.executeJavaScript(`(${pageOperation.toString()})({kind:'inspect'})`) as Page;
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
      const detail = await contents.executeJavaScript(`(${pageOperation.toString()})({kind:'diagnose'})`) as Omit<BrowserDiagnostics, 'accountId' | 'suggestion'>;
      const suggestions = { ready: detail.draftLength ? '页面已有草稿，请由人类处理后再继续任务' : detail.busy ? '网页正在回复，请等待完成' : '输入框已就绪；暂停的队列仍需明确恢复',
        loading: '输入框尚未就绪，请稍后再次诊断', verification_required: '请在此账号网页完成验证后继续原任务，不要重复提交',
        login_required: '请在此账号网页完成登录', not_open: '请先打开此账号', unavailable: '页面不可用，请在客户端检查' };
      return { ...detail, accountId, suggestion: suggestions[detail.readiness] };
    } catch {
      return { ...base, readiness: contents.isDestroyed() ? 'unavailable' : 'loading', suggestion: '页面正在切换或不可用，请稍后再次诊断' };
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
    const pending = (async () => {
      const captured = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (!this.isLocked(id) || contents.isDestroyed() || captured.isEmpty()) return null;
      const resized = captured.getSize().width > 1600 ? captured.resize({ width: 1600 }) : captured;
      return { accountId, pageId: id, image: `data:image/jpeg;base64,${resized.toJPEG(75).toString('base64')}`, capturedAt: Date.now() };
    })();
    this.previews.set(id, pending);
    try { return await pending; } finally { this.previews.delete(id); }
  }
  async navigate(accountId: string, value: unknown): Promise<void> {
    const url = chatUrl(value);
    const existing = [...this.owners].find(([, owner]) => owner.accountId === accountId && owner.url === url)?.[0];
    const id = existing ?? this.createView(accountId, url);
    this.activate(accountId, id);
    const contents = this.views.get(id)!.webContents;
    const deadline = Date.now() + 30000;
    while (contents.isLoading()) {
      if (Date.now() >= deadline) throw new AppError('会话加载超时，请检查页面');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
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
    this.destroyView(id);
    this.owners.delete(id); this.errors.delete(id);
    for (const [taskId, pageId] of this.taskPages) if (pageId === id) this.taskPages.delete(taskId);
    if (owner && this.selected.get(owner.accountId) === id) {
      const next = [...this.owners].find(([, item]) => item.accountId === owner.accountId)?.[0];
      if (next) this.selected.set(owner.accountId, next); else this.selected.delete(owner.accountId);
    }
  }
  private destroyView(id: string): void {
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
    if (!owner || this.views.get(id) !== view || this.activeId === id || this.isLocked(id) || this.observing.has(id) ||
      owner.hasDraft || owner.busy || !owner.hibernationReady || Date.now() - owner.idleSince < this.idlePageMs ||
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
    this.selected.set(id, pageId);
    if (this.accounts.activeId() === id) this.activate(id, pageId);
    const contents = this.openView(pageId).webContents;
    try {
      const result = await new ChatGPTAdapter(contents, signal, context, this.conversations).execute(input);
      signal.throwIfAborted();
      if (input.type === 'prompt' && input.submit && result && typeof result === 'object' && 'url' in result && 'replyToken' in result && typeof result.url === 'string' && typeof result.replyToken === 'string') {
        this.notifications.complete(id, result.url, this.title(id, result.url, contents.getTitle()), result.replyToken);
      }
      return result;
    }
    finally {
      if (contents.isDestroyed()) {
        const active = this.activeId === pageId;
        this.closeView(pageId);
        if (active && !this.closing) this.activate(id);
      }
    }
  }
  close(): void { this.closing = true; clearInterval(this.monitor); for (const id of [...this.views.keys()]) this.closeView(id); }
}
