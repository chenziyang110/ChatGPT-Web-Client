import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebContents } from 'electron';
import { ChatGPTAdapter, pageOperationResult } from '../src/main/adapters/ChatGPTAdapter';
import type { ConversationManager } from '../src/core/conversation/ConversationManager';
import type { ExecutionContext } from '../src/core/agent/AgentGateway';
import type { AgentTask } from '../src/shared/types';
import { Database } from '../src/core/storage/Database';
import { ConversationManager as Conversations } from '../src/core/conversation/ConversationManager';
const pageResult = (value: unknown) => ({ workspacePageResult: true, ok: true, value });

test('page result preserves a guarded failure instead of losing it across the Electron boundary', () => {
  assert.throws(() => pageOperationResult({ workspacePageResult: true, ok: false, error: 'PAGE_SCRIPT_FAILED [stage=write_text; error=TypeError]' }), /stage=write_text; error=TypeError/);
  assert.throws(() => pageOperationResult({ prepared: true }), /missing page result/);
});

function adapterFixture(readPage: (attempt: number) => Record<string, unknown>, prepareTimeoutMs = 4000, submit = false) {
  let attempts = 0; const operations: string[] = []; const controller = new AbortController();
  const url = 'https://chatgpt.com/c/delayed';
  const task = { id: 'test', accountId: 'account', input: { type: 'prompt', prompt: 'Question', submit },
    targetUrl: url, prepareTimeoutMs, idleTimeoutMs: 5000 } as AgentTask;
  const contents = { isLoading: () => false, getURL: () => url, isDestroyed: () => false,
    executeJavaScript: async (script: string) => {
      const operation = JSON.parse(script.slice(script.lastIndexOf(')(') + 2, -1)); operations.push(operation.kind);
      if (operation.kind === 'inspect') return pageResult({ url, title: 'ChatGPT', editor: true, draft: '', busy: false, messages: [], ...readPage(++attempts) });
      if (operation.kind === 'fill') return pageResult({ prepared: true });
      if (operation.kind === 'clear') return pageResult({ cleared: true });
      if (operation.kind === 'check_send') throw new Error('SEND_UNAVAILABLE: prompt remains a draft');
      throw new Error('Unexpected operation');
    } } as unknown as WebContents;
  const context: ExecutionContext = { task: () => task, stage: () => {}, intent: () => assert.fail('A draft must not send'), submitted: () => assert.fail('A draft must not submit') };
  return { adapter: new ChatGPTAdapter(contents, controller.signal, context, {} as ConversationManager), controller, operations, task, context };
}

test('a draft typed while waiting for execution capacity is preserved before any fill', async () => {
  let humanDraft = '';
  const fixture = adapterFixture(() => ({ readiness: 'ready', draft: humanDraft }));
  fixture.context.acquireExecution = async () => { humanDraft = 'Typed while waiting'; };
  const deadline = setTimeout(() => fixture.controller.abort(new Error('test deadline')), 4000);
  try {
    await assert.rejects(fixture.adapter.execute(fixture.task.input), /DRAFT_CONFLICT/);
    assert.equal(fixture.operations.includes('fill'), false);
    assert.equal(humanDraft, 'Typed while waiting');
  } finally { clearTimeout(deadline); }
});

test('page load completion waits for the delayed composer instead of blocking immediately', async () => {
  const fixture = adapterFixture(attempt => ({ editor: attempt > 3, readiness: attempt > 3 ? 'ready' : 'loading' }));
  const deadline = setTimeout(() => fixture.controller.abort(new Error('test deadline')), 6000);
  try {
    assert.deepEqual(await fixture.adapter.execute(fixture.task.input), { prepared: true });
    assert.equal(fixture.operations.filter(kind => kind === 'fill').length, 1);
  } finally { clearTimeout(deadline); }
});

test('unavailable send control is detected before recording send intent', async () => {
  const fixture = adapterFixture(() => ({ readiness: 'ready' }), 4000, true);
  await assert.rejects(fixture.adapter.execute(fixture.task.input), /SEND_UNAVAILABLE/);
  assert.equal(fixture.operations.includes('send'), false);
});

test('persistent verification is reported specifically without filling or sending', async () => {
  const fixture = adapterFixture(() => ({ editor: false, readiness: 'verification_required', title: '请稍候…' }), 50);
  await assert.rejects(fixture.adapter.execute(fixture.task.input), /VERIFICATION_REQUIRED/);
  assert.equal(fixture.operations.includes('fill'), false);
});

test('a transient signed-out shell can finish restoring its logged-in composer', async () => {
  const fixture = adapterFixture(attempt => ({ editor: attempt > 2, readiness: attempt > 2 ? 'ready' : 'login_required' }));
  assert.deepEqual(await fixture.adapter.execute(fixture.task.input), { prepared: true });
});

test('a known login gate is reported explicitly and existing drafts remain protected', async () => {
  const login = adapterFixture(() => ({ editor: false, readiness: 'login_required' }), 50);
  await assert.rejects(login.adapter.execute(login.task.input), /LOGIN_REQUIRED/);
  const draft = adapterFixture(() => ({ draft: 'Human unsent text', readiness: 'ready' }));
  await assert.rejects(draft.adapter.execute(draft.task.input), /DRAFT_CONFLICT/);
  assert.equal(draft.operations.includes('fill'), false);
});

test('waiting for a composer can be cancelled without a late fill', async () => {
  const fixture = adapterFixture(() => ({ editor: false, readiness: 'loading' }));
  const timer = setTimeout(() => fixture.controller.abort(new Error('User cancelled')), 30);
  try { await assert.rejects(fixture.adapter.execute(fixture.task.input), /User cancelled/); }
  finally { clearTimeout(timer); }
  assert.equal(fixture.operations.includes('fill'), false);
});

function submittedFixture(routes: string[]) {
  const db = new Database(':memory:'); const conversations = new Conversations(db);
  const conversation = conversations.create('account');
  const controller = new AbortController(); let sent = 0, acknowledged = 0, reads = 0;
  const task: AgentTask = { id: 'test', accountId: 'account', conversationId: conversation.id,
    input: { type: 'prompt', prompt: 'Question', submit: true }, status: 'running', createdAt: 1, updatedAt: 1,
    prepareTimeoutMs: 5000, idleTimeoutMs: 5000, replyTimeoutMs: 10000 };
  const contents = { isLoading: () => false, getURL: () => 'https://chatgpt.com/', isDestroyed: () => false,
    loadURL: async () => {}, executeJavaScript: async (script: string) => {
      const operation = JSON.parse(script.slice(script.lastIndexOf(')(') + 2, -1));
      if (operation.kind === 'send') { sent++; return pageResult({ clicked: true }); }
      if (operation.kind !== 'inspect') return pageResult({ prepared: true, ready: true });
      const url = sent ? routes[Math.min(reads++, routes.length - 1)] : 'https://chatgpt.com/';
      return pageResult({ url, title: 'ChatGPT', readiness: 'ready', editor: true, draft: '', busy: false, messages: sent ? [
        { id: 'user', role: 'user', text: 'Question', terminal: false },
        { id: 'reply', role: 'assistant', text: 'Verified answer', terminal: true },
      ] : [] });
    } } as unknown as WebContents;
  const context: ExecutionContext = { task: () => task, stage: () => {}, intent: () => { task.sendIntentAt = Date.now(); }, submitted: () => { acknowledged++; } };
  return { db, conversations, conversation, task, controller, adapter: new ChatGPTAdapter(contents, controller.signal, context, conversations), sent: () => sent, acknowledged: () => acknowledged };
}

test('a first send tolerates model parameters and trailing slash while binding and returning the same reply once', async () => {
  const f = submittedFixture(['https://chatgpt.com/?model=pro', 'https://chatgpt.com/c/local-chatgpt%3A11111111-1111-4111-8111-111111111111', 'https://chatgpt.com/c/new-reply/?model=pro#reply', 'https://chatgpt.com/c/new-reply']);
  const timer = setTimeout(() => f.controller.abort(new Error('test deadline')), 10000);
  try {
    const result = await f.adapter.execute(f.task.input) as { response: string; url: string };
    assert.equal(result.response, 'Verified answer'); assert.equal(result.url, 'https://chatgpt.com/c/new-reply');
    assert.equal(f.conversations.get('account', f.conversation.id).url, result.url);
    assert.equal(f.sent(), 1); assert.equal(f.acknowledged(), 1);
  } finally { clearTimeout(timer); f.db.close(); }
});

test('reply normalization still rejects another conversation, temporary chats and foreign origins without resending', async () => {
  const attempts = [
    ['https://chatgpt.com/c/first?model=pro', 'https://chatgpt.com/c/another?model=pro'],
    ['https://chatgpt.com/c/WEB:11111111-1111-4111-8111-111111111111', 'https://chatgpt.com/c/WEB:22222222-2222-4222-8222-222222222222'],
    ['https://chatgpt.com/c/first', 'https://chatgpt.com/c/WEB:11111111-1111-4111-8111-111111111111'],
    ['https://chatgpt.com/?temporary-chat=true'],
    ['https://example.com/c/first?token=do-not-record'],
  ];
  await Promise.all(attempts.map(async routes => {
    const f = submittedFixture(routes);
    try { await assert.rejects(f.adapter.execute(f.task.input), error => {
      assert.match(String(error), /TARGET_CHANGED/); assert.doesNotMatch(String(error), /do-not-record/); return true;
    }); assert.equal(f.sent(), 1); }
    finally { f.db.close(); }
  }));
});


test('recovered send receipt reads the original reply without filling or clicking Send again', async () => {
  const db = new Database(':memory:'); const conversations = new Conversations(db);
  const url = 'https://chatgpt.com/c/recovered'; const conversation = conversations.register('account',url);
  const controller = new AbortController(); const operations:string[]=[];
  const task:AgentTask={ id:'recovery', accountId:'account', conversationId:conversation.id, background:true,
    input:{type:'prompt',prompt:'Original question',submit:true}, status:'running', createdAt:1, updatedAt:1,
    sendIntentAt:1, submittedMessageId:'original-user',
    sendReceipt:{url,users:[{id:'unmounted-history',role:'user',text:'Earlier question',terminal:false}]}, replyTimeoutMs:15000 };
  const contents={isLoading:()=>false,getURL:()=>url,isDestroyed:()=>false,executeJavaScript:async(script:string)=>{
    const operation=JSON.parse(script.slice(script.lastIndexOf(')(')+2,-1));operations.push(operation.kind);
    assert.equal(operation.kind,'inspect');return pageResult({url,title:'Recovered',readiness:'ready',editor:true,draft:'',busy:false,messages:[
      {id:'original-user',role:'user',text:'Original question',terminal:false},
      {id:'reply',role:'assistant',text:'Original reply',terminal:true}
    ]});
  }} as unknown as WebContents;
  const context:ExecutionContext={task:()=>task,stage:()=>{},intent:()=>assert.fail('must not resend'),submitted:id=>assert.equal(id,'original-user')};
  try {
    const result=await new ChatGPTAdapter(contents,controller.signal,context,conversations).execute(task.input) as {response:string};
    assert.equal(result.response,'Original reply');assert.ok(operations.length>1);
  } finally {db.close()}
});

test('queue recovers an acknowledged long reply whose submitted user was virtualized away', async () => {
  const db = new Database(':memory:'); const conversations = new Conversations(db);
  const url = 'https://chatgpt.com/c/virtualized'; const conversation = conversations.register('account', url);
  const controller = new AbortController();
  const task: AgentTask = { id: 'virtualized', accountId: 'account', conversationId: conversation.id, background: true,
    input: { type: 'prompt', prompt: 'Long question', submit: true }, status: 'running', createdAt: 1, updatedAt: 1,
    sendIntentAt: 1, submittedAt: 2, submittedMessageId: 'sent-user', sendReceipt: { url, users: [] } };
  const contents = { isLoading: () => false, getURL: () => url, isDestroyed: () => false,
    executeJavaScript: async (script: string) => {
      const operation = JSON.parse(script.slice(script.lastIndexOf(')(') + 2, -1));
      assert.equal(operation.kind, 'inspect', 'an acknowledged prompt must never be filled or sent again');
      return pageResult({ url, title: 'Long reply', readiness: 'ready', editor: true, draft: '', busy: false,
        messages: [{ id: 'visible-answer', role: 'assistant', text: 'Visible answer', terminal: true }] });
    } } as unknown as WebContents;
  const context: ExecutionContext = { task: () => task, stage: () => {}, intent: () => assert.fail('resend'), submitted: () => assert.fail('already acknowledged') };
  const timer = setTimeout(() => controller.abort(new Error('virtualized reply remained stuck')), 15000);
  try {
    const result = await new ChatGPTAdapter(contents, controller.signal, context, conversations).execute(task.input) as Record<string, unknown>;
    assert.equal(result.submitted, true); assert.equal(result.responseUnavailable, true);
    assert.equal(result.url, url); assert.equal(result.response, undefined); assert.equal(result.replyToken, undefined);
  } finally { clearTimeout(timer); db.close(); }
});

test('missing submitted DOM is not completion during generation, loading, draft input, or an unacknowledged send', async () => {
  await Promise.all([
    { busy: true }, { readiness: 'loading' }, { editor: false }, { draft: 'New unsent draft' },
    { unacknowledged: true }, { changedTarget: true }, { additionalUser: true },
  ].map(async variant => {
    const db = new Database(':memory:'); const conversations = new Conversations(db);
    const url = 'https://chatgpt.com/c/virtualized'; const conversation = conversations.register('account', url);
    const controller = new AbortController();
    const task: AgentTask = { id: 'virtualized', accountId: 'account', conversationId: conversation.id, background: true,
      input: { type: 'prompt', prompt: 'Long question', submit: true }, status: 'running', createdAt: 1, updatedAt: 1,
      sendIntentAt: 1, submittedAt: variant.unacknowledged ? undefined : 2, submittedMessageId: 'sent-user', sendReceipt: { url, users: [] } };
    const contents = { isLoading: () => false, getURL: () => url, isDestroyed: () => false,
      executeJavaScript: async (script: string) => {
        const operation = JSON.parse(script.slice(script.lastIndexOf(')(') + 2, -1));
        assert.equal(operation.kind, 'inspect');
        return pageResult({ url: variant.changedTarget ? 'https://chatgpt.com/c/other' : url,
          title: 'Long reply', readiness: 'ready', editor: true, draft: '', busy: false, ...variant,
          messages: [...(variant.additionalUser ? [{ id: 'another-user', role: 'user', text: 'Another prompt', terminal: false }] : []),
            { id: 'visible-answer', role: 'assistant', text: 'Visible answer', terminal: true }] });
      } } as unknown as WebContents;
    const context: ExecutionContext = { task: () => task, stage: () => {}, intent: () => assert.fail('resend'), submitted: () => assert.fail('missing user') };
    const timer = setTimeout(() => controller.abort(new Error('expected still waiting')), 7000);
    try {
      await assert.rejects(new ChatGPTAdapter(contents, controller.signal, context, conversations).execute(task.input),
        variant.changedTarget ? /TARGET_CHANGED/ : variant.additionalUser ? /CONVERSATION_CHANGED/ : /expected still waiting/);
    } finally { clearTimeout(timer); db.close(); }
  }));
});
