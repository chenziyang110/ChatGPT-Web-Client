import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/storage/Database';
import { ConversationManager, conversationUrl } from '../src/core/conversation/ConversationManager';
import { replyPageUrl } from '../src/main/adapters/ChatGPTAdapter';
import { ReplyReader } from '../src/main/adapters/ReplyReader';
import type { AgentTask } from '../src/shared/types';

const compoundDotId = '11111111-2222-4333-8444-555555555555~0123456789abcdef0123456789abcdef';
const compoundDotUrl = `https://chatgpt.com/dots/${compoundDotId}`;

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

test('compound Dot registration preserves both IDs and account isolation', () => {
  const db = new Database(':memory:'); const conversations = new ConversationManager(db);
  try {
    const target = conversationUrl(`${compoundDotUrl}/`);
    assert.deepEqual(target, { url: compoundDotUrl, remoteId: `dot:${compoundDotId}`, surface: 'dot' });
    const dot = conversations.register('a', compoundDotUrl);
    assert.equal(dot.surface, 'dot'); assert.equal(dot.remoteId, `dot:${compoundDotId}`);
    assert.equal(conversations.register('a', `${compoundDotUrl}/`).id, dot.id);
    assert.notEqual(conversations.register('a', compoundDotUrl.replace(/~.*$/, '~different-channel')).id, dot.id);
    assert.notEqual(conversations.register('a', compoundDotUrl.replace(/~.*$/, '')).id, dot.id);
    assert.notEqual(conversations.register('b', compoundDotUrl).id, dot.id);
    assert.throws(() => conversations.register('a', compoundDotUrl, undefined, 'chat'), /Your dot/);
  } finally { db.close(); }
});

test('compound Dot reply normalization accepts observed UI parameters without broadening chat routes', () => {
  assert.equal(replyPageUrl(`${compoundDotUrl}/?ui=1#latest`), compoundDotUrl);
  assert.equal(replyPageUrl(`${compoundDotUrl}?temporary-chat=false`), compoundDotUrl);
  assert.equal(replyPageUrl(`${compoundDotUrl}?temporary-chat=true`), undefined);
  const longest = `https://chatgpt.com/dots/${'a'.repeat(128)}~${'b'.repeat(128)}`;
  assert.equal(conversationUrl(longest).url, longest);
  assert.equal(replyPageUrl(longest), longest);
  for (const url of [
    'https://chatgpt.com/dots/~b', 'https://chatgpt.com/dots/a~', 'https://chatgpt.com/dots/a~~b',
    'https://chatgpt.com/dots/a~b~c', 'https://chatgpt.com/dots/a%7Eb', 'https://chatgpt.com/dots/a%2Fb',
    'https://chatgpt.com/dots/a%5Cb', `${compoundDotUrl}/tasks/b`, `${compoundDotUrl}%2Fextra`,
    `https://chatgpt.com/dots/${'a'.repeat(129)}~b`, `https://chatgpt.com/dots/a~${'b'.repeat(129)}`,
    `https://chatgpt.com/c/${compoundDotId}`, compoundDotUrl.replace('chatgpt.com', 'example.com'),
    compoundDotUrl.replace('https:', 'http:'), compoundDotUrl.replace('chatgpt.com', 'chatgpt.com.evil.test'),
  ]) {
    assert.throws(() => conversationUrl(url), url);
    assert.equal(replyPageUrl(url), undefined, url);
  }
  for (const suffix of ['?ui=1', '#latest', '?temporary-chat=false']) assert.throws(() => conversationUrl(`${compoundDotUrl}${suffix}`));
});

test('compound Dot reply recovery completes only the same full destination', () => {
  const reader = new ReplyReader();
  const task = { id: 'compound-dot', submittedMessageId: 'own', input: { type: 'prompt', prompt: 'Question', submit: true } } as AgentTask;
  const page = { url: `${compoundDotUrl}/?ui=1#latest`, surface: 'dot' as const, title: 'Your dot', readiness: 'ready' as const,
    editor: true, draft: '', busy: false, messages: [{ id: 'own', role: 'user', text: 'Question', terminal: false },
      { id: 'answer', role: 'assistant', text: 'Answer', terminal: true }] };
  assert.equal(reader.read(task, page, compoundDotUrl, 0).state, 'reading');
  const response = reader.read(task, page, compoundDotUrl, 6000);
  assert.equal(response.state, 'done'); assert.equal(response.result?.url, compoundDotUrl);
  assert.equal(reader.read(task, { ...page, url: compoundDotUrl.replace(/~.*$/, '~different-channel') }, compoundDotUrl, 7000).state, 'unavailable');
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
  assert.equal(reader.read(task, { ...page, dotWork: 'working', busy: true }, page.url, 8000).state, 'reading');
  assert.equal(reader.read(task, { ...page, dotWork: 'working', busy: true }, page.url, 18000).state, 'reading', 'Stable acknowledgement is not a final work result');
  assert.equal(reader.read(task, { ...page, dotWork: 'idle' }, page.url, 19000).state, 'reading');
  assert.equal(reader.read(task, { ...page, dotWork: 'idle' }, page.url, 25000).state, 'done');
});
