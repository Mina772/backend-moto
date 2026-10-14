import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { AlertModel, ProductModel, StockLevelModel, StockMovementModel } from '../../db/models.js';
import { checkStockForProduct, raiseAlert, resolveByKey } from '../alerts/engine.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
});
afterAll(stopTestDb);

const auth = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });
const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString();

describe('dead stock report', () => {
  it('lists products with qty > 0 and no sale in idleDays, with correct capital/cost and matching totals', async () => {
    // prod-30: old product, last sale 120 days ago in br-1, never sold in br-2 → dead in both when idleDays=90.
    await ProductModel.updateOne({ _id: 'prod-30' }, { $set: { createdAt: daysAgo(400), lastPurchaseCost: 40 } });
    await StockMovementModel.deleteMany({ productId: 'prod-30' });
    await StockLevelModel.updateMany({ productId: 'prod-30' }, { $set: { quantity: 0 } });
    await StockLevelModel.updateOne({ productId: 'prod-30', warehouseId: 'wh-2' }, { $set: { quantity: 5 } });
    await StockMovementModel.create({ _id: 'mv-dead-1', productId: 'prod-30', branchId: 'br-1', warehouseId: 'wh-2', type: 'sale', quantity: -1, previousStock: 6, newStock: 5, date: daysAgo(120), userId: 'u-admin', reference: 'test' });
    // prod-31: sold 10 days ago → not dead.
    await StockMovementModel.deleteMany({ productId: 'prod-31' });
    await StockLevelModel.updateOne({ productId: 'prod-31', warehouseId: 'wh-2' }, { $set: { quantity: 3 } });
    await StockMovementModel.create({ _id: 'mv-dead-2', productId: 'prod-31', branchId: 'br-1', warehouseId: 'wh-2', type: 'sale', quantity: -1, previousStock: 4, newStock: 3, date: daysAgo(10), userId: 'u-admin', reference: 'test' });

    const res = await api(app).get('/api/reports/dead-stock').query({ idleDays: 90, branchId: 'br-1' }).set(auth(admin));
    expect(res.status).toBe(200);
    const rows: { product: { id: string }; qtyOnHand: number; idleDays: number; unitCost: number; frozenCapital: number; carryingCost: number; suggestedAction: string }[] = res.body.rows;
    const dead = rows.find((r) => r.product.id === 'prod-30');
    expect(dead).toBeDefined();
    expect(rows.find((r) => r.product.id === 'prod-31')).toBeUndefined();
    expect(dead!.qtyOnHand).toBe(5);
    expect(dead!.idleDays).toBeGreaterThanOrEqual(120);
    expect(dead!.unitCost).toBe(40);
    expect(dead!.frozenCapital).toBe(200);
    const expectedCarrying = Math.round(200 * (res.body.annualCarryingRate / 365) * dead!.idleDays * 100) / 100;
    expect(dead!.carryingCost).toBeCloseTo(expectedCarrying, 1);
    expect(['discount', 'liquidate', 'transfer', 'return_to_supplier']).toContain(dead!.suggestedAction);

    const sumCapital = Math.round(rows.reduce((a, r) => a + r.frozenCapital, 0) * 100) / 100;
    const sumCost = Math.round(rows.reduce((a, r) => a + r.carryingCost, 0) * 100) / 100;
    expect(res.body.totals.itemCount).toBe(rows.length);
    expect(res.body.totals.frozenCapital).toBeCloseTo(sumCapital, 1);
    expect(res.body.totals.carryingCost).toBeCloseTo(sumCost, 1);
    // Sorted by frozen capital desc.
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.frozenCapital).toBeGreaterThanOrEqual(rows[i]!.frozenCapital);
  });

  it('a larger idleDays excludes the 120-day product', async () => {
    const res = await api(app).get('/api/reports/dead-stock').query({ idleDays: 365, branchId: 'br-1' }).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.rows.find((r: { product: { id: string } }) => r.product.id === 'prod-30')).toBeUndefined();
  });
});

describe('alert engine dedupe', () => {
  const base = { type: 'low_stock' as const, severity: 'warning' as const, title: { ar: 'x' }, body: { ar: 'y' }, entity: 'product' as const, entityId: 'prod-40', branchId: 'br-1', dedupeKey: 'test:dedupe:prod-40' };

  it('raiseAlert creates once per unresolved dedupeKey; resolving allows a new one', async () => {
    const a = await raiseAlert(base);
    const b = await raiseAlert(base);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(await AlertModel.countDocuments({ dedupeKey: base.dedupeKey })).toBe(1);

    await resolveByKey(base.dedupeKey);
    const c = await raiseAlert(base);
    expect(c).not.toBeNull();
    expect(await AlertModel.countDocuments({ dedupeKey: base.dedupeKey })).toBe(2);
    expect(await AlertModel.countDocuments({ dedupeKey: base.dedupeKey, resolvedAt: null })).toBe(1);
  });

  it('stock check flips out_of_stock ↔ low_stock and auto-resolves the opposite', async () => {
    await ProductModel.updateOne({ _id: 'prod-41' }, { $set: { minStock: 5, isActive: true } });
    await StockLevelModel.updateMany({ productId: 'prod-41', branchId: 'br-1' }, { $set: { quantity: 0 } });
    await AlertModel.deleteMany({ entityId: 'prod-41' });

    await checkStockForProduct('prod-41', 'br-1');
    await checkStockForProduct('prod-41', 'br-1');
    expect(await AlertModel.countDocuments({ type: 'out_of_stock', entityId: 'prod-41', resolvedAt: null })).toBe(1);

    await StockLevelModel.updateOne({ productId: 'prod-41', warehouseId: 'wh-2' }, { $set: { quantity: 3 } });
    await checkStockForProduct('prod-41', 'br-1');
    expect(await AlertModel.countDocuments({ type: 'out_of_stock', entityId: 'prod-41', resolvedAt: null })).toBe(0);
    expect(await AlertModel.countDocuments({ type: 'low_stock', entityId: 'prod-41', resolvedAt: null })).toBe(1);

    await StockLevelModel.updateOne({ productId: 'prod-41', warehouseId: 'wh-2' }, { $set: { quantity: 50 } });
    await checkStockForProduct('prod-41', 'br-1');
    expect(await AlertModel.countDocuments({ entityId: 'prod-41', resolvedAt: null })).toBe(0);
  });

  it('marking resolved via API and re-triggering creates a fresh alert', async () => {
    await StockLevelModel.updateMany({ productId: 'prod-41', branchId: 'br-1' }, { $set: { quantity: 0 } });
    await checkStockForProduct('prod-41', 'br-1');
    const total = await AlertModel.countDocuments({ type: 'out_of_stock', entityId: 'prod-41' });
    const open = await AlertModel.findOne({ type: 'out_of_stock', entityId: 'prod-41', resolvedAt: null }).lean();
    const res = await api(app).patch(`/api/alerts/${open!._id}/resolve`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(await AlertModel.countDocuments({ type: 'out_of_stock', entityId: 'prod-41', resolvedAt: null })).toBe(0);
    await checkStockForProduct('prod-41', 'br-1');
    expect(await AlertModel.countDocuments({ type: 'out_of_stock', entityId: 'prod-41' })).toBe(total + 1);
    expect(await AlertModel.countDocuments({ type: 'out_of_stock', entityId: 'prod-41', resolvedAt: null })).toBe(1);
  });
});
