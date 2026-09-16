export class Database {
  private data = new Map<string, unknown>();

  set(key: string, value: unknown) {
    this.data.set(key, value);
  }

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
}
