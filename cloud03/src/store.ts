import { FieldPath, type Firestore, type Transaction as FirebaseTransaction } from 'firebase-admin/firestore';

export interface Transaction {
  get<T>(path: string): Promise<T | undefined>;
  set(path: string, value: object): void;
  delete(path: string): void;
}
export interface Store {
  get<T>(path: string): Promise<T | undefined>;
  set(path: string, value: object): Promise<void>;
  transaction<T>(action: (tx: Transaction) => Promise<T>): Promise<T>;
  list<T>(collection: string, after: string | undefined, limit: number): Promise<Array<{ id: string; data: T }>>;
}
export class FirestoreStore implements Store {
  constructor(private db: Firestore) {}
  async get<T>(path: string) { return (await this.db.doc(path).get()).data() as T | undefined; }
  async set(path: string, value: object) { await this.db.doc(path).set(value); }
  transaction<T>(action: (tx: Transaction) => Promise<T>) {
    return this.db.runTransaction((tx: FirebaseTransaction) => action({
      get: async <V>(path: string) => (await tx.get(this.db.doc(path))).data() as V | undefined,
      set: (path, value) => { tx.set(this.db.doc(path), value); },
      delete: path => { tx.delete(this.db.doc(path)); },
    }));
  }
  async list<T>(collection: string, after: string | undefined, limit: number) {
    let query = this.db.collection(collection).orderBy(FieldPath.documentId()).limit(limit);
    if (after) query = query.startAfter(after);
    return (await query.get()).docs.map(doc => ({ id: doc.id, data: doc.data() as T }));
  }
}
