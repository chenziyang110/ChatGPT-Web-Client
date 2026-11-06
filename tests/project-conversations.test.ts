import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/storage/Database';
import { ConversationManager, conversationUrl } from '../src/core/conversation/ConversationManager';
import { replyPageUrl } from '../src/main/adapters/ChatGPTAdapter';
import { ReplyReader } from '../src/main/adapters/ReplyReader';
import type { AgentTask } from '../src/shared/types';

const project = 'g-p-6aedd1cd55308191bd405e8f082c8a31-xiang-jin-shi-jin-gong';
const url = `https://chatgpt.com/g/${project}/c/thread`;

test('existing project chats preserve their full route and isolate account, project and plain-chat identities', () => {
  assert.deepEqual(conversationUrl(`${url}/`), { url, remoteId: `project:${project}:thread` });
  assert.equal(replyPageUrl(`${url}/?model=pro#latest`), url);
  const db = new Database(':memory:'); const manager = new ConversationManager(db);
  try {
    const chat = manager.register('a', url);
    assert.equal(chat.surface, 'chat'); assert.equal(chat.url, url);
    assert.equal(manager.register('a', `${url}/`).id, chat.id);
    assert.notEqual(manager.register('b', url).id, chat.id);
    assert.notEqual(manager.register('a', url.replace(project, 'g-p-another')).id, chat.id);
    assert.notEqual(manager.register('a', 'https://chatgpt.com/c/thread').id, chat.id);
    assert.throws(() => manager.bind('a', chat.id, url.replace(project, 'g-p-another')), /changed/);
    assert.throws(() => manager.register('a', url, undefined, 'dot'), /Your dot/);
    const fresh = manager.create('a');
    assert.throws(() => manager.bind('a', fresh.id, url), /Project/);
  } finally { db.close(); }
});

test('project support does not enable homepages, custom GPTs, malformed routes, temporary chats or foreign origins', () => {
  for (const invalid of [
    `https://chatgpt.com/g/${project}`, `https://chatgpt.com/g/${project}/project`,
    'https://chatgpt.com/g/custom/c/thread', 'https://chatgpt.com/g/project/c/thread',
    'https://chatgpt.com/g/g-p-/c/thread', `${url}/extra`, `${url}%2Fextra`,
    url.replace(project, `${project}%2Fother`), url.replace(project, `${project}%5Cother`),
    url.replace('https:', 'http:'), url.replace('chatgpt.com', 'chatgpt.com.evil.test'),
    url.replace('chatgpt.com', 'user@chatgpt.com'), `${url}?temporary-chat=true`,
  ]) {
    assert.throws(() => conversationUrl(invalid), invalid);
    assert.equal(replyPageUrl(invalid), undefined, invalid);
  }
  for (const suffix of ['?model=pro', '#latest', '?temporary-chat=false']) assert.throws(() => conversationUrl(url + suffix));
});

test('project reply recovery finishes only the original acknowledged turn in the complete project destination', () => {
  const reader = new ReplyReader();
  const task = { id: 'project', submittedMessageId: 'own', input: { type: 'prompt', prompt: 'Question', submit: true } } as AgentTask;
  const page = { url, title: '', readiness: 'ready' as const, editor: true, draft: '', busy: false,
    messages: [{ id: 'own', role: 'user', text: 'Question', terminal: false }, { id: 'reply', role: 'assistant', text: 'Answer', terminal: true }] };
  assert.equal(reader.read(task, page, url, 0).state, 'reading');
  assert.equal(reader.read(task, page, url, 6000).state, 'done');
  for (const other of [url.replace(project, 'g-p-another'), 'https://chatgpt.com/c/thread', url.replace('/c/thread', '/c/other')])
    assert.equal(reader.read(task, { ...page, url: other }, url, 7000).state, 'unavailable');
});
