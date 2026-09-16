import { AccountManager } from './account/AccountManager';
import { AgentGateway } from './agent/AgentGateway';
import { AppError, identifier, record } from './validation';
import type { PageState, WorkspaceState } from '../shared/types';
export interface BrowserAdapter {
  activate(id: string): void;
  remove(id: string): Promise<void>;
  navigate(id: string, url: unknown): Promise<void>;
  control(id: string, action: string): void;
  page(): PageState | null;
}
export class Workspace {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly accounts: AccountManager, readonly tasks: AgentGateway,
    private readonly browser: BrowserAdapter, private readonly changed: () => void,
    private readonly apiState: () => WorkspaceState['api']) {}
  state(): WorkspaceState {
    return { accounts: this.accounts.list(), activeAccountId: this.accounts.activeId(), page: this.browser.page(),
      tasks: this.tasks.listTasks(), api: this.apiState() };
  }
  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'workspace.status') return Promise.resolve(this.state());
    if (method === 'accounts.list') return Promise.resolve(this.accounts.list());
    if (method === 'tasks.list') return Promise.resolve(this.tasks.listTasks());
    if (method === 'tasks.get') return Promise.resolve(this.tasks.get(identifier(params.id)));
    const next = this.queue.then(() => this.mutate(method, params));
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async mutate(method: string, params: Record<string, unknown>): Promise<unknown> {
    let result: unknown;
    switch (method) {
      case 'accounts.create': {
        const account = this.accounts.create(params.name);
        this.accounts.activate(account.id); this.browser.activate(account.id); result = account; break;
      }
      case 'accounts.rename': result = this.accounts.rename(params.id, params.name); break;
      case 'accounts.switch': {
        const account = this.accounts.activate(params.id); this.browser.activate(account.id); result = account; break;
      }
      case 'accounts.remove': {
        const account = this.accounts.get(params.id);
        if (params.confirmName !== account.name) throw new AppError('Account name confirmation does not match');
        if (this.tasks.hasActiveTasks(account.id)) throw new AppError('Cancel and wait for active tasks before deleting this account', 409);
        await this.browser.remove(account.id);
        this.tasks.removeHistory(account.id);
        this.accounts.remove(account.id);
        const next = this.accounts.activeId();
        if (next) this.browser.activate(next);
        result = { removed: true }; break;
      }
      case 'browser.navigate': {
        const account = this.accounts.get(params.accountId); await this.browser.navigate(account.id, params.url); result = { navigated: true }; break;
      }
      case 'browser.control': {
        const account = this.accounts.get(params.accountId);
        if (typeof params.action !== 'string') throw new AppError('Missing browser action');
        this.browser.control(account.id, params.action); result = { ok: true }; break;
      }
      case 'tasks.create': result = this.tasks.createTask(this.accounts.get(params.accountId).id, record(params.input)); break;
      case 'tasks.cancel': result = this.tasks.cancel(identifier(params.id)); break;
      case 'tasks.clear': this.tasks.removeHistory(); result = { cleared: true }; break;
      default: throw new AppError('Unknown method', 404);
    }
    this.changed();
    return result;
  }
  async settled(): Promise<void> { await this.queue; }
}
