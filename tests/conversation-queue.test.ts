import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/storage/Database';
import { AgentGateway, QueuePausedError } from '../src/core/agent/AgentGateway';
import { AccountManager } from '../src/core/account/AccountManager';
import { ConversationManager } from '../src/core/conversation/ConversationManager';
import { Workspace } from '../src/core/Workspace';
import { orderedTasks, LONG_REPLY_TIMEOUT_MS } from '../src/shared/conversationQueue';
import type { AgentTask } from '../src/shared/types';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < end, 'condition timed out'); await tick(); } }
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const prompt = (value: string) => ({ type: 'prompt' as const, prompt: value, submit: true });

test('a 31-minute previous turn and a separate 31-minute reply remain within independent budgets', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const db = new Database(':memory:'); const prior = gate(); let sends = 0;
  const flush = async () => { for (let i=0;i<10;i++) await Promise.resolve(); };
  const gateway = new AgentGateway(db, async (_id, _input, signal, execution) => {
    execution.stage('waiting_idle', execution.task().idleTimeoutMs); await prior.promise;
    signal.throwIfAborted(); execution.intent(); sends++; execution.stage('generating', execution.task().replyTimeoutMs);
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, () => {});
  try {
    const task=gateway.createTask('a',prompt('long'),{conversationId:'c',idleTimeoutMs:LONG_REPLY_TIMEOUT_MS,replyTimeoutMs:LONG_REPLY_TIMEOUT_MS});
    await flush(); context.mock.timers.tick(31*60000); await flush();
    assert.equal(gateway.get(task.id).status,'running'); assert.equal(sends,0);
    prior.resolve(); await flush(); context.mock.timers.tick(31*60000); await flush();
    assert.equal(gateway.get(task.id).status,'running'); assert.equal(sends,1);
    context.mock.timers.tick(30*60000); await flush();
    assert.equal(gateway.get(task.id).status,'uncertain'); assert.equal(sends,1);
    assert.equal(gateway.queues().find(queue=>queue.conversationId==='c')?.paused,true);
  } finally { prior.resolve(); await gateway.stop(); db.close(); }
});

test('conversation pause returns a waiting item to pending, releases its slot, and resumes it once', async () => {
  const db = new Database(':memory:'); let calls = 0; let sends = 0;
  const gateway = new AgentGateway(db, async (_id, _input, signal, context) => {
    if (++calls === 1) { context.stage('waiting_idle', LONG_REPLY_TIMEOUT_MS); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    context.intent(); sends++;
  }, () => {});
  try {
    const task = gateway.createTask('a', prompt('one'), { conversationId: 'c' });
    await until(() => gateway.get(task.id).phase === 'waiting_idle'); gateway.pause('a', 'c');
    await until(() => !gateway.isRunning('a', 'c'));
    assert.equal(gateway.get(task.id).status, 'pending'); assert.equal(gateway.get(task.id).attention, undefined); assert.equal(sends, 0);
    assert.equal(gateway.queues().find(queue => !queue.conversationId)?.paused, false);
    assert.equal(gateway.queues().find(queue => !queue.conversationId)?.pausedConversationCount, 1);
    gateway.resume('a', false, 'c'); await until(() => gateway.get(task.id).status === 'done'); assert.equal(sends, 1);
  } finally { await gateway.stop(); db.close(); }
});

test('pausing during preparation gates send intent without aborting cleanup; sent replies can resume without duplication', async () => {
  const db = new Database(':memory:'); const prepared = gate(); const reply = gate(); let sends = 0; let cleaned = 0; let attempts = 0;
  const gateway = new AgentGateway(db, async (_id, _input, signal, context) => {
    context.stage('preparing_prompt'); attempts++;
    if (attempts === 1) await prepared.promise;
    try { context.intent(); sends++; await reply.promise; }
    catch (error) { if (error instanceof QueuePausedError) { assert.equal(signal.aborted, false); cleaned++; } throw error; }
  }, () => {});
  try {
    const task = gateway.createTask('a', prompt('one'), { conversationId: 'c' });
    await until(() => gateway.get(task.id).phase === 'preparing_prompt'); gateway.pause('a', 'c'); prepared.resolve();
    await until(() => !gateway.isRunning('a')); assert.equal(sends, 0); assert.equal(cleaned, 1);
    gateway.resume('a', false, 'c'); await until(() => sends === 1);
    gateway.pause('a', 'c'); gateway.resume('a', false, 'c');
    await tick(); assert.equal(attempts, 2); assert.equal(sends, 1); assert.equal(gateway.get(task.id).status, 'running');
    reply.resolve(); await until(() => gateway.get(task.id).status === 'done');
  } finally { prepared.resolve(); reply.resolve(); await gateway.stop(); db.close(); }
});

test('pending edits and reorder are versioned, isolated, durable and determine actual dispatch order', async () => {
  const db = new Database(':memory:'); const sent: string[] = [];
  let gateway = new AgentGateway(db, async (_id, input) => { if (input.type === 'prompt') sent.push(input.prompt); }, () => {});
  try {
    gateway.pause('a', 'c');
    const first = gateway.createTask('a', prompt('first'), { conversationId: 'c', idempotencyKey: 'original' });
    const second = gateway.createTask('a', prompt('second'), { conversationId: 'c' });
    const third = gateway.createTask('a', prompt('third'), { conversationId: 'c' });
    assert.throws(() => gateway.edit('a', 'other', second.id, second.updatedAt, 'bad'), /不属于/);
    const edited = gateway.edit('a', 'c', second.id, second.updatedAt, 'edited');
    assert.throws(() => gateway.edit('a', 'c', second.id, second.updatedAt, 'stale'), /QUEUE_CHANGED/);
    const entries = [third, edited, first].map(task => ({ id: task.id, updatedAt: task.updatedAt }));
    assert.throws(() => gateway.reorder('a', 'c', [entries[0], entries[0], entries[2]]), /QUEUE_CHANGED/);
    gateway.reorder('a', 'c', entries);
    assert.throws(() => gateway.reorder('a', 'c', entries), /QUEUE_CHANGED/);
    await gateway.stop();
    gateway = new AgentGateway(db, async (_id, input) => { if (input.type === 'prompt') sent.push(input.prompt); }, () => {});
    assert.deepEqual(orderedTasks(gateway.listTasks()).map(task => task.id), [third.id, second.id, first.id]);
    gateway.resume('a', false, 'c'); await until(() => gateway.get(first.id).status === 'done');
    assert.deepEqual(sent, ['third', 'edited', 'first']);
    assert.equal(gateway.createTask('a', prompt('first'), { conversationId: 'c', idempotencyKey: 'original' }).id, first.id);
    assert.throws(() => gateway.edit('a', 'c', first.id, gateway.get(first.id).updatedAt, 'too late'), /QUEUE_CHANGED/);
    assert.throws(() => gateway.removeQueued('a', 'c', first.id, gateway.get(first.id).updatedAt), /QUEUE_CHANGED/);
  } finally { await gateway.stop(); db.close(); }
});

test('waiting replies release execution capacity across accounts but keep each conversation serial', async () => {
  const db = new Database(':memory:'); const replies = new Map<string, ReturnType<typeof gate>>(); const sent: string[] = [];
  const gateway = new AgentGateway(db, async (_id, input, _signal, context) => {
    if (input.type !== 'prompt') return;
    context.intent(); context.submitted(input.prompt); sent.push(input.prompt);
    if (input.prompt.startsWith('hold')) { const reply = gate(); replies.set(input.prompt, reply); await reply.promise; }
  }, () => {});
  try {
    const first = gateway.createTask('a', prompt('hold-a1'), { conversationId: 'one' });
    const second = gateway.createTask('a', prompt('hold-a2'), { conversationId: 'two' });
    await until(() => sent.length === 2);
    const follow = gateway.createTask('a', prompt('follow-a1'), { conversationId: 'one' });
    const other = gateway.createTask('b', prompt('hold-b1'), { conversationId: 'one' });
    const third = gateway.createTask('a', prompt('hold-a3'), { conversationId: 'three' });
    await until(() => sent.length === 4);
    assert.equal(gateway.get(first.id).status, 'running'); assert.equal(gateway.get(second.id).status, 'running');
    assert.equal(gateway.get(other.id).status, 'running'); assert.equal(gateway.get(third.id).status, 'running');
    assert.equal(gateway.get(follow.id).status, 'pending');
    replies.get('hold-a1')!.resolve(); await until(() => gateway.get(follow.id).status === 'done');
    assert.deepEqual(sent.filter(value => value === 'follow-a1'), ['follow-a1']);
    assert.equal(gateway.get(other.id).status, 'running', 'Finishing A does not interrupt B');
  } finally { for (const reply of replies.values()) reply.resolve(); await gateway.stop(); db.close(); }
});

test('idle waits yield capacity and must reacquire it before preparing a send', async () => {
  const db = new Database(':memory:'); const idle = gate(); const work = gate(); const started: string[] = [];
  const gateway = new AgentGateway(db, async (_id, input, signal, context) => {
    if (input.type !== 'prompt') return;
    if (input.prompt === 'idle') {
      context.stage('waiting_idle'); context.releaseExecution!(); await idle.promise;
      await context.acquireExecution!(); context.checkpoint!(); started.push('idle-ready');
    } else { started.push(input.prompt); await work.promise; }
    signal.throwIfAborted();
  }, () => {}, 1);
  try {
    const waiting = gateway.createTask('a', prompt('idle'), { conversationId: 'one' });
    await until(() => gateway.get(waiting.id).phase === 'waiting_idle');
    const preparing = gateway.createTask('b', prompt('preparing'), { conversationId: 'one' });
    await until(() => started.includes('preparing'));
    idle.resolve(); await tick(); assert.equal(started.includes('idle-ready'), false, 'No send work runs without a permit');
    gateway.pause('a', 'one'); await until(() => !gateway.isRunning('a'));
    assert.equal(gateway.get(waiting.id).status, 'pending');
    work.resolve(); await until(() => gateway.get(preparing.id).status === 'done');
    gateway.resume('a', false, 'one'); await until(() => gateway.get(waiting.id).status === 'done');
    assert.deepEqual(started, ['preparing', 'idle-ready']);
  } finally { idle.resolve(); work.resolve(); await gateway.stop(); db.close(); }
});

test('workspace propagates independent 60-minute budgets and includes new settings in deduplication', async () => {
  const db = new Database(':memory:'); const accounts = new AccountManager(db); const conversations = new ConversationManager(db);
  const gateway = new AgentGateway(db, async () => {}, () => {});
  const workspace = new Workspace(accounts, gateway, { activate() {}, remove: async () => {}, navigate: async () => {}, control() {}, page: () => null }, () => {}, () => ({ enabled: false, endpoint: null, discoveryFile: '' }), conversations);
  try {
    const account = accounts.create('queue'); const conversation = conversations.create(account.id); gateway.pause(account.id, conversation.id);
    const params = { accountId: account.id, conversation: conversation.id, input: prompt('long'), idempotencyKey: 'long', idleTimeoutMs: LONG_REPLY_TIMEOUT_MS, replyTimeoutMs: LONG_REPLY_TIMEOUT_MS, background: true };
    const created = await workspace.call('tasks.create', params) as AgentTask;
    assert.equal(created.idleTimeoutMs, 3600000); assert.equal(created.replyTimeoutMs, 3600000); assert.equal(created.background, true);
    await assert.rejects(workspace.call('tasks.create', { ...params, idleTimeoutMs: 600000 }), /IDEMPOTENCY_CONFLICT/);
    await assert.rejects(workspace.call('tasks.create', { ...params, idempotencyKey: 'bad', idleTimeoutMs: 3600001 }), /idleTimeoutMs/);
    await assert.rejects(workspace.call('tasks.create', { ...params, idempotencyKey: 'bad', background: 'yes' }), /background/);
    const other = accounts.create('other');
    await assert.rejects(workspace.call('tasks.edit', { accountId: other.id, conversation: conversation.id, id: created.id, expectedUpdatedAt: created.updatedAt, prompt: 'wrong' }), /not found/);
  } finally { await gateway.stop(); db.close(); }
});
