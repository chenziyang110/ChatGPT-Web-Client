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
    await writeFile(path.join(dir, `ChatGPT-Web-Client-1.1.0-${platform}-${ext === 'AppImage' && arch === 'x64' ? 'x86_64' : arch}.${ext}`), 'synthetic test artifact');
  }
  assert.equal((await releaseManifest(dir, '1.1.0')).length, 10);
  assert.equal((await readFile(path.join(dir, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n').length, 14);
  for (const [channel, suffix] of [['latest-x64.yml','win-x64.exe'],['latest-arm64.yml','win-arm64.exe'],['latest-linux.yml','linux-x86_64.AppImage'],['latest-linux-arm64.yml','linux-arm64.AppImage']]) {
    const update = JSON.parse(await readFile(path.join(dir, channel), 'utf8'));
    assert.equal(update.version, '1.1.0');
    assert.equal(update.files.length, 1);
    assert.equal(update.files[0].url, `ChatGPT-Web-Client-1.1.0-${suffix}`);
    assert.equal(update.files[0].size, Buffer.byteLength('synthetic test artifact'));
    assert.match(update.files[0].sha512, /^[A-Za-z0-9+/]{86}==$/);
  }
  assert.equal((await releaseManifest(dir, '1.1.0')).length, 10, 'Regenerating metadata is deterministic');
  const file = path.join(dir, 'ChatGPT-Web-Client-1.1.0-mac-arm64.dmg');
  await writeFile(file, ''); await assert.rejects(releaseManifest(dir, '1.1.0'), /Empty/);
  await writeFile(path.join(dir, 'private-log.txt'), 'must not publish');
  await assert.rejects(releaseManifest(dir, '1.1.0'), /exactly/);
});
