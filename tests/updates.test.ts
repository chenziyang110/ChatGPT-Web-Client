import test from 'node:test';
import assert from 'node:assert/strict';
import { newerStable } from '../src/shared/updates';
import { UpdateChecker } from '../src/main/UpdateChecker';

test('stable versions compare numerically and never downgrade or offer previews', () => {
  for (const version of ['v1.0.1', '1.10.0', '2.0.0']) assert.ok(newerStable(version, '1.0.0'));
  for (const version of ['1.0.0', '0.9.9', 'v2.0.0-beta.1', 'garbage', '01.2.3']) assert.equal(newerStable(version, '1.0.0'), false);
  assert.equal(newerStable('1.9.0', '1.10.0'), false);
});
test('checks deduplicate requests and send no account data', async () => {
  let count = 0;
  const checker = new UpdateChecker('1.0.0', true, () => {}, (async (url, options) => {
    count++;
    assert.equal(url, 'https://api.github.com/repos/chenziyang110/ChatGPT-Web-Client/releases/latest');
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.body, undefined);
    assert.deepEqual(Object.keys(options!.headers!), ['Accept', 'User-Agent']);
    return new Response(JSON.stringify({ tag_name: 'v1.1.0', draft: false, prerelease: false }));
  }) as typeof fetch);
  await Promise.all([checker.check(), checker.check()]);
  assert.equal(count, 1); assert.equal(checker.state.status, 'available');
  checker.setEnabled(false); assert.equal(checker.state.enabled, false);
});
test('network failures and invalid releases remain retryable errors', async () => {
  for (const response of [new Response('', { status: 404 }), new Response('invalid'), new Response(JSON.stringify({ tag_name: 'v2.0.0', prerelease: true }))]) {
    const checker = new UpdateChecker('1.0.0', true, () => {}, (async () => response.clone()) as typeof fetch);
    await checker.check(); assert.equal(checker.state.status, 'error');
    await checker.check(); assert.equal(checker.state.status, 'error');
  }
});
test('current release reports up to date', async () => {
  const checker = new UpdateChecker('1.0.0', true, () => {}, (async () => new Response('{"tag_name":"v1.0.0"}')) as typeof fetch);
  await checker.check(); assert.equal(checker.state.status, 'current');
});
