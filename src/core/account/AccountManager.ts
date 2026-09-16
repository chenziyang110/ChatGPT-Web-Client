export interface Account {
  id: string;
  name: string;
  partition: string;
  createdAt: number;
}

export class AccountManager {
  private accounts: Map<string, Account> = new Map();

  create(name: string): Account {
    const id = crypto.randomUUID();
    const account: Account = {
      id,
      name,
      partition: `persist:${id}`,
      createdAt: Date.now()
    };

    this.accounts.set(id, account);
    return account;
  }

  list(): Account[] {
    return Array.from(this.accounts.values());
  }

  get(id: string) {
    return this.accounts.get(id);
  }
}
