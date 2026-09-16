import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentPrompt } from '../src/core/agent/AgentPrompt';
import type { Account } from '../src/shared/types';

test('native Agent handoffs work with Windows, macOS and Linux executable paths', () => {
  const account = { id: 'example-account', name: 'Demo' } as Account;
  for (const cliPath of ['C:\\Program Files\\Workspace\\resources\\agent\\chatgpt-agent.exe', '/Applications/ChatGPT Web Client.app/Contents/Resources/agent/chatgpt-agent', '/opt/ChatGPT Web Client/resources/agent/chatgpt-agent']) {
    const handoff = buildAgentPrompt(account, { accountId: account.id }, 'Demo', { cliPath, discoveryFile: '/demo/agent-runtime.json', apiEnabled: true });
    assert.equal(handoff.commands!.create[0], cliPath);
    assert.ok(handoff.commands!.create.includes('ask'));
    assert.ok(handoff.commands!.wait.includes('resume'));
    assert.ok(!handoff.commands!.create.includes('node'));
    assert.ok(!handoff.commands!.create.includes('--submit'));
  }
});
