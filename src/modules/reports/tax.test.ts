import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { ProductModel, SaleModel } from '../../db/models.js';
let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
const date = '2026-01-03T12:00:00.000Z';
const query = { from: '2026-01-03T00:00:00.000Z', to: '2026-01-03T23:59:59.999Z' };
beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  await SaleModel.deleteMany({});
  const product = await ProductModel.findById('prod-1').lean();
  await SaleModel.create({ _id: 'sale-tax', invoiceNumber: 'INV-TAX', date, branchId: 'br-1', cashierId: admin.user.id,
    items: [{ id: 'line-1', productId: product!._id, name: product!.name, quantity: 1, unitPrice: 100, unitCost: 60, listPrice: 100, priceTier: 'retail1', discount: 0, subtotal: 100, returnedQty: 0 }],
    subtotal: 100, itemDiscounts: 0, invoiceDiscount: 10, tax: 12.6, total: 102.6, paid: 102.6, remaining: 0, change: 0, payments: [{ method: 'cash', amount: 102.6 }], type: 'cash', status: 'completed',
  });
});
afterAll(stopTestDb);
describe('tax and invoice discounts across reports', () => {
  it('preserves invoice cents across fractional quantities and line allocations', async () => {
    const query = { from: '2026-01-04T00:00:00.000Z', to: '2026-01-04T23:59:59.999Z' };
    await SaleModel.create({ _id: 'sale-cents', invoiceNumber: 'INV-CENTS', date: '2026-01-04T12:00:00.000Z', branchId: 'br-1', cashierId: admin.user.id,
      items: ['prod-1', 'prod-2', 'prod-3'].map((productId, index) => ({ id: `cent-line-${index}`, productId, name: { ar: 'Fractional part' }, quantity: 0.333, unitPrice: 10.01, unitCost: 1.01, listPrice: 10.01, priceTier: 'retail1', discount: 0, subtotal: 3.33, returnedQty: 0 })),
      subtotal: 10, itemDiscounts: 0, invoiceDiscount: 0.01, tax: 1.4, total: 11.39, paid: 11.39, remaining: 0, change: 0, payments: [{ method: 'cash', amount: 11.39 }], type: 'cash', status: 'completed',
    });
    for (const groupBy of ['day', 'cashier', 'branch', 'product', 'category', 'tier']) {
      const result = await api(app).get('/api/reports/sales').query({ ...query, groupBy }).set({ Authorization: `Bearer ${admin.token}` });
      expect(result.status).toBe(200);
      expect(result.body.totals).toMatchObject({ sales: 11.39, cost: 1.02, profit: 8.97 });
    }
    const accounting = await api(app).get('/api/reports/accounting').query(query).set({ Authorization: `Bearer ${admin.token}` });
    expect(accounting.body).toMatchObject({ totalSales: 11.39, netSales: 9.99, tax: 1.4, cogs: 1.02, grossProfit: 8.97 });
  });
  it('reports the same 30 profit and 102.60 billed amount in every grouping', async () => {
    for (const groupBy of ['day', 'cashier', 'branch', 'product', 'category', 'tier']) {
      const result = await api(app).get('/api/reports/sales').query({ ...query, groupBy }).set({ Authorization: `Bearer ${admin.token}` });
      expect(result.status).toBe(200);
      expect(result.body.totals.sales).toBe(102.6);
      expect(result.body.totals.profit).toBe(30);
    }
    const accounting = await api(app).get('/api/reports/accounting').query(query).set({ Authorization: `Bearer ${admin.token}` });
    expect(accounting.body).toMatchObject({ totalSales: 102.6, netSales: 90, tax: 12.6, cogs: 60, grossProfit: 30 });
    expect(accounting.body.series.reduce((sum: number, point: { profit: number }) => sum + point.profit, 0)).toBe(30);
    const dashboard = await api(app).get('/api/reports/dashboard').query(query).set({ Authorization: `Bearer ${admin.token}` });
    expect(dashboard.body.kpis.todayProfit).toBe(30);
    expect(dashboard.body.topProducts[0].revenue).toBe(102.6);
  });
});
