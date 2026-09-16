import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { LocalApi, type Discovery } from '../src/core/agent/LocalApi';
import { AppError } from '../src/core/validation';

test('local API enforces bearer auth, origin/host checks, bounds, RPC errors and secret rotation', async () => {
  const dir = mkdtempSync(path.resolve('.test-api-'));
  const filename = path.join(dir, 'agent-runtime.json');
  const api = new LocalApi(filename, async (method, params) => {
    if (method === 'fail') throw new AppError('Fixture rejected', 409);
    return { method, params };
  });
  try {
    await api.start();
    const discovery = JSON.parse(readFileSync(filename, 'utf8')) as Discovery;
    if (process.platform !== 'win32') assert.equal(statSync(filename).mode & 0o777, 0o600);
    assert.equal(new URL(discovery.endpoint).hostname, '127.0.0.1');
    const send = (body: string, headers: Record<string, string> = {}) => fetch(`${api.endpoint}/v1/rpc`, {
      method: 'POST', headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', ...headers }, body
    });
    assert.equal((await fetch(`${api.endpoint}/health`)).status, 401);
    assert.equal((await send('{}', { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await send('{}', { Origin: 'https://chatgpt.com' })).status, 403);
    assert.equal((await send('{}', { 'Sec-Fetch-Site': 'same-origin' })).status, 403);
    const hostStatus = await new Promise(resolve => {
      const req = request(`${api.endpoint}/health`, { headers: { Host: 'evil.test', Authorization: `Bearer ${discovery.token}` } }, res => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    assert.equal(hostStatus, 403);
    assert.equal((await send('{broken')).status, 400);
    assert.equal((await send(JSON.stringify({ method: 'fail' }))).status, 409);
    assert.equal((await send(JSON.stringify({ method: 'test', params: [] }))).status, 400);
    assert.equal((await send('x'.repeat(65537))).status, 413);
    const response = await send(JSON.stringify({ method: 'hello', params: { name: '工作账号' } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await response.json(), { ok: true, result: { method: 'hello', params: { name: '工作账号' } } });
    await api.stop();
    assert.equal(existsSync(filename), false);
    await api.start();
    const rotated = JSON.parse(readFileSync(filename, 'utf8')) as Discovery;
    assert.notEqual(rotated.token, discovery.token);
    assert.equal((await fetch(`${api.endpoint}/health`, { headers: { Authorization: `Bearer ${discovery.token}` } })).status, 401);
  } finally { await api.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('CLI uses private discovery and returns machine-readable JSON through the real HTTP gateway', async () => {
  const dir = mkdtempSync(path.resolve('.test-cli-'));
  const api = new LocalApi(path.join(dir, 'agent-runtime.json'), async method => {
    assert.equal(method, 'accounts.list');
    return [{ id: 'fixture', name: 'Test' }];
  });
  try {
    await api.start();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--data-dir', dir, 'accounts'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(code, 0, errors);
    assert.deepEqual(JSON.parse(output), [{ id: 'fixture', name: 'Test' }]);
    assert.equal(output.includes('token'), false);
  } finally { await api.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('CLI targets account/conversation, returns the same task on retry, and client timeout does not cancel', async () => {
  const dir = mkdtempSync(path.resolve('.test-cli-routing-'));
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let state = 'pending';
  const api = new LocalApi(path.join(dir, 'agent-runtime.json'), async (method, params) => {
    requests.push({ method, params });
    return { id: 'fixed-task', accountId: 'work', status: state, input: params.input };
  });
  const run = async (args: string[]) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--data-dir', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    const code = await new Promise(resolve => child.on('close', resolve));
    return { code, output, errors };
  };
  try {
    await api.start();
    const flags = ['prompt', '--account', 'work', '--conversation', 'daily', '--text', '你好', '--submit', '--idempotency-key', 'request-001'];
    const first = await run(flags); const retry = await run(flags);
    assert.equal(first.code, 0, first.errors); assert.equal(JSON.parse(first.output).id, JSON.parse(retry.output).id);
    assert.deepEqual(requests[0], { method: 'tasks.create', params: { accountId: 'work', input: { type: 'prompt', prompt: '你好', submit: true }, conversation: 'daily', idempotencyKey: 'request-001' } });
    const timed = await run([...flags, '--wait', '--wait-timeout', '1']);
    assert.equal(timed.code, 3); assert.match(timed.errors, /task continues/); assert.equal(JSON.parse(timed.output).id, 'fixed-task');
    assert.equal(requests.some(item => item.method === 'tasks.cancel'), false);
    state = 'waiting_user';
    const beforeWaiting = requests.length;
    const humanWait = await run(['task', 'wait', 'fixed-task', '--wait-timeout', '1']);
    assert.equal(humanWait.code, 3); assert.equal(JSON.parse(humanWait.output).status, 'waiting_user');
    assert.ok(requests.slice(beforeWaiting).every(item => ['tasks.get', 'tasks.wait'].includes(item.method)), 'Waiting for a human only reads the original task');
    const resume = await run(['queue', 'resume', '--account', 'work', '--acknowledged']);
    assert.equal(resume.code, 0); assert.deepEqual(requests.at(-1), { method: 'queues.resume', params: { accountId: 'work', acknowledged: true } });
  } finally { await api.stop(); rmSync(dir, { recursive: true, force: true }); }
});
