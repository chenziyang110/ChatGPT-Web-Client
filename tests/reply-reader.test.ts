import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyReader } from '../src/main/adapters/ReplyReader';
import type { Page } from '../src/main/adapters/ChatGPTAdapter';
import type { AgentTask } from '../src/shared/types';

test('uncertain reply recovery matches the original question and waits for stable final content', () => {
  const reader = new ReplyReader();
  const task = { id: 'original', input: { type: 'prompt', prompt: 'Question', submit: true } } as AgentTask;
  const page: Page = { url: 'https://chatgpt.com/c/original', title: '', readiness: 'ready', editor: true, draft: '', busy: true,
    messages: [{ id: 'user', role: 'user', text: 'Question', terminal: false }, { id: 'reply', role: 'assistant', text: 'Partial', terminal: false }] };
  assert.equal(reader.read(task, page, undefined, 0).state, 'reading');
  page.busy = false; page.messages[1].terminal = true;
  assert.equal(reader.read(task, page, undefined, 10000).state, 'reading');
  page.messages[1].text = 'Complete answer';
  assert.equal(reader.read(task, page, undefined, 13000).state, 'reading');
  assert.equal(reader.read(task, page, undefined, 18999).state, 'reading');
  assert.equal(reader.read(task, page, undefined, 19000).state, 'done');
  assert.equal(task.status, undefined, 'Reading does not mutate the task');
  assert.equal(reader.read(task, { ...page, url: 'https://chatgpt.com/c/other' }, page.url).state, 'unavailable');
  assert.equal(reader.read({ ...task, submittedMessageId: 'different' }, page).state, 'unavailable');
  assert.equal(reader.read({ ...task, input: { type: 'prompt', prompt: 'Different question', submit: true } }, page).state, 'unavailable');
  page.messages.unshift({ id: 'older', role: 'user', text: 'Question', terminal: false });
  assert.equal(reader.read(task, page).state, 'unavailable', 'Without a recorded message ID, repeated questions are ambiguous');
});
