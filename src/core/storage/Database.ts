import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
type Collection = 'tasks' | 'conversations' | 'account_queues' | 'request_keys';
/** Atomic SQLite metadata store. Browser credentials stay in Chromium profiles. */
export class Database {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    const version = this.get<number>('schemaVersion');
    if (version !== undefined && ![1, 2].includes(version)) { this.db.close(); throw new Error(`Unsupported schema: ${version}`); }
    if (version === 1 && filename !== ':memory:') {
      const backup = `${filename}.v1-backup-${Date.now()}`;
      this.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
      chmodSync(backup, 0o600);
    }
    this.transaction(() => {
      for (const table of ['tasks', 'conversations', 'account_queues', 'request_keys'] as const) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS task_account ON tasks(json_extract(value, '$.accountId'))");
      this.db.exec("CREATE INDEX IF NOT EXISTS conversation_account ON conversations(json_extract(value, '$.accountId'))");
      this.set('schemaVersion', 2);
    });
  }
  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    return row ? JSON.parse(row.value as string) as T : undefined;
  }
  delete(key: string): void { this.db.prepare('DELETE FROM metadata WHERE key=?').run(key); }
  records<T>(table: Collection): T[] {
    return this.db.prepare(`SELECT value FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(row.value as string) as T);
  }
  read<T>(table: Collection, id: string): T | undefined {
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(row.value as string) as T : undefined;
  }
  write(table: Collection, id: string, value: unknown): void {
    this.db.prepare(`INSERT INTO ${table}(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(id, JSON.stringify(value));
  }
  remove(table: Collection, id: string): void { this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id); }
  removeWhere(table: Collection, field: 'accountId', value: string): void {
    this.db.prepare(`DELETE FROM ${table} WHERE json_extract(value, '$.${field}')=?`).run(value);
  }
  transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
