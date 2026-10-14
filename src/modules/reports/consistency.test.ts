/**
 * Reports must agree with the ledgers they summarise. Every expectation here is computed
 * straight from the sale documents rather than from another report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { round2 } from '@moto/shared';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { CustomerDebtModel, SaleModel, SaleReturnModel, SupplierModel } from '../../db/models.js';

interface LeanSale {
  _id: string;
  branchId: string;
  total: number;
  invoiceDiscount: number;
  items: { quantity: number; subtotal: number; unitPrice: number; unitCost: number; discount: number }[];
}

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
let sales: LeanSale[];
let refundProfit: number;
const from = new Date(Date.now() - 95 * 86400000).toISOString();
const to = new Date().toISOString();

const auth = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });
const report = (groupBy: string, branchId?: string) =>
  api(app).get(`/api/reports/sales?from=${from}&to=${to}&groupBy=${groupBy}${branchId ? `&branchId=${branchId}` : ''}`).set(auth(admin));

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  sales = (await SaleModel.find({ date: { $gte: from, $lte: to }, status: { $nin: ['held', 'cancelled'] } }).lean()) as unknown as LeanSale[];
  expect(sales.length).toBeGreaterThan(100);
  const refunds = await SaleReturnModel.find({ date: { $gte: from, $lte: to } }).lean();
  const originals = await SaleModel.find({ _id: { $in: refunds.map(r => r.saleId) } }).lean();
  refundProfit = round2(refunds.reduce((sum, r) => {
    const original = originals.find(s => s._id === r.saleId)!;
    const net = round2(r.refundAmount - round2(original.total ? r.refundAmount * original.tax / original.total : 0));
    const cost = round2(r.items.reduce((value, item) => value + original.items.find(i => i.id === item.saleItemId)!.unitCost * item.quantity, 0));
    return sum + round2(net - cost);
  }, 0));
}, 60_000);
afterAll(stopTestDb);

describe('sales report vs the sales ledger', () => {
  it('totals the same revenue however the rows are grouped by invoice', async () => {
    const expected = round2(sales.reduce((a, s) => a + s.total, 0));
    for (const groupBy of ['day', 'cashier', 'branch']) {
      const res = await report(groupBy);
      expect(res.status).toBe(200);
      expect(res.body.totals.sales).toBeCloseTo(expected, 1);
      expect(res.body.totals.invoices).toBe(sales.length);
    }
  });

  it('totals the same line revenue however the rows are grouped by item', async () => {
    const expected = round2(sales.reduce((a, s) => a + s.total, 0));
    for (const groupBy of ['product', 'category', 'tier']) {
      const res = await report(groupBy);
      expect(res.status).toBe(200);
      expect(res.body.totals.sales).toBeCloseTo(expected, 1);
    }
  });

  it('counts the same units sold in every grouping', async () => {
    const expected = sales.reduce((a, s) => a + s.items.reduce((b, i) => b + i.quantity, 0), 0);
    for (const groupBy of ['day', 'cashier', 'branch', 'product', 'category', 'tier']) {
      const totals = (await report(groupBy)).body.totals;
      expect(totals.qty).toBeCloseTo(expected, 1);
      expect(totals.invoices).toBe(sales.length);
    }
  });

  it('has rows that add up to the totals row', async () => {
    for (const groupBy of ['day', 'cashier', 'product']) {
      const { rows, totals } = (await report(groupBy)).body;
      expect(round2(rows.reduce((a: number, r: { sales: number }) => a + r.sales, 0))).toBeCloseTo(totals.sales, 1);
      expect(round2(rows.reduce((a: number, r: { profit: number }) => a + r.profit, 0))).toBeCloseTo(totals.profit, 1);
    }
  });

  it('splits by branch into parts that rebuild the whole', async () => {
    const all = (await report('branch')).body;
    let summed = 0;
    for (const row of all.rows as { key: string; sales: number }[]) {
      const scoped = (await report('day', row.key)).body;
      expect(scoped.totals.sales).toBeCloseTo(row.sales, 1);
      summed = round2(summed + scoped.totals.sales);
    }
    expect(summed).toBeCloseTo(all.totals.sales, 1);
  });

  it('excludes cancelled and held invoices from the figures', async () => {
    const excluded = await SaleModel.find({ status: { $in: ['held', 'cancelled'] } }).lean();
    expect(excluded.length).toBeGreaterThan(0);
    const reported = (await report('day')).body.totals.sales;
    const withExcluded = round2(reported + excluded.reduce((a, s) => a + s.total, 0));
    expect(reported).not.toBeCloseTo(withExcluded, 1);
    expect(reported).toBeCloseTo(round2(sales.reduce((a, s) => a + s.total, 0)), 1);
  });

  it('reports a profit equal to margin after every discount', async () => {
    const expected = round2(sales.reduce((a, s) => a + s.items.reduce((b, i) => b + (i.unitPrice - i.unitCost) * i.quantity - i.discount, 0) - s.invoiceDiscount, 0));
    for (const groupBy of ['day', 'cashier', 'branch', 'product', 'category', 'tier']) {
      expect((await report(groupBy)).body.totals.profit).toBeCloseTo(expected, 1);
    }
    const acc = await api(app).get(`/api/reports/accounting?from=${from}&to=${to}`).set(auth(admin));
    expect(acc.body.grossProfit).toBeCloseTo(expected - refundProfit, 1);
    expect(round2(acc.body.series.reduce((sum: number, point: { profit: number }) => sum + point.profit, 0))).toBeCloseTo(expected - refundProfit, 1);
  });
});

describe('accounting summary vs the ledgers', () => {
  it('matches receivables and payables to the open debts and supplier balances', async () => {
    const res = await api(app).get(`/api/reports/accounting?from=${from}&to=${to}`).set(auth(admin));
    expect(res.status).toBe(200);
    const receivables = round2((await CustomerDebtModel.find({ remaining: { $gt: 0 } }).lean()).reduce((a, d) => a + d.remaining, 0));
    const payables = round2((await SupplierModel.find().lean()).reduce((a, s) => a + s.balance, 0));
    expect(res.body.receivables).toBeCloseTo(receivables, 1);
    expect(res.body.payables).toBeCloseTo(payables, 1);
  });

  it('builds its daily series out of the same sales the report counts', async () => {
    const res = await api(app).get(`/api/reports/accounting?from=${from}&to=${to}`).set(auth(admin));
    const expected = round2(sales.reduce((a, s) => a + s.total, 0));
    expect(res.body.totalSales).toBeCloseTo(expected, 1);
    expect(res.body.series.reduce((a: number, p: { sales: number }) => round2(a + p.sales), 0)).toBeCloseTo(expected, 1);
    expect(round2(res.body.grossProfit + res.body.cogs)).toBeCloseTo(res.body.netSales, 1);
    expect(round2(res.body.netSales + res.body.tax + res.body.returns)).toBeCloseTo(res.body.totalSales, 1);
    expect(round2(res.body.netProfit + res.body.expenses)).toBeCloseTo(res.body.grossProfit, 1);
  });

  it('matches the dashboard revenue to the accounting total for the same range', async () => {
    const dash = await api(app).get(`/api/reports/dashboard?from=${from}&to=${to}`).set(auth(admin));
    const acc = await api(app).get(`/api/reports/accounting?from=${from}&to=${to}`).set(auth(admin));
    expect(dash.status).toBe(200);
    const dashSales = (dash.body.salesSeries as { sales: number }[]).reduce((a, p) => round2(a + p.sales), 0);
    const accSales = (acc.body.series as { sales: number }[]).reduce((a, p) => round2(a + p.sales), 0);
    expect(dashSales).toBeCloseTo(accSales, 1);
    expect(dash.body.kpis.todaySales).toBeCloseTo(acc.body.totalSales, 1);
    expect(dash.body.kpis.invoicesCount).toBe(sales.length);
    expect(dash.body.kpis.customerDebts).toBeCloseTo(acc.body.receivables, 1);
    expect(round2((dash.body.salesByBranch as { value: number }[]).reduce((a, b) => a + b.value, 0))).toBeCloseTo(acc.body.totalSales, 1);
  });
});

describe('report access control', () => {
  it('scopes a branch user\u2019s report to their own branch', async () => {
    const manager = await loginAs(app, 'khaled.m');
    const mine = round2(sales.filter((s) => s.branchId === manager.user.branchId).reduce((a, s) => a + s.total, 0));
    const res = await api(app).get(`/api/reports/sales?from=${from}&to=${to}&groupBy=branch&branchId=br-2`).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.rows.every((r: { key: string }) => r.key === manager.user.branchId)).toBe(true);
    expect(res.body.totals.sales).toBeCloseTo(mine, 1);
  });

  it('denies a cashier the financial reports', async () => {
    const cashier = await loginAs(app, 'cashier1');
    expect((await api(app).get(`/api/reports/accounting?from=${from}&to=${to}`).set(auth(cashier))).status).toBe(403);
  });
});
