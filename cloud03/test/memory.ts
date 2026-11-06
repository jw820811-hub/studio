import type { Store, Transaction } from '../src/store.js';
export class MemoryStore implements Store {
  rows = new Map<string, object>();
  private queue = Promise.resolve();
  async get<T>(path: string) { return structuredClone(this.rows.get(path)) as T | undefined; }
  async set(path: string, value: object) { this.rows.set(path, structuredClone(value)); }
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const staged = structuredClone(this.rows);
      const value = await fn({
        get: async <V>(path: string) => structuredClone(staged.get(path)) as V | undefined,
        set: (path, row) => { staged.set(path, structuredClone(row)); },
        delete: path => { staged.delete(path); },
      });
      this.rows = staged; return value;
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  async list<T>(prefix: string, after: string | undefined, limit: number) {
    return [...this.rows].filter(([p]) => p.startsWith(prefix + '/') && !p.slice(prefix.length + 1).includes('/'))
      .map(([p, data]) => ({ id: p.slice(prefix.length + 1), data: structuredClone(data) as T }))
      .filter(r => !after || r.id > after).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
  }
}
