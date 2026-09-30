import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/storage/Database';
import { ConversationManager, conversationUrl } from '../src/core/conversation/ConversationManager';
import { replyPageUrl } from '../src/main/adapters/ChatGPTAdapter';
import { ReplyReader } from '../src/main/adapters/ReplyReader';
import type { AgentTask } from '../src/shared/types';

test('Work mode survives binding and reopening; Dot identity never collides with a chat or another account', () => {
  const db = new Database(':memory:'); const conversations = new ConversationManager(db);
  try {
    const work = conversations.create('a', 'Work queue', 'work');
    conversations.markSending('a', work.id);
    conversations.bind('a', work.id, 'https://chatgpt.com/c/same-id');
    assert.equal(conversations.get('a', work.id).surface, 'work');
    assert.equal(conversations.register('a', 'https://chatgpt.com/c/same-id').id, work.id);
    const dot = conversations.register('a', 'https://chatgpt.com/dots/same-id');
    assert.equal(dot.surface, 'dot'); assert.notEqual(dot.id, work.id);
    assert.equal(conversations.register('a', dot.url).id, dot.id);
    assert.notEqual(conversations.register('b', dot.url).id, dot.id);
    assert.throws(() => conversations.bind('a', work.id, dot.url), /surface/);
    assert.throws(() => conversations.register('a', dot.url, undefined, 'work'), /Your dot/);
    assert.throws(() => conversations.create('a', undefined, 'dot'), /register/);
    assert.throws(() => conversations.create('a', undefined, 'unknown'), /surface/);
  } finally { db.close(); }
});

test('Dot target validation accepts only the observed personal route, with strict explicit API targets', () => {
  assert.equal(conversationUrl('https://chatgpt.com/dots/my-dot/').url, 'https://chatgpt.com/dots/my-dot');
  assert.equal(replyPageUrl('https://chatgpt.com/dots/my-dot/?ui=1#latest'), 'https://chatgpt.com/dots/my-dot');
  for (const url of ['https://chatgpt.com/dots/', 'https://chatgpt.com/dots/a/tasks/b', 'https://chatgpt.com/dots/a?temporary-chat=true',
    'https://chatgpt.com/share/a', 'https://example.com/dots/a', 'https://chatgpt.com/dots/a#other']) {
    assert.throws(() => conversationUrl(url));
  }
  assert.equal(replyPageUrl('https://chatgpt.com/dots/a?temporary-chat=true'), undefined);
});

test('Dot reply recovery requires the acknowledged turn and stable assistant reply in the same channel', () => {
  const reader = new ReplyReader();
  const task = { id: 'dot', submittedMessageId: 'own', input: { type: 'prompt', prompt: 'Question', submit: true } } as AgentTask;
  const page = { url: 'https://chatgpt.com/dots/one', surface: 'dot' as const, title: 'Your dot', readiness: 'ready' as const,
    editor: true, draft: '', busy: false, messages: [{ id: 'own', role: 'user', text: 'Question', terminal: false },
      { id: 'answer', role: 'assistant', text: 'Answer', terminal: true }] };
  assert.equal(reader.read(task, page, page.url, 0).state, 'reading');
  assert.equal(reader.read(task, page, page.url, 6000).state, 'done');
  assert.equal(reader.read(task, { ...page, url: 'https://chatgpt.com/dots/two' }, page.url, 7000).state, 'unavailable');
});
