import type { UpdatePreparationStage } from '../shared/updates';

export interface UpdatePreparationHooks {
  isReady(): boolean;
  settled(): Promise<void>;
  isTaskRunning(): boolean;
  hasBusyPage(): Promise<boolean>;
  beginInstall(): void;
  shutdown(): void;
  stage(stage: UpdatePreparationStage): void;
  failed(message: string): void;
}

interface Preparation {
  force: boolean;
  deadline: number;
  upgraded: Promise<boolean>;
  upgrade(): void;
  pending: Promise<void>;
}

const busyMessage = '还有回复或任务正在进行，请完成后再安装，或选择强制安装。';

/** Bounds restart preflight without abandoning the local writes it must await. */
export class UpdatePreparation {
  private active?: Preparation;
  private committed = false;

  constructor(private hooks: UpdatePreparationHooks, private timeoutMs = 10000) {}

  get preparing(): boolean { return !!this.active; }

  prepare(force = false): Promise<void> {
    if (this.committed) return Promise.resolve();
    if (this.active) {
      if (force && !this.active.force) {
        this.active.force = true;
        this.active.upgrade();
      }
      return this.active.pending;
    }
    if (!this.hooks.isReady()) return Promise.reject(new Error('请先完成更新下载。'));
    if (!force && this.hooks.isTaskRunning()) return Promise.reject(new Error(busyMessage));

    let upgrade!: () => void;
    const upgraded = new Promise<boolean>(resolve => { upgrade = () => resolve(false); });
    const preparation: Preparation = {
      force, deadline: Date.now() + this.timeoutMs, upgraded, upgrade,
      pending: Promise.resolve()
    };
    this.active = preparation;
    preparation.pending = Promise.resolve().then(() => this.run(preparation)).catch(error => {
      const message = error instanceof Error ? error.message : '更新准备失败，请稍后重试。';
      this.hooks.failed(message);
      throw new Error(message);
    }).finally(() => {
      if (this.active === preparation) this.active = undefined;
    });
    return preparation.pending;
  }

  private async run(preparation: Preparation): Promise<void> {
    let stage: UpdatePreparationStage = 'settling';
    this.hooks.stage('settling');
    await this.wait(this.hooks.settled(), preparation, 'settling');
    if (!preparation.force && this.hooks.isTaskRunning()) throw new Error(busyMessage);
    if (!preparation.force) {
      stage = 'checking-replies';
      this.hooks.stage('checking-replies');
      if (!preparation.force) {
        // Upgrade wins this wait even if Chromium never answers. Its late result
        // only settles this race and cannot change a later preparation's state.
        const busy = await this.wait(Promise.race([
          this.hooks.hasBusyPage(), preparation.upgraded
        ]), preparation, 'checking-replies');
        if (!preparation.force && (busy || this.hooks.isTaskRunning())) throw new Error(busyMessage);
      }
    }
    if (Date.now() >= preparation.deadline) throw this.timeout(stage);
    this.hooks.beginInstall();
    this.hooks.shutdown();
    this.committed = true;
  }

  private timeout(stage: UpdatePreparationStage): Error {
    return new Error(stage === 'settling'
      ? '等待本地操作完成超时，更新尚未安装。请稍后重试；强制安装也需要完成本地保存。'
      : '检查网页回复超时，更新尚未安装。请重试，或确认强制安装。');
  }

  private wait<T>(promise: Promise<T>, preparation: Preparation, stage: UpdatePreparationStage): Promise<T> {
    const remaining = preparation.deadline - Date.now();
    if (remaining <= 0) {
      // The supplied operation is already running; consume a late rejection even
      // when the deadline expired before this wait was attached.
      void promise.catch(() => {});
      return Promise.reject(this.timeout(stage));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(this.timeout(stage)), remaining);
      promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }
}
