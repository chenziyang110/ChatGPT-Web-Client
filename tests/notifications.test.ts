import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/storage/Database';
import { ShortcutSettings } from '../src/core/settings/ShortcutSettings';
import { bossKeyBinding, defaultShortcuts, shortcutText } from '../src/shared/shortcuts';
import { ConversationNotifications, ConversationActivityObserver, replyToken, type ActivitySnapshot } from '../src/core/notifications/ConversationNotifications';
const idle: ActivitySnapshot = { url: 'https://chatgpt.com/c/a', title: 'Daily', editor: true, busy: false };
const generating: ActivitySnapshot = { ...idle, busy: true, user: { id: 'u1', text: 'Hi' }, lastRole: 'user' };
const finished: ActivitySnapshot = { ...generating, busy: false, lastRole: 'assistant', assistant: { id: 'r1', text: 'Hello', terminal: true } };

test('simultaneous pages in one account retain independent running and completion notices', () => {
  const db = new Database(':memory:'); const notices = new ConversationNotifications(db, () => {});
  const observer = new ConversationActivityObserver(notices, true);
  observer.observe('a', generating, 0);
  observer.observe('a', { ...generating, url: 'https://chatgpt.com/c/b' }, 0);
  assert.equal(notices.list('a').filter(item => item.running).length, 2);
  observer.observe('a', finished, 100); observer.observe('a', finished, 3200);
  assert.equal(notices.list('a').filter(item => item.running).length, 1);
  observer.observe('a', { ...finished, url: 'https://chatgpt.com/c/b' }, 3300);
  observer.observe('a', { ...finished, url: 'https://chatgpt.com/c/b' }, 6400);
  assert.equal(notices.list('a').filter(item => item.unread).length, 2);
  observer.disconnected('a', idle.url);
  assert.equal(notices.list('a').filter(item => item.unread).length, 2);
  db.close();
});

test('older shortcut settings gain takeover without overwriting existing bindings or creating conflicts', () => {
  const db = new Database(':memory:');
  const { takeover: _takeover, ...old } = defaultShortcuts('win32');
  db.set('shortcuts', old);
  const settings = new ShortcutSettings(db, 'win32');
  assert.deepEqual(settings.match(defaultShortcuts('win32').takeover!), { type: 'takeover' });
  db.set('shortcuts', { ...old, focus: defaultShortcuts('win32').takeover });
  assert.equal(settings.get().takeover, null);
  assert.deepEqual(settings.match(defaultShortcuts('win32').takeover!), { type: 'focus' });
  db.close();
});

test('shortcut changes, clearing, defaults and conflict checks persist and match exact modifiers', () => {
  const db = new Database(':memory:'); const settings = new ShortcutSettings(db, 'win32');
  assert.deepEqual(settings.match({ code: 'KeyF', control: true, meta: false, alt: false, shift: true }), { type: 'focus' });
  const custom = settings.get(); custom.focus!.code = 'KeyK'; custom.account1 = null;
  settings.save(custom);
  assert.equal(new ShortcutSettings(db, 'win32').get().focus?.code, 'KeyK');
  assert.equal(settings.match(defaultShortcuts('win32').focus!), undefined);
  assert.equal(settings.match(defaultShortcuts('win32').account1!), undefined);
  assert.equal(settings.match({ ...custom.focus!, alt: true }), undefined);
  assert.deepEqual(settings.match({ ...custom.account2!, code: 'Numpad2' }), { type: 'account', index: 1 });
  const duplicate = settings.get(); duplicate.next = duplicate.focus;
  assert.throws(() => settings.save(duplicate), /冲突/); assert.equal(settings.get().next?.code, 'ArrowRight');
  const invalid = settings.get(); invalid.focus = { ...invalid.focus!, control: false };
  assert.throws(() => settings.save(invalid), /至少包含/);
  assert.equal(settings.reset().focus?.code, 'KeyF');
  assert.equal(defaultShortcuts('darwin').focus?.meta, true);
  assert.equal(shortcutText(null), '未设置'); db.close();
});

test('the global boss key is reserved and legacy conflicts are disabled', () => {
  const db = new Database(':memory:'); const settings = new ShortcutSettings(db, 'win32');
  const conflict = settings.get(); conflict.focus = bossKeyBinding('win32');
  assert.throws(() => settings.save(conflict), /老板键/);
  db.set('shortcuts', conflict);
  assert.equal(settings.get().focus, null);
  assert.deepEqual(bossKeyBinding('darwin'), { code: 'KeyS', control: false, meta: true, alt: false, shift: true });
  db.close();
});

test('manual generation transitions to one unread conversation after a stable completed reply', () => {
  const db = new Database(':memory:'); const notices = new ConversationNotifications(db, () => {}); const observer = new ConversationActivityObserver(notices);
  observer.observe('a', idle, 0); observer.observe('a', generating, 100);
  assert.equal(notices.list('a')[0].running, true); assert.equal(notices.list('a')[0].unread, false);
  observer.observe('a', finished, 200); observer.observe('a', finished, 3199);
  assert.equal(notices.list('a')[0].unread, false);
  observer.observe('a', finished, 3200);
  assert.equal(notices.list('a')[0].running, false); assert.equal(notices.list('a')[0].unread, true);
  const item = notices.list('a')[0]; notices.read('a', item.id, item.token);
  observer.observe('a', finished, 9000); notices.complete('a', idle.url, idle.title, item.token!);
  assert.equal(notices.list('a')[0].unread, false, 'task completion and page observer share one deduplication token'); db.close();
});

test('count is per conversation, separates accounts, and reading an old reply cannot consume a newer one', () => {
  const db = new Database(':memory:'); const notices = new ConversationNotifications(db, () => {});
  notices.complete('a', idle.url, 'A', 'first', 1); const old = notices.list('a')[0];
  notices.complete('a', idle.url, 'A', 'second', 2);
  notices.complete('a', 'https://chatgpt.com/c/b', 'B', 'third', 3);
  notices.complete('other', idle.url, 'Other', 'fourth', 4);
  assert.equal(notices.list('a').filter(item => item.unread).length, 2);
  assert.throws(() => notices.read('a', old.id, old.token), /新的回复/);
  assert.throws(() => notices.read('other', old.id, old.token), /不存在/);
  const current = notices.list('a')[0]; notices.read('a', current.id, current.token);
  assert.equal(notices.list('a').filter(item => item.unread).length, 1);
  notices.removeAccount('a'); assert.equal(notices.list().length, 1); db.close();
});

test('opening history, navigating away, errors and unsupported pages never produce completion notices', () => {
  const db = new Database(':memory:'); const notices = new ConversationNotifications(db, () => {}); const observer = new ConversationActivityObserver(notices);
  observer.observe('a', finished, 0); observer.observe('a', finished, 4000);
  assert.equal(notices.list().some(item => item.unread), false);
  observer.observe('a', generating, 5000);
  observer.observe('a', { ...finished, url: 'https://chatgpt.com/c/other' }, 6000);
  observer.observe('a', { ...finished, url: 'https://chatgpt.com/c/other' }, 10000);
  assert.equal(notices.list().some(item => item.running || item.unread), false);
  observer.observe('a', generating, 11000);
  observer.observe('a', { ...finished, error: 'Rate limited' }, 12000);
  observer.observe('a', finished, 17000);
  assert.equal(notices.list().some(item => item.unread), false);
  observer.observe('a', { ...generating, url: 'https://chatgpt.com/share/a' }, 18000);
  assert.equal(notices.list().some(item => item.running), false); db.close();
});

test('fast reply between polls counts after a known empty page; stable text alone does not complete', () => {
  const db = new Database(':memory:'); const notices = new ConversationNotifications(db, () => {}); const observer = new ConversationActivityObserver(notices);
  observer.observe('a', idle, 0); observer.observe('a', finished, 100); observer.observe('a', finished, 3100);
  assert.equal(notices.list('a')[0].unread, true);
  observer.observe('b', generating, 0);
  observer.observe('b', { ...finished, assistant: { ...finished.assistant!, terminal: false } }, 100);
  observer.observe('b', { ...finished, assistant: { ...finished.assistant!, terminal: false } }, 6000);
  assert.equal(notices.list('b')[0].running, true); assert.equal(notices.list('b')[0].unread, false); db.close();
});

test('unread receipts survive restart but stale running indicators are cleared; no prompt text is persisted', () => {
  const db = new Database(':memory:'); let notices = new ConversationNotifications(db, () => {});
  notices.complete('a', idle.url, 'Daily', replyToken(finished.user!, finished.assistant!));
  notices.running('a', idle.url, 'Daily', true);
  notices = new ConversationNotifications(db, () => {});
  assert.equal(notices.list()[0].unread, true); assert.equal(notices.list()[0].running, false);
  assert.equal(JSON.stringify(db.get('conversationNotifications')).includes('Hello'), false); db.close();
});
