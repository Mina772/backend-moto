import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { PriceHistoryModel, ProductModel, SaleModel, UserModel } from '../../db/models.js';

let app: Express;
let cashier: Awaited<ReturnType<typeof loginAs>>;
let sales: Awaited<ReturnType<typeof loginAs>>;
let admin: Awaited<ReturnType<typeof loginAs>>;
beforeAll(async () => {
  app = await startTestDb({ seed: true });
  cashier = await loginAs(app, 'cashier1');
  sales = await loginAs(app, 'nour.h');
  admin = await loginAs(app, 'admin');
});
afterAll(stopTestDb);
const auth = (who: { token: string }) => ({ Authorization: `Bearer ${who.token}` });

describe('permissions across alternative routes', () => {
  it('hides costs in search, including nested invoice items', async () => {
    const product = await ProductModel.findById('prod-1').lean();
    const result = await api(app).get('/api/search').query({ term: product!.sku }).set(auth(cashier));
    expect(result.status).toBe(200);
    expect(result.body.products.length).toBeGreaterThan(0);
    expect(result.body.products[0].purchasePrice).toBe(0);
    expect(result.body.products[0].lastPurchaseCost).toBe(0);
    const invoice = await SaleModel.findOne({ branchId: cashier.user.branchId, status: 'completed' }).lean();
    const search = await api(app).get('/api/search').query({ term: invoice!.invoiceNumber }).set(auth(cashier));
    expect(search.body.sales.length).toBeGreaterThan(0);
    expect(search.body.sales[0].items.every((item: { unitCost: number }) => item.unitCost === 0)).toBe(true);
    const detail = await api(app).get(`/api/sales/${invoice!._id}`).set(auth(cashier));
    expect(detail.body.items.every((item: { unitCost: number }) => item.unitCost === 0)).toBe(true);
    const authorized = await api(app).get(`/api/sales/${invoice!._id}`).set(auth(admin));
    expect(authorized.body.items.some((item: { unitCost: number }) => item.unitCost > 0)).toBe(true);
  });
  it('keeps a user without supplier permission out of supplier search', async () => {
    const result = await api(app).get('/api/search').query({ term: 'ا' }).set(auth(cashier));
    expect(result.body.suppliers).toEqual([]);
  });
  it('hides financial fields in reports even if the caller bypasses the UI', async () => {
    const from = new Date(Date.now() - 95 * 86400000).toISOString();
    const to = new Date().toISOString();
    const result = await api(app).get('/api/reports/dashboard').query({ from, to }).set(auth(sales));
    expect(result.status).toBe(200);
    expect(result.body.kpis.todayProfit).toBe(0);
    expect(result.body.kpis.inventoryValue).toBe(0);
    expect(result.body.salesSeries.every((point: { profit: number }) => point.profit === 0)).toBe(true);
    expect(result.body.topProducts.every((row: { product: { purchasePrice: number } }) => row.product.purchasePrice === 0)).toBe(true);
  });
  it('uses the same permission for dashboard API and navigation', async () => {
    expect((await api(app).get('/api/reports/dashboard').set(auth(cashier))).status).toBe(403);
  });
  it('redacts inventory valuations and product mutation responses', async () => {
    const warehouse = await loginAs(app, 'warehouse1');
    const overview = await api(app).get('/api/inventory/overview').set(auth(warehouse));
    expect(overview.status).toBe(200);
    expect(overview.body.totalValue).toBe(0);
    expect(overview.body.rows.every((r: { value: number }) => r.value === 0)).toBe(true);
    const updated = await api(app).patch('/api/products/prod-5').set(auth(warehouse)).send({ minStock: 3 });
    expect(updated.status).toBe(200);
    expect(updated.body.purchasePrice).toBe(0);
    expect(updated.body.lastPurchaseCost).toBe(0);
    expect((await ProductModel.findById('prod-5').lean())!.lastPurchaseCost).toBeGreaterThan(0);
  });
  it('filters purchase cost history even for a user who can edit selling prices', async () => {
    await UserModel.updateOne({ _id: sales.user.id }, { $addToSet: { extraPermissions: 'prices.edit' } });
    const editor = await loginAs(app, 'nour.h');
    const date = new Date().toISOString();
    await PriceHistoryModel.create([
      { _id: 'visibility-cost', productId: 'prod-1', field: 'purchasePrice', oldValue: 35, newValue: 40, userId: admin.user.id, branchId: editor.user.branchId, date },
      { _id: 'visibility-retail', productId: 'prod-1', field: 'retail1', oldValue: 75, newValue: 80, userId: admin.user.id, branchId: editor.user.branchId, date },
    ]);
    const history = await api(app).get('/api/products/price-history').query({ productId: 'prod-1' }).set(auth(editor));
    expect(history.status).toBe(200);
    expect(history.body.some((r: { field: string }) => r.field === 'retail1')).toBe(true);
    expect(history.body.some((r: { field: string }) => r.field === 'purchasePrice')).toBe(false);
    const explicit = await api(app).get('/api/products/price-history').query({ field: 'purchasePrice' }).set(auth(editor));
    expect(explicit.body).toEqual([]);
    const full = await api(app).get('/api/products/price-history').query({ field: 'purchasePrice' }).set(auth(admin));
    expect(full.body.some((r: { id: string }) => r.id === 'visibility-cost')).toBe(true);
  });
});
