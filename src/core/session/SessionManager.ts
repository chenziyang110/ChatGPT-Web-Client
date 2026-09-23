import { Database } from '../storage/Database';
import { chatUrl, identifier } from '../validation';
import type { SessionState } from '../../shared/types';
export type { SessionState } from '../../shared/types';
export interface WindowState { x?: number; y?: number; width: number; height: number; maximized: boolean }
export interface SavedTab { id: string; url: string; title: string; conversationId?: string }
export interface SavedTabs { pages: SavedTab[]; selectedId?: string }
export class SessionManager {
  constructor(private readonly db: Database) {}
  save(accountId: string, url: string): void {
    const state: SessionState = { accountId: identifier(accountId), url: chatUrl(url), updatedAt: Date.now() };
    this.db.set(`session:${accountId}`, state);
  }
  restore(accountId: string): SessionState | undefined {
    return this.db.get<SessionState>(`session:${identifier(accountId)}`);
  }
  saveTabs(accountId: string, value: SavedTabs): void {
    const pages = value.pages.slice(0, 20).map(page => ({ id: identifier(page.id), url: chatUrl(page.url),
      title: page.title.slice(0, 120), conversationId: page.conversationId ? identifier(page.conversationId) : undefined }));
    const selectedId = value.selectedId && pages.some(page => page.id === value.selectedId) ? value.selectedId : undefined;
    this.db.set(`sessionTabs:${identifier(accountId)}`, { pages, selectedId });
  }
  restoreTabs(accountId: string): SavedTabs | undefined {
    const stored = this.db.get<unknown>(`sessionTabs:${identifier(accountId)}`);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
    const value = stored as Record<string, unknown>;
    if (!Array.isArray(value.pages)) return undefined;
    const pages: SavedTab[] = []; const seen = new Set<string>();
    for (const item of value.pages.slice(0, 20)) {
      try {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const page = item as Record<string, unknown>;
        const id = identifier(page.id), url = chatUrl(page.url);
        if (seen.has(id)) continue;
        seen.add(id);
        let conversationId: string | undefined;
        try { if (page.conversationId !== undefined) conversationId = identifier(page.conversationId); }
        catch { /* A damaged binding must not discard a valid tab. */ }
        pages.push({ id, url, title: typeof page.title === 'string' ? page.title.slice(0, 120) : '会话',
          conversationId });
      } catch { /* Ignore a damaged tab without losing the rest of this account. */ }
    }
    const selectedId = typeof value.selectedId === 'string' && pages.some(page => page.id === value.selectedId) ? value.selectedId : pages[0]?.id;
    return { pages, selectedId };
  }
  saveWindow(state: WindowState): void { this.db.set('window', state); }
  restoreWindow(): WindowState | undefined { return this.db.get<WindowState>('window'); }
}
