import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { api, loginAs, startTestDb, stopTestDb } from './harness.js';
import { CustomerModel, CustomerDebtModel, CustomerPaymentModel, ProductModel, PurchaseModel, PurchaseReturnModel, SaleModel, SaleReturnModel, StockLevelModel, SupplierPaymentModel } from '../db/models.js';
let app: Express, token: string;
const headers = () => ({ Authorization: `Bearer ${token}` });
const sale = () => api(app).post('/api/sales').set(headers()).set('Idempotency-Key', randomUUID()).send({ branchId: 'br-1', customerId: 'cust-close', items: [{ productId: 'prod-1', name: { ar: 'synthetic' }, quantity: 1, unitPrice: 100 }], type: 'credit', payments: [{ method: 'cash', amount: 50 }] });
const purchase = () => api(app).post('/api/purchases').set(headers()).send({ supplierId: 'sup-1', branchId: 'br-1', warehouseId: 'wh-1', items: [{ productId: 'prod-1', quantity: 1, unitCost: 100 }], paid: 50 });
beforeAll(async () => {
  app = await startTestDb({ seed: true }); token = (await loginAs(app, 'admin')).token;
  await ProductModel.updateOne({ _id: 'prod-1' }, { $set: { prices: { retail1: 100, retail2: 100, wholesale: 100 } } });
  await StockLevelModel.updateMany({ productId: 'prod-1', branchId: 'br-1' }, { $set: { quantity: 1000 } });
  await CustomerModel.create({ _id: 'cust-close', code: 'CLOSE', name: { ar: 'synthetic' }, address: { ar: '' }, branchId: 'br-1', type: 'retail', creditLimit: 10000, balance: 0, createdAt: new Date().toISOString() });
});
afterAll(stopTestDb);
it('reverses a paid credit invoice through an immutable return, clears debt and retains original receipts', async () => {
  const s = await sale(); expect(s.status).toBe(201);
  const receipts = await CustomerPaymentModel.find({ saleId: s.body.id }).lean();
  const r = await api(app).post(`/api/sales/${s.body.id}/cancel`).set(headers()).send({ refundMethod: 'bank_transfer' });
  expect(r.status).toBe(200); expect(r.body.status).toBe('returned'); expect(r.body.total).toBe(100); expect(r.body.paid).toBe(50); expect(r.body.remaining).toBe(0);
  const ret = await SaleReturnModel.findOne({ saleId: s.body.id }).lean(); expect(ret).toMatchObject({ debtReduction: 50, payoutAmount: 50, refundAmount: 100, refundMethod: 'bank_transfer', reversal: 'cancellation' });
  expect(await CustomerPaymentModel.find({ saleId: s.body.id }).lean()).toEqual(receipts);
  expect((await CustomerDebtModel.findOne({ saleId: s.body.id }).lean())!.remaining).toBe(0);
  const repeat = await api(app).post(`/api/sales/${s.body.id}/cancel`).set(headers()).send({ refundMethod: 'bank_transfer' }); expect(repeat.status).toBe(200); expect(await SaleReturnModel.countDocuments({ saleId: s.body.id })).toBe(1);
  const statement = await api(app).get('/api/customers/cust-close/statement').set(headers()); expect(statement.body[0].balance).toBe((await CustomerModel.findById('cust-close').lean())!.balance);
});
it('settles full customer return debt-first and prevents duplicate payout on retry', async () => {
  const s = await sale(); const key = randomUUID();
  const input = { saleId: s.body.id, settlement: 'debt_first', refundMethod: 'cash', items: [{ saleItemId: s.body.items[0].id, productId: 'prod-1', quantity: 1, unitPrice: 100, refund: 0, reason: 'defective' }] };
  const one = await api(app).post('/api/sales/returns').set(headers()).set('Idempotency-Key', key).send(input);
  const two = await api(app).post('/api/sales/returns').set(headers()).set('Idempotency-Key', key).send(input);
  expect(one.status).toBe(201); expect(two.status).toBe(201); expect(two.body.id).toBe(one.body.id); expect(one.body).toMatchObject({ debtReduction: 50, payoutAmount: 50 });
  expect((await SaleModel.findById(s.body.id).lean())!.remaining).toBe(0);
});
it('requires an explicit supplier method for paid value and preserves invoice and payment history', async () => {
  const p = await purchase(); expect(p.status).toBe(201);
  await api(app).post(`/api/purchases/${p.body.id}/receive`).set(headers()).send({ quantities: { [p.body.items[0].id]: 1 } });
  const receipts = await SupplierPaymentModel.find({ purchaseId: p.body.id }).lean();
  const input = { purchaseId: p.body.id, items: [{ productId: 'prod-1', purchaseItemId: p.body.items[0].id, quantity: 1, unitCost: 999 }], reason: 'synthetic' };
  const blocked = await api(app).post('/api/purchases/returns').set(headers()).send(input); expect(blocked.status).toBe(409);
  const key = randomUUID(); const one = await api(app).post('/api/purchases/returns').set(headers()).set('Idempotency-Key', key).send({ ...input, refundMethod: 'cash' });
  const two = await api(app).post('/api/purchases/returns').set(headers()).set('Idempotency-Key', key).send({ ...input, refundMethod: 'cash' });
  expect(one.status).toBe(201); expect(two.body.id).toBe(one.body.id); expect(one.body).toMatchObject({ total: 100, debtReduction: 50, payoutAmount: 50, refundMethod: 'cash' });
  expect((await PurchaseModel.findById(p.body.id).lean())!).toMatchObject({ total: 100, paid: 50, remaining: 0 }); expect(await SupplierPaymentModel.find({ purchaseId: p.body.id }).lean()).toEqual(receipts);
  expect(await PurchaseReturnModel.countDocuments({ purchaseId: p.body.id })).toBe(1);
  const statement = await api(app).get('/api/suppliers/sup-1/statement').set(headers()); const all = await PurchaseModel.find({ supplierId: 'sup-1', status: { $nin: ['cancelled', 'draft'] } }).lean(); expect(statement.body[0].balance).toBeCloseTo(all.reduce((sum, row) => sum + row.remaining, 0), 2);
});
it('selects the exact duplicate purchase line and derives its discounted historical cost', async () => {
  const p = await api(app).post('/api/purchases').set(headers()).send({ supplierId: 'sup-1', branchId: 'br-1', warehouseId: 'wh-1', items: [{ productId: 'prod-1', quantity: 1, unitCost: 10 }, { productId: 'prod-1', quantity: 1, unitCost: 20 }], discount: 3, paid: 0 });
  await api(app).post(`/api/purchases/${p.body.id}/receive`).set(headers()).send({ quantities: Object.fromEntries(p.body.items.map((i: { id: string }) => [i.id, 1])) });
  const input = { purchaseId: p.body.id, items: [{ productId: 'prod-1', purchaseItemId: p.body.items[1].id, quantity: 1, unitCost: 999 }] };
  const r = await api(app).post('/api/purchases/returns').set(headers()).send(input); expect(r.status).toBe(201); expect(r.body.total).toBe(18); expect(r.body.items[0].purchaseItemId).toBe(p.body.items[1].id);
  const repeat = await api(app).post('/api/purchases/returns').set(headers()).send(input);
  expect(repeat.status).toBe(400); expect(repeat.body.error.code).toBe('RETURN_QTY_EXCEEDED');
});
