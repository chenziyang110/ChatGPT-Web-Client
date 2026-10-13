import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedOperation } from '../src/main/BoundedOperation';

test('a hung page probe returns so a following local operation can run', async () => {
  await assert.rejects(boundedOperation(new Promise<void>(() => {}), 20), /PAGE_PROBE_TIMEOUT/);
  assert.equal(await boundedOperation(Promise.resolve('ready'), 20), 'ready');
});

test('canceling a hung retry wait does not await the navigation deadline', async () => {
  const controller = new AbortController();
  const pending = boundedOperation(new Promise<void>(() => {}), 60000, controller.signal);
  controller.abort(new Error('Human takeover'));
  await assert.rejects(pending, /Human takeover/);
});

test('a page operation that finishes after cancellation cannot resume its caller', async () => {
  let finish!: () => void;
  let resumed = false;
  const controller = new AbortController();
  const pending = boundedOperation(new Promise<void>(resolve => { finish = resolve; }), 60000, controller.signal)
    .then(() => { resumed = true; });
  controller.abort(new Error('Application is stopping'));
  await assert.rejects(pending, /Application is stopping/);
  finish();
  await Promise.resolve();
  assert.equal(resumed, false);
});

test('already aborted operations reject safely even if the page later rejects', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Stopped'));
  await assert.rejects(boundedOperation(Promise.reject(new Error('late page error')), 20, controller.signal), /Stopped/);
});
