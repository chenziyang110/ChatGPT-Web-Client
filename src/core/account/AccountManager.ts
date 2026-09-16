import { randomUUID } from 'node:crypto';
import { Database } from '../storage/Database';
import { AppError, identifier, text } from '../validation';
import type { Account } from '../../shared/types';
export type { Account } from '../../shared/types';
export class AccountManager {
  constructor(private readonly db: Database) {}
  list(): Account[] { return this.db.get<Account[]>('accounts') ?? []; }
  get(value: unknown): Account {
    const id = identifier(value);
    const account = this.list().find(account => account.id === id);
    if (!account) throw new AppError('Account not found', 404);
    return account;
  }
  resolve(value: unknown): Account {
    const reference = text(value, 'Account', 100);
    const byId = this.list().find(account => account.id === reference);
    if (byId) return byId;
    const matches = this.list().filter(account => account.alias?.toLowerCase() === reference.toLowerCase() || account.name === reference);
    if (matches.length !== 1) throw new AppError(matches.length ? 'Account name is ambiguous; use its ID' : 'Account not found', 404);
    return matches[0];
  }
  setAlias(id: unknown, value: unknown): Account {
    const alias = text(value, 'Account alias', 60);
    if (!/^[\p{L}\p{N}_-]+$/u.test(alias)) throw new AppError('Alias may contain letters, numbers, underscores and hyphens');
    const account = this.get(id);
    if (this.list().some(other => other.id !== account.id && (other.alias?.toLowerCase() === alias.toLowerCase() || other.name === alias))) throw new AppError('Account alias already exists', 409);
    const next = { ...account, alias };
    this.db.set('accounts', this.list().map(other => other.id === account.id ? next : other));
    return next;
  }
  create(value: unknown): Account {
    const name = text(value, 'Account name', 60);
    const accounts = this.list();
    if (accounts.length >= 20) throw new AppError('A maximum of 20 accounts is supported');
    const id = randomUUID();
    const account = { id, name, partition: `persist:account-${id}`, createdAt: Date.now() };
    this.db.set('accounts', [...accounts, account]);
    return account;
  }
  rename(id: unknown, value: unknown): Account {
    const account = { ...this.get(id), name: text(value, 'Account name', 60) };
    this.db.set('accounts', this.list().map(item => item.id === account.id ? account : item));
    return account;
  }
  remove(id: unknown): void {
    const account = this.get(id);
    this.db.transaction(() => {
      this.db.set('accounts', this.list().filter(item => item.id !== account.id));
      this.db.delete(`session:${account.id}`);
      if (this.activeId() === account.id) this.db.set('activeAccountId', this.list()[0]?.id ?? null);
    });
  }
  activeId(): string | null { return this.db.get<string | null>('activeAccountId') ?? null; }
  activate(id: unknown): Account {
    const account = this.get(id);
    this.db.set('activeAccountId', account.id);
    return account;
  }
}
