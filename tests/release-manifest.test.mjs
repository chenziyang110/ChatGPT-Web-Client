import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { releaseManifest } from '../scripts/release-manifest.mjs';
test('publishing refuses incomplete, empty or unexpected artifacts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workspace-manifest-'));
  await assert.rejects(releaseManifest(dir, '1.1.0'), /exactly/);
  for (const arch of ['x64', 'arm64']) for (const [platform, ext] of [['win','exe'],['mac','dmg'],['mac','zip'],['linux','AppImage'],['linux','tar.gz']]) {
    await writeFile(path.join(dir, `ChatGPT-Web-Client-1.1.0-${platform}-${arch}.${ext}`), 'synthetic test artifact');
  }
  assert.equal((await releaseManifest(dir, '1.1.0')).length, 10);
  assert.equal((await readFile(path.join(dir, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n').length, 10);
  const file = path.join(dir, 'ChatGPT-Web-Client-1.1.0-mac-arm64.dmg');
  await writeFile(file, ''); await assert.rejects(releaseManifest(dir, '1.1.0'), /Empty/);
  await writeFile(path.join(dir, 'private-log.txt'), 'must not publish');
  await assert.rejects(releaseManifest(dir, '1.1.0'), /exactly/);
});
