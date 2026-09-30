import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RuntimeDiagnostics } from '../src/main/RuntimeDiagnostics';

function fixture(run: (directory: string) => void) {
  const directory = mkdtempSync(path.resolve('.test-runtime-log-'));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
test('lifecycle records identify incomplete and clean exits', () => fixture(directory => {
  new RuntimeDiagnostics(directory, '1.4.19').record('ready', { accounts: 3 });
  const restarted = new RuntimeDiagnostics(directory, '1.4.19');
  restarted.finish('quit');
  new RuntimeDiagnostics(directory, '1.4.19').finish('quit');
  const records = readFileSync(path.join(directory, 'runtime.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.filter(row => row.event === 'previous_exit_incomplete').length, 1);
  assert.equal(records.find(row => row.event === 'ready').accounts, 3);
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'session.json'), 'utf8')).clean, true);
}));
test('errors keep source locations and codes without exception messages or private paths', () => fixture(directory => {
  const diagnostics = new RuntimeDiagnostics(directory, '1.4.19');
  const error = Object.assign(new Error('secret prompt and token'), { code: 'ERR_SQLITE_ERROR' });
  error.stack = 'Error: secret prompt and token\n    at open (C:\\private-account\\main.cjs:123:45)';
  diagnostics.error('startup_failed', error);
  const content = readFileSync(path.join(directory, 'runtime.jsonl'), 'utf8');
  assert.ok(content.includes('ERR_SQLITE_ERROR') && content.includes('main.cjs:123:45'));
  assert.ok(!content.includes('secret') && !content.includes('private-account'));
}));
test('logs rotate and logging failures cannot prevent startup or shutdown', () => fixture(directory => {
  const diagnostics = new RuntimeDiagnostics(directory, '1.4.19');
  writeFileSync(path.join(directory, 'runtime.jsonl'), 'x'.repeat(512 * 1024));
  diagnostics.record('ready');
  assert.equal(readFileSync(path.join(directory, 'runtime.jsonl.previous'), 'utf8').length, 512 * 1024);
  const unavailable = path.join(directory, 'file');
  writeFileSync(unavailable, 'file');
  assert.doesNotThrow(() => { const logger = new RuntimeDiagnostics(unavailable, '1.4.19'); logger.error('test', new Error()); logger.finish('quit'); });
}));
