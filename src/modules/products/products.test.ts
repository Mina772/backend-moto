import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Warehouse } from '@moto/shared';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { ProductModel, StockLevelModel, WarehouseModel } from '../../db/models.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
let wh: Warehouse & { _id: string };

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  const all = (await WarehouseModel.find({ isActive: true }).lean()) as unknown as (Warehouse & { _id: string })[];
  wh = all.find((w) => w.locations.length > 1 && w.locations[1]!.shelves.length > 1)!;
});
afterAll(stopTestDb);

const auth = () => ({ Authorization: `Bearer ${admin.token}` });
const base = (sku: string) => ({
  name: { ar: 'منتج برف' },
  sku,
  partNumber: 'SHELF-1',
  brandId: 'brand-1',
  categoryId: 'cat-2',
  supplierId: 'sup-1',
  purchasePrice: 10,
  prices: { retail1: 20, retail2: 18, wholesale: 15 },
  unit: { ar: 'قطعة' },
});

describe('product shelf placement', () => {
  it('stores the chosen shelf/bin on the warehouse stock level when creating', async () => {
    const loc = wh.locations[1]!;
    const shelf = loc.shelves[1]!;
    const bin = shelf.bins[0]!;
    const res = await api(app).post('/api/products').set(auth()).send({ ...base('SKU-SHELF-001'), placement: { warehouseId: wh._id, locationCode: loc.code, shelf: shelf.code, bin: bin.code } });
    expect(res.status).toBe(201);
    const level = await StockLevelModel.findOne({ productId: res.body.id, warehouseId: wh._id }).lean();
    expect(level).toMatchObject({ locationCode: loc.code, shelf: shelf.code, bin: bin.code, quantity: 0 });
    const others = await StockLevelModel.find({ productId: res.body.id, warehouseId: { $ne: wh._id } }).lean();
    expect(others.every((l) => l.shelf === 'A1')).toBe(true);
  });

  it('rejects a shelf that is not part of the warehouse structure without creating the product', async () => {
    const res = await api(app).post('/api/products').set(auth()).send({ ...base('SKU-SHELF-002'), placement: { warehouseId: wh._id, locationCode: wh.locations[0]!.code, shelf: 'NOPE-9' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_PLACEMENT');
    expect(await ProductModel.exists({ sku: 'SKU-SHELF-002' })).toBeNull();
  });

  it('moves the product to another shelf on update', async () => {
    const created = await api(app).post('/api/products').set(auth()).send(base('SKU-SHELF-003'));
    expect(created.status).toBe(201);
    const loc = wh.locations[0]!;
    const shelf = loc.shelves[loc.shelves.length - 1]!;
    const res = await api(app).patch(`/api/products/${created.body.id}`).set(auth()).send({ placement: { warehouseId: wh._id, locationCode: loc.code, shelf: shelf.code } });
    expect(res.status).toBe(200);
    const level = await StockLevelModel.findOne({ productId: created.body.id, warehouseId: wh._id }).lean();
    expect(level).toMatchObject({ locationCode: loc.code, shelf: shelf.code, bin: '' });
  });
});
