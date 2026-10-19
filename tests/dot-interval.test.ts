import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/storage/Database';
import { AgentGateway, type TaskExecutor } from '../src/core/agent/AgentGateway';
import { AccountManager } from '../src/core/account/AccountManager';
import { ConversationManager } from '../src/core/conversation/ConversationManager';
import { Workspace } from '../src/core/Workspace';
import type { AccountQueue, Conversation } from '../src/shared/types';

const minute = 60000;
const prompt = (value: string) => ({ type: 'prompt' as const, prompt: value, submit: true });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const key = (accountId = 'a', conversationId = 'dot') => `${accountId}:conversation:${conversationId}`;

function fixture(t: TestContext, execute: TaskExecutor, concurrency = 2) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const db = new Database(':memory:');
  for (const accountId of ['a', 'b']) db.write('conversations', `${accountId}-dot`, {
    id: `${accountId}-dot`, accountId, surface: 'dot', url: 'https://chatgpt.com/dots/home',
    binding: 'bound', title: 'Dot', createdAt: Date.now(), updatedAt: Date.now()
  } satisfies Conversation);
  let gateway = new AgentGateway(db, execute, () => {}, concurrency);
  t.after(async () => { await gateway.stop(); db.close(); });
  return { db, get gateway() { return gateway; },
    async restart() { await gateway.stop(); gateway = new AgentGateway(db, execute, () => {}, concurrency); await flush(); },
    queue: (accountId = 'a') => db.read<AccountQueue>('account_queues', key(accountId, `${accountId}-dot`))!,
    async advance(ms: number) { t.mock.timers.tick(ms); await flush(); }
  };
}

const options = { conversationId: 'a-dot', background: true };

test('Dot interval waits before the first delivery, then spaces from confirmation without occupying another queue', async t => {
  const deliveries: Array<{ text: string; at: number }> = [];
  const f = fixture(t, async (_id, input, _signal, ctx) => {
    if (input.type !== 'prompt') return;
    ctx.intent({ url: 'https://chatgpt.com/dots/home', users: [] });
    ctx.submitted(input.prompt); deliveries.push({ text: input.prompt, at: Date.now() });
  }, 1);
  f.gateway.configureTiming('a', 'a-dot', 10 * minute);
  assert.equal(f.queue().timing?.nextSendAt, undefined, 'An empty queue has no countdown');
  const first = f.gateway.createTask('a', prompt('first'), options);
  const second = f.gateway.createTask('a', prompt('second'), options);
  const other = f.gateway.createTask('b', prompt('ordinary'), { conversationId: 'b-dot' });
  await flush();
  assert.equal(f.gateway.get(other.id).status, 'done');
  assert.equal(f.gateway.get(first.id).sendMode, 'dot_interval');
  assert.equal(f.gateway.get(other.id).sendMode, undefined);
  assert.equal(f.gateway.isRunning('a'), false);
  assert.equal(f.gateway.automaticRecoveryTasks().some(task => task.id === first.id), false, 'Countdown must not authorize page recovery');
  await f.advance(10 * minute - 1);
  assert.equal(f.gateway.get(first.id).status, 'pending');
  await f.advance(1);
  assert.equal(f.gateway.get(first.id).status, 'done');
  assert.equal(f.gateway.get(second.id).status, 'pending');
  await f.advance(10 * minute);
  assert.equal(f.gateway.get(second.id).status, 'done');
  assert.deepEqual(deliveries.map(item => item.text), ['ordinary', 'first', 'second']);
  assert.equal(deliveries[2].at - deliveries[1].at, 10 * minute);
});

test('pause and interval changes retain user control; overdue deliveries never catch up in a burst', async t => {
  const sent: string[] = [];
  const f = fixture(t, async (_id, input, _signal, ctx) => {
    if (input.type !== 'prompt') return;
    ctx.intent(); ctx.submitted(input.prompt); sent.push(input.prompt);
  });
  f.gateway.pause('a', 'a-dot');
  f.gateway.configureTiming('a', 'a-dot', minute);
  const first = f.gateway.createTask('a', prompt('one'), options);
  f.gateway.createTask('a', prompt('two'), options);
  await f.advance(20 * minute);
  assert.deepEqual(sent, []); assert.equal(f.queue().paused, true);
  f.gateway.configureTiming('a', 'a-dot', 2 * minute);
  const due = f.queue().timing?.nextSendAt;
  f.gateway.resume('a', false, 'a-dot'); await flush();
  assert.equal(f.queue().timing?.nextSendAt, due);
  await f.advance(2 * minute);
  assert.equal(f.gateway.get(first.id).status, 'done'); assert.deepEqual(sent, ['one']);
  f.gateway.pause('a', 'a-dot'); await f.advance(20 * minute);
  f.gateway.resume('a', false, 'a-dot'); await flush();
  assert.deepEqual(sent, ['one', 'two']);
  assert.equal(f.queue().timing?.nextSendAt, Date.now() + 2 * minute);
});

test('restart preserves a future countdown and sends only one overdue item', async t => {
  const sent: string[] = [];
  const f = fixture(t, async (_id, input, _signal, ctx) => {
    if (input.type !== 'prompt') return;
    ctx.intent(); ctx.submitted(input.prompt); sent.push(input.prompt);
  });
  f.gateway.configureTiming('a', 'a-dot', minute);
  f.gateway.createTask('a', prompt('one'), options); f.gateway.createTask('a', prompt('two'), options);
  const due = f.queue().timing?.nextSendAt;
  await f.advance(20000); await f.restart();
  assert.equal(f.queue().paused, false); assert.equal(f.queue().timing?.nextSendAt, due);
  await f.advance(39999); assert.deepEqual(sent, []);
  await f.advance(1); assert.deepEqual(sent, ['one']);
  await f.gateway.stop(); await f.advance(10 * minute); await f.restart();
  assert.deepEqual(sent, ['one', 'two']);
  assert.equal(f.queue().timing?.nextSendAt, Date.now() + minute);
});

test('an explicit pause survives restart and changing timing does not resume it', async t => {
  let sends = 0;
  const f = fixture(t, async () => { sends++; });
  f.gateway.configureTiming('a', 'a-dot', minute); f.gateway.createTask('a', prompt('one'), options);
  f.gateway.pause('a', 'a-dot'); await f.advance(2 * minute); await f.restart();
  assert.equal(f.queue().paused, true); assert.equal(sends, 0);
  f.gateway.configureTiming('a', 'a-dot', 20 * minute); await flush();
  assert.equal(f.queue().paused, true); assert.equal(sends, 0);
});

test('unsent retries use retry backoff while the next item still waits from confirmed delivery', async t => {
  let attempts = 0; const sent: string[] = [];
  const f = fixture(t, async (_id, input, _signal, ctx) => {
    if (++attempts === 1) throw new Error('SEND_DISABLED');
    if (input.type !== 'prompt') return;
    ctx.intent(); ctx.submitted(input.prompt); sent.push(input.prompt);
  });
  f.gateway.configureTiming('a', 'a-dot', minute);
  const first = f.gateway.createTask('a', prompt('first'), options); f.gateway.createTask('a', prompt('second'), options);
  await f.advance(minute); assert.equal(attempts, 1); assert.equal(f.gateway.get(first.id).retryCount, 1);
  await f.advance(1999); assert.equal(attempts, 1);
  await f.advance(1); assert.deepEqual(sent, ['first']);
  await f.advance(minute - 1); assert.deepEqual(sent, ['first']);
  await f.advance(1); assert.deepEqual(sent, ['first', 'second']);
});

test('receipt reconciliation bypasses the countdown and does not move an already confirmed deadline', async t => {
  let attempts = 0;
  const f = fixture(t, async (_id, _input, _signal, ctx) => {
    if (++attempts === 1) {
      ctx.intent({ url: 'https://chatgpt.com/dots/home', users: [] }); ctx.submitted('confirmed-user');
      throw new Error('PAGE_GONE');
    }
    assert.equal(ctx.task().submittedMessageId, 'confirmed-user');
    ctx.submitted('confirmed-user'); return { submittedOnly: true };
  });
  f.gateway.configureTiming('a', 'a-dot', minute);
  const first = f.gateway.createTask('a', prompt('one'), options);
  await f.advance(minute); const due = f.queue().timing?.nextSendAt;
  await f.advance(2000);
  assert.equal(attempts, 2); assert.equal(f.gateway.get(first.id).status, 'done');
  assert.equal(f.queue().timing?.nextSendAt, due);
});

test('empty queues rearm on first enqueue and pending tasks switch back to completion mode', async t => {
  const f = fixture(t, async (_id, _input, _signal, ctx) => { ctx.intent(); ctx.submitted('sent'); });
  f.gateway.configureTiming('a', 'a-dot', minute);
  const first = f.gateway.createTask('a', prompt('one'), options);
  await f.advance(minute); assert.equal(f.gateway.get(first.id).status, 'done');
  await f.advance(10 * minute);
  const next = f.gateway.createTask('a', prompt('next'), options);
  assert.equal(f.queue().timing?.nextSendAt, Date.now() + minute);
  f.gateway.configureTiming('a', 'a-dot', undefined); await flush();
  assert.equal(f.gateway.get(next.id).sendMode, undefined);
  assert.equal(f.gateway.get(next.id).status, 'done');
});

test('enabling an interval while waiting for Dot work requeues the unsent item until its new deadline', async t => {
  let release!: () => void; let attempts = 0; let sends = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, async (_id, _input, _signal, ctx) => {
    if (++attempts === 1) { ctx.stage('waiting_idle'); await held; }
    ctx.checkpoint?.(); ctx.intent(); ctx.submitted('sent'); sends++;
  });
  const first = f.gateway.createTask('a', prompt('first'), options); await flush();
  assert.equal(f.gateway.get(first.id).status, 'running');
  f.gateway.configureTiming('a', 'a-dot', minute); release(); await flush();
  assert.equal(f.gateway.get(first.id).status, 'pending'); assert.equal(sends, 0);
  await f.advance(minute - 1); assert.equal(sends, 0);
  await f.advance(1); assert.equal(sends, 1);
});

test('switching back clears future item flags while a timed delivery is already underway', async t => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, async (_id, _input, _signal, ctx) => { ctx.intent(); ctx.submitted('first'); await held; });
  f.gateway.configureTiming('a', 'a-dot', minute);
  const first = f.gateway.createTask('a', prompt('first'), options);
  const next = f.gateway.createTask('a', prompt('next'), options);
  await f.advance(minute);
  f.gateway.configureTiming('a', 'a-dot', undefined);
  assert.equal(f.gateway.get(first.id).sendMode, 'dot_interval', 'A begun delivery keeps its policy');
  assert.equal(f.gateway.get(next.id).sendMode, undefined, 'Future items return to completion-based sending');
  f.gateway.pause('a', 'a-dot'); release(); await flush();
});

test('an unrelated foreground task cannot remove the first interval delay', async t => {
  let release!: () => void; let sends = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, async (_id, input, _signal, ctx) => {
    if (input.type === 'snapshot') { await held; return; }
    ctx.intent(); ctx.submitted('timed'); sends++;
  });
  f.gateway.configureTiming('a', 'a-dot', minute);
  f.gateway.createTask('a', { type: 'snapshot' }, { conversationId: 'a-dot' }); await flush();
  const timed = f.gateway.createTask('a', prompt('timed'), options);
  assert.equal(f.queue().timing?.nextSendAt, Date.now() + minute);
  release(); await flush(); assert.equal(sends, 0);
  await f.advance(minute); assert.equal(f.gateway.get(timed.id).status, 'done'); assert.equal(sends, 1);
});

test('timing is scoped to Dot background sends and validated at the workspace boundary', async t => {
  const f = fixture(t, async () => {}, 0);
  const accounts = new AccountManager(f.db); const account = accounts.create('owner'); const other = accounts.create('other');
  const conversations = new ConversationManager(f.db);
  const dot = conversations.register(account.id, 'https://chatgpt.com/dots/home', undefined, 'dot');
  const chat = conversations.register(account.id, 'https://chatgpt.com/c/normal');
  const workspace = new Workspace(accounts, f.gateway, {
    activate() {}, remove: async () => {}, navigate: async () => {}, control() {}, page: () => null
  }, () => {}, () => ({ enabled: false, endpoint: null, discoveryFile: '' }), conversations);
  for (const intervalMs of [0, 59999, 86400001, NaN, Infinity, '60000', 60000.5]) {
    await assert.rejects(workspace.call('queues.timing', { accountId: account.id, conversation: dot.id, mode: 'interval', intervalMs }));
  }
  await assert.rejects(workspace.call('queues.timing', { accountId: account.id, conversation: chat.id, mode: 'interval', intervalMs: minute }));
  await assert.rejects(workspace.call('queues.timing', { accountId: other.id, conversation: dot.id, mode: 'interval', intervalMs: minute }));
  await assert.rejects(workspace.call('queues.timing', { accountId: account.id, conversation: dot.id, mode: 'unknown' }));
  await workspace.call('queues.timing', { accountId: account.id, conversation: dot.id, mode: 'interval', intervalMs: 20 * minute });
  const timed = f.gateway.createTask(account.id, prompt('timed'), { conversationId: dot.id, background: true });
  const ordinary = f.gateway.createTask(account.id, prompt('ask'), { conversationId: dot.id });
  const draft = f.gateway.createTask(account.id, { ...prompt('draft'), submit: false }, { conversationId: dot.id, background: true });
  assert.equal(timed.sendMode, 'dot_interval'); assert.equal(ordinary.sendMode, undefined); assert.equal(draft.sendMode, undefined);
});
