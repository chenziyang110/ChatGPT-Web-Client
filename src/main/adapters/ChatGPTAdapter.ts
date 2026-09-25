import type { WebContents } from 'electron';
import type { ExecutionContext } from '../../core/agent/AgentGateway';
import { ReportedReplyError } from '../../core/agent/AgentGateway';
import { ConversationManager, conversationUrl } from '../../core/conversation/ConversationManager';
import { HOME_URL, isChatUrl } from '../../core/validation';
import type { BrowserReadiness, Conversation, TaskInput } from '../../shared/types';
import { COMPLETION_STABLE_MS, replyToken } from '../../core/notifications/ConversationNotifications';
import { ReplyTurnTracker, type ConversationMessage } from './ReplyTurnTracker';

type Message = ConversationMessage;
export interface Page { url: string; title: string; readiness: BrowserReadiness; editor: boolean; draft: string; busy: boolean; messages: Message[]; error?: string; failure?: 'thinking' | 'interrupted' }
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
  if (allowOptimistic && /^\/c\/(?:WEB|local-chatgpt):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/?$/.test(pathname)) return `${url.origin}${pathname.replace(/\/$/, '')}`;
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
    const visible = (element: Element | null | undefined): element is HTMLElement => !!element?.getClientRects().length;
    // Both schemas are observed on live ChatGPT accounts. Do not use generated
    // CSS classes, translated placeholder text, or an arbitrary page textbox.
    const editorSelector = '#prompt-textarea, [data-chatgpt-composer] [contenteditable="true"][role="textbox"]';
    const editor = [...document.querySelectorAll<HTMLElement>(editorSelector)].find(visible) ?? null;
    const composer = editor?.closest('[data-chatgpt-composer]');
    const composerButtons = [...(composer ?? document).querySelectorAll<HTMLButtonElement>('button')].filter(visible);
    const actionLabel = (button: HTMLElement) => (button.getAttribute('aria-label') ?? '').trim();
    const sendButton = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="send-button"]')].find(visible) ??
      (composer ? composerButtons.find(button => button.type === 'submit' && /^(发送|发送消息|Send|Send message|Send prompt)$/i.test(actionLabel(button))) : undefined);
    const messageSelector = '[data-message-author-role], [data-chatgpt-search-unit-key]';
    const roleOf = (element: HTMLElement) => element.dataset.messageAuthorRole ??
      element.getAttribute('data-chatgpt-search-unit-key')?.match(/:(user|assistant)$/)?.[1] ?? '';
    const elements = [...document.querySelectorAll<HTMLElement>(messageSelector)].filter(element =>
      ['user', 'assistant'].includes(roleOf(element)) && !element.parentElement?.closest(messageSelector));
    const turnOf = (element: Element) => element.closest('article, [data-testid^="conversation-turn-"], [data-turn-key]') ?? element;
    if (operation.kind === 'follow_latest') {
      stage = 'follow_latest';
      if (operation.url !== location.href) throw new Error('TARGET_CHANGED: page changed before action');
      const latest = elements.filter(visible).at(-1);
      if (!latest) return { scrolled: false };
      // Start outside the turn: code blocks and other nested reply widgets may
      // scroll independently. Never target the sidebar or focus the composer.
      const turn = turnOf(latest);
      for (let parent = turn.parentElement; parent; parent = parent.parentElement) {
        if (parent.clientHeight <= 0 || parent.scrollHeight <= parent.clientHeight) continue;
        if (parent !== document.scrollingElement && !/^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY)) continue;
        const before = parent.scrollTop;
        parent.scrollTo({ top: parent.scrollHeight, behavior: 'instant' });
        return { scrolled: parent.scrollTop !== before };
      }
      return { scrolled: false };
    }
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
    const lastUserElement = elements.filter(element => roleOf(element) === 'user' && visible(element)).at(-1);
    const afterLastUser = (element: Element) => !lastUserElement || !!(lastUserElement.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    const currentAssistant = elements.filter(element => roleOf(element) === 'assistant' && visible(element) && afterLastUser(element)).at(-1);
    const currentTurn = currentAssistant ? turnOf(currentAssistant) : lastUserElement ? turnOf(lastUserElement) : undefined;
    const terminalAction = (turn: Element | null | undefined) => !!turn && [...turn.querySelectorAll<HTMLElement>('[data-testid="copy-turn-action-button"], .turn-action-controls button')]
      .some(button => visible(button) && (button.getAttribute('data-testid') === 'copy-turn-action-button' || /^(复制|Copy|Copy response)$/i.test(actionLabel(button))));
    // Sidebar loaders and completed image widgets can retain aria-busy. They
    // are not evidence that the current reply is still streaming.
    const stopVisible = [...document.querySelectorAll('[data-testid="stop-button"]')].some(visible) ||
      !!composer && composerButtons.some(button => /^(停止|停止生成|停止回复|Stop|Stop generating|Stop response)$/i.test(actionLabel(button)));
    const streamingVisible = !terminalAction(currentTurn) &&
      [...document.querySelectorAll('main [data-is-streaming="true"]')].some(element => visible(element) && afterLastUser(element));
    const ariaBusyVisible = !!currentTurn && !terminalAction(currentTurn) &&
      (currentTurn.matches('[aria-busy="true"]') || [...currentTurn.querySelectorAll('[aria-busy="true"]')].some(visible));
    const interrupted = !!lastUserElement && visible(editor) && !stopVisible &&
      [...document.querySelectorAll<HTMLElement>('main [role="alert"], main div, main p, main span')].some(element => {
        if (!visible(element) || !afterLastUser(element) || element.closest('[data-message-author-role="user"]')) return false;
        const raw = element.textContent?.trim() ?? '';
        if (raw.length > 160 || !/连接已中断|Connection interrupted/i.test(raw)) return false;
        const label = element.innerText.trim();
        return label.length < 160 && /^(?:连接已中断[。.!！]?\s*正在等待完整回复|Connection interrupted[.!]?\s*Waiting for (?:a )?complete response)[。.!！…]*$/i.test(label);
      });
    const busy = stopVisible || !interrupted && (streamingVisible || ariaBusyVisible);
    if (operation.kind === 'diagnose') {
      const send = sendButton();
      const messages = elements;
      const last = messages.at(-1);
      const turn = last && turnOf(last);
      return { url: location.href, title: document.title.slice(0, 120), readiness,
        editor: visible(editor), draftLength: draft.length, busy, documentReady: document.readyState,
        dom: { editorTag: editor?.tagName.toLowerCase() ?? null, contentEditable: !!editor?.isContentEditable,
          visibleEditorCount: [...document.querySelectorAll(editorSelector)].filter(visible).length,
          draftLineLengths: draft.split('\n').slice(0, 20).map(line => line.length),
          editorBlocks: [...(editor?.children ?? [])].slice(0, 20).map(child => ({ tag: child.tagName.toLowerCase(),
            textLength: child.textContent.length, lineBreaks: child.querySelectorAll('br').length })),
          sendVisible: visible(send), sendEnabled: visible(send) && !send.disabled && send.getAttribute('aria-disabled') !== 'true',
          stopVisible, streamingVisible, ariaBusyVisible,
          messageCount: messages.length, lastRole: last ? roleOf(last) : null,
          lastTurnTerminal: !!last && roleOf(last) === 'assistant' && terminalAction(turn) }
      };
    }
    const readMessage = (element: HTMLElement, index: number) => {
      const turn = turnOf(element);
      const role = roleOf(element);
      const body = role === 'user'
        ? element.querySelector<HTMLElement>('[data-testid="collapsible-user-message-content"], [data-user-message-bubble]') ?? element
        : element.querySelector<HTMLElement>('[data-chatgpt-selection-message-id]') ?? element;
      const hasContent = role === 'assistant' &&
        [...turn.querySelectorAll('img, video, canvas')].some(media => {
          if (!visible(media)) return false;
          if (media instanceof HTMLImageElement && (!media.complete || media.naturalWidth < 32)) return false;
          const bounds = media.getBoundingClientRect(); return bounds.width >= 32 && bounds.height >= 32;
        });
      return { id: element.dataset.messageId ?? element.getAttribute('data-chatgpt-search-message-ids')?.trim().split(/\s+/)[0] ?? `position:${index}`, role,
        text: body.innerText.trim(), terminal: role === 'assistant' && terminalAction(turn), hasContent };
    };
    const markedError = [...document.querySelectorAll<HTMLElement>('[data-testid="conversation-error"], [data-testid="error-message"]')]
      .find(element => visible(element) && afterLastUser(element));
    // ChatGPT also renders reply failures as an inline card with no stable
    // test id. Require both the specific failure text and its Retry action so
    // an assistant quoting the same words does not become a false failure.
    const inlineError = [...document.querySelectorAll<HTMLButtonElement>('main button')].find(button => {
      if (!visible(button) || !/^(重试|Retry|Try again)$/i.test((button.innerText || button.getAttribute('aria-label') || '').trim())) return false;
      for (let card: HTMLElement | null = button.parentElement, depth = 0; card && depth < 5; card = card.parentElement, depth++) {
        if (!afterLastUser(card) || card.innerText.length > 600) continue;
        if (/Unusual activity has been detected from your device\.\s*Try again later\./i.test(card.innerText)) return true;
      }
      return false;
    });
    // A failed reasoning block can replace the answer without a Retry card or
    // copy action. ChatGPT renders its label as either a control or plain text.
    // Only inspect an exact standalone label after the latest user turn; a
    // completed assistant turn and quoted text are not current failures.
    const finishedAnswer = elements.some((element, index) => roleOf(element) === 'assistant' &&
      afterLastUser(element) && readMessage(element, index).terminal);
    const thinkingLabel = /^(无法思考|Unable to think)(?:\s*[›>])?$/i;
    const thinkingFailure = !!lastUserElement && visible(editor) && !busy && !finishedAnswer &&
      [...document.querySelectorAll<HTMLElement>('main button, main [role="button"], main [aria-expanded], main div, main p, main span')].some(control => {
        if (!visible(control) || !afterLastUser(control) || control.closest('[data-message-author-role="user"], [data-user-message-bubble]') ||
          control.querySelector(messageSelector)) return false;
        const label = (control.innerText || control.getAttribute('aria-label') || '').trim();
        return thinkingLabel.test(label);
      });
    const markedThinkingFailure = !!lastUserElement && visible(editor) && !busy && !finishedAnswer &&
      !!markedError && thinkingLabel.test(markedError.innerText.trim());
    const error = markedError?.innerText || (inlineError ? 'ChatGPT 检测到异常活动，请稍后重试' : thinkingFailure ? 'ChatGPT 无法思考，本轮回复未完成' : interrupted ? 'ChatGPT 连接已中断，本轮回复未完成' : undefined);
    const failure = interrupted ? 'interrupted' : (thinkingFailure || markedThinkingFailure) && !inlineError ? 'thinking' : undefined;
    if (operation.kind === 'activity') {
      let user: Message | undefined; let assistant: Message | undefined;
      for (let index = elements.length - 1; index >= 0 && (!user || !assistant); index--) {
        const role = roleOf(elements[index]);
        if (role === 'user' && !user) user = readMessage(elements[index], index);
        else if (role === 'assistant' && !assistant) assistant = readMessage(elements[index], index);
      }
      return { url: location.href, title: document.title.slice(0, 120), editor: visible(editor), busy,
        hasDraft: !!draft.trim(), error, user: user && { id: user.id, text: user.text.slice(0, 32000) },
        assistant: assistant && { ...assistant, text: assistant.text.slice(0, 64000) },
        lastRole: elements.length ? roleOf(elements.at(-1)!) : undefined };
    }
    const messages = elements.map(readMessage);
    const page: Page = { url: location.href, title: document.title.slice(0, 120), readiness, editor: visible(editor), draft, busy, messages, error, failure };
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
      const button = sendButton();
      if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') throw new Error('SEND_UNAVAILABLE: prompt remains a draft');
      if (operation.kind === 'check_send') return { ready: true };
      stage = 'click_send';
      button.click(); return { clicked: true };
    }
    stage = 'find_editor';
    const element = operation.selector ? document.querySelector<HTMLElement>(operation.selector) : editor;
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
    private readonly context: ExecutionContext, private readonly conversations: ConversationManager,
    private readonly pollingInterval: () => number = () => 250) {}
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
    this.context.releaseExecution?.();
    const priorError = this.context.precedingReplyError;
    const conversationId = this.context.task().conversationId;
    const failedTail = (page: Page): boolean => {
      if (!priorError || !conversationId) return false;
      const target = this.conversations.get(this.context.task().accountId, conversationId);
      const lastUser = page.messages.filter(message => message.role === 'user').at(-1);
      return !!target.url && replyPageUrl(page.url) === target.url &&
        (!!lastUser && (priorError.messageId ? lastUser.id === priorError.messageId : !!priorError.continueAfterInterruption));
    };
    let previous = ''; let since = Date.now();
    let lastSample = Date.now();
    let interval = 250;
    let composerMissingSince = Date.now();
    const composerBudget = Math.min(this.context.task().prepareTimeoutMs ?? 60000, 30000);
    while (true) {
      this.context.checkpoint?.();
      const page = await this.inspect();
      const now = Date.now();
      // A suspend or stalled renderer is not continuous evidence of completion.
      if (now - lastSample > Math.max(2000, interval * 2 + 500)) since = now;
      lastSample = now;
      const previousFailure = failedTail(page);
      const terminalFailure = !!page.failure || !!this.context.task().background && !!page.error && !page.busy;
      if (page.error && !terminalFailure && !(previousFailure && (priorError?.continueAfterInterruption || page.error === priorError?.error))) throw new Error(page.error);
      if (!page.editor || page.readiness === 'login_required' || page.readiness === 'verification_required') {
        if (Date.now() - composerMissingSince >= composerBudget) {
          if (page.readiness === 'login_required') throw new Error('LOGIN_REQUIRED: 请在此账号网页完成登录，再继续原任务');
          if (page.readiness === 'verification_required') throw new Error('VERIFICATION_REQUIRED: 网页停在验证页面，请在此账号完成验证后继续原任务；未发送消息');
          throw new Error(`COMPOSER_NOT_READY: 等待输入框超时，请用 browser inspect 检查此账号页面；未发送消息 (${page.url})`);
        }
        previous = ''; since = Date.now();
        interval = 250; await this.delay(interval); continue;
      }
      composerMissingSince = Date.now();
      if (page.draft.trim()) throw new Error('DRAFT_CONFLICT: clear or send the existing draft first');
      const last = page.messages.at(-1);
      // A usable composer with no active generation is an idle conversation,
      // even when ChatGPT never produced a copyable assistant turn.
      const ready = !page.busy;
      const fingerprint = JSON.stringify([page.url, page.messages, page.error]);
      if (!ready || previous !== fingerprint) since = Date.now();
      if (ready && Date.now() - since >= (last ? COMPLETION_STABLE_MS : 1000)) {
        await this.context.acquireExecution?.();
        this.context.checkpoint?.();
        // Another operation may have held capacity while this page changed.
        // Recheck after acquisition before using the baseline for a write.
        const confirmed = await this.inspect();
        if (confirmed.editor && confirmed.readiness === 'ready' && (!confirmed.error || confirmed.failure || this.context.task().background && !confirmed.busy ||
          (failedTail(confirmed) && (priorError?.continueAfterInterruption || confirmed.error === priorError?.error))) &&
          !confirmed.busy && !confirmed.draft.trim() && JSON.stringify([confirmed.url, confirmed.messages, confirmed.error]) === fingerprint) return confirmed;
        this.context.releaseExecution?.();
        previous = ''; since = Date.now(); interval = 250;
        continue;
      }
      previous = fingerprint;
      interval = page.busy ? this.pollingInterval() : 250;
      await this.delay(interval);
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
    if (input.type === 'prompt' && input.submit && task.background && task.sendIntentAt && task.sendReceipt) {
      const conversation = task.conversationId ? this.conversations.get(task.accountId, task.conversationId) : undefined;
      const target = conversation?.url ?? task.sendReceipt.url;
      if (replyPageUrl(this.contents.getURL(), true) === HOME_URL && target !== HOME_URL) await this.navigate(target);
      return this.awaitReply({ url: task.sendReceipt.url, title: '', readiness: 'ready', editor: true, draft: '', busy: false,
        messages: task.sendReceipt.users }, input.prompt, task.sendReceipt.url, conversation);
    }
    const initial = input.type !== 'snapshot' ? await this.idle() : undefined;
    let conversation = task.conversationId ? this.conversations.get(task.accountId, task.conversationId) : undefined;
    if (conversation?.binding === 'uncertain') {
      const prior = this.context.precedingReplyError;
      const page = initial ?? await this.inspect();
      const users = page.messages.filter(message => message.role === 'user');
      const actual = replyPageUrl(page.url);
      if (actual && actual !== HOME_URL && users.length === 1 && prior?.prompt && users[0].text === prior.prompt.trim() &&
        (!prior.messageId || prior.messageId === users[0].id)) {
        this.conversations.bind(task.accountId, conversation.id, actual);
        conversation = this.conversations.get(task.accountId, conversation.id);
      } else throw new Error('NEW_CHAT_UNRESOLVED: 正在等待首次发送的原会话恢复，消息保留在队首');
    }
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
      // React replaces the voice button asynchronously after editor input.
      // Wait for an actual enabled Send action instead of assuming 250 ms.
      const sendReadyDeadline = Date.now() + Math.min(10000, task.prepareTimeoutMs ?? 10000);
      while (true) {
        try { await this.evaluate({ ...guard, kind: 'check_send', value }); break; }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('SEND_UNAVAILABLE') || Date.now() >= sendReadyDeadline) throw error;
          await this.delay(); this.context.checkpoint?.();
        }
      }
      this.context.checkpoint?.();
      this.context.intent({ url: baseline.url, users: baseline.messages.filter(message => message.role === 'user').slice(-5) });
      if (conversation?.binding === 'new') this.conversations.markSending(task.accountId, conversation.id);
      await this.evaluate({ ...guard, kind: 'send', value });
    } catch (error) {
      if (prepared && !this.context.task().sendIntentAt) {
        // The task signal may already be aborted. Cleanup still uses the same
        // URL/history/text guard; never erase a draft someone changed.
        const cleanup = this.contents.executeJavaScript(pageOperationScript({ ...guard, kind: 'clear', value }), true);
        this.pending.add(cleanup);
        void cleanup.then(() => this.pending.delete(cleanup), () => this.pending.delete(cleanup));
        let timer: ReturnType<typeof setTimeout>;
        await Promise.race([cleanup.catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
        clearTimeout(timer!);
      }
      throw error;
    }
    return this.awaitReply(baseline, value, target, conversation);
  }
  private async awaitReply(baseline: Page, value: string, target: string, conversation?: Conversation): Promise<unknown> {
    const task = this.context.task();
    const guard = { url: target, anchor: this.anchor(baseline) };
    // A short caller deadline must not restart observation before the stable
    // completion window can ever elapse on a recovered turn.
    this.context.stage('generating', task.retryCount ? Math.max(30000, task.replyTimeoutMs ?? 0) : task.replyTimeoutMs);
    this.context.releaseExecution?.();
    const turns = new ReplyTurnTracker(baseline.messages, value, task.submittedMessageId);
    let acknowledged = false; let boundUrl = conversation?.url;
    let observedConversationUrl = boundUrl;
    let optimisticUrl: string | undefined;
    let previous = ''; let since = Date.now();
    let failureFingerprint = ''; let failureSince = Date.now();
    let lastSample = Date.now();
    let nextPollMs = 250;
    let lastSendAttempt = Date.now(); let sendRetries = 0; let readFailures = 0;
    while (true) {
      const interval = nextPollMs;
      await this.delay(interval);
      let page: Page;
      try { page = await this.inspect(); readFailures = 0; }
      catch (error) {
        this.signal.throwIfAborted();
        if (!task.background || this.contents.isDestroyed()) throw error;
        if (++readFailures >= 3) {
          // Recover observation of the same remote turn. Never fill/resend here.
          await this.track(this.contents.loadURL(boundUrl ?? observedConversationUrl ?? target));
          readFailures = 0;
        }
        nextPollMs = 2000; continue;
      }
      const now = Date.now();
      if (now - lastSample > Math.max(2000, interval * 2 + 500)) { since = now; failureSince = now; }
      lastSample = now;
      const replyUrl = replyPageUrl(page.url, !boundUrl && !!conversation);
      const optimistic = !!replyUrl && /\/c\/(WEB|local-chatgpt):/.test(replyUrl);
      if (!replyUrl || (observedConversationUrl && replyUrl !== observedConversationUrl)) throw changedReplyTarget(observedConversationUrl ?? HOME_URL, page.url);
      if (optimistic) {
        if (optimisticUrl && replyUrl !== optimisticUrl) throw changedReplyTarget(optimisticUrl, page.url);
        optimisticUrl = replyUrl;
      } else if (replyUrl !== HOME_URL) observedConversationUrl ??= replyUrl;
      const ownUser = turns.read(page.messages);
      if (ownUser && !acknowledged) { this.context.submitted(ownUser.id); acknowledged = true; }
      // A click can be ignored while ChatGPT hydrates or reconnects. Retry only
      // when the unchanged prompt is still a draft AND the recorded pre-send user
      // history is unchanged. A missing acknowledgement alone is never proof.
      if (!acknowledged && !page.busy && page.readiness === 'ready' &&
        page.messages.filter(message => message.role === 'user').at(-1)?.id === baseline.messages.filter(message => message.role === 'user').at(-1)?.id &&
        page.url === guard.url && page.draft.replace(/\r\n?/g, '\n').trim() === value.replace(/\r\n?/g, '\n').trim() &&
        Date.now() - lastSendAttempt >= Math.min(30000, 3000 * 2 ** Math.min(sendRetries, 4))) {
        try {
          await this.context.acquireExecution?.();
          await this.evaluate({ ...guard, anchor: this.anchor(page), kind: 'check_send', value });
          await this.evaluate({ ...guard, anchor: this.anchor(page), kind: 'send', value });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('SEND_UNAVAILABLE')) throw error;
        } finally { this.context.releaseExecution?.(); }
        lastSendAttempt = Date.now(); sendRetries++;
      }
      nextPollMs = acknowledged && page.busy ? this.pollingInterval() : 250;
      if (acknowledged && !boundUrl && !optimistic && replyUrl !== HOME_URL && conversation) {
        boundUrl = conversationUrl(replyUrl).url;
        this.conversations.bind(task.accountId, conversation.id, boundUrl);
      }
      if (page.error) {
        // A visible reply error is terminal only after the sent user turn and
        // the actual conversation are confirmed. Earlier failures stay in the
        // uncertain path so the prompt is never replayed by mistake.
        if (acknowledged && boundUrl) {
          if (page.busy) continue;
          {
            const fingerprint = JSON.stringify([replyUrl, page.messages, page.error]);
            if (fingerprint !== failureFingerprint) { failureFingerprint = fingerprint; failureSince = now; }
            if (now - failureSince < COMPLETION_STABLE_MS) continue;
          }
          throw new ReportedReplyError(page.error, !!page.failure);
        }
        throw new Error(page.error);
      }
      failureFingerprint = '';
      const last = page.messages.at(-1);
      const userIndex = ownUser ? page.messages.indexOf(ownUser) : -1;
      if (acknowledged && userIndex >= 0 && last?.role === 'assistant' && page.messages.indexOf(last) > userIndex) {
        this.context.progress?.(last.text, boundUrl);
      }
      const finished = acknowledged && !!boundUrl && page.editor && !page.busy && !page.draft.trim() && userIndex >= 0 &&
        page.messages.length > userIndex + 1 && last?.role === 'assistant' && last.terminal && (!!last.text || !!last.hasContent);
      const fingerprint = JSON.stringify([replyUrl, page.messages]);
      const stopped = acknowledged && !!boundUrl && page.readiness === 'ready' && !page.busy && !page.draft.trim() && userIndex >= 0;
      if (!stopped || fingerprint !== previous) since = Date.now();
      if (stopped && Date.now() - since >= COMPLETION_STABLE_MS) {
        if (finished) return { submitted: true, response: last!.text.slice(0, 64000), url: boundUrl, conversationId: conversation?.id, replyToken: replyToken(ownUser!, last!) };
        throw new ReportedReplyError('ChatGPT 已停止回复，本轮未提供完整可确认的答复', true);
      }
      previous = fingerprint;
    }
  }
}
