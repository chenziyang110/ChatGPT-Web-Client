import { createHash } from 'node:crypto';
import type { Database } from '../storage/Database';
import { conversationUrl } from '../conversation/ConversationManager';
import { AppError } from '../validation';
import type { ConversationNotice } from '../../shared/types';

export const COMPLETION_STABLE_MS = 6000;

export interface ActivitySnapshot {
  url: string; title: string; editor: boolean; busy: boolean; hasDraft?: boolean; error?: string;
  user?: { id: string; text: string }; assistant?: { id: string; text: string; terminal: boolean; hasContent?: boolean }; lastRole?: string;
}
export function replyToken(user: { id: string; text: string }, assistant: { id: string; text: string }): string {
  return createHash('sha256').update(JSON.stringify([user.id, user.text.slice(0, 32000), assistant.id, assistant.text.slice(0, 64000)])).digest('hex');
}
export class ConversationNotifications {
  private items: ConversationNotice[];
  constructor(private readonly db: Database, private readonly changed: () => void,
    private readonly completed: (notice: ConversationNotice) => void = () => {}) {
    this.items = (db.get<ConversationNotice[]>('conversationNotifications') ?? []).map(item => ({ ...item, running: false }));
  }
  list(accountId?: string): ConversationNotice[] { return this.items.filter(item => !accountId || item.accountId === accountId).map(item => ({ ...item })); }
  private save(): void { this.db.set('conversationNotifications', this.items); this.changed(); }
  private ensure(accountId: string, value: string, title: string): ConversationNotice {
    const { url, remoteId } = conversationUrl(value); const id = `${accountId}:${remoteId}`;
    let item = this.items.find(item => item.id === id);
    if (!item) { item = { id, accountId, url, title: title.slice(0, 120) || `会话 ${remoteId.slice(0, 8)}`, running: false, unread: false }; this.items.push(item); }
    return item;
  }
  running(accountId: string, url: string, title: string, running: boolean): void {
    const item = this.ensure(accountId, url, title);
    if (item.running === running) return;
    item.running = running; this.save();
  }
  disconnected(accountId: string, exceptUrl?: string): void {
    let changed = false;
    for (const item of this.items) if (item.accountId === accountId && item.url !== exceptUrl && item.running) { item.running = false; changed = true; }
    if (changed) this.save();
  }
  complete(accountId: string, url: string, title: string, token: string, now = Date.now()): void {
    const item = this.ensure(accountId, url, title);
    if (item.token === token) { this.running(accountId, url, title, false); return; }
    Object.assign(item, { running: false, unread: true, token, completedAt: now, title: title.slice(0, 120) || item.title }); this.save();
    try { this.completed({ ...item }); } catch { /* Desktop notification failures never fail a completed task. */ }
  }
  get(accountId: string, id: unknown): ConversationNotice {
    const item = this.items.find(item => item.accountId === accountId && item.id === id);
    if (!item) throw new AppError('会话通知不存在', 404);
    return { ...item };
  }
  read(accountId: string, id: unknown, token: unknown): ConversationNotice {
    const current = this.get(accountId, id);
    if (!token || current.token !== token) throw new AppError('会话有新的回复，请刷新后再处理', 409);
    const item = this.items.find(item => item.id === current.id)!;
    if (item.unread) { item.unread = false; this.save(); }
    return { ...item };
  }
  viewed(accountId: string, value: string): ConversationNotice | undefined {
    let remoteId: string;
    try { remoteId = conversationUrl(value).remoteId; } catch { return; }
    const item = this.items.find(item => item.id === `${accountId}:${remoteId}`);
    if (!item) return;
    if (item.unread) { item.unread = false; this.save(); }
    return { ...item };
  }
  removeAccount(accountId: string): void { this.items = this.items.filter(item => item.accountId !== accountId); this.save(); }
}

/** Observe transitions, not historical messages; unsupported states never complete. */
export class ConversationActivityObserver {
  private readonly observed = new Map<string, { accountId: string; token?: string; userId?: string; generating: boolean; candidate?: string; since: number }>();
  constructor(private readonly notifications: ConversationNotifications, private readonly multiplePages = false) {}
  disconnected(accountId: string, url?: string): void {
    for (const [key, value] of this.observed) if (value.accountId === accountId && (!url || key === `${accountId}:${url}`)) this.observed.delete(key);
    if (url) {
      try { this.notifications.running(accountId, url, '', false); } catch { /* Unsupported page. */ }
    } else this.notifications.disconnected(accountId);
  }
  observe(accountId: string, page: ActivitySnapshot, now = Date.now()): void {
    let url: string;
    try { url = conversationUrl(page.url).url; } catch { if (!this.multiplePages) this.disconnected(accountId); return; }
    if (!this.multiplePages) this.notifications.disconnected(accountId, url);
    const key = `${accountId}:${url}`;
    // Discard old page baselines so opening a historical conversation is not a new reply.
    if (!this.multiplePages) for (const [other, value] of this.observed) if (value.accountId === accountId && other !== key) this.observed.delete(other);
    const ready = !!page.user && page.lastRole === 'assistant' && !!page.assistant?.terminal && (!!page.assistant.text || !!page.assistant.hasContent) && !page.busy;
    const token = ready ? replyToken(page.user!, page.assistant!) : undefined;
    let previous = this.observed.get(key);
    if (!previous) {
      previous = { accountId, token: token ?? 'empty', userId: page.user?.id, generating: page.busy, since: now }; this.observed.set(key, previous);
      this.notifications.running(accountId, url, page.title, page.busy); return;
    }
    if (page.error || !page.editor) {
      if (page.busy) previous.generating = true;
      previous.userId = page.user?.id ?? previous.userId; previous.candidate = undefined;
      this.notifications.running(accountId, url, page.title, !page.error && previous.generating); return;
    }
    const userChanged = !!page.user?.id && page.user.id !== previous.userId;
    if (page.busy || !ready && (previous.generating || userChanged)) {
      previous.generating = true; previous.userId = page.user?.id ?? previous.userId; previous.candidate = undefined;
      this.notifications.running(accountId, url, page.title, true); return;
    }
    if (!ready) {
      previous.generating = false; previous.userId = page.user?.id ?? previous.userId; previous.candidate = undefined;
      this.notifications.running(accountId, url, page.title, false); return;
    }
    if (previous.generating || userChanged || (previous.token && token !== previous.token)) {
      if (previous.candidate !== token) { previous.candidate = token; previous.since = now; }
      if (now - previous.since < COMPLETION_STABLE_MS) return;
      this.notifications.complete(accountId, url, page.title, token!, now);
    }
    previous.token = token; previous.userId = page.user?.id; previous.generating = false; previous.candidate = undefined;
    this.notifications.running(accountId, url, page.title, false);
  }
}
