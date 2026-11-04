import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/core/storage/Database';
import { AgentGateway, type TaskExecutor } from '../src/core/agent/AgentGateway';
import { AccountManager } from '../src/core/account/AccountManager';
import { ConversationManager } from '../src/core/conversation/ConversationManager';
import { Workspace } from '../src/core/Workspace';
import { MAX_QUEUE_REPEAT_COUNT, orderedTasks } from '../src/shared/conversationQueue';
import type { AccountQueue, AgentTask } from '../src/shared/types';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const minute = 60000;
function fixture(t: TestContext, execute: TaskExecutor = async () => {}, concurrency = 0) {
  const db = new Database(':memory:');
  const accounts = new AccountManager(db);
  const account = accounts.create('First'); const other = accounts.create('Second');
  const conversations = new ConversationManager(db);
  const dot = conversations.register(account.id, 'https://chatgpt.com/dots/first~channel');
  const sibling = conversations.register(account.id, 'https://chatgpt.com/dots/first~sibling');
  const otherDot = conversations.register(other.id, dot.url);
  const chat = conversations.register(account.id, 'https://chatgpt.com/c/chat');
  const work = conversations.register(account.id, 'https://chatgpt.com/c/work', undefined, 'work');
  let changes = 0;
  let gateway = new AgentGateway(db, execute, () => { changes++; }, concurrency);
  const workspace = () => new Workspace(accounts, gateway, {
    activate() {}, remove: async () => {}, navigate: async () => {}, control() {}, page: () => null
  }, () => {}, () => ({ enabled: false, endpoint: null, discoveryFile: '' }), conversations);
  let app = workspace();
  const params = { accountId: account.id, conversation: dot.id, prompt: '继续工作', count: 10, idempotencyKey: 'repeat-request' };
  t.after(async () => { await gateway.stop(); db.close(); });
  return { db, account, other, dot, sibling, otherDot, chat, work, params,
    get gateway() { return gateway; }, get changes() { return changes; },
    repeat: (patch: Record<string, unknown> = {}) => app.call('tasks.repeat', { ...params, ...patch }) as Promise<AgentTask[]>,
    call: (method: string, value: Record<string, unknown>) => app.call(method, value),
    async restart() { await gateway.stop(); gateway = new AgentGateway(db, execute, () => { changes++; }, concurrency); app = workspace(); await flush(); },
    queue: () => db.read<AccountQueue>('account_queues', `${account.id}:conversation:${dot.id}`)!
  };
}

test('Dot repeats append exactly N independent messages with contiguous FIFO order and preserve pause/timing', async t => {
  const f = fixture(t);
  f.gateway.configureTiming(f.account.id, f.dot.id, 10 * minute);
  f.gateway.pause(f.account.id, f.dot.id);
  const existing = f.gateway.createTask(f.account.id, { type: 'prompt', prompt: 'already queued', submit: true }, {
    conversationId: f.dot.id, background: true
  });
  const due = f.queue().timing?.nextSendAt;
  const changes = f.changes;
  const tasks = await f.repeat({ replyTimeoutMs: 3600000, idleTimeoutMs: 3600000 });
  assert.equal(tasks.length, 10);
  assert.equal(new Set(tasks.map(task => task.id)).size, 10);
  assert.deepEqual(tasks.map(task => task.seq), Array.from({ length: 10 }, (_, index) => existing.seq! + index + 1));
  assert.deepEqual(orderedTasks(f.gateway.listTasks()).map(task => task.id), [existing.id, ...tasks.map(task => task.id)]);
  for (const task of tasks) {
    assert.deepEqual(task.input, { type: 'prompt', prompt: '继续工作', submit: true });
    assert.equal(task.accountId, f.account.id); assert.equal(task.conversationId, f.dot.id);
    assert.equal(task.targetUrl, f.dot.url); assert.equal(task.background, true);
    assert.equal(task.status, 'pending'); assert.equal(task.sendMode, 'dot_interval');
    assert.equal(task.replyTimeoutMs, 3600000); assert.equal(task.idleTimeoutMs, 3600000);
    assert.equal(task.idempotencyKey, undefined, 'Per-task updates must not overwrite the batch request record');
  }
  assert.equal(f.changes, changes + 1, 'Notify the gateway once after the whole batch commits');
  assert.equal(f.queue().paused, true); assert.equal(f.queue().timing?.nextSendAt, due);
  f.gateway.edit(f.account.id, f.dot.id, tasks[0].id, tasks[0].updatedAt, 'Changed first only');
  assert.equal((f.gateway.get(tasks[1].id).input as { prompt: string }).prompt, '继续工作');
});

test('Dot repeat validates the batch boundary before writes and does not impose a total queue capacity', async t => {
  const f = fixture(t);
  for (const count of [0, -1, 1.5, NaN, Infinity, '10', undefined, MAX_QUEUE_REPEAT_COUNT + 1, 1e12]) {
    await assert.rejects(f.repeat({ count }), /发送次数/);
  }
  for (const patch of [
    { prompt: '' }, { prompt: ' '.repeat(10) }, { prompt: 'x'.repeat(32001) },
    { idempotencyKey: undefined }, { idempotencyKey: '' }, { replyTimeoutMs: 999 }, { idleTimeoutMs: '1000' },
    { conversation: f.chat.id }, { conversation: f.work.id }, { conversation: undefined },
    { accountId: f.other.id }, { conversation: f.otherDot.id },
    { url: f.dot.url }, { new: true }, { current: true }
  ]) await assert.rejects(f.repeat(patch));
  assert.equal(f.gateway.listTasks().length, 0); assert.equal(f.db.get('taskSequence'), undefined);
  assert.equal(f.db.records('request_keys').length, 0);
  const maximum = await f.repeat({ count: MAX_QUEUE_REPEAT_COUNT });
  assert.equal(maximum.length, MAX_QUEUE_REPEAT_COUNT);
  await f.repeat({ count: 5, idempotencyKey: 'next-batch' });
  assert.equal(f.gateway.listTasks().length, MAX_QUEUE_REPEAT_COUNT + 5, 'The resource bound applies to one operation, not all pending messages');
});

test('repeat retries are idempotent across concurrent calls and conflicts never add another batch', async t => {
  const f = fixture(t);
  const [first, retried] = await Promise.all([f.repeat(), f.repeat()]);
  assert.deepEqual(retried.map(task => task.id), first.map(task => task.id));
  assert.equal(f.gateway.listTasks().length, 10);
  for (const patch of [{ count: 11 }, { prompt: 'different' }, { conversation: f.sibling.id }, { replyTimeoutMs: 1000 }, { idleTimeoutMs: 1000 }]) {
    await assert.rejects(f.repeat(patch), /IDEMPOTENCY_CONFLICT/);
  }
  await assert.rejects(f.call('tasks.create', { accountId: f.account.id, conversation: f.dot.id,
    idempotencyKey: f.params.idempotencyKey, input: { type: 'prompt', prompt: f.params.prompt, submit: true } }), /IDEMPOTENCY_CONFLICT/);
  assert.throws(() => f.gateway.findRequest(f.account.id, f.params.idempotencyKey, first[0].requestHash!), /IDEMPOTENCY_CONFLICT/);
  const another = await f.repeat({ idempotencyKey: 'new-key' });
  assert.notEqual(another[0].id, first[0].id, 'An intentional second batch of the same text is allowed');
  const other = await f.repeat({ accountId: f.other.id, conversation: f.otherDot.id });
  assert.equal(other.length, 10); assert.equal(other[0].accountId, f.other.id);
  assert.equal(f.gateway.listTasks().filter(task => task.conversationId === f.sibling.id).length, 0);
  assert.equal(f.gateway.listTasks().length, 30);
  await f.call('tasks.create', { accountId: f.account.id, conversation: f.dot.id,
    idempotencyKey: 'single-first', input: { type: 'prompt', prompt: f.params.prompt, submit: true } });
  await assert.rejects(f.repeat({ idempotencyKey: 'single-first' }), /IDEMPOTENCY_CONFLICT/);
});

test('failed task or batch-record writes roll back tasks, sequence, countdown and request key atomically', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  for (const failure of ['second-task', 'batch-record']) {
    const f = fixture(t);
    f.gateway.configureTiming(f.account.id, f.dot.id, minute);
    const before = JSON.stringify(f.queue()); const changes = f.changes;
    const write = f.db.write.bind(f.db); let writes = 0;
    const mocked = t.mock.method(f.db, 'write', (...args: Parameters<Database['write']>) => {
      if (failure === 'second-task' && args[0] === 'tasks' && ++writes === 2 || failure === 'batch-record' && args[0] === 'request_keys') throw new Error('Injected disk write failure');
      return write(...args);
    });
    await assert.rejects(f.repeat(), /Injected disk write failure/);
    mocked.mock.restore();
    assert.equal(f.gateway.listTasks().length, 0); assert.equal(f.db.get('taskSequence'), undefined);
    assert.equal(f.db.records('request_keys').length, 0); assert.equal(JSON.stringify(f.queue()), before);
    assert.equal(f.changes, changes, 'Do not expose or schedule an uncommitted partial batch');
    const tasks = await f.repeat();
    assert.equal(tasks.length, 10); assert.equal(tasks[0].seq, 1);
    assert.equal(f.queue().timing?.nextSendAt, Date.now() + minute);
  }
});

test('persisted repeat keys survive closing SQLite and never replay a partially cleared batch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-dot-repeat-'));
  const filename = join(directory, 'metadata.sqlite');
  let db = new Database(filename); let gateway = new AgentGateway(db, async () => {}, () => {}, 0);
  try {
    const account = new AccountManager(db).create('Owner');
    const dot = new ConversationManager(db).register(account.id, 'https://chatgpt.com/dots/persisted');
    gateway.pause(account.id, dot.id);
    const options = { conversationId: dot.id, idempotencyKey: 'persisted-key' };
    const first = gateway.createRepeatedTasks(account.id, 'persist me', 3, options);
    await gateway.stop(); db.close();
    db = new Database(filename); gateway = new AgentGateway(db, async () => {}, () => {}, 0);
    const retried = gateway.createRepeatedTasks(account.id, 'persist me', 3, options);
    assert.deepEqual(retried.map(task => task.id), first.map(task => task.id));
    assert.equal(gateway.queues().find(queue => queue.conversationId === dot.id)?.paused, true);
    db.write('tasks', first[0].id, { ...retried[0], status: 'done', phase: 'completed' });
    assert.equal(gateway.clearFinishedHistory(), 1);
    assert.throws(() => gateway.createRepeatedTasks(account.id, 'persist me', 3, options), /REQUEST_ALREADY_HANDLED/);
    assert.equal(gateway.listTasks().length, 2, 'Never recreate a member whose history was cleared');
  } finally {
    await gateway.stop(); db.close();
    assert.equal(join(directory, '..'), tmpdir());
    rmSync(directory, { recursive: true, force: true });
  }
});

test('identical Dot messages retain FIFO intervals and a restart delivers only one overdue member', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const sent: Array<{ id: string; at: number }> = [];
  const f = fixture(t, async (_account, input, _signal, context) => {
    assert.equal(input.type, 'prompt');
    context.intent(); context.submitted(`receipt-${context.task().id}`);
    sent.push({ id: context.task().id, at: Date.now() });
  }, 1);
  f.gateway.configureTiming(f.account.id, f.dot.id, minute);
  const tasks = await f.repeat({ count: 3 }); await flush();
  assert.equal(sent.length, 0);
  t.mock.timers.tick(minute); await flush();
  assert.deepEqual(sent.map(item => item.id), [tasks[0].id]);
  const due = f.queue().timing?.nextSendAt;
  await f.restart();
  assert.equal(f.queue().timing?.nextSendAt, due);
  t.mock.timers.tick(minute - 1); await flush(); assert.equal(sent.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(sent.length, 2);
  await f.gateway.stop(); t.mock.timers.tick(10 * minute); await f.restart();
  assert.deepEqual(sent.map(item => item.id), tasks.map(task => task.id));
  assert.equal(f.queue().timing?.nextSendAt, Date.now() + minute);
  assert.deepEqual((await f.repeat({ count: 3 })).map(task => task.id), tasks.map(task => task.id));
  assert.equal(sent.length, 3);
  assert.equal(new Set(tasks.map(task => f.gateway.get(task.id).submittedMessageId)).size, 3);
});
