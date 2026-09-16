import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { LocalApi } from '../src/core/agent/LocalApi';

test('help is readable without credentials while operations stay authenticated and private', async () => {
  const directory = mkdtempSync(path.resolve('.test-help-')); let calls = 0;
  const api = new LocalApi(path.join(directory, 'agent-runtime.json'), async () => { calls++; return { secret: 'private data' }; });
  try {
    await api.start(); const discovery = JSON.parse(readFileSync(api.discoveryFile, 'utf8'));
    const help = await fetch(`${api.endpoint}/help.html`, { headers: { 'Sec-Fetch-Site': 'none' } });
    assert.equal(help.status, 200); assert.match(help.headers.get('content-type')!, /text\/html/);
    const html = await help.text();
    for (const word of ['tasks.create', 'tasks.get', 'waiting_user', '接管', 'browser.inspect']) assert.ok(html.includes(word), word);
    assert.equal(html.includes(discovery.token), false); assert.equal(html.includes(directory), false);
    assert.ok(help.headers.get('content-security-policy')?.includes("default-src 'none'"));
    const schema = await fetch(`${api.endpoint}/help.json`); assert.equal(schema.status, 200);
    assert.equal((await schema.json()).rpcPath, '/v1/rpc');
    assert.equal((await fetch(`${api.endpoint}/health`)).status, 401);
    assert.equal((await fetch(`${api.endpoint}/v1/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"method":"tasks.list"}' })).status, 401);
    assert.equal((await fetch(`${api.endpoint}/v1/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${discovery.token}`, Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{"method":"tasks.list"}' })).status, 403);
    assert.equal(calls, 0);
  } finally { await api.stop(); rmSync(directory, { recursive: true, force: true }); }
});
