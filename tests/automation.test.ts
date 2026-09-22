import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { Database } from '../src/core/storage/Database';
import { AccountManager } from '../src/core/account/AccountManager';
import { ConversationManager, conversationUrl } from '../src/core/conversation/ConversationManager';
import { AgentGateway } from '../src/core/agent/AgentGateway';
import { Workspace } from '../src/core/Workspace';
import { argumentsFor, seconds } from '../src/cli/arguments';
import type { AgentTask } from '../src/shared/types';
const sleep = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) { assert.ok(Date.now() < deadline, 'condition timed out'); await sleep(); }
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test('history cleanup removes finished records while preserving active work and retry protection', async () => {
  const db = new Database(':memory:'); const gate = deferred();
  const gateway = new AgentGateway(db, async (_account, input) => { if (input.type === 'prompt') await gate.promise; }, () => {});
  try {
    const done = gateway.createTask('a', { type: 'snapshot' }, { idempotencyKey: 'clear-once' });
    await until(() => gateway.get(done.id).status === 'done');
    const running = gateway.createTask('a', { type: 'prompt', prompt: 'hold' });
    await until(() => gateway.get(running.id).status === 'running');
    for (const status of ['pending', 'blocked', 'waiting_user', 'uncertain', 'failed', 'cancelled'] as const) {
      db.write('tasks', status, { ...done, id: status, status, idempotencyKey: undefined });
    }
    assert.equal(gateway.clearFinishedHistory(), 3);
    assert.deepEqual(gateway.listTasks().map(task => task.id).sort(), [running.id, 'pending', 'blocked', 'waiting_user', 'uncertain'].sort());
    assert.throws(() => gateway.createTask('a', { type: 'snapshot' }, { idempotencyKey: 'clear-once' }), /REQUEST_ALREADY_HANDLED/);
    assert.equal(gateway.clearFinishedHistory(), 0);
  } finally { gate.resolve(); await gateway.stop(); db.close(); }
});

test('different conversations in one account run together while each conversation keeps FIFO', async () => {
  const db = new Database(':memory:'); const gate = deferred(); const started: string[] = [];
  const gateway = new AgentGateway(db, async (_account, input) => { if (input.type !== 'prompt') return; started.push(input.prompt); if (input.prompt === 'a1') await gate.promise; }, () => {});
  try {
    const a1 = gateway.createTask('same', { type: 'prompt', prompt: 'a1' }, { conversationId: 'a' });
    const a2 = gateway.createTask('same', { type: 'prompt', prompt: 'a2' }, { conversationId: 'a' });
    const b = gateway.createTask('same', { type: 'prompt', prompt: 'b' }, { conversationId: 'b' });
    await until(() => gateway.get(b.id).status === 'done');
    assert.equal(gateway.get(a1.id).status, 'running'); assert.equal(gateway.get(a2.id).status, 'pending');
    assert.deepEqual(started, ['a1', 'b']); gate.resolve(); await until(() => gateway.get(a2.id).status === 'done');
  } finally { gate.resolve(); await gateway.stop(); db.close(); }
});

test('a legacy conversation error does not keep the entire account paused after migration', async () => {
  const db = new Database(':memory:');
  db.write('tasks', 'old', { id: 'old', accountId: 'same', conversationId: 'a', status: 'blocked', input: { type: 'snapshot' }, createdAt: 1, updatedAt: 1, error: 'COMPOSER_NOT_READY' });
  db.write('account_queues', 'same', { accountId: 'same', paused: true, reason: '任务需要处理，请检查错误后继续' });
  const gateway = new AgentGateway(db, async () => 'done', () => {});
  try {
    const next = gateway.createTask('same', { type: 'snapshot' }, { conversationId: 'b' });
    await until(() => gateway.get(next.id).status === 'done');
    assert.equal(gateway.get('old').status, 'waiting_user');
    assert.equal(gateway.get('old').sendIntentAt, undefined);
    assert.equal(gateway.queues().find(queue => queue.conversationId === 'a')?.paused, true);
  } finally { await gateway.stop(); db.close(); }
});

test('per-account FIFO, global limit and waiting-account fairness', async () => {
  const db = new Database(':memory:');
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const started: string[] = [];
  const gateway = new AgentGateway(db, async (_id, input) => {
    const name = input.type === 'prompt' ? input.prompt : '';
    started.push(name); const gate = deferred(); gates.set(name, gate); await gate.promise;
  }, () => {});
  const add = (account: string, name: string) => gateway.createTask(account, { type: 'prompt', prompt: name }, { conversationId: account });
  add('a', 'a1'); add('a', 'a2'); add('a', 'a3'); add('b', 'b1'); add('b', 'b2'); add('c', 'c1');
  await until(() => started.length === 2);
  assert.deepEqual(started, ['a1', 'b1']);
  gates.get('a1')!.resolve(); await until(() => started.length === 3);
  assert.equal(started[2], 'c1', 'an unserved account must not starve behind more work for A');
  gates.get('b1')!.resolve(); await until(() => started.length === 4);
  assert.equal(started[3], 'a2');
  gates.get('c1')!.resolve(); gates.get('a2')!.resolve(); await until(() => started.length === 6);
  gates.get('a3')!.resolve(); gates.get('b2')!.resolve();
  await until(() => gateway.runningAccounts().length === 0);
  assert.deepEqual(started.filter(name => name.startsWith('a')), ['a1', 'a2', 'a3']);
  await gateway.stop(); db.close();
});

test('uncertain cancellation quarantines the account until review and keeps the lock through cleanup', async () => {
  const db = new Database(':memory:'); const cleanup = deferred(); let sent = 0;
  const gateway = new AgentGateway(db, async (_account, input, signal, context) => {
    if (input.type === 'snapshot') return;
    context.intent(); sent++;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    await cleanup.promise;
  }, () => {});
  const first = gateway.createTask('a', { type: 'prompt', prompt: 'once', submit: true }, { conversationId: 'c', idempotencyKey: 'one' });
  const next = gateway.createTask('a', { type: 'snapshot' }, { conversationId: 'c' });
  await until(() => sent === 1); gateway.cancel(first.id);
  assert.equal(gateway.get(first.id).status, 'uncertain');
  assert.equal(gateway.isRunning('a'), true);
  assert.throws(() => gateway.resume('a', true), /暂停操作完成/);
  cleanup.resolve(); await until(() => !gateway.isRunning('a'));
  assert.equal(gateway.get(next.id).status, 'pending');
  assert.throws(() => gateway.resume('a'), /REVIEW_REQUIRED/);
  gateway.resume('a', true); await until(() => gateway.get(next.id).status === 'done');
  assert.equal(sent, 1); assert.ok(gateway.get(first.id).resolvedAt);
  const duplicate = gateway.createTask('a', { type: 'prompt', prompt: 'once', submit: true }, { conversationId: 'c', idempotencyKey: 'one' });
  assert.equal(duplicate.id, first.id); assert.equal(duplicate.status, 'uncertain');
  await gateway.stop(); db.close();
});

test('reply timeout pauses only its account; pre-send blocks can be resumed', async () => {
  const db = new Database(':memory:'); let fail = true;
  const gateway = new AgentGateway(db, async (id, _input, signal, context) => {
    if (id === 'slow') { context.intent(); context.stage('generating', 25); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    if (id === 'draft' && fail) throw new Error('DRAFT_CONFLICT');
  }, () => {});
  const slow = gateway.createTask('slow', { type: 'snapshot' }, { conversationId: 'c' });
  const draft = gateway.createTask('draft', { type: 'snapshot' }, { conversationId: 'c' });
  const good = gateway.createTask('good', { type: 'snapshot' }, { conversationId: 'c' });
  await until(() => gateway.get(slow.id).status === 'uncertain' && gateway.get(good.id).status === 'done');
  assert.equal(gateway.get(draft.id).status, 'waiting_user'); assert.equal(gateway.get(draft.id).sendIntentAt, undefined);
  fail = false; await gateway.decide(draft.id, gateway.get(draft.id).attention!.id, 'retry'); await until(() => gateway.get(draft.id).status === 'done');
  await gateway.stop(); db.close();
});

test('new-conversation retries use one target and one task; account/current target is frozen at enqueue time', async () => {
  const db = new Database(':memory:'); const accounts = new AccountManager(db); const conversations = new ConversationManager(db);
  const account = accounts.create('Work'); accounts.setAlias(account.id, 'work');
  let current = 'https://chatgpt.com/c/first';
  const gateway = new AgentGateway(db, async () => {}, () => {}); gateway.pause(account.id);
  const workspace = new Workspace(accounts, gateway, { activate: () => {}, remove: async () => {}, navigate: async () => {}, control: () => {}, page: () => null, url: () => current }, () => {}, () => ({ enabled: false, endpoint: null, discoveryFile: '' }), conversations);
  const params = { accountId: 'work', new: true, alias: 'daily', idempotencyKey: 'stable', input: { type: 'prompt', prompt: 'Hello', submit: true } };
  const first = await workspace.call('tasks.create', params) as AgentTask;
  const second = await workspace.call('tasks.create', params) as AgentTask;
  assert.equal(first.id, second.id); assert.equal(conversations.list().length, 1);
  await assert.rejects(workspace.call('tasks.create', { ...params, input: { ...params.input, prompt: 'Changed' } }), /IDEMPOTENCY_CONFLICT/);
  const fixed = await workspace.call('tasks.create', { accountId: 'work', current: true, input: { type: 'prompt', prompt: 'A' } }) as AgentTask;
  current = 'https://chatgpt.com/c/second'; workspace.state();
  assert.equal(gateway.get(fixed.id).targetUrl, 'https://chatgpt.com/c/first');
  const other = accounts.create('Personal');
  assert.throws(() => conversations.get(other.id, first.conversationId!), /not found/);
  await assert.rejects(workspace.call('tasks.create', { ...params, idempotencyKey: 'bad', alias: 'invalid-timeout', replyTimeoutMs: 1 }), /replyTimeout/);
  assert.equal(conversations.list().some(item => item.alias === 'invalid-timeout'), false);
  await gateway.stop(); db.close();
});

test('restart restores queues paused and persists deduplication even after clearing history', async () => {
  const directory = mkdtempSync(path.resolve('.test-recovery-')); const filename = path.join(directory, 'workspace.sqlite');
  try {
    let db = new Database(filename); let executions = 0;
    let gateway = new AgentGateway(db, async () => { executions++; }, () => {});
    gateway.pause('a');
    const pending = gateway.createTask('a', { type: 'snapshot' }, { conversationId: 'c', idempotencyKey: 'key' });
    await gateway.stop(); db.close();
    db = new Database(filename); gateway = new AgentGateway(db, async () => { executions++; }, () => {});
    await sleep(20); assert.equal(executions, 0); assert.equal(gateway.get(pending.id).status, 'pending');
    assert.equal(gateway.queues()[0].paused, true);
    gateway.resume('a'); await until(() => gateway.get(pending.id).status === 'done');
    gateway.removeHistory();
    assert.throws(() => gateway.createTask('a', { type: 'snapshot' }, { conversationId: 'c', idempotencyKey: 'key' }), /REQUEST_ALREADY_HANDLED/);
    assert.equal(executions, 1);
    assert.deepEqual(Object.keys(db.records('request_keys')[0] as object).sort(), ['accountId', 'hash', 'taskId']);
    await gateway.stop(); db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('schema migration creates a restorable backup and preserves account/profile metadata', () => {
  const directory = mkdtempSync(path.resolve('.test-migration-')); const filename = path.join(directory, 'workspace.sqlite');
  try {
    const old = new DatabaseSync(filename); old.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    old.prepare('INSERT INTO metadata VALUES (?, ?)').run('schemaVersion', '1');
    old.prepare('INSERT INTO metadata VALUES (?, ?)').run('accounts', JSON.stringify([{ id: 'old', partition: 'persist:untouched' }])); old.close();
    const db = new Database(filename); assert.equal(db.get('schemaVersion'), 2);
    assert.deepEqual(db.get('accounts'), [{ id: 'old', partition: 'persist:untouched' }]); db.close();
    const backup = new DatabaseSync(path.join(directory, readdirSync(directory).find(name => name.includes('v1-backup'))!));
    assert.equal(backup.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get()?.value, '1'); backup.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('conversation addressing and CLI reject ambiguous targets, unsupported URLs and malformed options', () => {
  for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/share/a', 'https://chatgpt.com/g/a/c/b', 'https://chatgpt.com/c/a?temporary-chat=true']) assert.throws(() => conversationUrl(url));
  assert.equal(conversationUrl('https://chatgpt.com/c/abc/').remoteId, 'abc');
  const db = new Database(':memory:'); const conversations = new ConversationManager(db);
  const item = conversations.register('a', 'https://chatgpt.com/c/a', 'daily');
  assert.equal(conversations.register('a', item.url).id, item.id);
  assert.throws(() => conversations.register('a', 'https://chatgpt.com/c/b', 'daily'), /alias/);
  const fresh = conversations.create('a'); conversations.markSending('a', fresh.id);
  assert.equal(conversations.get('a', fresh.id).binding, 'uncertain');
  conversations.bind('a', fresh.id, 'https://chatgpt.com/c/new'); assert.equal(conversations.get('a', fresh.id).binding, 'bound');
  assert.throws(() => conversations.bind('a', fresh.id, 'https://chatgpt.com/c/different'));
  assert.equal(argumentsFor(['prompt', '--account', 'work', '--new', '--text', '你好', '--submit']).options.text, '你好');
  assert.throws(() => argumentsFor(['--account'])); assert.throws(() => argumentsFor(['--unknown']));
  assert.throws(() => argumentsFor(['--new', '--new'])); assert.throws(() => seconds('NaN')); assert.equal(seconds('120'), 120000);
  db.close();
});
