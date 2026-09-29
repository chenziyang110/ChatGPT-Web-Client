import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyTurnTracker, type ConversationMessage } from '../src/main/adapters/ReplyTurnTracker';

const user = (id: string, text = id): ConversationMessage => ({ id, role: 'user', text, terminal: false });
const answer: ConversationMessage = { id: 'reply', role: 'assistant', text: 'Answer', terminal: true };
const history = [user('old-1'), user('old-2'), user('old-3')];
const own = user('submitted', 'Question');

test('queue tracking uses stable turn boundaries when Markdown rendering changes source text', () => {
  const original = user('anchor', '[old](https://example.com/old)');
  const rendered = user('anchor', 'old');
  const sent = user('new', 'new link');
  const tracker = new ReplyTurnTracker([original], '[new link](https://example.com/new)', undefined, true);
  assert.equal(tracker.read([rendered, sent]), sent);
  assert.equal(tracker.read([sent]), sent);
  assert.equal(new ReplyTurnTracker([original], 'source', 'new', true).read([rendered, sent]), sent);
  assert.throws(() => new ReplyTurnTracker([original], 'source').read([rendered, sent]), /content changed/);
  assert.throws(() => new ReplyTurnTracker([original], 'source', undefined, true).read([sent]), /anchor is missing/);
  assert.throws(() => tracker.read([sent, user('extra', 'new link')]), /additional user turn/);
  assert.throws(() => new ReplyTurnTracker([], 'source', undefined, true).read([user('position:0', 'different')]), /does not match/);
});

test('sending after a virtualized answer tolerates remounted history without acknowledging an older identical prompt', () => {
  const tracker = new ReplyTurnTracker([answer], 'Question');
  const older = user('older-identical', 'Question');
  assert.equal(tracker.read([older, answer]), undefined);
  assert.equal(tracker.read([older, answer, own]), own);
  assert.equal(tracker.read([own]), own);
  assert.equal(tracker.read([older, answer, own]), own);
  assert.throws(() => tracker.read([older, answer, user('another', 'Question')]), /identity changed/);
  assert.throws(() => new ReplyTurnTracker([answer], 'Question').read([older, answer, own, user('extra', 'Question')]), /additional user turn/);
  assert.equal(new ReplyTurnTracker([answer], 'Question', own.id).read([older, answer, own]), own);
});

test('restores a persisted stable submission after all older DOM history unmounts', () => {
  assert.equal(new ReplyTurnTracker(history, 'Question', own.id).read([own, answer]), own);
  assert.throws(() => new ReplyTurnTracker(history, 'Question', own.id).read([user('different', 'Question'), answer]), /CONVERSATION_CHANGED/);
  assert.throws(() => new ReplyTurnTracker(history, 'Question', own.id).read([user(own.id, 'Edited'), answer]), /does not match/);
  assert.throws(() => new ReplyTurnTracker(history, 'Question', 'position:3').read([own, answer]), /anchor is missing/);
});

test('restored queue acknowledgement survives history mounted outside its original DOM window', () => {
  for (const baseline of [[], history, [answer]]) {
    const tracker = new ReplyTurnTracker(baseline, 'Question', own.id, true);
    const remounted = [user('previously-unmounted'), own, answer];
    assert.equal(tracker.read(remounted), own);
    assert.equal(tracker.read([own, answer]), own);
    assert.throws(() => tracker.read([...remounted, user('external')]), /additional user turn/);
    assert.throws(() => tracker.read([own, own]), /duplicate/);
  }
  assert.throws(() => new ReplyTurnTracker([], 'Question', own.id).read([user('old'), own]), /anchor is missing/);
  assert.throws(() => new ReplyTurnTracker([], 'Question', undefined, true).read([user('old'), own]), /additional user/);
});

test('matches a sent turn after the old DOM prefix unmounts before acknowledgement', () => {
  const tracker = new ReplyTurnTracker(history, 'Question');
  assert.equal(tracker.read([...history.slice(1), own, answer]), own);
  assert.equal(tracker.read([...history.slice(2), own, answer]), own);
  assert.equal(tracker.read([own, answer]), own);
  assert.equal(tracker.read([...history, own, answer]), own);
});

test('matches the acknowledged turn while older history unmounts and earlier history mounts', () => {
  const tracker = new ReplyTurnTracker(history, 'Question');
  assert.equal(tracker.read([...history, own, answer]), own);
  assert.equal(tracker.read([...history.slice(1), own, answer]), own);
  assert.equal(tracker.read([user('earlier'), ...history, own, answer]), own);
});

test('missing own turn does not turn a historical assistant reply into completion', () => {
  const tracker = new ReplyTurnTracker(history, 'Question');
  assert.equal(tracker.read([...history, own, answer]), own);
  assert.equal(tracker.read([history[1], answer]), undefined);
  assert.equal(tracker.read([]), undefined);
  assert.equal(tracker.read([own, answer]), own);
});

test('requires the last pre-send history anchor before acknowledging even identical text', () => {
  const tracker = new ReplyTurnTracker(history, 'Question');
  assert.equal(tracker.read(history.slice(0, 2)), undefined);
  assert.throws(() => tracker.read([own, answer]), /anchor is missing/);
});

test('still rejects changed, replaced, missing interior and reordered history', () => {
  for (const visible of [
    [history[0], user('old-2', 'edited'), history[2]],
    [history[0], user('replacement'), history[2]],
    [history[0], history[2]],
    [history[1], history[0], history[2]],
    [history[0], user('extra'), history[1], history[2]],
  ]) assert.throws(() => new ReplyTurnTracker(history, 'Question').read([...visible, own, answer]), /CONVERSATION_CHANGED/);
});

test('rejects extra user turns before and after the acknowledged question, including identical prompts', () => {
  assert.throws(() => new ReplyTurnTracker(history, 'Question').read([...history, user('external', 'Question'), own, answer]), /additional user turn/);
  const tracker = new ReplyTurnTracker(history, 'Question'); tracker.read([...history, own, answer]);
  assert.throws(() => tracker.read([own, user('external', 'Question'), answer]), /additional user turn/);
});

test('the submitted message identity and text cannot change after acknowledgement', () => {
  const tracker = new ReplyTurnTracker(history, 'Question'); tracker.read([...history, own, answer]);
  assert.throws(() => tracker.read([...history, user('replacement', 'Question'), answer]), /CONVERSATION_CHANGED/);
  assert.throws(() => tracker.read([...history, user('submitted', 'edited'), answer]), /submitted turn does not match/);
});

test('does not treat positional fallback IDs or duplicate IDs as stable anchors', () => {
  const baseline = [user('position:0'), user('position:2')];
  assert.equal(new ReplyTurnTracker(baseline, 'Question').read([...baseline, own, answer]), own);
  assert.throws(() => new ReplyTurnTracker(baseline, 'Question').read([baseline[1], own, answer]), /without stable message IDs/);
  assert.throws(() => new ReplyTurnTracker(history, 'Question').read([...history, own, own, answer]), /duplicate/);
});

test('new conversations accept exactly one matching user turn and preserve line breaks', () => {
  const multiline = user('sent', 'Question\nnext line');
  assert.equal(new ReplyTurnTracker([], 'Question\r\nnext line').read([multiline, answer]), multiline);
  assert.throws(() => new ReplyTurnTracker([], 'Question').read([user('wrong'), answer]), /does not match/);
  assert.throws(() => new ReplyTurnTracker([], 'Question').read([own, user('extra'), answer]), /additional user turn/);
});
