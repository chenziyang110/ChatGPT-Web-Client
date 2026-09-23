export interface ConversationMessage { id: string; role: string; text: string; terminal: boolean; hasContent?: boolean }

const stableId = (message: ConversationMessage) => !!message.id && !message.id.startsWith('position:');
const changed = (detail: string): never => { throw new Error(`CONVERSATION_CHANGED: ${detail}`); };

// ChatGPT may unmount the beginning of a long conversation after sending.
// Match the recent history by stable message IDs, not DOM array positions. The
// new user turn must first follow our last pre-send anchor; once acknowledged,
// its exact ID and content remain mandatory even if every older turn unmounts.
export class ReplyTurnTracker {
  private readonly history: ConversationMessage[];
  private ownId?: string;
  constructor(messages: ConversationMessage[], private readonly prompt: string) {
    this.history = messages.filter(message => message.role === 'user').map(message => ({ ...message }));
  }
  private same(actual: ConversationMessage, expected: ConversationMessage): void {
    if (actual.id !== expected.id) changed('prior user identity or order changed');
    if (actual.text !== expected.text) changed('prior user content changed');
  }
  private historyBeforeOwn(visible: ConversationMessage[]): void {
    if (visible.length === this.history.length && visible.every((message, index) => message.id === this.history[index].id)) {
      visible.forEach((message, index) => this.same(message, this.history[index]));
      return;
    }
    if (!this.history.every(stableId) || !visible.every(stableId)) changed('history moved without stable message IDs');
    if (!visible.length) return;
    const firstKnown = visible.findIndex(message => this.history.some(old => old.id === message.id));
    if (firstKnown < 0) changed('recent history anchor is missing');
    const start = this.history.findIndex(message => message.id === visible[firstKnown].id);
    // Earlier history may mount before the entire known sequence, or an old
    // prefix may unmount. Missing/replaced turns inside that sequence are not OK.
    if (firstKnown > 0 && start > 0) changed('history is not contiguous');
    const overlap = visible.slice(firstKnown);
    const expected = this.history.slice(start);
    if (overlap.length !== expected.length) changed('prior user sequence changed');
    overlap.forEach((message, index) => this.same(message, expected[index]));
  }
  private waitingHistory(visible: ConversationMessage[]): void {
    if (!visible.length) return;
    const start = this.history.findIndex(message => message.id === visible[0].id);
    if (start < 0 || start + visible.length > this.history.length) changed('submitted turn or recent history anchor is missing');
    if ((start > 0 || visible.length !== this.history.length) && (!visible.every(stableId) || !this.history.every(stableId))) changed('history moved without stable message IDs');
    visible.forEach((message, index) => this.same(message, this.history[start + index]));
  }
  read(messages: ConversationMessage[]): ConversationMessage | undefined {
    const users = messages.filter(message => message.role === 'user');
    if (new Set(users.map(message => message.id)).size !== users.length) changed('duplicate user message identities');
    let own: ConversationMessage | undefined;
    if (this.ownId !== undefined) {
      const index = users.findIndex(message => message.id === this.ownId);
      if (index < 0) { this.waitingHistory(users); return; }
      if (index !== users.length - 1) changed('additional user turn appeared');
      if (!stableId(users[index]) && index !== this.history.length) changed('submitted turn moved without a stable message ID');
      this.historyBeforeOwn(users.slice(0, index));
      own = users[index];
    } else if (!this.history.length) {
      if (users.length > 1) changed('additional user turn appeared');
      own = users[0];
    } else {
      const anchor = users.findIndex(message => message.id === this.history.at(-1)!.id);
      if (anchor < 0) { this.waitingHistory(users); return; }
      this.historyBeforeOwn(users.slice(0, anchor + 1));
      if (users.length > anchor + 2) changed('additional user turn appeared');
      const candidate = users[anchor + 1];
      if (candidate && this.history.some(message => message.id === candidate.id)) changed('prior user order changed');
      own = candidate;
    }
    if (own) {
      if (own.text.replace(/\r\n?/g, '\n') !== this.prompt.replace(/\r\n?/g, '\n').trim()) changed('submitted turn does not match');
      this.ownId = own.id;
    }
    return own;
  }
}
