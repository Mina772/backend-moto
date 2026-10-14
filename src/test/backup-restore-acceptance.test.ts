import { afterAll, beforeAll, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { BSON } from 'mongodb';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTestDb, stopTestDb } from './harness.js';
import { planThreeTierPrices } from '../db/migrations/price-plan.js';
const folder = mkdtempSync(path.join(tmpdir(), 'moto-backup-audit-'));
beforeAll(async () => { await startTestDb({ seed: true }); });
afterAll(stopTestDb);
it('writes and restores a BSON logical backup of disposable fixtures including financial documents and indexes', async () => {
  const source = mongoose.connection.db!;
  expect(source.databaseName).toBe('moto-test');
  const archive = [];
  for (const collection of await source.listCollections().toArray()) {
    const rows = await source.collection(collection.name).find().toArray();
    const indexes = await source.collection(collection.name).listIndexes().toArray();
    archive.push({ name: collection.name, rows, indexes });
  }
  const file = path.join(folder, 'synthetic-backup.bson'); writeFileSync(file, BSON.serialize({ collections: archive }));
  const restored = BSON.deserialize(readFileSync(file)).collections as typeof archive;
  const destination = mongoose.connection.getClient().db(`moto-audit-restore-${randomUUID()}`);
  try {
    for (const collection of restored) {
      await destination.createCollection(collection.name);
      if (collection.rows.length) await destination.collection(collection.name).insertMany(collection.rows);
      for (const index of collection.indexes) if (index.name !== '_id_') {
        const { v: _version, ns: _namespace, key, ...options } = index;
        void _version; void _namespace;
        await destination.collection(collection.name).createIndex(key, options);
      }
      const hash = (rows: unknown[]) => createHash('sha256').update(BSON.serialize({ rows })).digest('hex');
      expect(hash(await destination.collection(collection.name).find().sort({ _id: 1 }).toArray())).toBe(hash(await source.collection(collection.name).find().sort({ _id: 1 }).toArray()));
      expect((await destination.collection(collection.name).listIndexes().toArray()).map(i => ({ key: i.key, unique: Boolean(i.unique) }))).toEqual(collection.indexes.map(i => ({ key: i.key, unique: Boolean(i.unique) })));
    }
    const sum = async (db: typeof source, name: string, field: string) => (await db.collection(name).aggregate([{ $group: { _id: null, sum: { $sum: `$${field}` } } }]).toArray())[0]?.sum ?? 0;
    for (const [name, field] of [['sales', 'total'], ['customerdebts', 'remaining'], ['purchases', 'remaining'], ['customerpayments', 'amount'], ['supplierpayments', 'amount'], ['stocklevels', 'quantity']]) expect(await sum(destination, name, field)).toBe(await sum(source, name, field));
  } finally { await destination.dropDatabase(); }
});
it('applies the reviewed additive price mapping only to a disposable legacy fixture and verifies repeat safety', async () => {
  const collection = mongoose.connection.db!.collection('audit_legacy_prices');
  await collection.insertMany([{ _id: 'legacy' as never, retailPrice: 100, wholesalePrice: 80 }, { _id: 'current' as never, prices: { retail1: 100, retail2: 95, wholesale: 80 } }]);
  for await (const row of collection.find()) {
    const plan = planThreeTierPrices(row);
    if (plan.status === 'planned') await collection.updateOne({ _id: row._id, prices: { $exists: false } }, { $set: { prices: plan.prices } });
  }
  const rows = await collection.find().toArray();
  expect(rows.every(row => planThreeTierPrices(row).status === 'unchanged')).toBe(true);
  expect(rows.find(row => String(row._id) === 'legacy')).toMatchObject({ retailPrice: 100, wholesalePrice: 80, prices: { retail1: 100, retail2: 100, wholesale: 80 } });
  expect(rows.find(row => String(row._id) === 'current')).toMatchObject({ prices: { retail2: 95 } });
});
