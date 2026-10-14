import { beforeAll, afterAll, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from './harness.js';
import { CustomerModel, PurchaseModel, SpecialPriceModel, SupplierModel } from '../db/models.js';
let app: Express;
let manager: Awaited<ReturnType<typeof loginAs>>;
let admin: Awaited<ReturnType<typeof loginAs>>;
const header = (who = manager) => ({ Authorization: `Bearer ${who.token}` });
beforeAll(async () => {
  app = await startTestDb({ seed: true });
  manager = await loginAs(app, 'khaled.m'); admin = await loginAs(app, 'admin');
  const foreignPurchase = await api(app).post('/api/purchases').set(header(admin)).send({ supplierId: 'sup-1', branchId: 'br-2', warehouseId: 'wh-3', items: [{ productId: 'prod-1', quantity: 1, unitCost: 123 }], paid: 0 });
  expect(foreignPurchase.status).toBe(201);
  const now = new Date().toISOString();
  for (const type of ['retail', 'wholesale'] as const) await CustomerModel.create({ _id: `cust-projection-${type}`, code: `PROJECTION-${type}`, branchId: 'br-2', name: { ar: 'synthetic' }, address: { ar: '' }, type, balance: 98765, creditLimit: 123456, notes: 'private financial note', isActive: true, createdAt: now, updatedAt: now });
  await SpecialPriceModel.create({ _id: 'sp-projection', customerId: 'cust-projection-wholesale', productId: 'prod-1', price: 42, validFrom: now });
}, 60000);
afterAll(stopTestDb);
it('denies direct foreign retail customer reads', async () => {
  expect((await api(app).get('/api/customers/cust-projection-retail').set(header())).status).toBe(403);
});
it('shares foreign wholesale contact identity without financial fields or notes', async () => {
  const r = await api(app).get('/api/customers/cust-projection-wholesale').set(header());
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ id: 'cust-projection-wholesale', balance: 0, creditLimit: 0, financialRestricted: true });
  expect(r.body.notes).toBeUndefined();
  const all = await api(app).get('/api/customers/all').set(header());
  expect(all.body.find((c: { id: string }) => c.id === r.body.id)).toEqual(r.body);
  expect(all.body.some((c: { id: string }) => c.id === 'cust-projection-retail')).toBe(false);
});
it('does not expose foreign customer prices through direct API', async () => {
  expect((await api(app).get('/api/customers/special-prices').set(header()).query({ customerId: 'cust-projection-wholesale' })).status).toBe(403);
  const r = await api(app).get('/api/customers/special-prices').set(header());
  expect(r.body.some((p: { id: string }) => p.id === 'sp-projection')).toBe(false);
});
it('projects only branch-scoped finances and prices through bootstrap and delta sync', async () => {
  for (const endpoint of ['bootstrap', 'pull']) {
    const r = await api(app).get(`/api/sync/${endpoint}`).set(header()).query({ branchId: 'br-1', ...(endpoint === 'pull' ? { since: '2000-01-01T00:00:00.000Z' } : {}) });
    expect(r.status).toBe(200);
    expect(r.body.customers.find((c: { id: string }) => c.id === 'cust-projection-wholesale')).toMatchObject({ financialRestricted: true, balance: 0, creditLimit: 0 });
    expect(r.body.customers.some((c: { id: string }) => c.id === 'cust-projection-retail')).toBe(false);
    expect(r.body.specialPrices.some((p: { id: string }) => p.id === 'sp-projection')).toBe(false);
  }
});
it('keeps supplier list, lookup and direct-read balances within the caller branch', async () => {
  const purchases = await PurchaseModel.find({ supplierId: 'sup-1', branchId: 'br-1', status: { $nin: ['draft', 'cancelled'] } }).lean();
  const expected = Math.round(purchases.reduce((sum, p) => sum + p.remaining, 0) * 100) / 100;
  expect((await SupplierModel.findById('sup-1').lean())?.balance).not.toBe(expected);
  const direct = await api(app).get('/api/suppliers/sup-1').set(header());
  expect(direct.body.balance).toBe(expected);
  const all = await api(app).get('/api/suppliers/all').set(header());
  expect(all.body.find((s: { id: string }) => s.id === 'sup-1').balance).toBe(expected);
  const listed = await api(app).get('/api/suppliers').set(header()).query({ pageSize: 500 });
  expect(listed.body.data.find((s: { id: string }) => s.id === 'sup-1').balance).toBe(expected);
});
it('retains explicitly authorized all-branch ERP customer access', async () => {
  const r = await api(app).get('/api/customers/cust-projection-retail').set(header(admin));
  expect(r.status).toBe(200); expect(r.body.balance).toBe(98765);
});
it('permits shared cash contacts but blocks foreign credit, retail sales and financial summaries', async () => {
  const body = { branchId: 'br-1', customerId: 'cust-projection-wholesale', items: [{ productId: 'prod-1', name: { ar: 'synthetic' }, quantity: 1, unitPrice: 100 }], type: 'cash', payments: [{ method: 'cash', amount: 100 }] };
  expect((await api(app).post('/api/sales').set(header(admin)).send(body)).status).toBe(201);
  expect((await api(app).post('/api/sales').set(header(admin)).send({ ...body, type: 'credit', payments: [] })).status).toBe(403);
  expect((await api(app).post('/api/sales').set(header(admin)).send({ ...body, customerId: 'cust-projection-retail' })).status).toBe(403);
  for (const endpoint of ['statement', 'summary']) expect((await api(app).get(`/api/customers/cust-projection-wholesale/${endpoint}`).set(header())).status).toBe(403);
});
it('keeps an owned shared customer summary within the branch even when other branches made cash sales', async () => {
  const now = new Date().toISOString();
  await CustomerModel.create({ _id: 'cust-owned-shared', code: 'OWNED-SHARED', branchId: 'br-1', type: 'wholesale', name: { ar: 'synthetic' }, address: { ar: '' }, balance: 0, createdAt: now });
  const r = await api(app).post('/api/sales').set(header(admin)).send({ branchId: 'br-2', customerId: 'cust-owned-shared', type: 'cash', payments: [{ method: 'cash', amount: 100 }], items: [{ productId: 'prod-1', quantity: 1, unitPrice: 100, name: { ar: 'synthetic' } }] });
  expect(r.status).toBe(201);
  const summary = await api(app).get('/api/customers/cust-owned-shared/summary').set(header());
  expect(summary.status).toBe(200); expect(summary.body).toMatchObject({ invoiceCount: 0, totalPurchases: 0 });
});
