import test from 'node:test';
import assert from 'node:assert/strict';
import { newerStable, validUpdateMetadata } from '../src/shared/updates';
import { UpdateChecker } from '../src/main/UpdateChecker';

test('stable versions compare numerically and never downgrade or offer previews', () => {
  for (const version of ['v1.0.1', '1.10.0', '2.0.0']) assert.ok(newerStable(version, '1.0.0'));
  for (const version of ['1.0.0', '0.9.9', 'v2.0.0-beta.1', 'garbage', '01.2.3']) assert.equal(newerStable(version, '1.0.0'), false);
  assert.equal(newerStable('1.9.0', '1.10.0'), false);
});
test('checks deduplicate requests and send no account data', async () => {
  let count = 0;
  const checker = new UpdateChecker('1.0.0', true, () => {}, (async (url, options) => {
    count++;
    assert.equal(url, 'https://api.github.com/repos/chenziyang110/ChatGPT-Web-Client/releases/latest');
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.body, undefined);
    assert.deepEqual(Object.keys(options!.headers!), ['Accept', 'User-Agent']);
    return new Response(JSON.stringify({ tag_name: 'v1.1.0', draft: false, prerelease: false }));
  }) as typeof fetch);
  await Promise.all([checker.check(), checker.check()]);
  assert.equal(count, 1); assert.equal(checker.state.status, 'available');
  checker.setEnabled(false); assert.equal(checker.state.enabled, false);
});
test('network failures and invalid releases remain retryable errors', async () => {
  for (const response of [new Response('', { status: 404 }), new Response('invalid'), new Response(JSON.stringify({ tag_name: 'v2.0.0', prerelease: true }))]) {
    const checker = new UpdateChecker('1.0.0', true, () => {}, (async () => response.clone()) as typeof fetch);
    await checker.check(); assert.equal(checker.state.status, 'error');
    await checker.check(); assert.equal(checker.state.status, 'error');
  }
});
test('current release reports up to date', async () => {
  const checker = new UpdateChecker('1.0.0', true, () => {}, (async () => new Response('{"tag_name":"v1.0.0"}')) as typeof fetch);
  await checker.check(); assert.equal(checker.state.status, 'current');
});

const release = (async () => new Response('{"tag_name":"v1.4.0"}')) as typeof fetch;
test('download is explicit, deduplicated, reports progress, and installs only after completion', async () => {
  let downloads = 0, installs = 0, finish!: () => void;
  const checker = new UpdateChecker('1.3.1', true, () => {}, release, {
    download: async (version, progress) => {
      downloads++; assert.equal(version, '1.4.0'); progress(42.7);
      await new Promise<void>(resolve => { finish = resolve; });
    }, cancel() {}, install() { installs++; }
  });
  await checker.check(); assert.equal(downloads, 0);
  assert.throws(() => checker.beginInstall());
  const first = checker.download(); const second = checker.download();
  assert.equal(downloads, 1); assert.equal(checker.state.progress, 42);
  assert.equal((await checker.check()).status, 'downloading');
  finish(); await Promise.all([first, second]);
  assert.equal(checker.state.status, 'downloaded'); assert.equal(installs, 0);
  assert.equal((await checker.check()).status, 'downloaded', 'Automatic checks cannot discard a ready installer');
  await checker.download(); assert.equal(downloads, 1);
  checker.beginInstall(); checker.install(); assert.equal(installs, 1);
  assert.throws(() => checker.beginInstall(), /先完成/);
});
test('failed downloads retry, cancellation returns to available, and manual builds cannot install', async () => {
  let attempts = 0, reject!: (error: Error) => void;
  const checker = new UpdateChecker('1.3.1', true, () => {}, release, {
    download: async () => {
      if (++attempts === 1) throw new Error('SHA512 mismatch');
      await new Promise<void>((_, fail) => { reject = fail; });
    }, cancel() { reject(new Error('Cancelled')); }, install() { assert.fail('Must not install'); }
  });
  await checker.check(); await checker.download();
  assert.equal(checker.state.status, 'error'); assert.match(checker.state.error!, /校验/);
  const next = checker.download(); checker.cancelDownload(); await next;
  assert.equal(attempts, 2); assert.equal(checker.state.status, 'available'); assert.equal(checker.state.error, undefined);
  assert.throws(() => checker.install());
  const manual = new UpdateChecker('1.3.1', true, () => {}, release);
  await manual.check(); await assert.rejects(manual.download(), /官方下载/);
});
test('update metadata must match the exact version, platform, architecture and file hash', () => {
  const info = { version: '1.4.0', files: [{ url: 'ChatGPT-Web-Client-1.4.0-win-x64.exe', size: 12345, sha512: Buffer.alloc(64).toString('base64') }] };
  assert.ok(validUpdateMetadata(info, '1.4.0', 'win32', 'x64'));
  assert.equal(validUpdateMetadata(info, '1.4.0', 'win32', 'arm64'), false);
  assert.equal(validUpdateMetadata(info, '1.4.1', 'win32', 'x64'), false);
  for (const changes of [{ url: 'https://untrusted.test/app.exe' }, { url: '../app.exe' }, { sha512: '' }, { size: 0 }, { size: 3 * 1024 ** 3 }]) {
    assert.equal(validUpdateMetadata({ ...info, files: [{ ...info.files[0], ...changes }] }, '1.4.0', 'win32', 'x64'), false);
  }
  for (const value of [null, {}, { ...info, files: [] }, { ...info, files: [...info.files, ...info.files] }]) {
    assert.equal(validUpdateMetadata(value, '1.4.0', 'win32', 'x64'), false);
  }
  assert.ok(validUpdateMetadata({ ...info, files: [{ ...info.files[0], url: 'ChatGPT-Web-Client-1.4.0-linux-arm64.AppImage' }] }, '1.4.0', 'linux', 'arm64'));
});
