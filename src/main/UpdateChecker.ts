import { newerStable, type UpdateState } from '../shared/updates';

const endpoint = 'https://api.github.com/repos/chenziyang110/ChatGPT-Web-Client/releases/latest';
export interface UpdateInstaller {
  download(version: string, progress: (percent: number) => void): Promise<void>;
  cancel(): void;
  install(): void;
}
export class UpdateChecker {
  state: UpdateState;
  private pending?: Promise<UpdateState>;
  private downloading?: Promise<UpdateState>;
  private cancelled = false;
  constructor(current: string, enabled: boolean, private changed: () => void, private request: typeof fetch = fetch,
    private installer?: UpdateInstaller, installMode: UpdateState['installMode'] = installer ? 'in-app' : 'manual') {
    this.state = { current, enabled, status: 'idle', installMode };
  }
  setEnabled(enabled: boolean) { this.state.enabled = enabled; this.changed(); }
  check(): Promise<UpdateState> {
    if (['downloading', 'downloaded', 'installing'].includes(this.state.status)) return Promise.resolve({ ...this.state });
    if (this.pending) return this.pending;
    this.pending = this.run().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async run(): Promise<UpdateState> {
    this.state.status = 'checking'; this.state.error = undefined; this.changed();
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
    } catch { this.state.status = 'error'; this.state.error = '暂时无法检查更新，请检查网络后重试。'; }
    this.changed(); return { ...this.state };
  }
  download(): Promise<UpdateState> {
    if (this.downloading) return this.downloading;
    if (!this.installer) return Promise.reject(new Error('此安装方式暂不支持软件内安装，请使用官方下载。'));
    if (this.state.status === 'downloaded') return Promise.resolve({ ...this.state });
    if (!['available', 'error'].includes(this.state.status) || !this.state.latest || !newerStable(this.state.latest, this.state.current)) {
      return Promise.reject(new Error('请先检查并确认有新版本。'));
    }
    this.cancelled = false;
    this.state.status = 'downloading'; this.state.progress = 0; this.state.error = undefined; this.changed();
    const version = this.state.latest.replace(/^v/, '');
    this.downloading = this.installer.download(version, percent => {
      if (this.cancelled || !Number.isFinite(percent)) return;
      const progress = Math.min(100, Math.max(0, Math.floor(percent)));
      if (this.state.progress !== progress) { this.state.progress = progress; this.changed(); }
    }).then(() => {
      this.state.status = this.cancelled ? 'available' : 'downloaded';
      this.state.progress = this.cancelled ? undefined : 100;
    }).catch(() => {
      this.state.status = this.cancelled ? 'available' : 'error';
      this.state.progress = undefined;
      this.state.error = this.cancelled ? undefined : '下载或校验失败，请重试下载。';
    }).then(() => {
      this.changed(); return { ...this.state };
    }).finally(() => { this.downloading = undefined; });
    return this.downloading;
  }
  cancelDownload(): void {
    if (this.state.status !== 'downloading') return;
    this.cancelled = true; this.installer?.cancel();
  }
  beginInstall(): void {
    if (this.state.status !== 'downloaded' || !this.installer) throw new Error('请先完成更新下载。');
    this.state.status = 'installing'; this.state.error = undefined; this.changed();
  }
  install(): void {
    if (this.state.status !== 'installing' || !this.installer) throw new Error('更新尚未准备好。');
    this.installer.install();
  }
}
