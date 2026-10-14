import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { ProductModel, StockLevelModel, WarehouseModel, stockLevelId } from '../../db/models.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
let cashier: Awaited<ReturnType<typeof loginAs>>;
let branchId: string;
let warehouseId: string;

const PRODUCT = 'prod-1';

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  cashier = await loginAs(app, 'cashier1');
  branchId = cashier.user.branchId;
  const wh = await WarehouseModel.findOne({ branchId, isActive: true }).lean();
  warehouseId = wh!._id;
  // The shown shelf is the one holding the most stock, so park the branch's stock in a single warehouse.
  await StockLevelModel.updateMany({ productId: PRODUCT, branchId }, { $set: { quantity: 0, locationCode: '', shelf: '', bin: '' } });
  await StockLevelModel.updateOne(
    { productId: PRODUCT, warehouseId },
    { $set: { branchId, quantity: 25, locationCode: 'A', shelf: 'A3', bin: 'A3-04' } },
    { upsert: true },
  );
});
afterAll(stopTestDb);

const auth = (who: { token: string }) => ({ Authorization: `Bearer ${who.token}` });

describe('product location in POS', () => {
  it('returns the shelf when a cashier scans the internal barcode', async () => {
    const product = await ProductModel.findById(PRODUCT).lean();
    const res = await api(app).get(`/api/products/lookup?term=${product!.internalBarcode}`).set(auth(cashier));
    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe(PRODUCT);
    expect(res.body[0].location).toBe('A · A3 · A3-04');
  });

  it('returns the shelf when searching by name', async () => {
    const product = await ProductModel.findById(PRODUCT).lean();
    const res = await api(app).get(`/api/products/lookup?term=${encodeURIComponent(product!.name.ar.slice(0, 6))}`).set(auth(cashier));
    expect(res.status).toBe(200);
    const hit = (res.body as { id: string; location?: string }[]).find((p) => p.id === PRODUCT);
    expect(hit?.location).toBe('A · A3 · A3-04');
  });

  it('scopes the shelf to the requested branch', async () => {
    const other = await WarehouseModel.findOne({ branchId: { $ne: branchId }, isActive: true }).lean();
    await StockLevelModel.updateMany({ productId: PRODUCT, branchId: other!.branchId }, { $set: { quantity: 0, locationCode: '', shelf: '', bin: '' } });
    await StockLevelModel.updateOne(
      { productId: PRODUCT, warehouseId: other!._id },
      { $set: { branchId: other!.branchId, quantity: 5, locationCode: 'B', shelf: 'B1', bin: 'B1-09' } },
      { upsert: true },
    );

    const mine = await api(app).get(`/api/products/${PRODUCT}?branchId=${branchId}`).set(auth(cashier));
    expect(mine.body.location).toBe('A · A3 · A3-04');

    const theirs = await api(app).get(`/api/products/all?branchId=${other!.branchId}`).set(auth(admin));
    const row = (theirs.body as { id: string; location?: string }[]).find((p) => p.id === PRODUCT);
    expect(row?.location).toBe('B · B1 · B1-09');
  });

  it('reflects a location change immediately', async () => {
    const res = await api(app)
      .patch(`/api/products/${PRODUCT}`)
      .set(auth(admin))
      .send({ placement: { warehouseId, locationCode: 'A', shelf: 'A1', bin: '' } });
    expect(res.status).toBe(200);

    const after = await api(app).get(`/api/products/${PRODUCT}?branchId=${branchId}`).set(auth(cashier));
    expect(after.body.location).toBe('A · A1');
  });

  it('omits the location rather than inventing one when no shelf is set', async () => {
    await StockLevelModel.updateMany({ productId: 'prod-2' }, { $set: { locationCode: '', shelf: '', bin: '' } });
    const res = await api(app).get(`/api/products/prod-2?branchId=${branchId}`).set(auth(cashier));
    expect(res.body.location).toBeUndefined();
  });
});

describe('location in alternative suggestions', () => {
  it('uses one warehouse for sync, checkout availability and sale deduction', async () => {
    const { salesWarehouseFor } = await import('../inventory/stock.js');
    const shopId = await salesWarehouseFor(branchId);
    const other = await WarehouseModel.findOne({ branchId, _id: { $ne: shopId }, isActive: true }).lean();
    expect(other).toBeTruthy();
    const id = 'prod-4';
    await StockLevelModel.updateMany({ productId: id, branchId }, { $set: { quantity: 0 } });
    for (const [warehouse, quantity] of [[shopId, 2], [other!._id, 100]] as const) {
      await StockLevelModel.updateOne({ _id: stockLevelId(id, warehouse) }, { $set: { productId: id, branchId, warehouseId: warehouse, quantity, reserved: 0 } }, { upsert: true });
    }
    const snapshot = await api(app).get('/api/sync/bootstrap').query({ branchId }).set(auth(cashier));
    expect(snapshot.body.salesWarehouseId).toBe(shopId);
    const detail = await api(app).get(`/api/products/${id}`).set(auth(cashier));
    expect(detail.body.saleStock).toBe(2);
    expect(detail.body.totalStock).toBe(102);
    const created = await api(app).post('/api/sales').set(auth(cashier)).send({ branchId, items: [{ productId: id, name: detail.body.name, quantity: 1, unitPrice: detail.body.prices.retail1, priceTier: 'retail1' }], payments: [{ method: 'cash', amount: 10000 }], type: 'cash' });
    expect(created.status).toBe(201);
    expect((await StockLevelModel.findById(stockLevelId(id, shopId)).lean())!.quantity).toBe(1);
    expect((await StockLevelModel.findById(stockLevelId(id, other!._id)).lean())!.quantity).toBe(100);
  });
  it('includes the shelf of each in-stock alternative', async () => {
    const { salesWarehouseFor } = await import('../inventory/stock.js');
    const saleWarehouseId = await salesWarehouseFor(branchId);
    const base = await ProductModel.findById(PRODUCT).lean();
    const alt = await ProductModel.findOne({ _id: { $ne: PRODUCT }, categoryId: base!.categoryId, deletedAt: null }).lean();
    expect(alt).toBeTruthy();

    await ProductModel.updateOne({ _id: PRODUCT }, { $addToSet: { alternativeProductIds: alt!._id } });
    await StockLevelModel.updateMany({ productId: alt!._id, branchId }, { $set: { quantity: 0, locationCode: '', shelf: '', bin: '' } });
    await StockLevelModel.updateOne(
      { productId: alt!._id, warehouseId: saleWarehouseId },
      { $set: { branchId, quantity: 12, locationCode: 'C', shelf: 'C2', bin: 'C2-07' } },
      { upsert: true },
    );

    const res = await api(app).get(`/api/products/${PRODUCT}/alternatives?branchId=${branchId}`).set(auth(cashier));
    expect(res.status).toBe(200);
    const hit = (res.body as { product: { id: string }; location?: string }[]).find((s) => s.product.id === alt!._id);
    expect(hit).toBeDefined();
    expect(hit!.location).toBe('C · C2 · C2-07');
  });
});
