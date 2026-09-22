import { app } from 'electron';
import path from 'node:path';
import { NsisUpdater, AppImageUpdater, CancellationToken } from 'electron-updater';
import type { UpdateInstaller } from './UpdateChecker';
import { newerStable, validUpdateMetadata } from '../shared/updates';

const downloads = 'https://github.com/chenziyang110/ChatGPT-Web-Client/releases/download/';

export function createUpdateInstaller(): UpdateInstaller | undefined {
  if (!app.isPackaged || !['x64', 'arm64'].includes(process.arch)) return;
  // Squirrel.Mac requires a stable signing identity; current Mac builds use
  // ad-hoc signing, so retain the ordinary installer link on that platform.
  if (process.platform !== 'win32' && !(process.platform === 'linux' && process.env.APPIMAGE)) return;
  let engine: NsisUpdater | AppImageUpdater | undefined;
  let token: CancellationToken | undefined;
  let ready = false;
  return {
    async download(version, progress) {
      if (!newerStable(version, app.getVersion())) throw new Error('Update must be newer');
      ready = false; token = new CancellationToken();
      const options = { provider: 'generic' as const, url: `${downloads}v${version}/`,
        channel: process.platform === 'win32' ? `latest-${process.arch}` : 'latest', useMultipleRangeRequest: false };
      engine = process.platform === 'win32' ? new NsisUpdater(options) : new AppImageUpdater(options);
      engine.autoDownload = false; engine.autoInstallOnAppQuit = false;
      engine.allowPrerelease = false; engine.allowDowngrade = false;
      engine.disableDifferentialDownload = true; engine.disableWebInstaller = true;
      engine.logger = null;
      if (engine instanceof NsisUpdater) engine.installDirectory = path.dirname(process.execPath);
      engine.on('error', () => { /* downloadUpdate rejects; show a safe, retryable UI error. */ });
      engine.on('download-progress', event => progress(event.percent));
      const result = await engine.checkForUpdates();
      if (token.cancelled) throw new Error('Cancelled');
      if (!result || !validUpdateMetadata(result.updateInfo, version, process.platform, process.arch)) throw new Error('Invalid update metadata');
      const files = await engine.downloadUpdate(token);
      if (token.cancelled || files.length !== 1) throw new Error('Incomplete download');
      ready = true;
    },
    cancel() { token?.cancel(); },
    install() {
      if (!ready || !engine) throw new Error('Update not downloaded');
      // The caller has already flushed task state, closed SQLite and saved
      // sessions. NSIS replaces the current installation and starts it again.
      engine.quitAndInstall(true, true);
    }
  };
}
