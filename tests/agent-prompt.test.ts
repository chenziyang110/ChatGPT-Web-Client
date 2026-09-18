import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Database } from '../src/core/storage/Database';
import { AccountManager } from '../src/core/account/AccountManager';
import { ConversationManager } from '../src/core/conversation/ConversationManager';
import { AgentGateway } from '../src/core/agent/AgentGateway';
import { LocalApi } from '../src/core/agent/LocalApi';
import { buildAgentPrompt } from '../src/core/agent/AgentPrompt';
import { Workspace } from '../src/core/Workspace';
import type { AgentHandoff, AgentTask, BrowserPage } from '../src/shared/types';

function setup(discoveryFile = path.resolve('agent-runtime.json'), execute = async (_account: string, input: unknown): Promise<unknown> => input) {
  const db = new Database(':memory:'); const accounts = new AccountManager(db); const conversations = new ConversationManager(db);
  const account = accounts.create('Work'); const other = accounts.create('Personal'); accounts.setAlias(account.id, 'work');
  let current = 'https://chatgpt.com/c/initial'; let enabled = false;
  let pages: BrowserPage[] = [];
  const gateway = new AgentGateway(db, execute, () => {});
  const workspace = new Workspace(accounts, gateway, { activate: () => {}, remove: async () => {}, navigate: async () => {}, control: () => {}, page: () => null, url: () => current, pages: () => pages }, () => {},
    () => ({ enabled, endpoint: enabled ? 'http://127.0.0.1:12345' : null, discoveryFile }), conversations, undefined, undefined, path.resolve('src/cli/index.ts'));
  return { db, accounts, account, other, conversations, gateway, workspace, current: (value: string) => { current = value; }, pages: (value: BrowserPage[]) => { pages = value; }, enable: () => { enabled = true; } };
}

test('Agent handoff pins the requested tab and never substitutes a previous conversation for a loading or new tab', async () => {
  const f = setup();
  try {
    const page: BrowserPage = { id: f.account.id, accountId: f.account.id, url: '', title: 'ChatGPT', selected: false, locked: false };
    f.pages([page]);
    assert.throws(() => f.workspace.call('agent.prompt', { accountId: f.account.id, pageId: page.id }), /正在加载/);
    page.url = 'https://chatgpt.com/';
    const blank = await f.workspace.call('agent.prompt', { accountId: f.account.id, pageId: page.id }) as AgentHandoff;
    assert.equal(blank.scope, 'account'); assert.equal(blank.createRequest.params.new, true);
    assert.equal(blank.target.url, undefined); assert.doesNotMatch(blank.prompt, /\/c\/initial/);
    page.url = 'https://chatgpt.com/c/new-conversation';
    const pinned = await f.workspace.call('agent.prompt', { accountId: f.account.id, pageId: page.id }) as AgentHandoff;
    assert.equal(pinned.target.url, page.url);
    page.url = 'https://chatgpt.com/c/another';
    f.enable();
    const copy = await f.workspace.call('agent.prompt', { ...pinned.target }) as AgentHandoff;
    assert.equal(copy.target.url, 'https://chatgpt.com/c/new-conversation');
    assert.throws(() => f.workspace.call('agent.prompt', { accountId: f.other.id, pageId: page.id }), /已关闭/);
    assert.throws(() => f.workspace.call('agent.prompt', { accountId: f.account.id, pageId: page.id, current: true }), /请选择一个/);
    f.pages([]);
    assert.throws(() => f.workspace.call('agent.prompt', { accountId: f.account.id, pageId: page.id }), /已关闭/);
    assert.equal(f.gateway.listTasks().length, 0);
  } finally { await f.gateway.stop(); f.db.close(); }
});

test('Agent prompt generation is read-only, pins IDs, and supplies account or conversation workflows without secrets', async () => {
  const fixture = setup(); const { workspace, account, conversations, gateway, db } = fixture;
  const accountPrompt = await workspace.call('agent.prompt', { accountId: 'work' }) as AgentHandoff;
  assert.equal(accountPrompt.scope, 'account'); assert.equal(accountPrompt.apiEnabled, false);
  assert.equal(accountPrompt.createRequest.params.accountId, account.id); assert.equal(accountPrompt.createRequest.params.new, true);
  assert.equal(conversations.list().length, 0); assert.equal(gateway.listTasks().length, 0);
  assert.equal(accountPrompt.prompt.includes('127.0.0.1:12345'), false);
  fixture.enable();
  const helpPrompt = await workspace.call('agent.prompt', { accountId: account.id }) as AgentHandoff;
  assert.equal(helpPrompt.helpUrl, 'http://127.0.0.1:12345/help.html');
  assert.match(helpPrompt.prompt, /help.html/); assert.match(helpPrompt.prompt, /waiting_user/);
  assert.match(helpPrompt.prompt, /默认不要加 --stream/);
  assert.match(helpPrompt.prompt, /不要创建定时轮询或监控目标/);
  assert.match(helpPrompt.prompt, /保持同一个子进程/);
  assert.ok(helpPrompt.prompt.length < 1600, 'Instructions stay compact; the help page carries API detail');
  await assert.rejects(workspace.call('tasks.decide', { id: 'not-a-task' }), /Unknown method/);
  await assert.rejects(workspace.call('browser.preview', { accountId: account.id }), /Unknown method/);
  assert.ok(accountPrompt.commands?.create.includes('--text-file'));
  assert.ok(accountPrompt.commands?.wait.includes('--wait-timeout'));
  assert.match(accountPrompt.prompt, /uncertain/); assert.match(accountPrompt.prompt, /网页当前模型/);
  const pinned = await workspace.call('agent.prompt', { accountId: account.id, current: true }) as AgentHandoff;
  fixture.current('https://chatgpt.com/c/changed');
  assert.equal(pinned.target.url, 'https://chatgpt.com/c/initial');
  const copy = await workspace.call('agent.prompt', { ...pinned.target }) as AgentHandoff;
  assert.equal(copy.prompt, pinned.prompt, 'Copying the preview must not re-resolve the current tab');
  const saved = conversations.register(account.id, 'https://chatgpt.com/c/research', 'Research');
  const scoped = await workspace.call('agent.prompt', { accountId: 'work', conversation: 'Research' }) as AgentHandoff;
  assert.equal(scoped.target.conversation, saved.id); assert.equal(scoped.scope, 'conversation');
  assert.equal(scoped.createRequest.params.new, undefined); assert.equal(scoped.commands?.create.includes('--new'), false);
  assert.throws(() => workspace.call('agent.prompt', { accountId: fixture.other.id, conversation: saved.id }), /not found/);
  assert.throws(() => workspace.call('agent.prompt', { accountId: account.id, url: 'https://evil.test/' }));
  assert.throws(() => workspace.call('agent.prompt', { accountId: account.id, current: true, conversation: saved.id }));
  const unbound = conversations.create(account.id); conversations.markSending(account.id, unbound.id);
  assert.throws(() => workspace.call('agent.prompt', { accountId: account.id, conversation: unbound.id }), /待核对/);
  await assert.rejects(workspace.call('agent.prompt.copy', { accountId: account.id }), /Unknown method/, 'HTTP/core dispatch cannot write to the clipboard');
  const installed = buildAgentPrompt(account, { accountId: account.id, url: saved.url }, saved.title, { apiEnabled: true, discoveryFile: path.resolve('agent-runtime.json') });
  assert.equal(installed.commands, undefined, 'Packaged apps provide HTTP instructions without an unusable CLI path');
  assert.equal(installed.createRequest.params.url, saved.url);
  assert.match(installed.prompt, /POST/); assert.match(installed.prompt, /tasks.wait/);
  assert.equal(gateway.listTasks().length, 0); await gateway.stop(); db.close();
});

test('generated CLI instructions complete consultation, preserve multiline UTF-8 questions, and reuse the new conversation', async () => {
  const directory = mkdtempSync(path.resolve('.test-agent-prompt-')); const discoveryFile = path.join(directory, 'agent-runtime.json');
  const seen: Array<{ account: string; prompt: string }> = [];
  const fixture = setup(discoveryFile, async (account, value) => {
    const input = value as { prompt: string }; seen.push({ account, prompt: input.prompt });
    return { submitted: true, response: `Advice: ${input.prompt}`, url: 'https://chatgpt.com/c/advisor' };
  });
  fixture.enable();
  const api = new LocalApi(discoveryFile, (method, params) => fixture.workspace.call(method, params));
  const run = async (command: string[]) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...command.slice(1)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    const code = await new Promise(resolve => child.on('close', resolve));
    return { code, output, errors };
  };
  try {
    await api.start();
    const generated = await run(['node', path.resolve('src/cli/index.ts'), '--data-dir', directory, 'agent-prompt', '--account', 'work']);
    assert.equal(generated.code, 0, generated.errors);
    const handoff = JSON.parse(generated.output) as AgentHandoff;
    const file = path.join(directory, 'question with spaces.txt'); const question = '分析这段代码：\nconst x = `value`;\n$(do-not-execute) "quoted"';
    writeFileSync(file, '\uFEFF' + question, 'utf8');
    const initial = handoff.commands!.create.map(arg => arg === 'QUESTION_FILE' ? file : arg === 'REQUEST_UUID' ? 'consultation-1' : arg);
    const created = await run(initial); assert.equal(created.code, 0, created.errors);
    const task = JSON.parse(created.output) as AgentTask;
    assert.equal(task.accountId, fixture.account.id); assert.ok(task.conversationId);
    const waited = await run(handoff.commands!.wait.map(arg => arg === 'TASK_ID' ? task.id : arg));
    assert.equal(waited.code, 0, waited.errors); assert.equal(JSON.parse(waited.output).result.response, `Advice: ${question}`);
    const duplicate = await run(initial); assert.equal(JSON.parse(duplicate.output).id, task.id); assert.equal(seen.length, 1);
    writeFileSync(file, '请给出验证步骤', 'utf8');
    const followup = await run(handoff.commands!.followup.map(arg => arg === 'QUESTION_FILE' ? file : arg === 'CONVERSATION_ID' ? task.conversationId! : arg === 'REQUEST_UUID' ? 'consultation-2' : arg));
    assert.equal(followup.code, 0, followup.errors); assert.equal(JSON.parse(followup.output).conversationId, task.conversationId);
    assert.deepEqual(seen.map(item => item.account), [fixture.account.id, fixture.account.id]);
    assert.deepEqual(seen.map(item => item.prompt), [question, '请给出验证步骤']);
    const ambiguous = await run([...initial, '--text', 'Ambiguous']); assert.equal(ambiguous.code, 1); assert.equal(seen.length, 2);
    assert.equal(fixture.conversations.list().length, 1);
  } finally { await api.stop(); await fixture.gateway.stop(); fixture.db.close(); rmSync(directory, { recursive: true, force: true }); }
});
