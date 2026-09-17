import test from 'node:test';
import assert from 'node:assert/strict';

import { allowChatGptClipboardWrite } from '../src/main/permissions';

test('allows sanitized clipboard writes from the top-level ChatGPT page', () => {
  assert.equal(allowChatGptClipboardWrite('clipboard-sanitized-write', 'https://chatgpt.com/', true), true);
  assert.equal(allowChatGptClipboardWrite('clipboard-sanitized-write', 'https://chatgpt.com/c/conversation', true), true);
});

test('denies clipboard reads, other permissions, subframes, and untrusted origins', () => {
  assert.equal(allowChatGptClipboardWrite('clipboard-read', 'https://chatgpt.com/', true), false);
  assert.equal(allowChatGptClipboardWrite('media', 'https://chatgpt.com/', true), false);
  assert.equal(allowChatGptClipboardWrite('clipboard-sanitized-write', 'https://chatgpt.com/', false), false);
  for (const url of [
    'https://chatgpt.com.evil.test/',
    'http://chatgpt.com/',
    'https://chatgpt.com:8443/',
    'https://auth.openai.com/',
    'not a url'
  ]) assert.equal(allowChatGptClipboardWrite('clipboard-sanitized-write', url, true), false, url);
});
