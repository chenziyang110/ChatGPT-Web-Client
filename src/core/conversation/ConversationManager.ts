import { randomUUID } from 'node:crypto';
import { Database } from '../storage/Database';
import { AppError, chatUrl, text } from '../validation';
import type { Conversation, ConversationSurface } from '../../shared/types';
import { parseConversationPath } from '../../shared/conversationRoute';

export function conversationUrl(value: unknown): { url: string; remoteId: string; surface?: ConversationSurface } {
  const parsed = new URL(chatUrl(value));
  const route = parseConversationPath(parsed.pathname);
  if (!route || parsed.search || parsed.hash) throw new AppError('Use a personal https://chatgpt.com/c/<id>, /g/g-p-<project>/c/<id> or /dots/<id> URL. Shared and temporary chats are not supported.');
  return { url: `https://chatgpt.com${route.pathname}`, remoteId: route.remoteId, ...(route.kind === 'dot' ? { surface: 'dot' as const } : {}) };
}
export class ConversationManager {
  constructor(private readonly db: Database) {}
  list(accountId?: string): Conversation[] { return this.db.records<Conversation>('conversations').filter(item => !accountId || item.accountId === accountId); }
  get(accountId: string, reference: unknown): Conversation {
    const ref = text(reference, 'Conversation', 4096);
    const all = this.list(accountId);
    const exact = all.find(item => item.id === ref);
    if (exact) return exact;
    const matches = all.filter(item => item.alias === ref || item.remoteId === ref || item.url === ref);
    if (matches.length !== 1) throw new AppError(matches.length ? 'Conversation is ambiguous; use its local ID' : 'Conversation not found for this account', 404);
    return matches[0];
  }
  private alias(accountId: string, value: unknown, except?: string): string | undefined {
    if (value === undefined || value === '') return undefined;
    const alias = text(value, 'Conversation alias', 60);
    if (this.list(accountId).some(item => item.id !== except && (item.alias === alias || item.remoteId === alias || item.id === alias))) throw new AppError('Conversation alias already exists', 409);
    return alias;
  }
  register(accountId: string, value: unknown, aliasValue?: unknown, surfaceValue?: unknown): Conversation {
    const target = conversationUrl(value);
    const existing = this.list(accountId).find(item => item.url === target.url);
    const surface = this.surface(surfaceValue ?? target.surface ?? existing?.surface ?? 'chat');
    if ((surface === 'dot') !== (target.surface === 'dot')) throw new AppError('Your dot requires its own /dots/<id> URL');
    if (existing && aliasValue === undefined && (existing.surface ?? 'chat') === surface) return existing;
    const alias = this.alias(accountId, aliasValue, existing?.id) ?? existing?.alias;
    const now = Date.now();
    const item: Conversation = { id: existing?.id ?? randomUUID(), accountId, alias, title: alias ?? existing?.title ?? `会话 ${target.remoteId.slice(0, 8)}`,
      ...target, surface, binding: 'bound', createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.db.write('conversations', item.id, item);
    return item;
  }
  private surface(value: unknown): ConversationSurface {
    if (value !== 'chat' && value !== 'work' && value !== 'dot') throw new AppError('surface must be chat, work or dot');
    return value;
  }
  create(accountId: string, aliasValue?: unknown, surfaceValue: unknown = 'chat'): Conversation {
    const surface = this.surface(surfaceValue);
    if (surface === 'dot') throw new AppError('Open Your dot and register its /dots/<id> URL');
    const alias = this.alias(accountId, aliasValue);
    const item: Conversation = { id: randomUUID(), accountId, alias, surface, title: alias ?? (surface === 'work' ? '新工作会话' : '新会话'), binding: 'new', createdAt: Date.now(), updatedAt: Date.now() };
    this.db.write('conversations', item.id, item);
    return item;
  }
  bind(accountId: string, id: string, value: unknown): Conversation {
    const existing = this.get(accountId, id);
    const target = conversationUrl(value);
    if (!existing.url && target.remoteId.startsWith('project:')) throw new AppError('Project conversations require an existing conversation URL');
    if ((existing.surface === 'dot') !== (target.surface === 'dot')) throw new AppError('Conversation surface changed unexpectedly', 409);
    if (existing.url && existing.url !== target.url) throw new AppError('Conversation changed unexpectedly', 409);
    const collision = this.list(accountId).find(item => item.id !== id && item.url === target.url);
    if (collision) throw new AppError('New conversation resolved to an existing conversation', 409);
    const next: Conversation = { ...existing, ...target, binding: 'bound', updatedAt: Date.now() };
    this.db.write('conversations', id, next);
    return next;
  }
  markSending(accountId: string, id: string): void {
    const existing = this.get(accountId, id);
    if (!existing.url) this.db.write('conversations', id, { ...existing, binding: 'uncertain', updatedAt: Date.now() });
  }
  remove(id: string): void { this.db.remove('conversations', id); }
  removeAccount(accountId: string): void { for (const item of this.list(accountId)) this.remove(item.id); }
}
