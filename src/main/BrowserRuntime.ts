import { randomUUID } from 'node:crypto';
import { BrowserWindow, WebContentsView, session, dialog, shell, type WebContents } from 'electron';
import { AccountManager } from '../core/account/AccountManager';
import { SessionManager } from '../core/session/SessionManager';
import { AppError, HOME_URL, chatUrl, webLink, isAccountNavigation, isAccountLoginUrl, isChatUrl } from '../core/validation';
import { authorizationCallback, hasAuthorizationParameters, isAuthorizationCallback, isAuthorizationSuccess,
  isCodexAppUrl, isHttpsWebUrl, isNativeAppAuthorizationSource } from '../shared/accountNavigation';
import type { AgentTask, BrowserBounds, BrowserDiagnostics, BrowserPreview, BrowserPage, Conversation, PageState, TaskInput, TaskResponse } from '../shared/types';
import { bindShortcuts } from './shortcuts';
import { ChatGPTAdapter, executePageScript, pageOperationScript, pageOperationResult, replyPageUrl, type Page } from './adapters/ChatGPTAdapter';
import { ReplyReader } from './adapters/ReplyReader';
import { COMPLETION_STABLE_MS, ConversationActivityObserver, type ActivitySnapshot, type ConversationNotifications } from '../core/notifications/ConversationNotifications';
import type { ShortcutSettings } from '../core/settings/ShortcutSettings';
import type { ExecutionContext } from '../core/agent/AgentGateway';
import type { ConversationManager } from '../core/conversation/ConversationManager';
import { allowChatGptClipboardWrite } from './permissions';
import type { RuntimeDiagnostics } from './RuntimeDiagnostics';

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
  customLink?: boolean;
  callbackUrl?: string;
}

const DEFAULT_PAGE_IDLE_MS = 60_000;
const DEFAULT_HIDDEN_PAGE_IDLE_MS = 15_000;
const MONITOR_INTERVAL_MS = 1_500;
const PREVIEW_TIMEOUT_MS = 5_000;
const DEFAULT_PAGE_LOAD_TIMEOUT_MS = 20_000;
const PAGE_LOAD_TIMEOUT_ERROR = '网页加载时间过长，请检查网络或点击“恢复页面”重试';
const PAGE_NAVIGATION_INCOMPLETE_ERROR = '网页导航未完成，正在自动恢复';
const CONVERSATION_LOAD_ERROR = 'ChatGPT 会话暂时无法加载，正在自动重试';
const REPLY_CONNECTION_ERROR = 'ChatGPT 连接已中断，正在自动重新连接';
const PAGE_PROBE_TIMEOUT_MS = 2_000;
const MAX_PAGE_RECOVERIES = 3;
type RecoveryReason = 'load_timeout' | 'load_failed' | 'conversation_load' | 'renderer_gone' | 'unresponsive' | 'manual';
interface RecoveryState {
  attempts: number; conversationAttempts?: number; conversationUrl?: string;
  conversationFailure?: Page['loadFailure']; connectionKey?: string; connectionSince?: number;
  healthySince?: number; timer?: ReturnType<typeof setTimeout>;
}

async function boundedPageOperation<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('PAGE_PROBE_TIMEOUT')), PAGE_PROBE_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

function pageLoadTimeoutMs(): number {
  const value = Number(process.env.WORKSPACE_PAGE_LOAD_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value >= 100 && value <= 60_000 ? value : DEFAULT_PAGE_LOAD_TIMEOUT_MS;
}

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
  private readonly loadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly popups = new Map<string, Set<BrowserWindow>>();
  private activeId: string | null = null;
  private locks: AgentTask[] = [];
  private automaticRecoveryTasks: AgentTask[] = [];
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
  private readonly observing = new Map<string, WebContentsView>();
  private readonly usableContents = new WeakSet<WebContents>();
  private readonly loadGenerations = new WeakMap<WebContentsView, number>();
  private readonly pendingNavigations = new WeakMap<WebContentsView, string>();
  private readonly authorizationNavigations = new WeakMap<WebContents, string>();
  private readonly externalAppRequests = new Map<string, Set<string>>();
  private readonly lastAppLaunch = new Map<string, { url: string; time: number }>();
  private readonly recoveries = new Map<string, RecoveryState>();
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly deferredRecoveries = new Map<string, { view: WebContentsView; generation?: number; reason: RecoveryReason }>();
  private readonly previews = new Map<string, Promise<BrowserPreview | null>>();
  private readonly previewAwaken = new Set<string>();
  private readonly previewStale = new Set<string>();
  private readonly previewFrames = new Map<string, { activityKey?: string; image: string }>();
  private readonly redirectingDuplicates = new Set<string>();
  private readonly monitor: ReturnType<typeof setInterval>;
  private readonly idlePageMs = pageIdleMs();
  private readonly hiddenIdlePageMs = hiddenPageIdleMs();
  private readonly loadTimeoutMs = pageLoadTimeoutMs();
  constructor(private readonly window: BrowserWindow, private readonly accounts: AccountManager,
    private readonly sessions: SessionManager, private readonly changed: () => void, private readonly conversations: ConversationManager,
    private readonly shortcuts: ShortcutSettings, private readonly notifications: ConversationNotifications,
    private readonly diagnostics?: Pick<RuntimeDiagnostics, 'record' | 'error'>) {
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
      pages: [...this.owners].filter(([, owner]) => owner.accountId === accountId).map(([id, owner]) => {
        const contents = this.views.get(id)?.webContents;
        const liveUrl = contents && !contents.isDestroyed() ? contents.getURL() : owner.url;
        const temporary = owner.customLink || isAccountLoginUrl(liveUrl) || hasAuthorizationParameters(liveUrl);
        const savedUrl = !owner.customLink && isChatUrl(owner.url) && !isAccountLoginUrl(owner.url) && !hasAuthorizationParameters(owner.url) ? owner.url : HOME_URL;
        return { id, url: savedUrl, title: temporary ? '授权页面' : owner.title, conversationId: owner.conversationId };
      }) });
  }
  private async observe(id: string, view: WebContentsView): Promise<void> {
    const contents = view.webContents;
    if (this.closing || this.observing.has(id) || !contents || contents.isDestroyed() || this.pageLoading(contents)) return;
    const owner = this.owners.get(id); if (!owner) return;
    if (this.redirectingDuplicates.has(id)) return;
    const url = contents.getURL();
    if (!isChatUrl(url) || isAccountLoginUrl(url) || hasAuthorizationParameters(url) || owner.customLink) {
      if (owner.lastUrl) this.observer.disconnected(owner.accountId, owner.lastUrl);
      owner.lastUrl = undefined; owner.hibernationReady = false;
      return;
    }
    if (owner.lastUrl && owner.lastUrl !== url) this.observer.disconnected(owner.accountId, owner.lastUrl);
    owner.lastUrl = url; owner.url = url;
    const generation = this.loadGenerations.get(view);
    this.observing.set(id, view);
    try {
      const snapshot = pageOperationResult<ActivitySnapshot>(await boundedPageOperation(executePageScript(contents, pageOperationScript({ kind: 'activity' }))));
      if (this.closing || this.views.get(id) !== view || contents.isDestroyed() || contents.getURL() !== url ||
        this.loadGenerations.get(view) !== generation || this.pageLoading(contents)) return;
      if (snapshot.loadFailure) {
        // The website can finish its native load while its conversation request
        // failed. This says nothing about whether a submitted remote turn ended.
        // Reopen the same account/tab/URL and retain its persisted send receipt.
        owner.hibernationReady = false; owner.hasDraft = !!snapshot.hasDraft; owner.busy = snapshot.busy;
        if (!this.hasAutomaticRecovery(id) && !this.hasUncommittedNavigation(view)) {
          // A page-level site error is still an interactive document. Keep its
          // Retry control visible unless this conversation has an active queue.
          this.observer.disconnected(owner.accountId, url);
          this.preserveSiteFailure(id, contents);
          return;
        }
        if (!this.hasUncommittedNavigation(view)) {
          const recovery = this.recoveries.get(id) ?? { attempts: 0 };
          const failedUrl = replyPageUrl(url);
          if (recovery.conversationUrl && recovery.conversationUrl !== failedUrl) {
            clearTimeout(recovery.timer); recovery.timer = undefined;
            recovery.conversationAttempts = 0;
            recovery.connectionKey = undefined; recovery.connectionSince = undefined;
          }
          recovery.conversationUrl = failedUrl;
          recovery.conversationFailure = snapshot.loadFailure;
          this.recoveries.set(id, recovery);
          // A transient reconnect banner or genuinely progressing reply must
          // not cause a refresh. Only a stable current interruption may bypass
          // the normal protection for an active Stop control.
          if (snapshot.loadFailure === 'reply_connection' && (!this.connectionFailureStable(recovery, snapshot.connectionKey) || owner.hasDraft)) {
            if (owner.hasDraft) { clearTimeout(recovery.timer); recovery.timer = undefined; }
            if (this.errors.get(id) === REPLY_CONNECTION_ERROR) {
              this.errors.delete(id); this.layout(); this.changed();
            }
            return;
          }
        }
        this.observer.disconnected(owner.accountId, url);
        const error = snapshot.loadFailure === 'reply_connection' ? REPLY_CONNECTION_ERROR : CONVERSATION_LOAD_ERROR;
        if (this.errors.get(id) !== error) {
          this.errors.set(id, error);
          this.diagnostics?.record(snapshot.loadFailure === 'reply_connection' ? 'reply_connection_interrupted' : 'conversation_load_failed');
          this.layout(); this.changed();
        }
        this.scheduleRecovery(id, view, this.hasUncommittedNavigation(view) ? 'load_failed' : 'conversation_load');
        return;
      }
      if ((this.errors.get(id) === CONVERSATION_LOAD_ERROR || this.errors.get(id) === REPLY_CONNECTION_ERROR || this.recoveries.get(id)?.conversationUrl) && !this.hasUncommittedNavigation(view) &&
        (snapshot.editor && !snapshot.error || snapshot.busy || snapshot.readiness === 'login_required' || snapshot.readiness === 'verification_required')) {
        // The site's Retry action can recover before our deferred retry runs.
        // Leave the current document and any newly entered draft in place.
        this.errors.delete(id);
        this.endConversationRecovery(id);
        this.layout(); this.changed();
      }
      snapshot.title = this.title(owner.accountId, snapshot.url, snapshot.title);
      const activityKey = JSON.stringify([snapshot.url, snapshot.busy, snapshot.hasDraft, snapshot.user?.id,
        snapshot.assistant?.id, snapshot.assistant?.text.length, snapshot.lastRole]);
      if (owner.activityKey !== activityKey) owner.idleSince = Date.now();
      Object.assign(owner, { url: snapshot.url, title: snapshot.title || owner.title, hasDraft: !!snapshot.hasDraft,
        busy: snapshot.busy, hibernationReady: snapshot.editor && !snapshot.error, activityKey });
      this.observer.observe(owner.accountId, snapshot);
      this.markViewed(id, snapshot.url);
      if (this.hasUncommittedNavigation(view)) {
        // A draft can keep the old responsive document resident after a failed
        // navigation. Resume its destination once that draft is cleared, without
        // moving the draft into a different conversation or interrupting a reply.
        if (!snapshot.hasDraft && !snapshot.busy) {
          this.errors.set(id, PAGE_NAVIGATION_INCOMPLETE_ERROR);
          this.scheduleRecovery(id, view, 'load_failed');
          this.layout(); this.changed();
        }
      } else if (snapshot.editor && !snapshot.error) this.pageHealthy(id);
    } catch {
      if (!this.closing && this.views.get(id) === view) {
        owner.hibernationReady = false;
        this.observer.disconnected(owner.accountId, url);
      }
    }
    finally { if (this.observing.get(id) === view) this.observing.delete(id); }
  }
  private pageLoading(contents: WebContents): boolean {
    return contents.isLoading() && !this.usableContents.has(contents);
  }
  private hasUncommittedNavigation(view: WebContentsView): boolean {
    const target = this.pendingNavigations.get(view);
    const contents = view.webContents;
    return !!target && !!contents && !contents.isDestroyed() && contents.getURL() !== target;
  }
  private async loginDocumentReady(id: string, contents: WebContents): Promise<boolean> {
    const url = contents.getURL();
    if (!isAccountLoginUrl(url) && !(this.owners.get(id)?.customLink && this.allowedPageNavigation(id, url))) return false;
    // OAuth has no ChatGPT composer. Inspect document readiness without reading
    // credentials or waiting for a provider's images and embedded resources.
    const ready = await boundedPageOperation(executePageScript(contents,
      'document.readyState !== "loading" && !document.documentURI.startsWith("chrome-error:") && !!document.body?.children.length'));
    return ready === true && !contents.isDestroyed() && contents.getURL() === url;
  }
  private pageHealthy(id: string): void {
    const recovery = this.recoveries.get(id);
    if (!recovery || this.errors.has(id)) return;
    if (recovery.healthySince === undefined && recovery.attempts > 0) this.diagnostics?.record('page_recovery_loaded');
    recovery.healthySince ??= Date.now();
    // A briefly visible page must not reset the budget of a repeatedly failing renderer.
    if (Date.now() - recovery.healthySince >= 60_000) recovery.attempts = 0;
  }
  private endConversationRecovery(id: string, recovered = true): void {
    const recovery = this.recoveries.get(id);
    if (!recovery) return;
    clearTimeout(recovery.timer); recovery.timer = undefined;
    if (recovered && recovery.conversationUrl) this.diagnostics?.record(recovery.conversationFailure === 'reply_connection' ? 'reply_connection_recovered' : 'conversation_load_recovered');
    recovery.conversationUrl = undefined; recovery.conversationAttempts = 0; recovery.conversationFailure = undefined;
    recovery.connectionKey = undefined; recovery.connectionSince = undefined;
  }
  private releaseConversationRecovery(id: string): void {
    this.endConversationRecovery(id, false);
    if ([CONVERSATION_LOAD_ERROR, REPLY_CONNECTION_ERROR].includes(this.errors.get(id) ?? '')) {
      this.errors.delete(id); this.layout(); this.changed();
    }
  }
  private preserveSiteFailure(id: string, contents: WebContents): void {
    const hidden = this.errors.delete(id);
    const loading = this.pageLoading(contents);
    this.usableContents.add(contents);
    this.endConversationRecovery(id, false);
    if (hidden || loading) { this.layout(); this.changed(); }
  }
  private connectionFailureStable(recovery: RecoveryState, key: string | undefined): boolean {
    if (!key) return false;
    if (recovery.connectionKey !== key) {
      clearTimeout(recovery.timer); recovery.timer = undefined;
      recovery.connectionKey = key; recovery.connectionSince = Date.now();
    }
    return Date.now() - (recovery.connectionSince ?? Date.now()) >= COMPLETION_STABLE_MS;
  }
  private async checkStalledLoad(id: string, view: WebContentsView, generation: number): Promise<void> {
    const contents = view.webContents;
    const current = () => this.views.get(id) === view && this.loadGenerations.get(view) === generation;
    if (!contents || !current() || contents.isDestroyed() || !this.pageLoading(contents)) return;
    if ((isAccountLoginUrl(contents.getURL()) || this.owners.get(id)?.customLink) && !contents.isWaitingForResponse() && !this.hasUncommittedNavigation(view)) {
      try {
        const ready = await this.loginDocumentReady(id, contents);
        if (!current() || contents.isDestroyed()) return;
        if (ready) {
          this.usableContents.add(contents); this.errors.delete(id); this.pageHealthy(id);
          this.diagnostics?.record('login_resource_load_pending');
          this.layout(); this.changed(); return;
        }
      } catch { /* A genuinely stalled login document can still be recovered. */ }
    }
    // isLoading() includes images and iframes. A usable composer must remain visible
    // and queueable even if an unrelated resource never finishes loading.
    if (isChatUrl(contents.getURL()) && !contents.isWaitingForResponse() && !this.hasUncommittedNavigation(view)) {
      try {
        const page = pageOperationResult<Page>(await boundedPageOperation(executePageScript(contents, pageOperationScript({ kind: 'inspect' }))));
        if (!current() || contents.isDestroyed()) return;
        if (page.loadFailure && !this.hasAutomaticRecovery(id)) {
          this.preserveSiteFailure(id, contents); return;
        }
        if (page.editor && page.readiness === 'ready') {
          this.usableContents.add(contents);
          this.errors.delete(id);
          this.pageHealthy(id);
          this.diagnostics?.record('page_resource_load_pending');
          this.layout(); this.changed(); return;
        }
      } catch { /* A hung renderer is replaced below, not probed indefinitely. */ }
    }
    if (!current() || contents.isDestroyed() || !this.pageLoading(contents)) return;
    this.errors.set(id, PAGE_LOAD_TIMEOUT_ERROR);
    this.diagnostics?.record('page_load_timeout', { mainFrame: contents.isLoadingMainFrame(), waitingResponse: contents.isWaitingForResponse() });
    this.layout(); this.changed();
    this.scheduleRecovery(id, view, 'load_timeout');
  }
  private scheduleRecovery(id: string, view: WebContentsView, reason: RecoveryReason): void {
    if (this.closing || this.views.get(id) !== view) return;
    if (this.recovering.has(id)) {
      this.deferredRecoveries.set(id, { view, generation: this.loadGenerations.get(view), reason });
      return;
    }
    const state = this.recoveries.get(id) ?? { attempts: 0 };
    const contents = view.webContents;
    const navigationTarget = this.pendingNavigations.get(view) ?? (contents && !contents.isDestroyed() ? contents.getURL() : '');
    const target = replyPageUrl(navigationTarget || this.owners.get(id)?.url || '');
    if (state.conversationUrl && state.conversationUrl !== target) {
      clearTimeout(state.timer); state.timer = undefined;
      state.conversationUrl = undefined; state.conversationAttempts = 0; state.conversationFailure = undefined;
      state.connectionKey = undefined; state.connectionSince = undefined;
    }
    // Keep the same conversation's recovery alive if its next fetch fails at
    // the transport layer. A different destination retains the native budget.
    if (state.conversationUrl && state.conversationUrl === target && ['load_failed', 'load_timeout'].includes(reason)) reason = 'conversation_load';
    if (reason === 'conversation_load' && !this.hasAutomaticRecovery(id)) {
      this.releaseConversationRecovery(id); return;
    }
    state.healthySince = undefined;
    this.recoveries.set(id, state);
    if (state.timer || (reason !== 'conversation_load' && state.attempts >= MAX_PAGE_RECOVERIES)) return;
    // Preserve a known human draft on a responsive page. Main-frame loads and
    // crashed pages have no usable document to preserve.
    const owner = this.owners.get(id);
    if (owner?.hasDraft && contents && !contents.isDestroyed() && !contents.isCrashed() && !this.pageLoading(contents) && !this.hasUncommittedNavigation(view)) return;
    const generation = this.loadGenerations.get(view);
    const attempts = reason === 'conversation_load' ? state.conversationAttempts ?? 0 : state.attempts;
    // A failed conversation fetch is commonly transient. Continue at a bounded
    // low frequency instead of permanently requiring repeated manual refreshes.
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.closing || this.views.get(id) !== view || this.loadGenerations.get(view) !== generation || !this.errors.has(id)) return;
      void this.recoverPage(id, view, reason).catch(error => this.recoveryFailed(id, view, error));
    }, Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)));
  }
  private recoveryFailed(id: string, view: WebContentsView, error: unknown): void {
    this.diagnostics?.error('page_recovery_failed', error);
    if (!this.closing && this.views.get(id) === view) {
      this.errors.set(id, '网页恢复未完成，请点击“恢复页面”重试');
      this.layout(); this.changed();
    }
  }
  private recoverPage(id: string, view: WebContentsView, reason: RecoveryReason): Promise<void> {
    const pending = this.recovering.get(id);
    if (pending) {
      if (reason === 'manual') this.deferredRecoveries.set(id, { view, generation: this.loadGenerations.get(view), reason });
      return pending;
    }
    const operation = this.rebuildPage(id, view, reason);
    this.recovering.set(id, operation);
    void operation.finally(() => {
      if (this.recovering.get(id) !== operation) return;
      this.recovering.delete(id);
      const deferred = this.deferredRecoveries.get(id);
      this.deferredRecoveries.delete(id);
      if (deferred && this.views.get(id) === deferred.view && this.loadGenerations.get(deferred.view) === deferred.generation) {
        if (deferred.reason === 'manual') {
          const contents = deferred.view.webContents;
          if (this.errors.has(id) || contents && !contents.isDestroyed() && this.pageLoading(contents))
            void this.recoverPage(id, deferred.view, 'manual').catch(error => this.recoveryFailed(id, deferred.view, error));
        } else if (this.errors.has(id)) this.scheduleRecovery(id, deferred.view, deferred.reason);
      }
    }).catch(() => {});
    return operation;
  }
  private async rebuildPage(id: string, view: WebContentsView, reason: RecoveryReason): Promise<void> {
    const owner = this.owners.get(id);
    if (this.closing || !owner || this.views.get(id) !== view) return;
    const generation = this.loadGenerations.get(view);
    const current = () => !this.closing && this.owners.get(id) === owner && this.views.get(id) === view &&
      this.loadGenerations.get(view) === generation && (reason === 'manual' || this.errors.has(id)) &&
      (reason !== 'conversation_load' || this.hasAutomaticRecovery(id));
    const contents = view.webContents;
    const stillDamaged = async () => {
      if (!current()) return false;
      if (reason === 'manual' || !contents || contents.isDestroyed() || contents.isCrashed()) return true;
      if (reason === 'conversation_load' && owner.hasDraft) {
        if (this.errors.get(id) === REPLY_CONNECTION_ERROR) {
          this.errors.delete(id); this.layout(); this.changed();
        }
        return false;
      }
      if (this.hasUncommittedNavigation(view)) {
        // The previous document can still accept a draft or start a reply while
        // navigation waits. Preserve either in place; a ready old document cannot cancel
        // recovery of the requested destination. Never inspect provider forms.
        const previousUrl = contents.getURL();
        if (isChatUrl(previousUrl) && !isAccountLoginUrl(previousUrl) && !hasAuthorizationParameters(previousUrl) && !owner.customLink) {
          try {
            const page = pageOperationResult<Page>(await boundedPageOperation(executePageScript(contents, pageOperationScript({ kind: 'inspect' }))));
            if (!current()) return false;
            if (contents.getURL() === previousUrl && this.hasUncommittedNavigation(view) && page.editor) {
              Object.assign(owner, { hasDraft: !!page.draft.trim(), busy: page.busy });
              if (owner.hasDraft || owner.busy) {
                this.usableContents.add(contents); this.errors.delete(id);
                this.layout(); this.changed(); return false;
              }
            }
          } catch {
            // A failed probe must not discard a draft or reply observed in this
            // document. A later observation can release the deferred navigation.
            if (current() && (owner.hasDraft || owner.busy)) {
              this.usableContents.add(contents); this.errors.delete(id);
              this.layout(); this.changed(); return false;
            }
          }
        }
        return current() && this.hasUncommittedNavigation(view);
      }
      if (contents.isWaitingForResponse()) return true;
      try {
        if (await this.loginDocumentReady(id, contents)) {
          if (!current()) return false;
          this.usableContents.add(contents); this.errors.delete(id); this.pageHealthy(id);
          this.layout(); this.changed(); return false;
        }
        const page = pageOperationResult<Page>(await boundedPageOperation(executePageScript(contents, pageOperationScript({ kind: 'inspect' }))));
        if (!current()) return false;
        if (page.loadFailure && !this.hasAutomaticRecovery(id)) {
          this.preserveSiteFailure(id, contents); return false;
        }
        const recovery = this.recoveries.get(id);
        if (reason === 'conversation_load' && recovery?.conversationUrl && replyPageUrl(page.url) !== recovery.conversationUrl) {
          this.errors.delete(id); this.endConversationRecovery(id);
          this.layout(); this.changed(); return false;
        }
        if (reason === 'conversation_load' && page.loadFailure === 'reply_connection') {
          Object.assign(owner, { hasDraft: !!page.draft.trim(), busy: page.busy });
          return !owner.hasDraft && !!recovery && this.connectionFailureStable(recovery, page.connectionKey);
        }
        if (reason === 'conversation_load' && !page.loadFailure &&
          (page.editor && page.readiness === 'ready' || page.busy || page.readiness === 'login_required' || page.readiness === 'verification_required')) {
          this.errors.delete(id);
          this.endConversationRecovery(id);
          this.layout(); this.changed();
          return false;
        }
        if (page.editor && page.readiness === 'ready') {
          this.usableContents.add(contents); this.errors.delete(id);
          Object.assign(owner, { hasDraft: !!page.draft.trim(), busy: page.busy });
          this.pageHealthy(id); this.layout(); this.changed();
          return false;
        }
      } catch {
        // An observer can learn about a new human draft while a queued probe
        // fails. Keep that responsive document instead of discarding its input.
        if (reason === 'conversation_load' && owner.hasDraft) return false;
      }
      return current();
    };
    if (!await stillDamaged()) return;
    const state = this.recoveries.get(id) ?? { attempts: 0 };
    clearTimeout(state.timer); state.timer = undefined; state.healthySince = undefined;
    if (reason === 'manual') { state.attempts = 0; this.endConversationRecovery(id); }
    if (reason === 'conversation_load') state.conversationAttempts = (state.conversationAttempts ?? 0) + 1;
    else state.attempts++;
    this.recoveries.set(id, state);
    const isolated = session.fromPartition(this.accounts.get(owner.accountId).partition);
    // Closing the session's connection pool affects EVERY page in this account.
    // Reset only this damaged account's sole live page with no login popup.
    // A locked conversation-fetch failure is safe: its send receipt survives,
    // and other accounts and healthy sibling replies remain untouched.
    const canResetConnections = (!this.isLocked(id) || reason === 'conversation_load') && ![...this.views].some(([otherId, other]) => {
      const otherContents = other.webContents;
      return otherId !== id && otherContents && !otherContents.isDestroyed() && otherContents.session === isolated;
    }) && ![...this.popups.values()].some(popups => [...popups].some(popup => !popup.isDestroyed() && popup.webContents.session === isolated));
    this.diagnostics?.record('page_recovery_started', { reason,
      attempt: reason === 'conversation_load' ? state.conversationAttempts : state.attempts, resetConnections: canResetConnections });
    if (canResetConnections) {
      try { await boundedPageOperation(Promise.all([isolated.closeAllConnections(), isolated.clearHostResolverCache()])); }
      catch (error) { this.diagnostics?.error('page_connection_reset_failed', error); }
    }
    if (!current() || !await stillDamaged()) return;
    state.connectionKey = undefined; state.connectionSince = undefined;
    const selected = this.accounts.activeId() === owner.accountId && this.selected.get(owner.accountId) === id;
    // Preserve a user's requested conversation if its main-frame response never
    // arrives. Agent-locked pages always retain their original pinned destination.
    const pendingUrl = this.pendingNavigations.get(view);
    // OAuth URLs may contain state or authorization parameters. Keep the active
    // login destination only in memory; never overwrite persisted conversation URLs.
    const currentUrl = contents && !contents.isDestroyed() ? contents.getURL() : undefined;
    const navigationUrl = pendingUrl && this.allowedPageNavigation(id, pendingUrl) ? pendingUrl : undefined;
    const transientUrl = navigationUrl
      ? this.isLocked(id) && !isAccountLoginUrl(navigationUrl) ? undefined : navigationUrl
      : currentUrl && (isAccountLoginUrl(currentUrl) || owner.customLink && this.allowedPageNavigation(id, currentUrl)) ? currentUrl : undefined;
    if (!owner.customLink && !this.isLocked(id) && navigationUrl && replyPageUrl(navigationUrl) && !hasAuthorizationParameters(navigationUrl)) owner.url = navigationUrl;
    // Replace only the native page. Owner, tab, conversation and persisted send
    // receipts survive, so a submitted message is read back rather than replayed.
    this.destroyView(id);
    this.errors.delete(id);
    this.openView(id, transientUrl);
    if (selected) this.activate(owner.accountId, id);
    this.layout(); this.changed();
    this.diagnostics?.record('page_recovery_recreated', { reason });
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
  private rememberAuthorization(contents: WebContents, pageId: string, url: string): void {
    const owner = this.owners.get(pageId);
    if (!owner) return;
    // Providers may expose redirect_uri only after the initial pasted link.
    // Keep it in memory; never replace it with an unrelated provider's callback.
    if (isNativeAppAuthorizationSource(url)) {
      try { owner.callbackUrl = authorizationCallback(url) ?? owner.callbackUrl; }
      catch { /* Ambiguous callbacks receive no new navigation exception. */ }
    }
    if (this.allowedPageNavigation(pageId, url)) this.authorizationNavigations.set(contents, url);
  }
  private cancelAppNavigation(contents: WebContents, pageId: string): void {
    const view = this.views.get(pageId);
    if (!view || view.webContents !== contents) return;
    // Allowing or rejecting an OS handoff intentionally cancels Chromium's main navigation.
    // It must not be mistaken for a stalled callback and replayed by recovery.
    this.pendingNavigations.delete(view);
    clearTimeout(this.loadTimers.get(pageId)); this.loadTimers.delete(pageId);
    this.loadGenerations.set(view, (this.loadGenerations.get(view) ?? 0) + 1);
    if ([PAGE_NAVIGATION_INCOMPLETE_ERROR, PAGE_LOAD_TIMEOUT_ERROR].includes(this.errors.get(pageId) ?? '')) {
      this.errors.delete(pageId);
      const recovery = this.recoveries.get(pageId);
      clearTimeout(recovery?.timer);
      if (recovery) recovery.timer = undefined;
    }
    this.changed();
  }
  private async externalApp(contents: WebContents, pageId: string, url: string, source: string): Promise<void> {
    if (!isCodexAppUrl(url) || contents.isDestroyed()) return;
    const owner = this.owners.get(pageId), callback = owner?.callbackUrl, documentUrl = contents.getURL();
    const target = new URL(url);
    const openCodex = target.hostname === 'threads' && target.pathname === '/new' && !target.search && !target.hash;
    if (!openCodex && !isAuthorizationCallback(url, callback)) return;
    const current = () => !!owner && this.owners.get(pageId) === owner && owner.callbackUrl === callback &&
      !this.closing && !this.window.isDestroyed() && !contents.isDestroyed() && contents.getURL() === documentUrl &&
      this.activeId === pageId && this.accounts.activeId() === owner.accountId && !this.backgrounded() &&
      !this.isInteractionLocked(pageId, contents) &&
      (this.views.get(pageId)?.webContents === contents || [...this.popups.get(pageId) ?? []].some(popup =>
        !popup.isDestroyed() && popup.webContents === contents && popup.isVisible()));
    if (!current() || !isNativeAppAuthorizationSource(source, callback)) return;
    const requests = this.externalAppRequests.get(pageId) ?? new Set<string>();
    const previous = this.lastAppLaunch.get(pageId);
    if (requests.has(url) || previous?.url === url && Date.now() - previous.time < 3000) return;
    requests.add(url); this.externalAppRequests.set(pageId, requests);
    try {
      const answer = await dialog.showMessageBox(this.window, { type: 'question', title: '打开 Codex',
        message: '在 Codex 中继续？', detail: '此授权页面请求打开已安装的 Codex 客户端。',
        buttons: ['取消', '打开 Codex'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1 || !current()) return;
      try {
        await shell.openExternal(url);
        this.lastAppLaunch.set(pageId, { url, time: Date.now() });
      } catch {
        // OS errors can echo the callback's secret query parameters.
        if (current()) await dialog.showMessageBox(this.window, { type: 'info', title: '无法打开 Codex',
          message: '未能打开 Codex，请确认已安装 Codex 后重试。', buttons: ['知道了'] });
      }
    } catch { /* Closing the host during a prompt must not crash the runtime. */ }
    finally { requests.delete(url); if (!requests.size) this.externalAppRequests.delete(pageId); }
  }
  private secure(contents: WebContents, pageId: string, partition: string): void {
    contents.on('before-input-event', event => { if (this.isInteractionLocked(pageId, contents)) event.preventDefault(); });
    contents.on('before-mouse-event', event => { if (this.isInteractionLocked(pageId, contents)) event.preventDefault(); });
    contents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) this.rememberAuthorization(contents, pageId, details.url);
    });
    contents.on('did-navigate', () => this.authorizationNavigations.delete(contents));
    contents.on('did-stop-loading', () => this.authorizationNavigations.delete(contents));
    contents.on('will-frame-navigate', event => {
      if (!event.isMainFrame && isCodexAppUrl(event.url)) event.preventDefault();
    });
    contents.on('will-navigate', event => {
      const url = event.url;
      if (this.allowedPageNavigation(pageId, url)) return;
      event.preventDefault();
      if (isCodexAppUrl(url)) {
        this.cancelAppNavigation(contents, pageId);
        if (!event.initiator || event.initiator === contents.mainFrame)
          void this.externalApp(contents, pageId, url, contents.getURL());
      } else void this.external(url);
    });
    contents.on('will-redirect', event => {
      if (event.isMainFrame) this.rememberAuthorization(contents, pageId, event.url);
      if (this.allowedPageNavigation(pageId, event.url)) return;
      event.preventDefault();
      if (event.isMainFrame) this.cancelAppNavigation(contents, pageId);
      if (event.isMainFrame && isCodexAppUrl(event.url)) {
        const source = this.authorizationNavigations.get(contents) ?? contents.getURL();
        if (!event.initiator || event.initiator === contents.mainFrame)
          void this.externalApp(contents, pageId, event.url, source);
      }
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url, referrer }) => {
      const blank = url === 'about:blank' && this.owners.get(pageId)?.customLink;
      if (!blank && !this.allowedPageNavigation(pageId, url)) {
        if (isCodexAppUrl(url)) {
          try {
            const source = contents.getURL();
            const origin = new URL(source).origin;
            // Chromium omits referrers for some non-HTTP window.open calls.
            // Without an initiating frame, accept only a same-origin frame tree.
            const main = contents.mainFrame;
            const sameSource = referrer.url ? new URL(referrer.url).origin === origin :
              !!main.origin && main.origin !== 'null' && main.framesInSubtree.every(frame =>
                !frame.isDestroyed() && !frame.detached && frame.origin === main.origin);
            if (sameSource &&
              isNativeAppAuthorizationSource(source, this.owners.get(pageId)?.callbackUrl))
              void this.externalApp(contents, pageId, url, source);
          } catch { /* A missing or cross-origin popup referrer cannot launch an app. */ }
        } else void this.external(url);
        return { action: 'deny' };
      }
      return { action: 'allow', overrideBrowserWindowOptions: {
        width: 560, height: 760, parent: this.window, autoHideMenuBar: true,
        webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, preload: undefined }
      } };
    });
    contents.on('did-create-window', popup => {
      const windows = this.popups.get(pageId) ?? new Set<BrowserWindow>();
      windows.add(popup); this.popups.set(pageId, windows);
      this.secure(popup.webContents, pageId, partition);
      const syncVisibility = () => {
        if (popup.isDestroyed()) return;
        if (this.isInteractionLocked(pageId, popup.webContents) || this.backgrounded() || this.activeId !== pageId) popup.hide();
        else popup.show();
      };
      popup.webContents.on('did-navigate', syncVisibility).on('did-navigate-in-page', syncVisibility);
      syncVisibility();
      popup.on('closed', () => windows.delete(popup));
    });
  }
  private savePage(id: string, url: string): void {
    const owner = this.owners.get(id); if (!owner) return;
    if (isAccountLoginUrl(url) || hasAuthorizationParameters(url)) return;
    if (owner.customLink || owner.callbackUrl) {
      // Only a committed ChatGPT destination finishes the temporary browser mode.
      // The original authorization link and loopback exception never reach storage.
      owner.customLink = false; owner.callbackUrl = undefined; owner.title = 'ChatGPT';
    }
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
  private createView(accountId: string, url: string, conversationId?: string, customLink = false): string {
    if ([...this.owners.values()].filter(owner => owner.accountId === accountId).length >= 20) throw new AppError('此账号已打开 20 个会话，请关闭不再使用的会话后继续', 409);
    const id = randomUUID();
    this.accounts.get(accountId);
    const callbackUrl = customLink ? authorizationCallback(url) : undefined;
    this.owners.set(id, { accountId, conversationId, url, title: customLink ? '授权页面' : '新会话', customLink, callbackUrl, idleSince: Date.now(),
      hasDraft: false, busy: false, hibernationReady: false });
    this.openView(id);
    this.saveTabs(accountId);
    return id;
  }
  private openView(id: string, initialUrl?: string): WebContentsView {
    const existing = this.views.get(id);
    const existingContents = existing?.webContents;
    if (existingContents && !existingContents.isDestroyed()) return existing!;
    if (existing) this.destroyView(id, false);
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
    const update = () => { if (this.views.get(id) === view && view.webContents && !view.webContents.isDestroyed()) { this.layout(); this.changed(); } };
    const updateTitle = (title: string) => {
      const url = view.webContents.getURL();
      // Login/result pages can include authorization codes in document.title.
      // Keep a neutral title so it cannot survive the subsequent ChatGPT commit.
      owner.title = owner.customLink || owner.callbackUrl || isAccountLoginUrl(url) || hasAuthorizationParameters(url) ? '授权页面' : title || owner.title;
      this.saveTabs(owner.accountId);
    };
    const clearLoadTimer = () => {
      if (this.views.get(id) !== view) return;
      const timer = this.loadTimers.get(id);
      if (timer) clearTimeout(timer);
      this.loadTimers.delete(id);
    };
    const startLoad = () => {
      if (this.views.get(id) !== view) return;
      const generation = (this.loadGenerations.get(view) ?? 0) + 1;
      this.loadGenerations.set(view, generation);
      const recovery = this.recoveries.get(id);
      clearTimeout(recovery?.timer);
      if (recovery) { recovery.timer = undefined; recovery.healthySince = undefined; }
      this.usableContents.delete(view.webContents);
      owner.hibernationReady = false; this.errors.delete(id);
      clearLoadTimer();
      this.loadTimers.set(id, setTimeout(() => {
        void this.checkStalledLoad(id, view, generation).catch(error => this.diagnostics?.error('page_load_probe_failed', error));
      }, this.loadTimeoutMs));
      update();
    };
    view.webContents.on('did-start-loading', startLoad);
    // A main navigation can start while an old image/iframe still keeps the
    // loading spinner active, without another did-start-loading event.
    view.webContents.on('did-start-navigation', details => {
      if (this.views.get(id) !== view || !details.isMainFrame || details.isSameDocument) return;
      const recovery = this.recoveries.get(id);
      if (recovery?.conversationUrl && replyPageUrl(details.url) !== recovery.conversationUrl) this.endConversationRecovery(id);
      this.pendingNavigations.delete(view);
      if (replyPageUrl(details.url) || isAccountLoginUrl(details.url) || owner.customLink && this.allowedPageNavigation(id, details.url)) {
        this.pendingNavigations.set(view, details.url);
      }
      startLoad();
    });
    view.webContents.on('did-stop-loading', () => {
      if (this.views.get(id) !== view) return;
      clearLoadTimer();
      // Chromium can reject a navigation without did-fail-load, leaving the old
      // document visible. Its usable composer does not mean the requested page
      // loaded, and must not cancel the pending destination's recovery.
      if (this.hasUncommittedNavigation(view)) {
        this.errors.set(id, PAGE_NAVIGATION_INCOMPLETE_ERROR);
        this.diagnostics?.record('page_navigation_incomplete');
        this.scheduleRecovery(id, view, 'load_failed');
        update(); return;
      }
      if ([PAGE_LOAD_TIMEOUT_ERROR, PAGE_NAVIGATION_INCOMPLETE_ERROR].includes(this.errors.get(id) ?? '')) this.errors.delete(id);
      const recovery = this.recoveries.get(id);
      if (!this.errors.has(id) && recovery?.timer) { clearTimeout(recovery.timer); recovery.timer = undefined; }
      updateTitle(view.webContents.getTitle()); update();
    });
    view.webContents.on('page-title-updated', (_event, title) => {
      if (this.closing || this.views.get(id) !== view) return;
      updateTitle(title); update();
    });
    const save = (url: string) => { if (!this.closing && this.views.get(id) === view && isChatUrl(url)) this.savePage(id, url); update(); };
    const navigationCommitted = () => {
      this.pendingNavigations.delete(view);
      if (this.views.get(id) === view && this.errors.get(id) === PAGE_NAVIGATION_INCOMPLETE_ERROR) this.errors.delete(id);
    };
    view.webContents.on('did-navigate', (_event, url) => { navigationCommitted(); save(url); });
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) { navigationCommitted(); save(url); }
    });
    view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (this.views.get(id) === view && isMainFrame && code !== -3) {
        clearLoadTimer(); this.errors.set(id, `${description} (${code})`); update();
        this.diagnostics?.record('page_load_failed', { code });
        this.scheduleRecovery(id, view, 'load_failed');
      }
    });
    view.webContents.on('render-process-gone', (_event, details) => {
      if (this.views.get(id) === view) {
        this.errors.set(id, '网页进程中断，正在自动恢复');
        this.diagnostics?.record('page_renderer_gone', { reason: details.reason, exitCode: details.exitCode });
        this.scheduleRecovery(id, view, 'renderer_gone');
      }
      update();
    });
    view.webContents.on('unresponsive', () => {
      if (this.views.get(id) !== view) return;
      this.errors.set(id, '网页暂时没有响应，正在自动恢复');
      this.diagnostics?.record('page_unresponsive');
      this.scheduleRecovery(id, view, 'unresponsive'); update();
    });
    view.webContents.on('responsive', () => {
      if (this.views.get(id) !== view) return;
      if (this.errors.get(id) === '网页暂时没有响应，正在自动恢复') {
        this.errors.delete(id);
        const recovery = this.recoveries.get(id);
        clearTimeout(recovery?.timer);
        if (recovery) recovery.timer = undefined;
        update();
      }
    });
    view.webContents.once('destroyed', () => {
      clearLoadTimer();
      // Chromium is still dispatching destruction here. Mutating the native
      // view tree before that dispatch finishes can stall the main process.
      setImmediate(() => {
        if (this.closing || this.views.get(id) !== view) return;
        try {
          const wasActive = this.activeId === id;
          this.destroyView(id, false);
          if (wasActive) setTimeout(() => {
            try { this.restoreSelectedView(); }
            catch { this.changed(); }
          }, 1000);
        } catch { this.errors.set(id, '网页画面中断，请点击“恢复页面”'); }
        this.changed();
      });
    });
    void view.webContents.loadURL(initialUrl ?? owner.url).catch(() => { /* did-fail-load reports the error to the UI. */ });
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
  private hasAutomaticRecovery(id: string): boolean {
    const owner = this.owners.get(id);
    return !!owner && this.automaticRecoveryTasks.some(task => task.accountId === owner.accountId &&
      (this.taskPage(task) === id || !!task.conversationId && task.conversationId === owner.conversationId));
  }
  private isInteractionLocked(id: string, contents?: WebContents): boolean {
    const page = contents ?? this.views.get(id)?.webContents;
    return this.isLocked(id) && !(page && !page.isDestroyed() && isAccountLoginUrl(page.getURL()));
  }
  private allowedPageNavigation(id: string, url: string): boolean {
    const owner = this.owners.get(id);
    return isAccountNavigation(url) || !!owner?.customLink && isHttpsWebUrl(url) ||
      !isCodexAppUrl(url) && (isAuthorizationCallback(url, owner?.callbackUrl) || isAuthorizationSuccess(url, owner?.callbackUrl));
  }
  pages(): BrowserPage[] {
    return [...this.owners].map(([id, owner]) => {
      const contents = this.views.get(id)?.webContents;
      const live = contents && !contents.isDestroyed();
      const liveUrl = live ? contents.getURL() || owner.url : owner.url;
      const authorization = owner.customLink || owner.callbackUrl || isAccountLoginUrl(liveUrl) || hasAuthorizationParameters(liveUrl);
      return { id, accountId: owner.accountId, conversationId: owner.conversationId,
        url: liveUrl, title: authorization ? '授权页面' : live ? contents.getTitle() || owner.title : owner.title,
        selected: this.selected.get(owner.accountId) === id, locked: this.isLocked(id), sleeping: !live,
        taskId: this.locks.find(task => this.taskPage(task) === id)?.id };
    });
  }
  activate(accountId: string, pageId?: string): void {
    this.accounts.get(accountId);
    if (pageId && this.owners.get(pageId)?.accountId !== accountId) throw new AppError('会话页面不属于此账号', 404);
    const id = pageId ?? this.pageId(accountId) ?? this.createView(accountId,
      this.restoredTabAccounts.has(accountId) ? HOME_URL : this.sessions.restore(accountId)?.url ?? HOME_URL);
    const activeContents = this.activeId ? this.views.get(this.activeId)?.webContents : undefined;
    const restoreFocus = !!activeContents && !activeContents.isDestroyed() && activeContents.isFocused();
    for (const windows of this.popups.values()) for (const popup of windows) popup.hide();
    if (this.activeId && this.activeId !== id && this.views.has(this.activeId)) {
      const previous = this.owners.get(this.activeId); if (previous) previous.idleSince = Date.now();
      const previousView = this.views.get(this.activeId)!;
      if (previousView.webContents && !previousView.webContents.isDestroyed() && this.window.contentView.children.includes(previousView))
        this.window.contentView.removeChildView(previousView);
    }
    const view = this.openView(id);
    this.owners.get(id)!.idleSince = Date.now();
    this.selected.set(accountId, id); this.activeId = id;
    this.saveTabs(accountId);
    if (!this.window.contentView.children.includes(view)) this.window.contentView.addChildView(view);
    for (const popup of this.popups.get(id) ?? []) { if (!this.isInteractionLocked(id, popup.webContents) && this.visible) popup.show(); }
    const url = view.webContents.getURL();
    if (!this.owners.get(id)?.customLink && isChatUrl(url) && !isAccountLoginUrl(url) && !hasAuthorizationParameters(url)) this.sessions.save(accountId, url);
    this.layout();
    if (restoreFocus && this.visible && !this.isInteractionLocked(id)) view.webContents.focus();
    this.changed();
  }
  select(accountId: string, pageId: string): void { this.activate(accountId, pageId); }
  async queueTarget(accountId: string, pageId: string): Promise<Conversation> {
    const owner = this.owners.get(pageId);
    if (!owner || owner.accountId !== accountId) throw new AppError('会话页面已关闭或不属于此账号', 404);
    const contents = this.openView(pageId).webContents;
    if (this.pageLoading(contents)) throw new AppError('页面正在加载，请稍后打开队列', 409);
    const url = contents.getURL();
    const home = replyPageUrl(url) === HOME_URL;
    const page = pageOperationResult<Page>(await executePageScript(contents, pageOperationScript({ kind: 'inspect' })));
    if (contents.isDestroyed() || contents.getURL() !== url || this.owners.get(pageId) !== owner) throw new AppError('页面正在切换，队列将自动重试', 409);
    if (!page.editor) throw new AppError('网页输入框正在加载，队列将自动重试', 409);
    if (owner.conversationId) {
      const existing = this.conversations.get(accountId, owner.conversationId);
      if (this.isLocked(pageId)) return existing;
      if (existing.url === replyPageUrl(url)) {
        if (existing.surface === 'work' && page.surface !== 'work') throw new AppError('正在恢复工作会话，队列将自动重试', 409);
        return this.conversations.register(accountId, existing.url, undefined, page.surface);
      }
      if (existing.binding !== 'bound' && home && (existing.surface ?? 'chat') === (page.surface ?? 'chat')) return existing;
    }
    let conversation: Conversation;
    if (home) {
      if (page.busy || page.messages.length) throw new AppError('等待网页生成会话地址，队列将自动继续', 409);
      conversation = this.conversations.create(accountId, undefined, page.surface ?? 'chat');
    } else conversation = this.conversations.register(accountId, replyPageUrl(url) ?? url, undefined, page.surface);
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
    const contents = view?.webContents;
    if (!contents || !owner || this.activeId !== id || this.backgrounded() || !this.window.isFocused() || this.isLocked(id) || !view.getVisible()) return;
    this.notifications.viewed(owner.accountId, url ?? contents.getURL());
  }
  private restoreSelectedView(): void {
    if (this.closing || this.activeId || this.backgrounded()) return;
    const accountId = this.accounts.activeId();
    const id = accountId ? this.selected.get(accountId) : undefined;
    if (accountId && id && this.owners.has(id) && !this.isInteractionLocked(id)) this.activate(accountId, id);
  }
  private updateVisibility(): void {
    if (!this.backgrounded()) this.restoreSelectedView();
    this.layout();
  }
  setVisible(visible: boolean): void { this.visible = visible; this.updateVisibility(); }
  setBounds(bounds: BrowserBounds): void { this.bounds = bounds; this.layout(); }
  private layout(): void {
    if (!this.activeId || this.window.isDestroyed()) return;
    const view = this.views.get(this.activeId);
    if (!view?.webContents || view.webContents.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    const bounds = this.bounds;
    if (!bounds) { view.setVisible(false); return; }
    const x = Math.min(width, Math.round(bounds.x));
    const y = Math.min(height, Math.round(bounds.y));
    view.setBounds({ x, y, width: Math.max(0, Math.min(Math.round(bounds.width), width - x)),
      height: Math.max(0, Math.min(Math.round(bounds.height), height - y)) });
    view.setVisible(!this.isInteractionLocked(this.activeId) && !this.backgrounded() && bounds.width > 0 && bounds.height > 0 && !this.errors.has(this.activeId));
    this.markViewed(this.activeId);
  }
  page(): PageState | null {
    const contents = this.activeId ? this.views.get(this.activeId)?.webContents : undefined;
    if (!contents || contents.isDestroyed()) return null;
    const owner = this.owners.get(this.activeId!), url = contents.getURL();
    const authorization = owner?.customLink || owner?.callbackUrl || isAccountLoginUrl(url) || hasAuthorizationParameters(url);
    return { id: this.activeId!, conversationId: owner?.conversationId, url, title: authorization ? '授权页面' : contents.getTitle(), loading: this.pageLoading(contents),
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(),
      error: this.errors.get(this.activeId!) };
  }
  async response(task: AgentTask, url?: string): Promise<TaskResponse> {
    const bound = task.conversationId ? this.conversations.get(task.accountId, task.conversationId).url : task.targetUrl;
    if (bound && url && bound !== url) return { taskId: task.id, state: 'unavailable', reason: '指定地址与原任务不一致' };
    const id = url ? [...this.owners].find(([, owner]) => owner.accountId === task.accountId && replyPageUrl(owner.url) === url)?.[0] : this.taskPage(task);
    const contents = id && this.owners.get(id)?.accountId === task.accountId ? this.openView(id).webContents : undefined;
    if (!contents || contents.isDestroyed()) return { taskId: task.id, state: 'unavailable', reason: '请在原账号打开已发送的咨询页面，再用 resume TASK_ID --url 会话地址读取' };
    if (this.pageLoading(contents)) return { taskId: task.id, state: 'reading' };
    const page = pageOperationResult<Page>(await executePageScript(contents, pageOperationScript({ kind: 'inspect' })));
    if (contents.isDestroyed() || contents.getURL() !== page.url) return { taskId: task.id, state: 'reading' };
    return this.replyReader.read(task, page, bound ?? url);
  }
  async inspect(accountId: string, pageId?: string): Promise<BrowserDiagnostics> {
    this.accounts.get(accountId);
    const id = pageId ?? this.pageId(accountId);
    if (id && this.owners.get(id)?.accountId !== accountId) throw new AppError('会话页面不属于此账号', 404);
    const contents = id ? this.openView(id).webContents : undefined;
    const base = { accountId, url: (id ? this.owners.get(id)?.url : this.url(accountId)) ?? HOME_URL, title: '', editor: false, draftLength: 0, busy: false };
    if (!contents || contents.isDestroyed()) return { ...base, readiness: 'not_open', suggestion: '请先在客户端打开此账号，再检查页面；队列未改变' };
    if (this.pageLoading(contents)) return { ...base, readiness: 'loading', suggestion: '页面正在加载，请稍后再次诊断' };
    if (!isChatUrl(contents.getURL())) return { ...base, readiness: 'login_required', suggestion: '请在此账号页面完成登录' };
    try {
      const detail = pageOperationResult<Omit<BrowserDiagnostics, 'accountId' | 'suggestion'>>(await executePageScript(contents, pageOperationScript({ kind: 'diagnose' })));
      const suggestions = { ready: detail.draftLength ? '页面已有草稿，请由人类处理后再继续任务' : detail.busy ? '网页正在回复，请等待完成' : '输入框已就绪；暂停的队列仍需明确恢复',
        loading: '输入框尚未就绪，请稍后再次诊断', verification_required: '请在此账号网页完成验证后继续原任务，不要重复提交',
        login_required: '请在此账号网页完成登录', not_open: '请先打开此账号',
        unavailable: detail.loadFailure === 'conversation' ? '会话加载失败，客户端正在自动重试；原消息和队列保留' : '页面不可用，请在客户端检查' };
      return { ...detail, accountId, suggestion: detail.loadFailure === 'reply_connection'
        ? detail.draftLength ? '网页连接已中断；保留现有草稿，清空后自动重新连接' : '网页连接已中断，客户端会自动重新连接；原消息和队列保留'
        : suggestions[detail.readiness] };
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
      if (this.activeId === id && this.visible && !this.pageLoading(contents) && isChatUrl(url)) {
        try {
          await executePageScript(contents, pageOperationScript({ kind: 'follow_latest', url }));
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
      if (!contents || contents.isDestroyed() || !isChatUrl(contents.getURL())) continue;
      if (this.pageLoading(contents)) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const busy = await Promise.race([
          executePageScript(contents, pageOperationScript({ kind: 'activity' })).then(value => pageOperationResult<ActivitySnapshot>(value).busy),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), 3000); })
        ]);
        if (busy) return true;
      } catch { return true; }
      finally { clearTimeout(timer); }
    }
    return false;
  }
  private async waitUntilLoaded(id: string): Promise<void> {
    const deadline = Date.now() + 30000;
    while (true) {
      // Recovery can replace the contents while this navigation is waiting.
      const contents = this.views.get(id)?.webContents;
      if (!contents || contents.isDestroyed()) throw new AppError('会话页面已中断，请重新打开');
      if (!this.pageLoading(contents)) return;
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
  }
  openLink(accountId: string, value: string): BrowserPage {
    const url = webLink(value);
    const id = this.createView(accountId, url, undefined, true);
    this.accounts.activate(accountId);
    this.activate(accountId, id);
    return this.pages().find(page => page.id === id)!;
  }
  control(accountId: string, action: string): void {
    const id = this.pageId(accountId); if (!id) return;
    if (this.isInteractionLocked(id)) throw new AppError('请先接管当前会话');
    const selectedContents = this.views.get(id)?.webContents;
    if (action === 'reload' && (this.activeId !== id || !selectedContents || selectedContents.isDestroyed())) {
      this.activate(accountId, id);
      return;
    }
    const contents = this.openView(id).webContents;
    if (action === 'reload') {
      if (this.pageLoading(contents) || this.errors.has(id) || contents.isCrashed() || !this.allowedPageNavigation(id, contents.getURL())) {
        const view = this.views.get(id)!;
        void this.recoverPage(id, view, 'manual').catch(error => this.recoveryFailed(id, view, error));
      } else contents.reload();
    }
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
    this.externalAppRequests.delete(id); this.lastAppLaunch.delete(id);
    this.recoveries.delete(id);
    this.deferredRecoveries.delete(id);
    for (const [taskId, pageId] of this.taskPages) if (pageId === id) this.taskPages.delete(taskId);
    if (owner && this.selected.get(owner.accountId) === id) {
      const next = [...this.owners].find(([, item]) => item.accountId === owner.accountId)?.[0];
      if (next) this.selected.set(owner.accountId, next); else this.selected.delete(owner.accountId);
    }
    if (owner) this.saveTabs(owner.accountId);
  }
  private destroyView(id: string, detach = true): void {
    const loadTimer = this.loadTimers.get(id);
    if (loadTimer) clearTimeout(loadTimer);
    this.loadTimers.delete(id);
    const recovery = this.recoveries.get(id);
    clearTimeout(recovery?.timer);
    if (recovery) recovery.timer = undefined;
    this.observing.delete(id);
    this.previews.delete(id);
    this.previewAwaken.delete(id);
    this.previewStale.delete(id);
    this.previewFrames.delete(id);
    const owner = this.owners.get(id);
    if (owner?.lastUrl) this.observer.disconnected(owner.accountId, owner.lastUrl);
    if (owner) { owner.lastUrl = undefined; owner.hibernationReady = false; owner.activityKey = undefined; }
    for (const popup of this.popups.get(id) ?? []) if (!popup.isDestroyed()) popup.destroy();
    this.popups.delete(id);
    const view = this.views.get(id);
    if (view) {
      const contents = view.webContents;
      if (this.activeId === id) {
        if (detach && contents && !contents.isDestroyed() && !this.window.isDestroyed() && this.window.contentView.children.includes(view))
          this.window.contentView.removeChildView(view);
        this.activeId = null;
      }
      this.views.delete(id);
      if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    }
  }
  private hibernateIfIdle(id: string, view: WebContentsView): void {
    const owner = this.owners.get(id);
    const contents = view.webContents;
    // Keep one warm page per account so switching accounts reattaches the same
    // WebContents without loading ChatGPT again. Other idle tabs may still sleep.
    if (owner && this.selected.get(owner.accountId) === id) return;
    if (owner?.conversationId && this.conversations.get(owner.accountId, owner.conversationId).binding === 'uncertain') return;
    const idleMs = this.backgrounded() ? this.hiddenIdlePageMs : this.idlePageMs;
    if (!owner || this.views.get(id) !== view || this.activeId === id && !this.backgrounded() || this.isLocked(id) || this.redirectingDuplicates.has(id) || this.observing.has(id) ||
      owner.hasDraft || owner.busy || !owner.hibernationReady || Date.now() - owner.idleSince < idleMs ||
      !contents || contents.isDestroyed() || this.pageLoading(contents) || !isChatUrl(contents.getURL())) return;
    this.destroyView(id);
    this.changed();
  }
  url(accountId: string): string | undefined {
    const id = this.pageId(accountId); const owner = id ? this.owners.get(id) : undefined;
    const contents = id ? this.views.get(id)?.webContents : undefined;
    // An opening tab must never inherit the previous tab's persisted destination.
    return contents && !contents.isDestroyed() ? contents.getURL() || owner?.url : owner?.url;
  }
  setLocked(tasks: AgentTask[], automaticRecoveryTasks: AgentTask[] = []): void {
    this.locks = tasks;
    this.automaticRecoveryTasks = automaticRecoveryTasks;
    for (const [id, recovery] of this.recoveries) {
      if (recovery.conversationUrl && !this.hasAutomaticRecovery(id)) this.releaseConversationRecovery(id);
    }
    for (const taskId of this.taskPages.keys()) if (!tasks.some(task => task.id === taskId)) this.taskPages.delete(taskId);
    for (const id of this.previewFrames.keys()) if (!this.isLocked(id)) {
      this.previewFrames.delete(id); this.previewStale.delete(id); this.previewAwaken.delete(id);
    }
    if (this.activeId && this.isInteractionLocked(this.activeId) && this.views.get(this.activeId)?.webContents?.isFocused()) this.window.webContents.focus();
    for (const [id, popups] of this.popups) for (const popup of popups) {
      if (this.isInteractionLocked(id, popup.webContents) || !this.visible || this.activeId !== id) popup.hide(); else popup.show();
    }
    this.restoreSelectedView();
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
      // Retry the fixed conversation, never another selected tab. Reload only
      // a stalled, empty, idle page; preserve human drafts and active replies.
      if (task.retryCount && conversation?.binding !== 'uncertain' && !this.pageLoading(contents)) {
        let safeToReload = false;
        try {
          const page = pageOperationResult<Page>(await executePageScript(contents, pageOperationScript({ kind: 'inspect' })));
          safeToReload = !page.busy && !page.draft.trim() && page.readiness !== 'login_required' && page.readiness !== 'verification_required' &&
            (!task.sendIntentAt || page.readiness === 'loading');
        } catch { safeToReload = contents.isCrashed(); }
        if (safeToReload) await contents.loadURL(conversation?.url ?? task.targetUrl ?? HOME_URL);
      }
      const result = await new ChatGPTAdapter(contents, signal, context, this.conversations,
        () => this.activeId === pageId && this.visible && !this.backgrounded() ? 250 : 2000,
        () => this.pageLoading(contents)).execute(input);
      signal.throwIfAborted();
      if (input.type === 'prompt' && input.submit && result && typeof result === 'object' && 'url' in result && 'replyToken' in result && typeof result.url === 'string' && typeof result.replyToken === 'string') {
        this.notifications.complete(id, result.url, this.title(id, result.url, contents.getTitle()), result.replyToken);
      }
      return result;
    }
    finally {
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(true);
      if (contents.isDestroyed()) {
        const current = this.views.get(pageId)?.webContents;
        if (!current || current === contents || current.isDestroyed()) this.destroyView(pageId, false);
        // The tab and its conversation queue still belong to the user. The
        // lock release will reattach the selected page after this task fails.
        if (!this.closing) { this.restoreSelectedView(); this.changed(); }
      }
    }
  }
  close(): void { this.closing = true; clearInterval(this.monitor); for (const id of [...this.views.keys()]) this.closeView(id); }
}
