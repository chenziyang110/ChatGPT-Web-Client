export interface SessionState {
  accountId: string;
  url: string;
  updatedAt: number;
}

export class SessionManager {
  private sessions: Map<string, SessionState> = new Map();

  save(state: SessionState) {
    this.sessions.set(state.accountId, state);
  }

  restore(accountId: string) {
    return this.sessions.get(accountId);
  }
}
