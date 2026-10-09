import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AgentGateway, type TaskExecutor } from '../src/core/agent/AgentGateway';
import { taskAttention } from '../src/core/agent/TaskAttention';
import { Database } from '../src/core/storage/Database';
import type { AccountQueue, AgentTask } from '../src/shared/types';

const prompt = (value: string) => ({ type: 'prompt' as const, prompt: value, submit: true });
const hold: TaskExecutor = async (_accountId, _input, signal) => {
  await new Promise<void>((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
};

function fixture(context: TestContext, execute: TaskExecutor = hold, concurrency = 2) {
  const db = new Database(':memory:');
  const gateway = new AgentGateway(db, execute, () => {}, concurrency);
  context.after(async () => { await gateway.stop(); db.close(); });
  return { db, gateway };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'task state did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function assertRecovery(gateway: AgentGateway, ...tasks: AgentTask[]) {
  assert.deepEqual(gateway.automaticRecoveryTasks().map(task => task.id).sort(), tasks.map(task => task.id).sort());
}

test('automatic recovery includes running and pending send tasks in independent conversations', async context => {
  const { gateway } = fixture(context);
  const first = gateway.createTask('a', prompt('first'), { conversationId: 'one' });
  const next = gateway.createTask('a', prompt('next'), { conversationId: 'one' });
  const other = gateway.createTask('a', prompt('other'), { conversationId: 'two' });

  await until(() => gateway.get(first.id).status === 'running' && gateway.get(other.id).status === 'running');
  assert.equal(gateway.get(next.id).status, 'pending');
  assertRecovery(gateway, first, next, other);
});

test('conversation and account pause remove recovery authority until their respective queues resume', async context => {
  // All three held conversations need a slot before exercising account pause.
  const { gateway } = fixture(context, hold, 3);
  const first = gateway.createTask('a', prompt('first'), { conversationId: 'one' });
  const sibling = gateway.createTask('a', prompt('sibling'), { conversationId: 'two' });
  const otherAccount = gateway.createTask('b', prompt('other account'), { conversationId: 'one' });
  await until(() => gateway.isRunning('a', 'one') && gateway.isRunning('a', 'two'));

  gateway.pause('a', 'one');
  await until(() => !gateway.isRunning('a', 'one'));
  assert.equal(gateway.get(first.id).status, 'pending');
  assertRecovery(gateway, sibling, otherAccount);

  gateway.pause('a');
  await until(() => !gateway.isRunning('a'));
  assertRecovery(gateway, otherAccount);
  gateway.resume('a', false, 'one');
  assertRecovery(gateway, otherAccount);
  gateway.resume('a');
  assertRecovery(gateway, first, sibling, otherAccount);
});

test('human takeover cannot regain automatic recovery merely by clearing a pause flag', async context => {
  const { db, gateway } = fixture(context, hold, 0);
  const first = gateway.createTask('a', prompt('first'), { conversationId: 'one' });
  const sibling = gateway.createTask('a', prompt('sibling'), { conversationId: 'two' });
  const otherAccount = gateway.createTask('b', prompt('other account'), { conversationId: 'one' });

  const conversation = await gateway.takeover('a', 'one');
  assert.equal(conversation.control, 'human');
  assertRecovery(gateway, sibling, otherAccount);
  db.write('account_queues', 'a:conversation:one', { ...conversation, paused: false });
  assertRecovery(gateway, sibling, otherAccount);

  const account = await gateway.takeover('a');
  assert.equal(account.control, 'human');
  db.write('account_queues', 'a', { ...account, paused: false });
  db.write('account_queues', 'a:conversation:one', {
    accountId: 'a', conversationId: 'one', paused: false, control: 'agent'
  } satisfies AccountQueue);
  assert.equal(gateway.get(first.id).status, 'pending');
  assertRecovery(gateway, otherAccount);
});

test('completed and cancelled prompts release automatic recovery while another prompt is running', async context => {
  const { gateway } = fixture(context, async (accountId, input, signal, execution) => {
    if (input.type === 'prompt' && input.prompt === 'done') return;
    await hold(accountId, input, signal, execution);
  });
  const completed = gateway.createTask('a', prompt('done'), { conversationId: 'one' });
  const running = gateway.createTask('a', prompt('running'), { conversationId: 'two' });
  const pending = gateway.createTask('a', prompt('pending'), { conversationId: 'two' });
  await until(() => gateway.get(completed.id).status === 'done' && gateway.get(running.id).status === 'running');
  assertRecovery(gateway, running, pending);

  gateway.cancel(pending.id);
  assert.equal(gateway.get(pending.id).status, 'cancelled');
  assertRecovery(gateway, running);
  gateway.cancel(running.id);
  await until(() => !gateway.isRunning('a', 'two'));
  assert.equal(gateway.get(running.id).status, 'cancelled');
  assertRecovery(gateway);
});

for (const receipt of [false, true]) {
  test(`automatic recovery retains a pending ${receipt ? 'reply receipt' : 'unsent prompt'} during retry backoff without a running lock`, async context => {
    const { gateway } = fixture(context, async (accountId, input, signal, execution) => {
      if (input.type === 'prompt' && input.prompt === 'retry') {
        if (receipt) execution.intent({ url: 'https://chatgpt.com/c/one', users: [] });
        throw new Error('COMPOSER_NOT_READY');
      }
      await hold(accountId, input, signal, execution);
    });
    const retry = gateway.createTask('a', prompt('retry'), { conversationId: 'one', background: true });
    const next = gateway.createTask('a', prompt('next'), { conversationId: 'one', background: true });
    const sibling = gateway.createTask('a', prompt('sibling'), { conversationId: 'two', background: true });
    await until(() => !!gateway.get(retry.id).nextAttemptAt && !gateway.isRunning('a', 'one'));

    const waiting = gateway.get(retry.id);
    assert.equal(waiting.status, 'pending');
    assert.equal(waiting.phase, receipt ? 'generating' : 'queued');
    assert.equal(waiting.retryCount, 1);
    assert.ok(waiting.nextAttemptAt! > Date.now());
    assert.equal(gateway.get(next.id).status, 'pending');
    assert.equal(gateway.lockedTasks().some(task => task.id === retry.id), false);
    assertRecovery(gateway, retry, next, sibling);

    gateway.pause('a', 'one');
    assertRecovery(gateway, sibling);
    gateway.resume('a', false, 'one');
    assert.equal(gateway.get(retry.id).nextAttemptAt, waiting.nextAttemptAt);
    assertRecovery(gateway, retry, next, sibling);
  });
}

test('automatic recovery excludes browser operations and unsubmitted drafts regardless of background mode', context => {
  const { gateway } = fixture(context, hold, 0);
  const options = { conversationId: 'one', background: true };
  gateway.createTask('a', { type: 'navigate', url: 'https://chatgpt.com/c/one' }, options);
  gateway.createTask('a', { type: 'snapshot' }, options);
  gateway.createTask('a', { type: 'click', selector: '#send' }, options);
  gateway.createTask('a', { type: 'fill', selector: '#prompt', text: 'human draft' }, options);
  gateway.createTask('a', { type: 'prompt', prompt: 'draft', submit: false }, options);
  gateway.createTask('a', { type: 'prompt', prompt: 'default draft' }, options);
  const foreground = gateway.createTask('a', prompt('foreground'), { conversationId: 'two' });
  const background = gateway.createTask('a', prompt('background'), options);

  assertRecovery(gateway, foreground, background);
});

test('waiting user decisions and unresolved send review block only their own account and conversation', async context => {
  const { db, gateway } = fixture(context, hold, 0);
  const waiting = gateway.createTask('a', prompt('needs a decision'), { conversationId: 'one' });
  const afterWaiting = gateway.createTask('a', prompt('after decision'), { conversationId: 'one' });
  const uncertain = gateway.createTask('a', prompt('needs send review'), { conversationId: 'two' });
  const afterUncertain = gateway.createTask('a', prompt('after review'), { conversationId: 'two' });
  const reviewed = gateway.createTask('a', prompt('already reviewed'), { conversationId: 'three' });
  const afterReviewed = gateway.createTask('a', prompt('after completed review'), { conversationId: 'three' });
  const sibling = gateway.createTask('a', prompt('healthy sibling'), { conversationId: 'four' });
  const otherAccount = gateway.createTask('b', prompt('same conversation ID, another account'), { conversationId: 'one' });
  const attention = taskAttention('The previous message may have been sent', true);

  // Leave the queues unpaused to prove that review itself blocks recovery.
  db.write('tasks', waiting.id, { ...waiting, status: 'waiting_user' });
  db.write('tasks', uncertain.id, { ...uncertain, status: 'uncertain', sendIntentAt: Date.now(), attention });
  db.write('tasks', reviewed.id, { ...reviewed, status: 'uncertain', resolvedAt: Date.now() });
  assertRecovery(gateway, afterReviewed, sibling, otherAccount);

  gateway.cancel(waiting.id);
  await gateway.decide(uncertain.id, attention.id, 'acknowledge');
  assertRecovery(gateway, afterWaiting, afterUncertain, afterReviewed, sibling, otherAccount);
});

test('stopping the gateway removes automatic recovery authority', async context => {
  const { gateway } = fixture(context, hold, 0);
  const task = gateway.createTask('a', prompt('pending'), { conversationId: 'one' });
  assertRecovery(gateway, task);
  await gateway.stop();
  assertRecovery(gateway);
});
