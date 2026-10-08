import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/core/storage/Database';
import { AccountManager } from '../src/core/account/AccountManager';
import { SessionManager } from '../src/core/session/SessionManager';
import { ConversationManager } from '../src/core/conversation/ConversationManager';
import { AgentGateway, parseTask } from '../src/core/agent/AgentGateway';
import { Workspace, type BrowserAdapter } from '../src/core/Workspace';
import { chatUrl, webLink, isAccountNavigation, isAccountLoginUrl } from '../src/core/validation';
import { authorizationCallback, isAuthorizationCallback, hasAuthorizationParameters } from '../src/shared/accountNavigation';

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('accounts, partitions, active account, URLs and window state survive a database restart', () => {
  const dir = mkdtempSync(path.resolve('.test-db-'));
  try {
    let db = new Database(path.join(dir, 'workspace.sqlite'));
    const accounts = new AccountManager(db);
    const first = accounts.create('Personal'), second = accounts.create('Work');
    assert.notEqual(first.partition, second.partition);
    assert.equal(first.partition, `persist:account-${first.id}`);
    accounts.activate(second.id);
    const sessions = new SessionManager(db);
    sessions.save(first.id, 'https://chatgpt.com/c/first');
    sessions.save(second.id, 'https://chatgpt.com/c/second');
    const firstTab = randomUUID(), secondTab = randomUUID();
    sessions.saveTabs(second.id, { pages: [
      { id: firstTab, url: 'https://chatgpt.com/c/second', title: 'Second' },
      { id: secondTab, url: 'https://chatgpt.com/c/another', title: 'Another' }
    ], selectedId: secondTab });
    sessions.saveWindow({ x: 10, y: 20, width: 1280, height: 800, maximized: true });
    accounts.rename(first.id, 'Home');
    db.close();
    db = new Database(path.join(dir, 'workspace.sqlite'));
    const restored = new AccountManager(db);
    assert.equal(restored.get(first.id).name, 'Home');
    assert.equal(restored.get(first.id).partition, first.partition);
    assert.equal(restored.activeId(), second.id);
    assert.equal(new SessionManager(db).restore(second.id)?.url, 'https://chatgpt.com/c/second');
    assert.deepEqual(new SessionManager(db).restoreTabs(second.id), { pages: [
      { id: firstTab, url: 'https://chatgpt.com/c/second', title: 'Second', conversationId: undefined },
      { id: secondTab, url: 'https://chatgpt.com/c/another', title: 'Another', conversationId: undefined }
    ], selectedId: secondTab });
    assert.equal(new SessionManager(db).restoreWindow()?.maximized, true);
    restored.remove(second.id);
    assert.equal(restored.activeId(), first.id);
    assert.equal(new SessionManager(db).restore(second.id), undefined);
    assert.equal(new SessionManager(db).restoreTabs(second.id), undefined);
    assert.equal(new SessionManager(db).restore(first.id)?.url, 'https://chatgpt.com/c/first');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('storage transactions roll back rather than leave partial metadata', () => {
  const db = new Database(':memory:');
  db.set('test', 1);
  assert.throws(() => db.transaction(() => { db.set('test', 2); throw new Error('fail'); }));
  assert.equal(db.get('test'), 1);
  db.close();
});

test('validation rejects account traversal, bad names and untrusted URLs', () => {
  const db = new Database(':memory:');
  const accounts = new AccountManager(db);
  assert.throws(() => accounts.create('   '));
  assert.throws(() => accounts.create('a'.repeat(61)));
  assert.throws(() => accounts.get('../another-profile'));
  for (const url of ['https://chatgpt.com.evil.test/', 'http://chatgpt.com/', 'file:///etc/passwd',
    'javascript:alert(1)', 'https://user:pass@chatgpt.com/', 'https://chatgpt.com:8443/', 'https://127.0.0.1/']) {
    assert.throws(() => chatUrl(url), url);
    assert.equal(isAccountNavigation(url), false, url);
  }
  assert.equal(isAccountNavigation('https://accounts.google.com/signin'), true);
  assert.equal(isAccountNavigation('https://accounts.google.com.evil.test'), false);
  for (let i = 0; i < 20; i++) accounts.create(`Account ${i}`);
  assert.throws(() => accounts.create('Too many'));
  db.close();
});

test('interactive login exemption is restricted to exact trusted HTTPS login origins', () => {
  for (const url of ['https://accounts.google.com/v3/signin/accountchooser?state=private',
    'https://auth.openai.com/authorize', 'https://appleid.apple.com/auth/authorize',
    'https://chatgpt.com/api/auth/callback/google?code=private&state=private', 'https://chatgpt.com/auth/login'])
    assert.equal(isAccountLoginUrl(url), true, url);
  for (const url of ['https://chatgpt.com/c/queue', 'https://accounts.google.com.evil.test/',
    'http://accounts.google.com/', 'https://accounts.google.com:8443/',
    'https://user:pass@accounts.google.com/', 'https://chatgpt.com/author/article', 'file:///signin', 'not a URL'])
    assert.equal(isAccountLoginUrl(url), false, url);
});

test('manual account links allow HTTPS and only their declared loopback callback', () => {
  assert.equal(webLink(' https://custom.example:8443/authorize?state=private '), 'https://custom.example:8443/authorize?state=private');
  for (const url of ['http://localhost:3210/', 'https://user:pass@custom.example/', 'javascript:alert(1)', 'file:///signin', 'not a URL', 'https://example.com/' + 'a'.repeat(16384)])
    assert.throws(() => webLink(url), url.slice(0, 80));
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const callback = `http://${host}:3210/callback?fixed=yes`;
    const link = `https://custom.example/authorize?redirect_uri=${encodeURIComponent(callback)}`;
    assert.equal(authorizationCallback(link), callback);
    assert.equal(isAuthorizationCallback(callback + '&code=private', callback), true);
    for (const url of [callback.replace(':3210', ':3211'), callback.replace('/callback', '/other'), callback.replace('fixed=yes', 'fixed=no'), callback + '#code=private'])
      assert.equal(isAuthorizationCallback(url, callback), false);
  }
  for (const target of ['http://example.com/callback', 'http://localhost.evil.test/callback', 'http://user:pass@localhost/callback', 'http://localhost/callback#token', 'https://custom.example/callback'])
    assert.equal(authorizationCallback('https://custom.example/?redirect_uri=' + encodeURIComponent(target)), undefined);
  assert.throws(() => authorizationCallback('https://custom.example/?redirect_uri=http%3A%2F%2Flocalhost%2Fa&redirect_uri=http%3A%2F%2Flocalhost%2Fb'));
  for (const key of ['code', 'state', 'access_token', 'id_token', 'oauth_token', 'oauth_verifier']) {
    assert.equal(hasAuthorizationParameters(`https://chatgpt.com/?${key}=private`), true);
    assert.equal(hasAuthorizationParameters(`https://chatgpt.com/#${key}=private`), true);
  }
  assert.equal(hasAuthorizationParameters('https://chatgpt.com/c/ordinary'), false);
});

test('opening a manual link validates the account and URL without adding queue work', async () => {
  const db = new Database(':memory:');
  const accounts = new AccountManager(db), conversations = new ConversationManager(db);
  const account = accounts.create('Link account'); accounts.setAlias(account.id, 'link-account');
  const opened: Array<{ id: string; url: string }> = [];
  const browser: BrowserAdapter = {
    activate: () => {}, remove: async () => {}, navigate: async () => {}, control: () => {}, page: () => null,
    openLink: (id, url) => { opened.push({ id, url }); return { id: 'auth-tab', accountId: id, url, title: 'Authorization', selected: true, locked: false }; }
  };
  const gateway = new AgentGateway(db, async () => ({}), () => {});
  const workspace = new Workspace(accounts, gateway, browser, () => {}, () => ({ enabled: false, endpoint: null, discoveryFile: '' }), conversations);
  try {
    const url = 'https://custom.example/authorize?state=private';
    const page = await workspace.call('browser.openLink', { accountId: 'link-account', url: ' ' + url + ' ' });
    assert.deepEqual(opened, [{ id: account.id, url }]);
    assert.equal((page as { id: string }).id, 'auth-tab');
    await assert.rejects(workspace.call('browser.openLink', { accountId: 'missing', url }));
    await assert.rejects(workspace.call('browser.openLink', { accountId: account.id, url: 'http://custom.example' }));
    assert.equal(opened.length, 1);
    assert.deepEqual(gateway.listTasks(), []);
    assert.deepEqual(conversations.list(account.id), []);
  } finally { await gateway.stop(); db.close(); }
});

test('prompt submission is opt-in and the task protocol does not accept arbitrary code', () => {
  assert.deepEqual(parseTask({ type: 'prompt', prompt: ' Hello ' }), { type: 'prompt', prompt: 'Hello', submit: false });
  assert.throws(() => parseTask({ type: 'prompt', prompt: 'Hello', submit: 'false' }));
  assert.throws(() => parseTask({ type: 'eval', code: 'process.exit()' }));
  assert.throws(() => parseTask({ type: 'fill', selector: '#prompt', text: 'x'.repeat(32001) }));
  assert.deepEqual(parseTask({ type: 'fill', selector: '#prompt', text: '' }), { type: 'fill', selector: '#prompt', text: '' });
});

test('queue isolates failures and does not corrupt cancelled tasks', async () => {
  const db = new Database(':memory:');
  const order: string[] = [];
  const gateway = new AgentGateway(db, async (id, _input, signal) => {
    order.push(id);
    if (id === 'cancel') await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cancelled')); }, { once: true });
    });
    if (id === 'fail') throw new Error('Fixture failure');
    return { id };
  }, () => {});
  const first = gateway.createTask('cancel', { type: 'snapshot' });
  const second = gateway.createTask('ok', { type: 'snapshot' });
  const third = gateway.createTask('fail', { type: 'snapshot' });
  await eventually(() => gateway.get(first.id).status === 'running');
  gateway.cancel(first.id);
  await eventually(() => gateway.get(third.id).status === 'waiting_user');
  assert.deepEqual(order, ['cancel', 'ok', 'fail']);
  assert.equal(gateway.get(first.id).status, 'cancelled');
  assert.equal(gateway.get(second.id).status, 'done');
  assert.equal(gateway.get(third.id).error, 'Fixture failure');
  gateway.cancel(third.id);
  await eventually(() => gateway.runningAccounts().length === 0);
  gateway.removeHistory();
  assert.deepEqual(gateway.listTasks(), []);
  await gateway.stop(); db.close();
});

test('restart marks interrupted tasks failed without replaying side effects', async () => {
  const db = new Database(':memory:');
  db.set('tasks', [{ id: 'pending', accountId: 'one', input: { type: 'snapshot' }, status: 'pending' },
    { id: 'running', accountId: 'two', input: { type: 'snapshot' }, status: 'running' }]);
  let executions = 0;
  const gateway = new AgentGateway(db, async () => { executions++; }, () => {});
  assert.equal(executions, 0);
  assert.ok(gateway.listTasks().every(task => task.status === 'failed'));
  await gateway.stop(); db.close();
});

test('workspace refuses unconfirmed deletion and clears the right profile before removing metadata', async () => {
  const db = new Database(':memory:');
  const accounts = new AccountManager(db);
  const events: string[] = [];
  const browser: BrowserAdapter = {
    activate: id => { events.push(`activate:${id}`); },
    remove: async id => { assert.equal(accounts.get(id).id, id); events.push(`wipe:${id}`); },
    navigate: async () => {}, control: () => {}, page: () => null
  };
  const gateway = new AgentGateway(db, async () => ({}), () => {});
  const workspace = new Workspace(accounts, gateway, browser, () => {}, () => ({ enabled: false, endpoint: null, discoveryFile: '' }), new ConversationManager(db));
  const first = await workspace.call('accounts.create', { name: 'Personal' }) as { id: string };
  const second = await workspace.call('accounts.create', { name: 'Work' }) as { id: string };
  await assert.rejects(workspace.call('accounts.remove', { id: second.id, confirmName: 'Wrong' }));
  assert.equal(accounts.list().length, 2);
  await workspace.call('accounts.remove', { id: second.id, confirmName: 'Work' });
  assert.equal(accounts.activeId(), first.id);
  assert.deepEqual(events.slice(-2), [`wipe:${second.id}`, `activate:${first.id}`]);
  await assert.rejects(workspace.call('settings.api', { enabled: true }));
  await assert.rejects(workspace.call('tasks.create', { accountId: second.id, input: { type: 'snapshot' } }));
  await gateway.stop(); db.close();
});

test('history retention never evicts a running task when cancelled tasks accumulate', async () => {
  const db = new Database(':memory:');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const gateway = new AgentGateway(db, async () => { await gate; return 'finished'; }, () => {});
  const active = gateway.createTask('account', { type: 'snapshot' });
  await eventually(() => gateway.get(active.id).status === 'running');
  for (let i = 0; i < 220; i++) {
    const queued = gateway.createTask('account', { type: 'snapshot' });
    gateway.cancel(queued.id);
  }
  assert.equal(gateway.listTasks().length, 200);
  assert.equal(gateway.get(active.id).status, 'running');
  release();
  await eventually(() => gateway.get(active.id).status === 'done');
  await gateway.stop(); db.close();
});

test('confirmed account deletion cancels unsent waiting and queued tasks without affecting another account', async () => {
  const db = new Database(':memory:'); const accounts = new AccountManager(db);
  const account = accounts.create('Example Personal'); const other = accounts.create('Example Work');
  const removed: string[] = [];
  const gateway = new AgentGateway(db, async () => { throw new Error('COMPOSER_NOT_READY'); }, () => {});
  const workspace = new Workspace(accounts, gateway, { activate: () => {}, remove: async id => { removed.push(id); }, navigate: async () => {}, control: () => {}, page: () => null }, () => {},
    () => ({ enabled: false, endpoint: null, discoveryFile: '' }), new ConversationManager(db));
  try {
    const blocked = gateway.createTask(account.id, { type: 'prompt', prompt: 'Unsent', submit: true }, { targetUrl: 'https://chatgpt.com/c/a' });
    await eventually(() => gateway.get(blocked.id).status === 'waiting_user' && !gateway.isRunning(account.id));
    const queued = gateway.createTask(account.id, { type: 'snapshot' }, { targetUrl: 'https://chatgpt.com/c/a' });
    gateway.pause(other.id);
    const unrelated = gateway.createTask(other.id, { type: 'snapshot' }, { targetUrl: 'https://chatgpt.com/c/b' });
    await assert.rejects(workspace.call('accounts.remove', { id: account.id, confirmName: 'wrong' }));
    assert.equal(gateway.get(blocked.id).status, 'waiting_user'); assert.equal(gateway.get(queued.id).status, 'pending');
    await workspace.call('accounts.remove', { id: account.id, confirmName: account.name });
    assert.deepEqual(removed, [account.id]); assert.deepEqual(accounts.list().map(item => item.id), [other.id]);
    assert.equal(gateway.listTasks().some(task => task.accountId === account.id), false);
    assert.equal(gateway.get(unrelated.id).status, 'pending');
  } finally { await gateway.stop(); db.close(); }
});

test('deletion refuses unresolved sends before cancelling any queued work', async () => {
  const db = new Database(':memory:'); const accounts = new AccountManager(db); const account = accounts.create('Review');
  let wiped = false;
  const gateway = new AgentGateway(db, async (_id, _input, _signal, context) => { context.intent(); throw new Error('Lost acknowledgement'); }, () => {});
  const workspace = new Workspace(accounts, gateway, { activate: () => {}, remove: async () => { wiped = true; }, navigate: async () => {}, control: () => {}, page: () => null }, () => {},
    () => ({ enabled: false, endpoint: null, discoveryFile: '' }), new ConversationManager(db));
  try {
    const sent = gateway.createTask(account.id, { type: 'prompt', prompt: 'Sent once', submit: true }, { targetUrl: 'https://chatgpt.com/c/a' });
    await eventually(() => gateway.get(sent.id).status === 'uncertain' && !gateway.isRunning(account.id));
    const queued = gateway.createTask(account.id, { type: 'snapshot' }, { targetUrl: 'https://chatgpt.com/c/a' });
    await assert.rejects(workspace.call('accounts.remove', { id: account.id, confirmName: account.name }), /先在任务中心核对/);
    assert.equal(wiped, false); assert.equal(accounts.get(account.id).id, account.id);
    assert.equal(gateway.get(queued.id).status, 'pending'); assert.equal(gateway.get(sent.id).resolvedAt, undefined);
  } finally { await gateway.stop(); db.close(); }
});
