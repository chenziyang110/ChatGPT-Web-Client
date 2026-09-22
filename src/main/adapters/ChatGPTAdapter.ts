import type { WebContents } from 'electron';
import type { ExecutionContext } from '../../core/agent/AgentGateway';
import { QueuePausedError } from '../../core/agent/AgentGateway';
import { ConversationManager, conversationUrl } from '../../core/conversation/ConversationManager';
import { HOME_URL, isChatUrl } from '../../core/validation';
import type { BrowserReadiness, TaskInput } from '../../shared/types';
import { COMPLETION_STABLE_MS, replyToken } from '../../core/notifications/ConversationNotifications';
import { ReplyTurnTracker, type ConversationMessage } from './ReplyTurnTracker';

type Message = ConversationMessage;
export interface Page { url: string; title: string; readiness: BrowserReadiness; editor: boolean; draft: string; busy: boolean; messages: Message[]; error?: string }
interface Operation { kind: 'inspect' | 'diagnose' | 'activity' | 'follow_latest' | 'fill' | 'clear' | 'check_send' | 'send' | 'click' | 'snapshot'; url?: string; anchor?: string; value?: string; selector?: string }

// Electron otherwise replaces page exceptions with an unhelpful "Script failed
// to execute" rejection. Catch inside the page before crossing that boundary.
export function pageOperationScript(operation: Operation): string {
  return `(operation => { try { return { workspacePageResult: true, ok: true, value: (${pageOperation.toString()})(operation) }; }
    catch (error) { return { workspacePageResult: true, ok: false, error: error.message }; } })(${JSON.stringify(operation)})`;
}
export function pageOperationResult<T>(result: unknown): T {
  if (result && typeof result === 'object' && 'workspacePageResult' in result && result.workspacePageResult === true) {
    if ('ok' in result && result.ok === true && 'value' in result) return result.value as T;
    throw new Error('error' in result && typeof result.error === 'string' ? result.error : 'PAGE_SCRIPT_FAILED: invalid page result');
  }
  throw new Error('PAGE_SCRIPT_FAILED: missing page result');
}

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
  let stage = 'inspect';
  try {
    if (location.origin !== 'https://chatgpt.com') throw new Error('LOGIN_REQUIRED: sign in to ChatGPT');
    const visible = (element: Element | null): element is HTMLElement => !!element?.getClientRects().length;
    if (operation.kind === 'follow_latest') {
      stage = 'follow_latest';
      if (operation.url !== location.href) throw new Error('TARGET_CHANGED: page changed before action');
      const latest = [...document.querySelectorAll('[data-message-author-role]')].filter(visible).at(-1);
      if (!latest) return { scrolled: false };
      // Start outside the turn: code blocks and other nested reply widgets may
      // scroll independently. Never target the sidebar or focus the composer.
      const turn = latest.closest('article, [data-testid^="conversation-turn-"]') ?? latest;
      for (let parent = turn.parentElement; parent; parent = parent.parentElement) {
        if (parent.clientHeight <= 0 || parent.scrollHeight <= parent.clientHeight) continue;
        if (parent !== document.scrollingElement && !/^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY)) continue;
        const before = parent.scrollTop;
        parent.scrollTo({ top: parent.scrollHeight, behavior: 'instant' });
        return { scrolled: parent.scrollTop !== before };
      }
      return { scrolled: false };
    }
    const editor = document.querySelector<HTMLElement>('#prompt-textarea');
    const readEditor = (element: HTMLElement | null): string => {
      if (!element) return '';
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
      // ChatGPT's rich editor represents lines as sibling paragraphs. Chromium's
      // innerText inserts TWO newlines between those paragraphs; the editor sends
      // one. Preserve empty paragraphs and explicit line breaks, never collapse
      // arbitrary whitespace (which could hide a real human draft edit).
      const children = [...element.childNodes];
      if (element.isContentEditable && children.length && children.every(node =>
        node instanceof HTMLParagraphElement || (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()))) {
        return children.filter((node): node is HTMLParagraphElement => node instanceof HTMLParagraphElement).map(paragraph => {
          if (paragraph.childNodes.length === 1 && paragraph.firstChild instanceof HTMLBRElement) return '';
          const value = paragraph.innerText;
          return paragraph.lastChild instanceof HTMLBRElement && paragraph.lastChild.classList.contains('ProseMirror-trailingBreak')
            ? value.replace(/\n$/, '') : value;
        }).join('\n');
      }
      return element.innerText;
    };
    const draft = readEditor(editor);
    // The document can finish loading while React or the site's verification page
    // is still initializing. Inspect those states without attempting a challenge.
    const verification = !visible(editor) && (!!document.querySelector('#challenge-running, #challenge-stage, #challenge-form, input[id^="cf-chl-widget-"], iframe[src*="challenges.cloudflare.com"]') || /^(请稍候|Just a moment)/i.test(document.title.trim()));
    const login = [...document.querySelectorAll('[data-testid="login-button"], a[href="/auth/login"], a[href^="https://auth.openai.com/"]')].some(visible);
    const readiness: BrowserReadiness = verification ? 'verification_required' : login ? 'login_required' : visible(editor) ? 'ready' : 'loading';
    const busy = [...document.querySelectorAll('[data-testid="stop-button"], [data-is-streaming="true"], [aria-busy="true"]')].some(visible);
    if (operation.kind === 'diagnose') {
      const send = document.querySelector<HTMLButtonElement>('[data-testid="send-button"]');
      const messages = [...document.querySelectorAll<HTMLElement>('[data-message-author-role]')];
      const last = messages.at(-1);
      const turn = last?.closest('article, [data-testid^="conversation-turn-"]') ?? last;
      return { url: location.href, title: document.title.slice(0, 120), readiness,
        editor: visible(editor), draftLength: draft.length, busy, documentReady: document.readyState,
        dom: { editorTag: editor?.tagName.toLowerCase() ?? null, contentEditable: !!editor?.isContentEditable,
          visibleEditorCount: [...document.querySelectorAll('#prompt-textarea')].filter(visible).length,
          draftLineLengths: draft.split('\n').slice(0, 20).map(line => line.length),
          editorBlocks: [...(editor?.children ?? [])].slice(0, 20).map(child => ({ tag: child.tagName.toLowerCase(),
            textLength: child.textContent.length, lineBreaks: child.querySelectorAll('br').length })),
          sendVisible: visible(send), sendEnabled: visible(send) && !send.disabled && send.getAttribute('aria-disabled') !== 'true',
          stopVisible: [...document.querySelectorAll('[data-testid="stop-button"]')].some(visible),
          streamingVisible: [...document.querySelectorAll('[data-is-streaming="true"]')].some(visible),
          ariaBusyVisible: [...document.querySelectorAll('[aria-busy="true"]')].some(visible),
          messageCount: messages.length, lastRole: last?.dataset.messageAuthorRole ?? null,
          lastTurnTerminal: !!turn && [...turn.querySelectorAll('[data-testid="copy-turn-action-button"]')].some(visible) }
      };
    }
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
    stage = 'verify_target';
    if (operation.url !== location.href) throw new Error('TARGET_CHANGED: page changed before action');
    if (operation.kind === 'snapshot') return { url: location.href, title: document.title, text: (document.querySelector('main') ?? document.body).innerText.slice(0, 64000) };
    const anchor = JSON.stringify(messages.filter(message => message.role === 'user').map(message => [message.id, message.text]));
    if (operation.anchor !== anchor || busy) throw new Error('PAGE_CHANGED: conversation is no longer idle');
    if (operation.kind === 'send' || operation.kind === 'check_send') {
      stage = 'verify_send';
      // Textareas and contenteditable normalize Windows file line endings to LF.
      if (draft.replace(/\r\n?/g, '\n').trim() !== operation.value?.replace(/\r\n?/g, '\n').trim()) throw new Error('DRAFT_CHANGED: prompt was edited');
      const button = document.querySelector<HTMLButtonElement>('[data-testid="send-button"]');
      if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') throw new Error('SEND_UNAVAILABLE: prompt remains a draft');
      if (operation.kind === 'check_send') return { ready: true };
      stage = 'click_send';
      button.click(); return { clicked: true };
    }
    stage = 'find_editor';
    const element = document.querySelector<HTMLElement>(operation.selector ?? '#prompt-textarea');
    if (!visible(element) || element.matches(':disabled, [aria-disabled="true"]')) throw new Error('Element unavailable');
    if (element instanceof HTMLInputElement && element.type === 'password') throw new Error('Password fields cannot be automated');
    if (operation.kind === 'click') { element.click(); return { clicked: true }; }
    stage = 'check_draft';
    const existing = readEditor(element);
    if (operation.kind === 'clear') {
      if (existing.replace(/\r\n?/g, '\n').trim() !== operation.value?.replace(/\r\n?/g, '\n').trim()) throw new Error('DRAFT_CHANGED: prompt was edited');
    } else if (existing.trim()) throw new Error('DRAFT_CONFLICT: clear or send the existing draft first');
    const nextValue = operation.kind === 'clear' ? '' : operation.value;
    stage = 'focus_editor';
    element.focus();
    stage = 'write_text';
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, nextValue);
    } else if (element.isContentEditable) {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      if (!document.execCommand('insertText', false, nextValue)) element.textContent = nextValue ?? '';
    } else throw new Error('Element is not editable');
    stage = 'dispatch_input';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
    stage = 'dispatch_change';
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return operation.kind === 'clear' ? { cleared: true } : { prepared: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // Do not persist arbitrary page exception text, which can contain prompt
    // content. Preserve only our known guard messages and safe error names.
    const guards = ['LOGIN_REQUIRED: sign in to ChatGPT', 'TARGET_CHANGED: page changed before action',
      'PAGE_CHANGED: conversation is no longer idle', 'DRAFT_CHANGED: prompt was edited',
      'SEND_UNAVAILABLE: prompt remains a draft', 'Element unavailable', 'Password fields cannot be automated',
      'DRAFT_CONFLICT: clear or send the existing draft first', 'Element is not editable'];
    const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
    throw new Error(`${guards.includes(message) ? message : 'PAGE_SCRIPT_FAILED'} [stage=${stage}; error=${name}]`);
  }
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
    return pageOperationResult<T>(await this.track(this.contents.executeJavaScript(pageOperationScript(operation), true)));
  }
  private inspect(): Promise<Page> { return this.evaluate<Page>({ kind: 'inspect' }); }
  private anchor(page: Page): string { return JSON.stringify(page.messages.filter(message => message.role === 'user').map(message => [message.id, message.text])); }
  private async loaded(): Promise<void> { while (this.contents.isLoading()) await this.delay(); }
  private async idle(): Promise<Page> {
    this.context.stage('waiting_idle', this.context.task().idleTimeoutMs);
    let previous = ''; let since = Date.now();
    let lastSample = Date.now();
    let composerMissingSince = Date.now();
    const composerBudget = Math.min(this.context.task().prepareTimeoutMs ?? 60000, 30000);
    while (true) {
      this.context.checkpoint?.();
      const page = await this.inspect();
      const now = Date.now();
      // A suspend or stalled renderer is not continuous evidence of completion.
      if (now - lastSample > 2000) since = now;
      lastSample = now;
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
      if (ready && Date.now() - since >= (last ? COMPLETION_STABLE_MS : 1000)) return page;
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
    const initial = input.type !== 'snapshot' ? await this.idle() : undefined;
    const conversation = task.conversationId ? this.conversations.get(task.accountId, task.conversationId) : undefined;
    if (conversation?.binding === 'uncertain') throw new Error('NEW_CHAT_UNRESOLVED: inspect the page and register its actual conversation URL; this new conversation will not be created again');
    const target = conversation?.url ?? (conversation ? HOME_URL : task.targetUrl);
    if (!target) throw new Error('TARGET_REQUIRED: choose a conversation');
    if (input.type === 'snapshot' && this.contents.getURL() !== target) await this.idle();
    const navigate = this.contents.getURL() !== target || conversation?.binding === 'new';
    if (navigate) await this.navigate(target);
    if (this.contents.getURL() !== target) throw new Error('TARGET_CHANGED: target redirected');
    if (input.type === 'snapshot') return this.evaluate({ kind: 'snapshot', url: target });
    const baseline = !navigate && initial ? initial : await this.idle();
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
    let prepared = false;
    try {
      this.context.checkpoint?.();
      const result = await this.evaluate({ ...guard, kind: 'fill', selector: input.type === 'fill' ? input.selector : undefined, value });
      prepared = true;
      if (input.type !== 'prompt' || !input.submit) return result;
      await this.delay();
      this.context.checkpoint?.();
      await this.evaluate({ ...guard, kind: 'check_send', value });
      this.context.checkpoint?.();
      this.context.intent();
      if (conversation?.binding === 'new') this.conversations.markSending(task.accountId, conversation.id);
      await this.evaluate({ ...guard, kind: 'send', value });
    } catch (error) {
      if (error instanceof QueuePausedError && prepared && !this.context.task().sendIntentAt) {
        await this.evaluate({ ...guard, kind: 'clear', value });
        await this.delay();
        if ((await this.inspect()).draft.trim()) throw new Error('DRAFT_CONFLICT: 无法确认已清理本次自动填写的草稿，请接管检查');
      }
      throw error;
    }
    this.context.stage('generating', task.replyTimeoutMs);
    const turns = new ReplyTurnTracker(baseline.messages, value);
    let acknowledged = false; let boundUrl = conversation?.url;
    let observedConversationUrl = boundUrl;
    let optimisticUrl: string | undefined;
    let previous = ''; let since = Date.now();
    let lastSample = Date.now();
    while (true) {
      await this.delay();
      const page = await this.inspect();
      const now = Date.now();
      if (now - lastSample > 2000) since = now;
      lastSample = now;
      if (page.error) throw new Error(page.error);
      const replyUrl = replyPageUrl(page.url, !boundUrl && conversation?.binding === 'new');
      const optimistic = replyUrl?.includes('/c/WEB:');
      if (!replyUrl || (observedConversationUrl && replyUrl !== observedConversationUrl)) throw changedReplyTarget(observedConversationUrl ?? HOME_URL, page.url);
      if (optimistic) {
        if (optimisticUrl && replyUrl !== optimisticUrl) throw changedReplyTarget(optimisticUrl, page.url);
        optimisticUrl = replyUrl;
      } else if (replyUrl !== HOME_URL) observedConversationUrl ??= replyUrl;
      const ownUser = turns.read(page.messages);
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
