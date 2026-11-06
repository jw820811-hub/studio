import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { RecordService, recordPath, type Envelope } from '../src/records.js';
import { PrivateStore } from '../src/private-store.js';
import { MemoryStore } from './memory.js';
const stamp = '2026-11-06T04:00:00.000Z';
const paper: Envelope = { kind: 'papers', value: { id: 'paper-1', title: '測試稿件', status: '已投稿', updatedAt: stamp,
  files: [{ id: 'file-1', path: 'users/a/files/file-1', name: 'private.docx' }], authors: '私人聯絡資料', expenses: [{ amount: 123 }] } };

test('account isolation, traversal rejection and limited projections', async () => {
  const store = new MemoryStore(), records = new RecordService(store);
  await store.set(recordPath('a', 'papers', 'paper-1'), paper);
  assert.equal((await records.search('b', {})).records.length, 0);
  await assert.rejects(records.get('b', 'papers', 'paper-1'));
  assert.throws(() => recordPath('a/records/x', 'papers', 'paper-1'));
  assert.throws(() => recordPath('a', 'papers', '../paper-1'));
  const result = await records.get('a', 'papers', 'paper-1');
  assert.equal(result.attachmentCount, 1);
  assert.equal(result.value.files, undefined); assert.equal(result.value.authors, undefined); assert.equal(result.value.expenses, undefined);
});
test('paper update retains attachments and unknown website fields; stale writes fail', async () => {
  const store = new MemoryStore(), records = new RecordService(store, () => stamp);
  await store.set(recordPath('a', 'papers', 'paper-1'), paper);
  const updated = await records.updatePaper('a', randomUUID(), 'paper-1', stamp, { status: '修改中', revisionDue: '2026-12-01' });
  assert.equal(updated.value.updatedAt, '2026-11-06T04:00:00.001Z');
  const saved = await store.get<Envelope>(recordPath('a', 'papers', 'paper-1'));
  assert.deepEqual(saved?.value.files, paper.value.files); assert.deepEqual(saved?.value.expenses, paper.value.expenses);
  await assert.rejects(records.updatePaper('a', randomUUID(), 'paper-1', stamp, { status: '已通過' }), /版本已變更/);
  assert.equal([...store.rows.keys()].filter(p => p.includes('/op_')).length, 1);
});
test('concurrent duplicate create applies once and rejects mismatched idempotency payload', async () => {
  const store = new MemoryStore(), records = new RecordService(store), requestId = randomUUID();
  const result = await Promise.all([records.createTask('a', requestId, { title: '修回' }), records.createTask('a', requestId, { title: '修回' })]);
  assert.equal(result[0].value.id, result[1].value.id); assert.equal(result[1].alreadyApplied, true);
  assert.equal((await records.search('a', {})).records.length, 1);
  await assert.rejects(records.createTask('a', requestId, { title: '不同內容' }), /requestId/);
});
test('same requestId is scoped to each user and cannot move a record between users', async () => {
  const store = new MemoryStore(), records = new RecordService(store), id = randomUUID();
  const a = await records.createTask('a', id, { title: 'A' }), b = await records.createTask('b', id, { title: 'B' });
  assert.notEqual(a.value.id, b.value.id); assert.equal((await records.search('b', {})).records[0].value.title, 'B');
});
test('event dates, cross-midnight time and strict write allowlists', () => {
  const records = new RecordService(new MemoryStore());
  assert.throws(() => records.createEvent('a', randomUUID(), { title: 'x', date: '2026-02-30' }));
  assert.throws(() => records.createEvent('a', randomUUID(), { title: 'x', date: '2026-11-06', time: '23:00', endTime: '00:00' }));
  assert.throws(() => records.createEvent('a', randomUUID(), { title: 'x', date: '2026-11-06', kind: '課表' }));
  assert.throws(() => records.createTask('a', randomUUID(), { title: 'x', uid: 'b' }));
  assert.throws(() => records.updatePaper('a', randomUUID(), 'paper-1', stamp, { files: [] }));
});
test('cross-day single event and task completion preserve website format', async () => {
  const store = new MemoryStore(), records = new RecordService(store, () => stamp);
  const e = await records.createEvent('a', randomUUID(), { title: 'x', date: '2026-11-06', time: '23:00', endDate: '2026-11-07', endTime: '00:00' });
  assert.equal(e.value.repeat, '不重複');
  assert.equal(e.value.reminderPreset, '不提醒');
  const task = await records.createTask('a', randomUUID(), { title: '待辦' });
  const done = await records.completeTask('a', randomUUID(), String(task.value.id), String(task.value.updatedAt), true);
  assert.equal(done.value.done, true);
});
test('empty filtered pages preserve cursor; deleted and unrelated record kinds are excluded', async () => {
  const store = new MemoryStore(), records = new RecordService(store);
  for (let i = 0; i < 201; i++) await store.set(`users/a/records/authors__${String(i).padStart(3, '0')}`, { kind: 'authors', value: { id: String(i) } });
  await store.set(recordPath('a', 'papers', 'paper-1'), paper);
  await store.set(recordPath('a', 'tasks', 'deleted'), { kind: 'tasks', value: { id: 'deleted', deletedAt: stamp } });
  const first = await records.search('a', { kind: 'papers' });
  assert.deepEqual(first.records, []); assert.ok(first.nextCursor);
  const second = await records.search('a', { kind: 'papers', cursor: first.nextCursor });
  assert.equal(second.records.length, 1); assert.equal(second.nextCursor, null);
});
test('private credentials and audit snapshots are encrypted and bound to their document path', async () => {
  const raw = new MemoryStore(), store = new PrivateStore(raw, randomBytes(32));
  await store.set('_cloud03_private/test', { secret: 'hidden-value' });
  assert.equal(JSON.stringify(raw.rows.get('_cloud03_private/test')).includes('hidden-value'), false);
  assert.deepEqual(await store.get('_cloud03_private/test'), { secret: 'hidden-value' });
  raw.rows.set('_cloud03_private/other', raw.rows.get('_cloud03_private/test')!);
  await assert.rejects(store.get('_cloud03_private/other'));
  await store.set('users/a/records/papers__paper-1', paper);
  assert.deepEqual(raw.rows.get('users/a/records/papers__paper-1'), paper);
});
