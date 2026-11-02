import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tempRequire = createRequire(require.resolve('temp'));
type CleanupOptions = { maxBusyTries?: number };
type Cleanup = {
  (target: string, options: CleanupOptions, callback: (error: NodeJS.ErrnoException | null) => void): void;
  (target: string, callback: (error: NodeJS.ErrnoException | null) => void): void;
  sync(target: string, options?: CleanupOptions): void;
};
const cleanup = tempRequire('rimraf') as Cleanup;
type Counts = { files: number; dirs: number };
const temp = require('temp') as {
  track(): void;
  mkdirSync(options: { dir: string; prefix: string }): string;
  mkdir(options: { dir: string; prefix: string }): Promise<string>;
  openSync(options: { dir: string; prefix: string }): { path: string; fd: number };
  open(options: { dir: string; prefix: string }): Promise<{ path: string; fd: number }>;
  cleanupSync(): Counts;
  cleanup(callback: (error: Error | null, counts: Counts) => void): void;
};

function fixture(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-temp-cleanup-'));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), dir);
    assert.ok(relative.startsWith('chatgpt-temp-cleanup-') && !relative.includes(path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('temp resolves its literal cleanup dependency to the private adapter', () => {
  const manifest = tempRequire('rimraf/package.json');
  assert.equal(manifest.name, '@chatgpt-web-client/temp-cleanup');
  assert.equal(manifest.private, true);
});

test('installed temp tracks and cleans nested files with sync and callback APIs', async t => {
  const root = fixture(t);
  temp.track();
  t.after(() => temp.cleanupSync());
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'keep');

  function populate(dir: string): string {
    fs.mkdirSync(path.join(dir, 'nested', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', 'deep', '[literal]{a,b}!.txt'), 'remove');
    fs.symlinkSync(outside, path.join(dir, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
    const similar = dir.replace('[literal]', 'l');
    fs.mkdirSync(similar);
    fs.writeFileSync(path.join(similar, 'keep.txt'), 'keep');
    return similar;
  }

  const syncDir = temp.mkdirSync({ dir: root, prefix: '[literal]-sync-' });
  const syncSimilar = populate(syncDir);
  const syncFile = temp.openSync({ dir: root, prefix: '[literal]-sync-file-' });
  fs.closeSync(syncFile.fd);
  assert.deepEqual(temp.cleanupSync(), { files: 1, dirs: 1 });
  assert.equal(fs.existsSync(syncDir), false);
  assert.equal(fs.existsSync(syncFile.path), false);
  assert.equal(fs.readFileSync(path.join(syncSimilar, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');

  const asyncDir = await temp.mkdir({ dir: root, prefix: '[literal]-async-' });
  const asyncSimilar = populate(asyncDir);
  const asyncFile = await temp.open({ dir: root, prefix: '[literal]-async-file-' });
  fs.closeSync(asyncFile.fd);
  let calls = 0;
  const counts = await new Promise<Counts>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('temp cleanup callback did not finish')), 5000);
    temp.cleanup((error, result) => {
      calls += 1;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    });
  });
  assert.deepEqual(counts, { files: 1, dirs: 1 });
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(asyncDir), false);
  assert.equal(fs.existsSync(asyncFile.path), false);
  assert.equal(fs.readFileSync(path.join(asyncSimilar, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});

test('literal cleanup tolerates missing paths and invokes its callback once', async t => {
  const missing = path.join(fixture(t), '[missing]');
  cleanup.sync(missing);
  let calls = 0;
  await new Promise<void>((resolve, reject) => cleanup(missing, error => {
    calls += 1;
    if (error) reject(error);
    else resolve();
  }));
  assert.equal(calls, 1);
});

test('cleanup preserves temp retry settings and propagates asynchronous EBUSY', async t => {
  const expected = Object.assign(new Error('busy'), { code: 'EBUSY' });
  let calls = 0;
  t.mock.method(fs, 'rm', (target: string, options: fs.RmOptions, callback: (error: NodeJS.ErrnoException) => void) => {
    assert.equal(target, 'literal-[path]');
    assert.deepEqual(options, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    callback(expected);
  });
  await new Promise<void>(resolve => cleanup('literal-[path]', { maxBusyTries: 6 }, error => {
    calls += 1;
    assert.equal(error, expected);
    resolve();
  }));
  assert.equal(calls, 1);
});

test('cleanup preserves sync retry settings and propagates filesystem errors', t => {
  const expected = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  t.mock.method(fs, 'rmSync', (target: string, options: fs.RmOptions) => {
    assert.equal(target, 'literal-[path]');
    assert.deepEqual(options, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    throw expected;
  });
  assert.throws(() => cleanup.sync('literal-[path]', { maxBusyTries: 6 }), error => error === expected);
});
