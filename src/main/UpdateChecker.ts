import { newerStable, type UpdateState } from '../shared/updates';

const endpoint = 'https://api.github.com/repos/chenziyang110/ChatGPT-Web-Client/releases/latest';
export class UpdateChecker {
  state: UpdateState;
  private pending?: Promise<UpdateState>;
  constructor(current: string, enabled: boolean, private changed: () => void, private request: typeof fetch = fetch) {
    this.state = { current, enabled, status: 'idle' };
  }
  setEnabled(enabled: boolean) { this.state.enabled = enabled; this.changed(); }
  check(): Promise<UpdateState> {
    if (this.pending) return this.pending;
    this.pending = this.run().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async run(): Promise<UpdateState> {
    this.state.status = 'checking'; this.changed();
    try {
      // Node fetch uses no Chromium session, account cookies, API token or user data.
      const response = await this.request(endpoint, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ChatGPT-Web-Client-Update-Check' },
        redirect: 'error', signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error('Release unavailable');
      const release = await response.json() as { tag_name?: unknown; draft?: boolean; prerelease?: boolean };
      if (release.draft || release.prerelease || typeof release.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('Invalid stable release');
      this.state.latest = release.tag_name;
      this.state.status = newerStable(release.tag_name, this.state.current) ? 'available' : 'current';
      this.state.checkedAt = new Date().toISOString();
    } catch { this.state.status = 'error'; }
    this.changed(); return { ...this.state };
  }
}
