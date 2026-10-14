import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { PriceHistoryModel, ProductModel } from '../../db/models.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
let warehouse: Awaited<ReturnType<typeof loginAs>>;
let cashier: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  warehouse = await loginAs(app, 'warehouse1');
  cashier = await loginAs(app, 'cashier1');
});
afterAll(stopTestDb);

const auth = (who: { token: string }) => ({ Authorization: `Bearer ${who.token}` });

describe('role boundaries on product pricing', () => {
  it('a stock clerk may move a product but must not change its selling price', async () => {
    const before = await ProductModel.findById('prod-6').lean();
    const res = await api(app)
      .patch('/api/products/prod-6')
      .set(auth(warehouse))
      .send({ prices: { retail1: before!.prices.retail1 + 500 } });
    expect(res.status).toBe(403);

    const after = await ProductModel.findById('prod-6').lean();
    expect(after!.prices.retail1).toBe(before!.prices.retail1);
  });

  it('a stock clerk must not change the cost price either', async () => {
    const before = await ProductModel.findById('prod-6').lean();
    const res = await api(app).patch('/api/products/prod-6').set(auth(warehouse)).send({ purchasePrice: before!.purchasePrice + 100 });
    expect(res.status).toBe(403);
    expect((await ProductModel.findById('prod-6').lean())!.purchasePrice).toBe(before!.purchasePrice);
  });

  it('a stock clerk can still edit non-price fields', async () => {
    const res = await api(app).patch('/api/products/prod-6').set(auth(warehouse)).send({ minStock: 42 });
    expect(res.status).toBe(200);
    expect((await ProductModel.findById('prod-6').lean())!.minStock).toBe(42);
  });

  it('a manager with prices.edit can change the price and it lands in the history', async () => {
    const before = await ProductModel.findById('prod-7').lean();
    const res = await api(app).patch('/api/products/prod-7').set(auth(admin)).send({ prices: { retail1: before!.prices.retail1 + 10 } });
    expect(res.status).toBe(200);
    const entry = await PriceHistoryModel.findOne({ productId: 'prod-7', field: 'retail1' }).sort({ date: -1 }).lean();
    expect(entry!.newValue).toBe(before!.prices.retail1 + 10);
  });

  it('a cashier cannot touch products at all', async () => {
    expect((await api(app).patch('/api/products/prod-6').set(auth(cashier)).send({ minStock: 5 })).status).toBe(403);
    expect((await api(app).post('/api/products/bulk').set(auth(cashier)).send({ ids: ['prod-6'], patch: { prices: { retail1: 1 } } })).status).toBe(403);
  });

  it('a stock clerk cannot smuggle a price change through the bulk route', async () => {
    const before = await ProductModel.findById('prod-8').lean();
    const res = await api(app).post('/api/products/bulk').set(auth(warehouse)).send({ ids: ['prod-8'], patch: { prices: { wholesale: 1 } } });
    expect(res.status).toBe(403);
    expect((await ProductModel.findById('prod-8').lean())!.prices.wholesale).toBe(before!.prices.wholesale);
  });

  it('refuses a manufacturer barcode that another product already uses', async () => {
    const taken = await ProductModel.findOne({ legacyBarcode: { $nin: [null, ''] } }).lean();
    expect(taken).toBeTruthy();

    const created = await api(app).post('/api/products').set(auth(admin)).send({
      name: { ar: 'صنف بباركود مكرر' },
      sku: 'SKU-DUP-001',
      brandId: 'brand-1',
      categoryId: 'cat-1',
      supplierId: 'sup-1',
      purchasePrice: 10,
      prices: { retail1: 20, retail2: 18, wholesale: 15 },
      unit: { ar: 'قطعة' },
      legacyBarcode: taken!.legacyBarcode,
    });
    expect(created.status).toBe(409);
    expect(created.body.error.code).toBe('BARCODE_EXISTS');
    expect(await ProductModel.exists({ sku: 'SKU-DUP-001' })).toBeNull();

    const patched = await api(app).patch('/api/products/prod-9').set(auth(admin)).send({ legacyBarcode: taken!.legacyBarcode });
    expect(patched.status).toBe(409);
  });

  it('allows a product to keep its own manufacturer barcode on update', async () => {
    const p = await ProductModel.findOne({ legacyBarcode: { $nin: [null, ''] } }).lean();
    const res = await api(app).patch(`/api/products/${p!._id}`).set(auth(admin)).send({ legacyBarcode: p!.legacyBarcode, minStock: 11 });
    expect(res.status).toBe(200);
  });

  it('price history has no route that rewrites or deletes it', async () => {
    const entry = await PriceHistoryModel.findOne().lean();
    for (const method of ['patch', 'put', 'delete'] as const) {
      const res = await api(app)[method](`/api/products/price-history/${entry!._id}`).set(auth(admin)).send({ newValue: 0 });
      expect(res.status).toBe(404);
    }
    expect(await PriceHistoryModel.findById(entry!._id).lean()).toBeTruthy();
  });
});
