import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from './harness.js';
import { CustomerModel, CustomerPaymentModel, CustomerDebtModel, ProductModel, PurchaseModel, PurchaseReturnModel, SaleModel, SaleReturnModel, StockLevelModel, SupplierModel, SupplierPaymentModel } from '../db/models.js';
let app: Express; let token: string;
const auth = () => ({ Authorization: `Bearer ${token}` });
const cash = (total: number) => [{ method: 'cash', amount: total }];
const checkout = (over: object = {}) => api(app).post('/api/sales').set(auth()).set('Idempotency-Key', randomUUID()).send({ branchId: 'br-1', customerId: 'cust-finance', items: [{ productId: 'prod-1', name: { ar: 'synthetic' }, quantity: 1, unitPrice: 100 }], type: 'credit', payments: cash(50), ...over });
const returnBody = (sale: { id: string; items: { id: string }[] }, method: string) => ({ saleId: sale.id, refundMethod: method, items: [{ saleItemId: sale.items[0].id, productId: 'prod-1', quantity: 1, unitPrice: 100, refund: 0, reason: 'defective' }] });
beforeAll(async () => {
  app = await startTestDb({ seed: true }); token = (await loginAs(app, 'admin')).token;
  await ProductModel.updateOne({ _id: 'prod-1' }, { $set: { prices: { retail1: 100, retail2: 100, wholesale: 100 } } });
  await StockLevelModel.updateMany({ productId: 'prod-1', branchId: 'br-1' }, { $set: { quantity: 1000 } });
  await CustomerModel.create({ _id: 'cust-finance', code: 'FINANCE', name: { ar: 'synthetic' }, address: { ar: '' }, branchId: 'br-1', type: 'retail', creditLimit: 10000, balance: 0, createdAt: new Date().toISOString() });
}, 60000);
afterAll(stopTestDb);
it('records initial credit-sale tender exactly once and reconciles its statement', async () => {
  const s = await checkout(); expect(s.status).toBe(201);
  const records = await CustomerPaymentModel.find({ saleId: s.body.id }).lean();
  expect(records.reduce((sum, p) => sum + p.amount, 0)).toBe(50);
  const statement = await api(app).get('/api/customers/cust-finance/statement').set(auth());
  expect(statement.body[0].balance).toBe((await CustomerModel.findById('cust-finance').lean())!.balance);
});
it('blocks cancelling a paid credit sale without deleting receipt history or changing balances', async () => {
  const s = await checkout(); expect(s.status).toBe(201);
  const before = await CustomerPaymentModel.find({ saleId: s.body.id }).lean();
  const balance = (await CustomerModel.findById('cust-finance').lean())!.balance;
  const r = await api(app).post(`/api/sales/${s.body.id}/cancel`).set(auth());
  expect(r.status).toBe(409); expect(r.body.error.code).toBe('PAYMENT_RECONCILIATION_REQUIRED');
  expect(await CustomerPaymentModel.find({ saleId: s.body.id }).lean()).toEqual(before);
  expect((await CustomerModel.findById('cust-finance').lean())!.balance).toBe(balance);
  expect((await SaleModel.findById(s.body.id).lean())!.status).toBe('completed');
});
it('blocks an excess credit refund before creating a return or restoring stock', async () => {
  const s = await checkout(); expect(s.status).toBe(201);
  const before = await SaleReturnModel.countDocuments({ saleId: s.body.id });
  const r = await api(app).post('/api/sales/returns').set(auth()).send(returnBody(s.body, 'credit'));
  expect(r.status).toBe(409); expect(r.body.error.code).toBe('REFUND_RECONCILIATION_REQUIRED');
  expect(await SaleReturnModel.countDocuments({ saleId: s.body.id })).toBe(before);
  expect((await SaleModel.findById(s.body.id).lean())!.items[0].returnedQty).toBe(0);
});
it('requires a cash refund to be covered by tender already paid, not unpaid credit debt', async () => {
  const s = await checkout({ payments: [] }); expect(s.status).toBe(201);
  const r = await api(app).post('/api/sales/returns').set(auth()).send(returnBody(s.body, 'cash'));
  expect(r.status).toBe(409); expect(r.body.error.code).toBe('REFUND_RECONCILIATION_REQUIRED');
  expect((await CustomerDebtModel.findOne({ saleId: s.body.id }).lean())!.remaining).toBe(100);
});
it('supplier initial payment already appears once and reconciles its statement', async () => {
  const p = await api(app).post('/api/purchases').set(auth()).send({ supplierId: 'sup-1', branchId: 'br-1', warehouseId: 'wh-1', items: [{ productId: 'prod-1', quantity: 1, unitCost: 100 }], paid: 50 });
  expect(p.status).toBe(201);
  expect((await SupplierPaymentModel.find({ purchaseId: p.body.id }).lean()).reduce((sum, pay) => sum + pay.amount, 0)).toBe(50);
  const statement = await api(app).get('/api/suppliers/sup-1/statement').set(auth());
  const purchases = await PurchaseModel.find({ supplierId: 'sup-1', status: { $nin: ['draft', 'cancelled'] } }).lean();
  expect(statement.body[0].balance).toBeCloseTo(purchases.reduce((sum, row) => sum + row.remaining, 0), 2);
});
it('allocates purchase discount across repeated partial returns and reconciles the supplier statement', async () => {
  const p = await api(app).post('/api/purchases').set(auth()).send({ supplierId: 'sup-1', branchId: 'br-1', warehouseId: 'wh-1', items: [{ productId: 'prod-1', quantity: 3, unitCost: 0.05 }], discount: 0.01, paid: 0 });
  expect(p.status).toBe(201);
  expect((await api(app).post(`/api/purchases/${p.body.id}/receive`).set(auth()).send({ quantities: { [p.body.items[0].id]: 3 } })).status).toBe(200);
  const totals: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await api(app).post('/api/purchases/returns').set(auth()).send({ purchaseId: p.body.id, items: [{ productId: 'prod-1', quantity: 1, unitCost: 999 }], reason: 'synthetic' });
    expect(r.status).toBe(201); totals.push(r.body.total);
  }
  expect(totals).toEqual([0.05, 0.04, 0.05]);
  expect((await PurchaseModel.findById(p.body.id).lean())!.remaining).toBe(0);
  expect((await PurchaseReturnModel.find({ purchaseId: p.body.id }).lean()).reduce((sum, r) => sum + r.total, 0)).toBeCloseTo(p.body.total, 2);
  const statement = await api(app).get('/api/suppliers/sup-1/statement').set(auth());
  const purchases = await PurchaseModel.find({ supplierId: 'sup-1', status: { $nin: ['draft', 'cancelled'] } }).lean();
  expect(statement.body[0].balance).toBeCloseTo(purchases.reduce((sum, row) => sum + row.remaining, 0), 2);
});
it('blocks paid purchase returns that require an explicit supplier reimbursement', async () => {
  const p = await api(app).post('/api/purchases').set(auth()).send({ supplierId: 'sup-1', branchId: 'br-1', warehouseId: 'wh-1', items: [{ productId: 'prod-1', quantity: 1, unitCost: 100 }], paid: 100 });
  expect(p.status).toBe(201);
  expect((await api(app).post(`/api/purchases/${p.body.id}/receive`).set(auth()).send({ quantities: { [p.body.items[0].id]: 1 } })).status).toBe(200);
  const r = await api(app).post('/api/purchases/returns').set(auth()).send({ purchaseId: p.body.id, items: [{ productId: 'prod-1', quantity: 1, unitCost: 100 }], reason: 'synthetic' });
  expect(r.status).toBe(409); expect(r.body.error.code).toBe('REFUND_RECONCILIATION_REQUIRED');
  expect(await PurchaseReturnModel.countDocuments({ purchaseId: p.body.id })).toBe(0);
  expect((await PurchaseModel.findById(p.body.id).lean())!.remaining).toBe(0);
});
it('preserves the methods of initial split credit tender', async () => {
  const s = await checkout({ payments: [{ method: 'cash', amount: 20 }, { method: 'card', amount: 30 }] });
  expect(s.status).toBe(201);
  const records = await CustomerPaymentModel.find({ saleId: s.body.id }).lean();
  expect(records.map(p => ({ method: p.method, amount: p.amount }))).toEqual([{ method: 'cash', amount: 20 }, { method: 'card', amount: 30 }]);
});
it('includes automatically allocated supplier receipts in the branch statement', async () => {
  await SupplierModel.create({ _id: 'sup-auto', code: 'SYNTHETIC-AUTO', name: { ar: 'synthetic' }, contactPerson: { ar: '' }, address: { ar: '' }, createdAt: new Date().toISOString() });
  const p = await api(app).post('/api/purchases').set(auth()).send({ supplierId: 'sup-auto', branchId: 'br-1', warehouseId: 'wh-1', items: [{ productId: 'prod-1', quantity: 1, unitCost: 100 }], paid: 0 });
  expect(p.status).toBe(201);
  const manager = await loginAs(app, 'khaled.m');
  const pay = await api(app).post('/api/purchases/payments').set(auth()).send({ supplierId: 'sup-auto', amount: 25, method: 'cash', reference: 'SYNTHETIC-AUTO-ALLOCATED' });
  expect(pay.status).toBe(201);
  const statement = await api(app).get('/api/suppliers/sup-auto/statement').set('Authorization', `Bearer ${manager.token}`);
  expect(statement.body.some((row: { reference: string }) => row.reference === 'SYNTHETIC-AUTO-ALLOCATED')).toBe(true);
  const purchases = await PurchaseModel.find({ supplierId: 'sup-auto', branchId: 'br-1', status: { $nin: ['draft', 'cancelled'] } }).lean();
  expect(statement.body[0].balance).toBeCloseTo(purchases.reduce((sum, row) => sum + row.remaining, 0), 2);
});
it('blocks ambiguous purchase return costs for historical duplicate product rows', async () => {
  const p = await api(app).post('/api/purchases').set(auth()).send({ supplierId: 'sup-1', branchId: 'br-1', warehouseId: 'wh-1', items: [{ productId: 'prod-1', quantity: 1, unitCost: 10 }, { productId: 'prod-1', quantity: 1, unitCost: 20 }], paid: 0 });
  expect(p.status).toBe(201);
  expect((await api(app).post(`/api/purchases/${p.body.id}/receive`).set(auth()).send({ quantities: Object.fromEntries(p.body.items.map((row: { id: string }) => [row.id, 1])) })).status).toBe(200);
  const response = await api(app).post('/api/purchases/returns').set(auth()).send({ purchaseId: p.body.id, items: [{ productId: 'prod-1', quantity: 1, unitCost: 20 }] });
  expect(response.status).toBe(409); expect(response.body.error.code).toBe('RETURN_LINE_RECONCILIATION_REQUIRED');
  expect(await PurchaseReturnModel.countDocuments({ purchaseId: p.body.id })).toBe(0);
});

