import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/storage/Database';
import { AgentGateway, type ExecutionContext } from '../src/core/agent/AgentGateway';

test('long waits publish streaming updates and final completion without blocking another conversation', async () => {
  const db = new Database(':memory:');
  let started!: (value: ExecutionContext) => void; const context = new Promise<ExecutionContext>(resolve => { started = resolve; });
  let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; });
  const gateway = new AgentGateway(db, async (_account, input, _signal, ctx) => {
    if (input.type === 'prompt' && input.prompt === 'First') { started(ctx); await held; }
    return { response: 'Final' };
  }, () => {});
  try {
    const first = gateway.createTask('a', { type: 'prompt', prompt: 'First', submit: true }, { conversationId: 'first' });
    const ctx = await context;
    const old = gateway.get(first.id);
    const wait = gateway.wait(first.id, 1000, old.updatedAt, true);
    ctx.progress?.('Partial', 'https://chatgpt.com/c/first');
    const update = await wait;
    assert.equal(update.progress?.response, 'Partial'); assert.ok(update.updatedAt > old.updatedAt);
    const timed = await gateway.wait(first.id, 15, update.updatedAt, true);
    assert.equal(timed.status, 'running', 'A wait timeout must not cancel the task');
    const second = gateway.createTask('a', { type: 'prompt', prompt: 'Second', submit: true }, { conversationId: 'second' });
    assert.equal((await gateway.wait(second.id, 1000)).status, 'done');
    const done = gateway.wait(first.id, 1000); finish();
    assert.equal((await done).status, 'done');
    assert.throws(() => gateway.wait(first.id, -1), /timeout/);
  } finally { finish(); await gateway.stop(); db.close(); }
});
