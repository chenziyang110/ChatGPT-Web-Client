import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateChecker } from '../src/main/UpdateChecker';
import { UpdatePreparation } from '../src/main/UpdatePreparation';
import type { UpdatePreparationStage, UpdateState } from '../src/shared/updates';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(options: {
  settled?: () => Promise<void>;
  busy?: () => Promise<boolean>;
  taskRunning?: () => boolean;
  status?: UpdateState['status'];
  timeoutMs?: number;
} = {}) {
  let commits = 0, shutdowns = 0, pageChecks = 0, localWaits = 0;
  const stages: UpdatePreparationStage[] = [];
  const checking = deferred<void>();
  const checker = new UpdateChecker('1.0.0', true, () => {}, fetch, {
    download: async () => {}, cancel() {}, install() {}
  });
  checker.state.latest = 'v1.1.0';
  checker.state.status = options.status ?? 'downloaded';
  checker.state.progress = checker.state.status === 'downloaded' ? 100 : 50;
  const preparation = new UpdatePreparation({
    isReady: () => checker.state.status === 'downloaded',
    settled: () => { localWaits++; return options.settled?.() ?? Promise.resolve(); },
    isTaskRunning: options.taskRunning ?? (() => false),
    hasBusyPage: () => { pageChecks++; return options.busy?.() ?? Promise.resolve(false); },
    beginInstall: () => { checker.beginInstall(); commits++; },
    shutdown: () => { shutdowns++; },
    stage: stage => {
      checker.prepareInstall(stage); stages.push(stage);
      if (stage === 'checking-replies') checking.resolve();
    },
    failed: message => checker.preparationFailed(message)
  }, options.timeoutMs ?? 1000);
  return { preparation, checker, stages, checking: checking.promise,
    counts: () => ({ commits, shutdowns, pageChecks, localWaits }) };
}

test('a stalled local operation times out, unlocks preparation, preserves the download, and can retry', async () => {
  let stalled = true;
  const f = fixture({ settled: () => stalled ? new Promise(() => {}) : Promise.resolve(), timeoutMs: 50 });
  const first = f.preparation.prepare();
  assert.equal(f.preparation.preparing, true);
  await assert.rejects(first, /本地操作.*超时/);
  assert.equal(f.preparation.preparing, false);
  assert.equal(f.checker.state.status, 'downloaded');
  assert.equal(f.checker.state.progress, 100);
  assert.match(f.checker.state.error!, /本地操作.*超时/);
  assert.equal(f.checker.state.preparationStage, undefined);
  stalled = false;
  await f.preparation.prepare();
  assert.deepEqual(f.counts(), { commits: 1, shutdowns: 1, pageChecks: 1, localWaits: 2 });
  assert.equal(f.checker.state.status, 'installing');
});

test('normal preparation immediately refuses running tasks and refuses an active reply', async () => {
  const running = fixture({ taskRunning: () => true, settled: () => new Promise(() => {}) });
  await assert.rejects(running.preparation.prepare(), /回复或任务/);
  assert.equal(running.preparation.preparing, false);
  assert.equal(running.checker.state.status, 'downloaded');
  assert.equal(running.counts().localWaits, 0);
  const reply = fixture({ busy: async () => true });
  await assert.rejects(reply.preparation.prepare(), /回复或任务/);
  assert.equal(reply.preparation.preparing, false);
  assert.equal(reply.checker.state.status, 'downloaded');
  assert.equal(reply.counts().commits, 0);
});

test('force upgrades a normal preparation even when the page check never returns', async () => {
  const f = fixture({ busy: () => new Promise(() => {}) });
  const normal = f.preparation.prepare();
  await f.checking;
  assert.equal(f.checker.state.status, 'preparing');
  assert.equal(f.checker.state.preparationStage, 'checking-replies');
  assert.equal((await f.checker.check()).status, 'preparing', 'Checks must retain the downloaded installer during preflight');
  const forced = f.preparation.prepare(true);
  assert.equal(forced, normal);
  await forced;
  assert.deepEqual(f.counts(), { commits: 1, shutdowns: 1, pageChecks: 1, localWaits: 1 });
  assert.equal(f.checker.state.status, 'installing');
});

test('force still waits for local writes and skips busy tasks and page checks', async () => {
  const local = deferred<void>();
  const f = fixture({ settled: () => local.promise, taskRunning: () => true,
    busy: async () => { assert.fail('Forced installation must skip the page check'); } });
  const forced = f.preparation.prepare(true);
  await Promise.resolve();
  assert.equal(f.counts().commits, 0);
  assert.equal(f.checker.state.preparationStage, 'settling');
  local.resolve();
  await forced;
  assert.deepEqual(f.counts(), { commits: 1, shutdowns: 1, pageChecks: 0, localWaits: 1 });
});

test('a late page result from an upgraded check cannot install twice or overwrite state', async () => {
  const page = deferred<boolean>();
  const f = fixture({ busy: () => page.promise });
  const normal = f.preparation.prepare();
  await f.checking;
  await f.preparation.prepare(true);
  page.resolve(true);
  await normal;
  await Promise.resolve();
  assert.equal(f.counts().commits, 1);
  assert.equal(f.counts().shutdowns, 1);
  assert.equal(f.checker.state.status, 'installing');
  assert.equal(f.checker.state.error, undefined);
});

test('a late page result after a timeout cannot overwrite a later successful retry', async () => {
  const oldPage = deferred<boolean>();
  let checks = 0;
  const f = fixture({ busy: () => ++checks === 1 ? oldPage.promise : Promise.resolve(false), timeoutMs: 50 });
  await assert.rejects(f.preparation.prepare(), /检查网页回复.*超时/);
  await f.preparation.prepare();
  oldPage.resolve(true);
  await Promise.resolve();
  assert.equal(f.counts().commits, 1);
  assert.equal(f.checker.state.status, 'installing');
  assert.equal(f.checker.state.error, undefined);
});

test('duplicate normal requests share one preparation and commit once', async () => {
  const local = deferred<void>();
  const f = fixture({ settled: () => local.promise });
  const first = f.preparation.prepare(), second = f.preparation.prepare();
  assert.equal(first, second);
  local.resolve();
  await Promise.all([first, second]);
  await f.preparation.prepare(true);
  assert.deepEqual(f.counts(), { commits: 1, shutdowns: 1, pageChecks: 1, localWaits: 1 });
});

test('download must be complete before either normal or forced preparation', async () => {
  for (const force of [false, true]) {
    const f = fixture({ status: 'downloading' });
    await assert.rejects(f.preparation.prepare(force), /先完成更新下载/);
    assert.equal(f.preparation.preparing, false);
    assert.equal(f.checker.state.status, 'downloading');
    assert.deepEqual(f.counts(), { commits: 0, shutdowns: 0, pageChecks: 0, localWaits: 0 });
  }
});
