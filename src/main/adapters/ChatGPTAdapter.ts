import type { WebContents } from 'electron';
import type { ExecutionContext } from '../../core/agent/AgentGateway';
import { ConversationManager, conversationUrl } from '../../core/conversation/ConversationManager';
import { HOME_URL, isChatUrl } from '../../core/validation';
import type { BrowserReadiness, TaskInput } from '../../shared/types';
import { COMPLETION_STABLE_MS, replyToken } from '../../core/notifications/ConversationNotifications';

interface Message { id: string; role: string; text: string; terminal: boolean }
export interface Page { url: string; title: string; readiness: BrowserReadiness; editor: boolean; draft: string; busy: boolean; messages: Message[]; error?: string }
interface Operation { kind: 'inspect' | 'diagnose' | 'activity' | 'fill' | 'check_send' | 'send' | 'click' | 'snapshot'; url?: string; anchor?: string; value?: string; selector?: string }

// During the first send ChatGPT may retain model/UI query parameters and a
// trailing slash while assigning its conversation URL. They are not identity.
// Keep explicit API targets strict; normalize only this observed reply route.
export function replyPageUrl(value: string, allowOptimistic = false): string | undefined {
  if (!isChatUrl(value)) return;
  const url = new URL(value);
  if (url.searchParams.getAll('temporary-chat').some(flag => flag !== 'false' && flag !== '0')) return;
  if (url.pathname === '/') return HOME_URL;
  let pathname: string;
  try { pathname = decodeURI(url.pathname).replace(/%3A/ig, ':'); } catch { return; }
  if (allowOptimistic && /^\/c\/WEB:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/?$/.test(pathname)) return `${url.origin}${pathname.replace(/\/$/, '')}`;
  const match = /^\/c\/([a-zA-Z0-9_-]{1,128})\/?$/.exec(url.pathname);
  return match ? `${HOME_URL}c/${match[1]}` : undefined;
}

function changedReplyTarget(expected: string, actual: string): Error {
  // Include routing evidence for diagnosis without persisting query values.
  let route = 'invalid URL';
  try { const url = new URL(actual); route = `${url.origin}${url.pathname} (query keys: ${[...new Set(url.searchParams.keys())].join(', ') || 'none'})`; } catch { /* Keep the safe fallback. */ }
  return new Error(`TARGET_CHANGED: conversation moved after sending; expected ${expected}, observed ${route}`);
}

// Serialized into the sandboxed website. Keep this function self-contained.
export function pageOperation(operation: Operation): unknown {
  if (location.origin !== 'https://chatgpt.com') throw new Error('LOGIN_REQUIRED: sign in to ChatGPT');
  const visible = (element: Element | null): element is HTMLElement => !!element?.getClientRects().length;
  const editor = document.querySelector<HTMLElement>('#prompt-textarea');
  const draft = editor instanceof HTMLTextAreaElement ? editor.value : editor?.innerText ?? '';
  // The document can finish loading while React or the site's verification page
  // is still initializing. Inspect those states without attempting a challenge.
  const verification = !visible(editor) && (!!document.querySelector('#challenge-running, #challenge-stage, #challenge-form, input[id^="cf-chl-widget-"], iframe[src*="challenges.cloudflare.com"]') || /^(请稍候|Just a moment)/i.test(document.title.trim()));
  const login = [...document.querySelectorAll('[data-testid="login-button"], a[href="/auth/login"], a[href^="https://auth.openai.com/"]')].some(visible);
  const readiness: BrowserReadiness = verification ? 'verification_required' : login ? 'login_required' : visible(editor) ? 'ready' : 'loading';
  const busy = [...document.querySelectorAll('[data-testid="stop-button"], [data-is-streaming="true"], [aria-busy="true"]')].some(visible);
  if (operation.kind === 'diagnose') return { url: location.href, title: document.title.slice(0, 120), readiness,
    editor: visible(editor), draftLength: draft.length, busy, documentReady: document.readyState };
  const elements = [...document.querySelectorAll<HTMLElement>('[data-message-author-role]')];
  const readMessage = (element: HTMLElement, index: number) => {
    const turn = element.closest('article, [data-testid^="conversation-turn-"]') ?? element;
    const body = element.dataset.messageAuthorRole === 'user'
      ? element.querySelector<HTMLElement>('[data-testid="collapsible-user-message-content"]') ?? element : element;
    return { id: element.dataset.messageId ?? `position:${index}`, role: element.dataset.messageAuthorRole ?? '',
      text: body.innerText.trim(), terminal: [...turn.querySelectorAll('[data-testid="copy-turn-action-button"]')].some(visible) };
  };
  const error = [...document.querySelectorAll<HTMLElement>('[data-testid="conversation-error"], [data-testid="error-message"]')].find(visible)?.innerText;
  if (operation.kind === 'activity') {
    let user: Message | undefined; let assistant: Message | undefined;
    for (let index = elements.length - 1; index >= 0 && (!user || !assistant); index--) {
      const role = elements[index].dataset.messageAuthorRole;
      if (role === 'user' && !user) user = readMessage(elements[index], index);
      else if (role === 'assistant' && !assistant) assistant = readMessage(elements[index], index);
    }
    return { url: location.href, title: document.title.slice(0, 120), editor: visible(editor), busy,
      hasDraft: !!draft.trim(), error, user: user && { id: user.id, text: user.text.slice(0, 32000) },
      assistant: assistant && { ...assistant, text: assistant.text.slice(0, 64000) },
      lastRole: elements.at(-1)?.dataset.messageAuthorRole };
  }
  const messages = elements.map(readMessage);
  const page: Page = { url: location.href, title: document.title.slice(0, 120), readiness, editor: visible(editor), draft, busy, messages, error };
  if (operation.kind === 'inspect') return page;
  if (operation.url !== location.href) throw new Error('TARGET_CHANGED: page changed before action');
  if (operation.kind === 'snapshot') return { url: location.href, title: document.title, text: (document.querySelector('main') ?? document.body).innerText.slice(0, 64000) };
  const anchor = JSON.stringify(messages.filter(message => message.role === 'user').map(message => [message.id, message.text]));
  if (operation.anchor !== anchor || busy) throw new Error('PAGE_CHANGED: conversation is no longer idle');
  if (operation.kind === 'send' || operation.kind === 'check_send') {
    // Textareas and contenteditable normalize Windows file line endings to LF.
    if (draft.replace(/\r\n?/g, '\n').trim() !== operation.value?.replace(/\r\n?/g, '\n').trim()) throw new Error('DRAFT_CHANGED: prompt was edited');
    const button = document.querySelector<HTMLButtonElement>('[data-testid="send-button"]');
    if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') throw new Error('SEND_UNAVAILABLE: prompt remains a draft');
    if (operation.kind === 'check_send') return { ready: true };
    button.click(); return { clicked: true };
  }
  const element = document.querySelector<HTMLElement>(operation.selector ?? '#prompt-textarea');
  if (!visible(element) || element.matches(':disabled, [aria-disabled="true"]')) throw new Error('Element unavailable');
  if (element instanceof HTMLInputElement && element.type === 'password') throw new Error('Password fields cannot be automated');
  if (operation.kind === 'click') { element.click(); return { clicked: true }; }
  const existing = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? element.value : element.innerText;
  if (existing.trim()) throw new Error('DRAFT_CONFLICT: clear or send the existing draft first');
  element.focus();
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, operation.value);
  } else if (element.isContentEditable) {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    if (!document.execCommand('insertText', false, operation.value)) element.textContent = operation.value ?? '';
  } else throw new Error('Element is not editable');
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: operation.value }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { prepared: true };
}

export class ChatGPTAdapter {
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly contents: WebContents, private readonly signal: AbortSignal,
    private readonly context: ExecutionContext, private readonly conversations: ConversationManager) {}
  private async wait<T>(promise: Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(this.signal.reason ?? new Error('Cancelled'));
      this.signal.addEventListener('abort', aborted, { once: true });
      promise.then(resolve, reject).finally(() => this.signal.removeEventListener('abort', aborted));
    });
  }
  private async delay(ms = 250): Promise<void> { await this.wait(new Promise<void>(resolve => setTimeout(resolve, ms))); }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return this.wait(promise);
  }
  private async evaluate<T>(operation: Operation): Promise<T> {
    this.signal.throwIfAborted();
    return this.track(this.contents.executeJavaScript(`(${pageOperation.toString()})(${JSON.stringify(operation)})`, true) as Promise<T>);
  }
  private inspect(): Promise<Page> { return this.evaluate<Page>({ kind: 'inspect' }); }
  private anchor(page: Page): string { return JSON.stringify(page.messages.filter(message => message.role === 'user').map(message => [message.id, message.text])); }
  private async loaded(): Promise<void> { while (this.contents.isLoading()) await this.delay(); }
  private async idle(): Promise<Page> {
    this.context.stage('waiting_idle', this.context.task().idleTimeoutMs);
    let previous = ''; let since = Date.now();
    let composerMissingSince = Date.now();
    const composerBudget = Math.min(this.context.task().prepareTimeoutMs ?? 60000, 30000);
    while (true) {
      const page = await this.inspect();
      if (page.error) throw new Error(page.error);
      if (!page.editor || page.readiness === 'login_required' || page.readiness === 'verification_required') {
        if (Date.now() - composerMissingSince >= composerBudget) {
          if (page.readiness === 'login_required') throw new Error('LOGIN_REQUIRED: 请在此账号网页完成登录，再继续原任务');
          if (page.readiness === 'verification_required') throw new Error('VERIFICATION_REQUIRED: 网页停在验证页面，请在此账号完成验证后继续原任务；未发送消息');
          throw new Error(`COMPOSER_NOT_READY: 等待输入框超时，请用 browser inspect 检查此账号页面；未发送消息 (${page.url})`);
        }
        previous = ''; since = Date.now();
        await this.delay(); continue;
      }
      composerMissingSince = Date.now();
      if (page.draft.trim()) throw new Error('DRAFT_CONFLICT: clear or send the existing draft first');
      const last = page.messages.at(-1);
      const ready = !page.busy && (!last || (last.role === 'assistant' && last.terminal));
      const fingerprint = JSON.stringify([page.url, page.messages]);
      if (!ready || previous !== fingerprint) since = Date.now();
      if (ready && Date.now() - since >= 1000) return page;
      previous = fingerprint;
      await this.delay();
    }
  }
  private async navigate(url: string): Promise<void> {
    this.context.stage('preparing', this.context.task().prepareTimeoutMs);
    this.signal.throwIfAborted();
    await this.track(this.contents.loadURL(url)); await this.loaded();
  }
  async execute(input: TaskInput): Promise<unknown> {
    try { return await this.run(input); }
    finally {
      // A cancelled queued script must never execute after the account lock is released.
      if (this.pending.size) {
        let timer: ReturnType<typeof setTimeout>;
        await Promise.race([Promise.allSettled([...this.pending]), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
        clearTimeout(timer!);
        if (this.pending.size && !this.contents.isDestroyed()) this.contents.close({ waitForBeforeUnload: false });
      }
    }
  }
  private async run(input: TaskInput): Promise<unknown> {
    const task = this.context.task();
    await this.loaded();
    if (!isChatUrl(this.contents.getURL())) throw new Error('LOGIN_REQUIRED: sign in to ChatGPT first');
    if (input.type !== 'snapshot') await this.idle();
    const conversation = task.conversationId ? this.conversations.get(task.accountId, task.conversationId) : undefined;
    if (conversation?.binding === 'uncertain') throw new Error('NEW_CHAT_UNRESOLVED: inspect the page and register its actual conversation URL; this new conversation will not be created again');
    const target = conversation?.url ?? (conversation ? HOME_URL : task.targetUrl);
    if (!target) throw new Error('TARGET_REQUIRED: choose a conversation');
    if (input.type === 'snapshot' && this.contents.getURL() !== target) await this.idle();
    if (this.contents.getURL() !== target || conversation?.binding === 'new') await this.navigate(target);
    if (this.contents.getURL() !== target) throw new Error('TARGET_CHANGED: target redirected');
    if (input.type === 'snapshot') return this.evaluate({ kind: 'snapshot', url: target });
    const baseline = await this.idle();
    if (baseline.url !== target) throw new Error('TARGET_CHANGED: conversation changed while waiting');
    if (conversation?.binding === 'new' && baseline.messages.length) throw new Error('NEW_CHAT_UNAVAILABLE: expected an empty conversation');
    if (input.type === 'navigate') return { url: target };
    this.context.stage('preparing_prompt', task.prepareTimeoutMs);
    const guard = { url: target, anchor: this.anchor(baseline) };
    if (input.type === 'click') {
      this.context.intent();
      return this.evaluate({ ...guard, kind: 'click', selector: input.selector });
    }
    const value = input.type === 'prompt' ? input.prompt : input.text;
    const result = await this.evaluate({ ...guard, kind: 'fill', selector: input.type === 'fill' ? input.selector : undefined, value });
    if (input.type !== 'prompt' || !input.submit) return result;
    await this.delay();
    await this.evaluate({ ...guard, kind: 'check_send', value });
    if (conversation?.binding === 'new') this.conversations.markSending(task.accountId, conversation.id);
    this.context.intent();
    await this.evaluate({ ...guard, kind: 'send', value });
    this.context.stage('generating', task.replyTimeoutMs);
    const oldUsers = baseline.messages.filter(message => message.role === 'user');
    let acknowledged = false; let boundUrl = conversation?.url;
    let observedConversationUrl = boundUrl;
    let optimisticUrl: string | undefined;
    let previous = ''; let since = Date.now();
    while (true) {
      await this.delay();
      const page = await this.inspect();
      if (page.error) throw new Error(page.error);
      const replyUrl = replyPageUrl(page.url, !boundUrl && conversation?.binding === 'new');
      const optimistic = replyUrl?.includes('/c/WEB:');
      if (!replyUrl || (observedConversationUrl && replyUrl !== observedConversationUrl)) throw changedReplyTarget(observedConversationUrl ?? HOME_URL, page.url);
      if (optimistic) {
        if (optimisticUrl && replyUrl !== optimisticUrl) throw changedReplyTarget(optimisticUrl, page.url);
        optimisticUrl = replyUrl;
      } else if (replyUrl !== HOME_URL) observedConversationUrl ??= replyUrl;
      const users = page.messages.filter(message => message.role === 'user');
      if (users.length > oldUsers.length + 1 || users.slice(0, oldUsers.length).some((message, index) => message.id !== oldUsers[index].id || message.text !== oldUsers[index].text)) throw new Error('CONVERSATION_CHANGED: another turn appeared');
      const ownUser = users.length === oldUsers.length + 1 ? users.at(-1) : undefined;
      if (ownUser && ownUser.text.replace(/\r\n?/g, '\n') !== value.replace(/\r\n?/g, '\n').trim()) throw new Error('CONVERSATION_CHANGED: submitted turn does not match');
      if (ownUser && !acknowledged) { this.context.submitted(ownUser.id); acknowledged = true; }
      if (acknowledged && !boundUrl && !optimistic && replyUrl !== HOME_URL && conversation) {
        boundUrl = conversationUrl(replyUrl).url;
        this.conversations.bind(task.accountId, conversation.id, boundUrl);
      }
      const last = page.messages.at(-1);
      const userIndex = ownUser ? page.messages.indexOf(ownUser) : -1;
      if (acknowledged && userIndex >= 0 && last?.role === 'assistant' && page.messages.indexOf(last) > userIndex) {
        this.context.progress?.(last.text, boundUrl);
      }
      const finished = acknowledged && !!boundUrl && page.editor && !page.busy && !page.draft.trim() && userIndex >= 0 &&
        page.messages.length > userIndex + 1 && last?.role === 'assistant' && last.terminal && !!last.text;
      const fingerprint = JSON.stringify([replyUrl, page.messages]);
      if (!finished || fingerprint !== previous) since = Date.now();
      if (finished && Date.now() - since >= COMPLETION_STABLE_MS) return { submitted: true, response: last!.text.slice(0, 64000), url: boundUrl, conversationId: conversation?.id, replyToken: replyToken(ownUser!, last!) };
      previous = fingerprint;
    }
  }
}
