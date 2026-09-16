import { Database } from '../storage/Database';
import { chatUrl, identifier } from '../validation';
import type { SessionState } from '../../shared/types';
export type { SessionState } from '../../shared/types';
export interface WindowState { x?: number; y?: number; width: number; height: number; maximized: boolean }
export class SessionManager {
  constructor(private readonly db: Database) {}
  save(accountId: string, url: string): void {
    const state: SessionState = { accountId: identifier(accountId), url: chatUrl(url), updatedAt: Date.now() };
    this.db.set(`session:${accountId}`, state);
  }
  restore(accountId: string): SessionState | undefined {
    return this.db.get<SessionState>(`session:${identifier(accountId)}`);
  }
  saveWindow(state: WindowState): void { this.db.set('window', state); }
  restoreWindow(): WindowState | undefined { return this.db.get<WindowState>('window'); }
}
