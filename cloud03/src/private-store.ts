import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Store, Transaction } from './store.js';

// Encrypt server credentials and audit snapshots before storing in Firestore.
// The Secret Manager key must never be shipped to the website or committed.
export class PrivateStore implements Store {
  constructor(private inner: Store, private key: Buffer) {
    if (key.length !== 32) throw Error('CLOUD03_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  private encode(path: string, value: object) {
    if (!path.startsWith('_cloud03_private/')) return value;
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(path));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') };
  }
  private decode<T>(path: string, value: unknown): T | undefined {
    if (!value || !path.startsWith('_cloud03_private/')) return value as T | undefined;
    const sealed = value as { v: number; iv: string; tag: string; data: string };
    if (sealed.v !== 1) throw Error('Invalid encrypted record');
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(sealed.iv, 'base64'));
    cipher.setAAD(Buffer.from(path)); cipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(sealed.data, 'base64')), cipher.final()]).toString()) as T;
  }
  async get<T>(path: string) { return this.decode<T>(path, await this.inner.get(path)); }
  set(path: string, value: object) { return this.inner.set(path, this.encode(path, value)); }
  transaction<T>(action: (tx: Transaction) => Promise<T>) {
    return this.inner.transaction(tx => action({
      get: async <V>(path: string) => this.decode<V>(path, await tx.get(path)),
      set: (path, value) => tx.set(path, this.encode(path, value)),
      delete: path => tx.delete(path),
    }));
  }
  list<T>(collection: string, after: string | undefined, limit: number) {
    if (collection.startsWith('_cloud03_private')) throw Error('Private listing is disabled');
    return this.inner.list<T>(collection, after, limit);
  }
}
