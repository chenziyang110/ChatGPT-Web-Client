import { BrowserWindow, WebContentsView, session, dialog, shell, type WebContents } from 'electron';
import { AccountManager } from '../core/account/AccountManager';
import { SessionManager } from '../core/session/SessionManager';
import { AppError, HOME_URL, chatUrl, isAccountNavigation, isChatUrl } from '../core/validation';
import type { PageState, TaskInput } from '../shared/types';

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error('Cancelled'));
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
const pause = (ms: number, signal: AbortSignal) => abortable(new Promise<void>(resolve => setTimeout(resolve, ms)), signal);

// This function is serialized into the unprivileged page. No Node or IPC bridge.
function domAction(input: TaskInput): unknown {
  if (location.origin !== 'https://chatgpt.com') throw new Error('Sign in to ChatGPT before running browser tasks');
  if (input.type === 'snapshot') {
    return { url: location.href, title: document.title, text: (document.querySelector('main') ?? document.body).innerText.slice(0, 64000) };
  }
  const selector = input.type === 'prompt' ? '#prompt-textarea' : ('selector' in input ? input.selector : '');
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  if (!element.getClientRects().length) throw new Error('Element is not visible');
  if (element instanceof HTMLInputElement && element.type === 'password') throw new Error('Password fields cannot be automated');
  if (element.matches(':disabled, [aria-disabled="true"]')) throw new Error('Element is disabled');
  if (input.type === 'click') { element.click(); return { clicked: true }; }
  const value = input.type === 'prompt' ? input.prompt : input.type === 'fill' ? input.text : '';
  element.focus();
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  } else if (element.isContentEditable) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    // insertText preserves the contenteditable editor's native input transaction.
    if (!document.execCommand('insertText', false, value)) element.textContent = value;
  } else { throw new Error('Element is not editable'); }
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { prepared: true };
}

export class BrowserRuntime {
  private readonly views = new Map<string, WebContentsView>();
  private readonly errors = new Map<string, string>();
  private readonly popups = new Map<string, Set<BrowserWindow>>();
  private activeId: string | null = null;
  private visible = true;
  private closing = false;
  private readonly configured = new Set<string>();
  constructor(private readonly window: BrowserWindow, private readonly accounts: AccountManager,
    private readonly sessions: SessionManager, private readonly changed: () => void) {
    window.on('resize', () => this.layout());
  }
  private configureSession(partition: string): void {
    if (this.configured.has(partition)) return;
    const isolated = session.fromPartition(partition);
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
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
      popup.on('closed', () => windows.delete(popup));
    });
  }
  private view(id: string): WebContentsView {
    const existing = this.views.get(id);
    if (existing) return existing;
    const account = this.accounts.get(id);
    this.configureSession(account.partition);
    const view = new WebContentsView({ webPreferences: { partition: account.partition,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, backgroundThrottling: false } });
    this.views.set(id, view);
    this.secure(view.webContents, id, account.partition);
    const update = () => { if (!view.webContents.isDestroyed()) { this.layout(); this.changed(); } };
    view.webContents.on('did-start-loading', () => { this.errors.delete(id); update(); });
    view.webContents.on('did-stop-loading', update);
    view.webContents.on('page-title-updated', update);
    const save = (url: string) => { if (!this.closing && this.views.has(id) && isChatUrl(url)) this.sessions.save(id, url); update(); };
    view.webContents.on('did-navigate', (_event, url) => save(url));
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) save(url); });
    view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { this.errors.set(id, `${description} (${code})`); update(); }
    });
    view.webContents.on('render-process-gone', (_event, details) => { this.errors.set(id, `Page stopped: ${details.reason}. Reload to continue.`); update(); });
    const url = this.sessions.restore(id)?.url ?? HOME_URL;
    void view.webContents.loadURL(url).catch(() => { /* did-fail-load reports the error to the UI. */ });
    return view;
  }
  activate(id: string): void {
    for (const windows of this.popups.values()) for (const popup of windows) popup.hide();
    if (this.activeId && this.views.has(this.activeId)) this.window.contentView.removeChildView(this.views.get(this.activeId)!);
    const view = this.view(id);
    this.activeId = id;
    this.window.contentView.addChildView(view);
    for (const popup of this.popups.get(id) ?? []) popup.show();
    this.layout();
    this.changed();
  }
  setVisible(visible: boolean): void { this.visible = visible; this.layout(); }
  private layout(): void {
    if (!this.activeId || this.window.isDestroyed()) return;
    const view = this.views.get(this.activeId);
    if (!view) return;
    const [width, height] = this.window.getContentSize();
    view.setBounds({ x: 264, y: 96, width: Math.max(0, width - 264), height: Math.max(0, height - 96) });
    view.setVisible(this.visible && !this.errors.has(this.activeId));
  }
  page(): PageState | null {
    const contents = this.activeId ? this.views.get(this.activeId)?.webContents : undefined;
    if (!contents || contents.isDestroyed()) return null;
    return { url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(),
      error: this.errors.get(this.activeId!) };
  }
  navigate(id: string, value: unknown): Promise<void> { return this.view(id).webContents.loadURL(chatUrl(value)); }
  control(id: string, action: string): void {
    const contents = this.view(id).webContents;
    if (action === 'reload') contents.reload();
    else if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (!['back', 'forward'].includes(action)) throw new AppError('Unknown browser action');
  }
  async remove(id: string): Promise<void> {
    const account = this.accounts.get(id);
    this.closeView(id);
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
    for (const popup of this.popups.get(id) ?? []) popup.destroy();
    this.popups.delete(id);
    const view = this.views.get(id);
    if (view) {
      if (this.activeId === id) { this.window.contentView.removeChildView(view); this.activeId = null; }
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
      this.views.delete(id);
    }
  }
  async execute(id: string, input: TaskInput, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (input.type === 'navigate') {
      await abortable(this.navigate(id, input.url), signal);
      return { url: this.view(id).webContents.getURL() };
    }
    const contents = this.view(id).webContents;
    while (contents.isLoading()) await pause(100, signal);
    signal.throwIfAborted();
    if (!isChatUrl(contents.getURL())) throw new AppError('Sign in to ChatGPT before running browser tasks');
    const evaluate = <T>(script: string) => {
      signal.throwIfAborted();
      if (!isChatUrl(contents.getURL())) throw new AppError('Page navigated away from ChatGPT');
      return abortable(contents.executeJavaScript(script, true) as Promise<T>, signal);
    };
    const replyState = `(() => {
      if (location.origin !== 'https://chatgpt.com') throw new Error('Page navigated away');
      const replies = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      return { count: replies.length, text: replies.at(-1)?.innerText?.slice(0, 64000) ?? '',
        streaming: !!document.querySelector('[data-testid="stop-button"]') };
    })()`;
    const baseline = input.type === 'prompt' && input.submit
      ? await evaluate<{ count: number }>(replyState) : undefined;
    const result = await evaluate(`(${domAction.toString()})(${JSON.stringify(input)})`);
    if (input.type !== 'prompt' || !input.submit) return result;
    await pause(200, signal);
    await evaluate(`(() => {
      if (location.origin !== 'https://chatgpt.com') throw new Error('Page navigated away');
      const button = document.querySelector('[data-testid="send-button"]');
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') throw new Error('Send button unavailable; prompt remains a draft');
      button.click();
    })()`);
    let previous = '';
    let stable = 0;
    while (true) {
      await pause(500, signal);
      const reply = await evaluate<{ count: number; text: string; streaming: boolean }>(replyState);
      if (reply.count > baseline!.count && reply.text && !reply.streaming) {
        stable = reply.text === previous ? stable + 1 : 0;
        if (stable >= 2) return { submitted: true, response: reply.text, url: contents.getURL() };
        previous = reply.text;
      } else { stable = 0; }
    }
  }
  close(): void { this.closing = true; for (const id of [...this.views.keys()]) this.closeView(id); }
}
