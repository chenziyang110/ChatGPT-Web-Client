import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/storage/Database';
import { AgentGateway } from '../src/core/agent/AgentGateway';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < end, 'condition timed out'); await tick(); } }

test('a page conflict waits for an explicit human choice and retries the same task only once', async () => {
  const db = new Database(':memory:'); let calls = 0;
  const gateway = new AgentGateway(db, async () => { if (++calls === 1) throw new Error('DRAFT_CONFLICT: existing draft'); return { answer: 'done' }; }, () => {});
  try {
    const task = gateway.createTask('a', { type: 'prompt', prompt: 'Question', submit: true }, { targetUrl: 'https://chatgpt.com/c/a' });
    await until(() => !gateway.isRunning('a') && gateway.get(task.id).status !== 'pending');
    const waiting = gateway.get(task.id);
    assert.equal(waiting.status, 'waiting_user'); assert.equal(waiting.attention?.kind, 'draft');
    assert.deepEqual(gateway.lockedAccounts(), ['a']);
    assert.throws(() => gateway.resume('a'), /USER_DECISION_REQUIRED/);
    await assert.rejects(gateway.decide(task.id, 'stale', 'retry'), /STALE_DECISION/);
    await gateway.decide(task.id, waiting.attention!.id, 'takeover');
    assert.deepEqual(gateway.lockedAccounts(), []); assert.equal(gateway.queues()[0].control, 'human');
    await gateway.decide(task.id, waiting.attention!.id, 'retry');
    await until(() => gateway.get(task.id).status === 'done');
    assert.equal(calls, 2); assert.equal(gateway.listTasks().length, 1);
    await assert.rejects(gateway.decide(task.id, waiting.attention!.id, 'retry'), /STALE_DECISION/);
  } finally { await gateway.stop(); db.close(); }
});

test('human takeover keeps an unsent task recoverable and waits for executor cleanup before unlocking', async () => {
  const db = new Database(':memory:'); let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  const gateway = new AgentGateway(db, async (_id, _input, signal) => {
    try { await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    finally { await cleanup; }
  }, () => {});
  try {
    const task = gateway.createTask('a', { type: 'prompt', prompt: 'Question', submit: true }, { targetUrl: 'https://chatgpt.com/c/a' });
    await until(() => gateway.isRunning('a'));
    const takingOver = gateway.takeover('a');
    assert.equal(gateway.get(task.id).status, 'waiting_user');
    assert.equal(gateway.get(task.id).attention?.kind, 'manual_takeover');
    assert.deepEqual(gateway.lockedAccounts(), ['a']);
    release(); await takingOver;
    assert.deepEqual(gateway.lockedAccounts(), []);
    assert.equal(gateway.get(task.id).sendIntentAt, undefined);
  } finally { release(); await gateway.stop(); db.close(); }
});

test('takeover after send intent requires review and never offers replay', async () => {
  const db = new Database(':memory:'); let calls = 0;
  const gateway = new AgentGateway(db, async (_id, _input, signal, context) => {
    calls++; context.intent();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, () => {});
  try {
    const task = gateway.createTask('a', { type: 'prompt', prompt: 'Question', submit: true }, { targetUrl: 'https://chatgpt.com/c/a' });
    await until(() => !!gateway.get(task.id).sendIntentAt);
    await gateway.takeover('a'); const uncertain = gateway.get(task.id);
    assert.equal(uncertain.status, 'uncertain');
    assert.equal(uncertain.attention?.choices.some(choice => choice.id === 'retry'), false);
    await assert.rejects(gateway.decide(task.id, uncertain.attention!.id, 'retry'), /INVALID_CHOICE/);
    await gateway.decide(task.id, uncertain.attention!.id, 'acknowledge');
    assert.ok(gateway.get(task.id).resolvedAt); assert.equal(calls, 1);
  } finally { await gateway.stop(); db.close(); }
});

test('human control and decision token survive restart without dispatching pending work', async () => {
  const db = new Database(':memory:'); let calls = 0;
  const gateway = new AgentGateway(db, async () => { throw new Error('DRAFT_CONFLICT'); }, () => {});
  const task = gateway.createTask('a', { type: 'prompt', prompt: 'Question', submit: true }, { targetUrl: 'https://chatgpt.com/c/a', idempotencyKey: 'same-question' });
  await until(() => gateway.get(task.id).status === 'waiting_user');
  await gateway.takeover('a'); const token = gateway.get(task.id).attention!.id;
  await gateway.stop();
  const restarted = new AgentGateway(db, async () => { calls++; }, () => {});
  try {
    assert.equal(restarted.get(task.id).attention!.id, token);
    assert.deepEqual(restarted.lockedAccounts(), []);
    const later = restarted.createTask('a', { type: 'snapshot' }, { targetUrl: 'https://chatgpt.com/c/a' });
    await tick(); assert.equal(calls, 0); assert.equal(restarted.get(later.id).status, 'pending');
    await restarted.decide(task.id, token, 'retry');
    await until(() => restarted.get(later.id).status === 'done');
    assert.equal(calls, 2); assert.equal(restarted.get(task.id).idempotencyKey, 'same-question');
  } finally { await restarted.stop(); db.close(); }
});
