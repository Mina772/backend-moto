import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from './harness.js';
import { CashRegisterModel, CustomerModel, ProductModel, PurchaseModel, RegisterSessionModel, SaleModel, SaleReturnModel, StockLevelModel, StockMovementModel, SupplierModel, SupplierPaymentModel, UserModel, WarehouseModel } from '../db/models.js';
import { salesWarehouseFor } from '../modules/inventory/stock.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
let manager: Awaited<ReturnType<typeof loginAs>>;
let cashier: Awaited<ReturnType<typeof loginAs>>;
let sessionId: string;
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const saleBody = () => ({ branchId: 'br-1', registerSessionId: sessionId, items: [{ productId: 'prod-1', name: { ar: 'audit' }, quantity: 1, unitPrice: 100 }], payments: [{ method: 'cash', amount: 100 }], type: 'cash' });
const checkout = (body: object, who = admin) => api(app).post('/api/sales').set(auth(who)).set('Idempotency-Key', randomUUID()).send(body);
const purchase = async (branchId = 'br-1') => {
  const warehouse = (await WarehouseModel.findOne({ branchId, isActive: true }).lean())!;
  const result = await api(app).post('/api/purchases').set(auth(admin)).send({ supplierId: 'sup-1', branchId, warehouseId: warehouse._id, items: [{ productId: 'prod-1', quantity: 2, unitCost: 50 }] });
  expect(result.status).toBe(201);
  return result.body as { id: string };
};

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  manager = await loginAs(app, 'khaled.m');
  cashier = await loginAs(app, 'cashier1');
  await UserModel.updateOne({ _id: manager.user.id }, { $addToSet: { extraPermissions: 'purchases.pay' } });
  await ProductModel.updateOne({ _id: 'prod-1' }, { $set: { prices: { retail1: 100, retail2: 100, wholesale: 100 }, isActive: true } });
  await StockLevelModel.updateOne({ productId: 'prod-1', warehouseId: await salesWarehouseFor('br-1') }, { $set: { quantity: 1000 } });
  await CashRegisterModel.create({ _id: 'reg-audit-20261012', code: 'AUDIT-20261012', name: { ar: 'audit' }, branchId: 'br-1', isActive: true });
  const opened = await api(app).post('/api/cash/sessions').set(auth(admin)).send({ registerId: 'reg-audit-20261012', openingBalance: 1000 });
  expect(opened.status).toBe(201);
  sessionId = opened.body.id;
}, 60_000);
afterAll(stopTestDb);

it('rejects electronic overpayment before recording a sale or drawer movement', async () => {
  const before = await SaleModel.countDocuments();
  const drawer = await RegisterSessionModel.findById(sessionId).lean();
  const response = await checkout({ ...saleBody(), payments: [{ method: 'card', amount: 150 }] });
  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('OVERPAYMENT');
  expect(await SaleModel.countDocuments()).toBe(before);
  expect((await RegisterSessionModel.findById(sessionId).lean())?.movements).toEqual(drawer?.movements);
});

it('allows split payment change only from the cash tendered', async () => {
  const good = await checkout({ ...saleBody(), payments: [{ method: 'card', amount: 80 }, { method: 'cash', amount: 50 }] });
  expect(good.status).toBe(201);
  expect(good.body).toMatchObject({ total: 100, paid: 100, change: 30 });
  const bad = await checkout({ ...saleBody(), payments: [{ method: 'card', amount: 150 }, { method: 'cash', amount: 20 }] });
  expect(bad.status).toBe(422);
  expect(bad.body.error.code).toBe('OVERPAYMENT');
});

it('rejects credit-sale overpayment instead of silently discarding excess tender', async () => {
  const customer = await CustomerModel.findOne({ branchId: 'br-1', isActive: true }).lean();
  const response = await checkout({ ...saleBody(), customerId: customer!._id, type: 'credit', payments: [{ method: 'cash', amount: 150 }] });
  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('OVERPAYMENT');
});

it('preserves the established cashier credit-sale workflow', async () => {
  const customer = await CustomerModel.findOne({ branchId: 'br-1', isActive: true }).lean();
  const response = await checkout({ ...saleBody(), registerSessionId: null, customerId: customer!._id, type: 'credit', payments: [] }, cashier);
  expect(response.status).toBe(201);
  expect(response.body).toMatchObject({ type: 'credit', paid: 0, remaining: 100 });
});

it('rejects inactive products even when their ID and stock are known', async () => {
  await ProductModel.updateOne({ _id: 'prod-1' }, { $set: { isActive: false } });
  try {
    const response = await checkout(saleBody());
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('PRODUCT_NOT_FOUND');
  } finally {
    await ProductModel.updateOne({ _id: 'prod-1' }, { $set: { isActive: true } });
  }
});

it('does not refund an already returned invoice again through cancellation', async () => {
  const sold = await checkout(saleBody());
  expect(sold.status).toBe(201);
  const returned = await api(app).post('/api/sales/returns').set(auth(admin)).send({ saleId: sold.body.id, refundMethod: 'cash', items: [{ saleItemId: sold.body.items[0].id, productId: 'prod-1', quantity: 1, unitPrice: 100, refund: 0, reason: 'defective' }] });
  expect(returned.status).toBe(201);
  const before = await RegisterSessionModel.findById(sessionId).lean();
  const cancelled = await api(app).post(`/api/sales/${sold.body.id}/cancel`).set(auth(admin));
  expect(cancelled.status).toBe(409);
  expect(cancelled.body.error.code).toBe('SALE_HAS_RETURNS');
  expect((await RegisterSessionModel.findById(sessionId).lean())?.refunds).toBe(before?.refunds);
  expect((await SaleModel.findById(sold.body.id).lean())?.status).toBe('returned');
});

it('returns a client error for malformed JSON', async () => {
  const response = await api(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"username":');
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('INVALID_JSON');
});

it('blocks supplier-payment allocation to a foreign branch', async () => {
  const po = await purchase('br-2');
  const response = await api(app).post('/api/purchases/payments').set(auth(manager)).send({ supplierId: 'sup-1', purchaseId: po.id, amount: 10, method: 'cash' });
  expect(response.status).toBe(403);
  expect((await PurchaseModel.findById(po.id).lean())?.paid).toBe(0);
});

it('records a retried supplier payment once, including its durable response', async () => {
  const po = await purchase();
  const key = randomUUID();
  const body = { supplierId: 'sup-1', purchaseId: po.id, amount: 10, method: 'cash' };
  const results = await Promise.all(Array.from({ length: 3 }, () => api(app).post('/api/purchases/payments').set(auth(admin)).set('Idempotency-Key', key).send(body)));
  expect(results.map(r => r.status)).toEqual([201, 201, 201]);
  expect(new Set(results.map(r => r.body.id)).size).toBe(1);
  expect((await PurchaseModel.findById(po.id).lean())?.paid).toBe(10);
  expect(await SupplierPaymentModel.countDocuments({ purchaseId: po.id })).toBe(1);
});

it('rejects supplier overpayment when no supplier-credit allocation exists', async () => {
  const po = await purchase();
  const response = await api(app).post('/api/purchases/payments').set(auth(admin)).send({ supplierId: 'sup-1', purchaseId: po.id, amount: 150, method: 'cash' });
  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('OVERPAYMENT');
  expect((await PurchaseModel.findById(po.id).lean())?.paid).toBe(0);
  expect(await SupplierPaymentModel.countDocuments({ purchaseId: po.id })).toBe(0);
});

it('rejects a payment to a nonexistent supplier', async () => {
  const response = await api(app).post('/api/purchases/payments').set(auth(admin)).send({ supplierId: 'supplier-does-not-exist', amount: 10, method: 'cash' });
  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('SUPPLIER_NOT_FOUND');
});

it('rejects client-selected returned state before persisting an unposted invoice', async () => {
  const before = await SaleModel.countDocuments();
  const response = await checkout({ ...saleBody(), status: 'returned' });
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('INVALID_SALE_STATUS');
  expect(await SaleModel.countDocuments()).toBe(before);
});

it('denies access to a foreign customer statement and summary', async () => {
  const customer = await CustomerModel.findOne({ branchId: 'br-2' }).lean();
  expect(customer).toBeTruthy();
  for (const suffix of ['statement', 'summary']) {
    const response = await api(app).get(`/api/customers/${customer!._id}/${suffix}`).set(auth(manager));
    expect(response.status).toBe(403);
  }
});

it('confines listed purchase returns and supplier payments to the caller branch', async () => {
  const foreign = await purchase('br-2');
  const payment = await api(app).post('/api/purchases/payments').set(auth(admin)).send({ supplierId: 'sup-1', purchaseId: foreign.id, amount: 10, method: 'cash' });
  expect(payment.status).toBe(201);
  const listed = await api(app).get('/api/purchases/payments').set(auth(manager)).query({ pageSize: 500 });
  expect(listed.status).toBe(200);
  expect(listed.body.data.map((p: { id: string }) => p.id)).not.toContain(payment.body.id);
});

it('prevents checkout from consuming stock reserved for a transfer', async () => {
  const warehouseId = await salesWarehouseFor('br-1');
  await StockLevelModel.updateOne({ productId: 'prod-1', warehouseId }, { $set: { quantity: 1, reserved: 1 } });
  const before = await StockMovementModel.countDocuments();
  try {
    const response = await checkout(saleBody());
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await StockMovementModel.countDocuments()).toBe(before);
  } finally {
    await StockLevelModel.updateOne({ productId: 'prod-1', warehouseId }, { $set: { quantity: 1000, reserved: 0 } });
  }
});

it('keeps cumulative partial refunds within the rounded invoice total', async () => {
  const sold = await checkout({ ...saleBody(), items: [{ productId: 'prod-1', name: { ar: 'audit' }, quantity: 3, unitPrice: 0.05 }], invoiceDiscount: 0.01, payments: [{ method: 'cash', amount: 0.14 }] });
  expect(sold.status).toBe(201);
  expect(sold.body.total).toBe(0.14);
  const refunds: number[] = [];
  for (let i = 0; i < 3; i++) {
    const response = await api(app).post('/api/sales/returns').set(auth(admin)).send({ saleId: sold.body.id, refundMethod: 'cash', items: [{ saleItemId: sold.body.items[0].id, productId: 'prod-1', quantity: 1, unitPrice: 0.05, refund: 0, reason: 'defective' }] });
    expect(response.status).toBe(201);
    refunds.push(response.body.refundAmount);
  }
  expect(Math.round(refunds.reduce((total, amount) => total + amount, 0) * 100)).toBe(14);
  expect(await SaleReturnModel.countDocuments({ saleId: sold.body.id })).toBe(3);
});

it('refuses negative and overpaid purchase invoices and unknown suppliers/products', async () => {
  const warehouse = (await WarehouseModel.findOne({ branchId: 'br-1', isActive: true }).lean())!;
  const body = { supplierId: 'sup-1', branchId: 'br-1', warehouseId: warehouse._id, items: [{ productId: 'prod-1', quantity: 1, unitCost: 10 }] };
  const before = await PurchaseModel.countDocuments();
  for (const override of [{ discount: 20 }, { paid: 20 }, { supplierId: 'no-supplier' }, { items: [{ productId: 'no-product', quantity: 1, unitCost: 10 }] }]) {
    const response = await api(app).post('/api/purchases').set(auth(admin)).send({ ...body, ...override });
    expect(response.status).toBe(422);
  }
  expect(await PurchaseModel.countDocuments()).toBe(before);
});

it('rejects approving competing transfers beyond available stock', async () => {
  const warehouseId = await salesWarehouseFor('br-1');
  await StockLevelModel.updateOne({ productId: 'prod-1', warehouseId }, { $set: { quantity: 2, reserved: 0 } });
  try {
    const transfers = await Promise.all(Array.from({ length: 2 }, () => api(app).post('/api/transfers').set(auth(admin)).send({ sourceBranchId: 'br-1', sourceWarehouseId: warehouseId, destinationBranchId: 'br-2', items: [{ productId: 'prod-1', requestedQty: 2 }] })));
    expect(transfers.map(result => result.status)).toEqual([201, 201]);
    const approvals = await Promise.all(transfers.map(result => api(app).post(`/api/transfers/${result.body.id}/advance`).set(auth(admin)).send({ next: 'approved' })));
    expect(approvals.map(result => result.status).sort()).toEqual([200, 400]);
    expect((await StockLevelModel.findOne({ productId: 'prod-1', warehouseId }).lean())?.reserved).toBe(2);
  } finally {
    await StockLevelModel.updateOne({ productId: 'prod-1', warehouseId }, { $set: { quantity: 1000, reserved: 0 } });
  }
});

it('rejects cancellation of another branch purchase', async () => {
  const po = await purchase('br-2');
  const response = await api(app).post(`/api/purchases/${po.id}/cancel`).set(auth(manager));
  expect(response.status).toBe(403);
  expect((await PurchaseModel.findById(po.id).lean())?.status).toBe('ordered');
});

it('validates accumulated duplicate purchase-return lines and uses recorded costs', async () => {
  const po = await purchase();
  const doc = (await PurchaseModel.findById(po.id).lean())!;
  expect((await api(app).post(`/api/purchases/${po.id}/receive`).set(auth(admin)).send({ quantities: { [doc.items[0]!.id]: 2 } })).status).toBe(200);
  const before = await StockLevelModel.findOne({ productId: 'prod-1', warehouseId: doc.warehouseId }).lean();
  const duplicates = await api(app).post('/api/purchases/returns').set(auth(admin)).send({ purchaseId: po.id, items: [{ productId: 'prod-1', quantity: 2, unitCost: 50 }, { productId: 'prod-1', quantity: 2, unitCost: 50 }] });
  expect(duplicates.status).toBe(400);
  expect(duplicates.body.error.code).toBe('RETURN_QTY_EXCEEDED');
  expect((await StockLevelModel.findById(before!._id).lean())?.quantity).toBe(before?.quantity);
  const forgedCost = await api(app).post('/api/purchases/returns').set(auth(admin)).send({ purchaseId: po.id, items: [{ productId: 'prod-1', quantity: 1, unitCost: 50000 }] });
  expect(forgedCost.status).toBe(201);
  expect(forgedCost.body.total).toBe(50);
  expect(forgedCost.body.items[0].unitCost).toBe(50);
});

it('reports branch payables from purchases in that branch', async () => {
  await purchase('br-2');
  const owed = await PurchaseModel.find({ branchId: 'br-1', status: { $nin: ['cancelled', 'draft'] } }).lean();
  const expected = Math.round(owed.reduce((amount, purchase) => amount + purchase.remaining, 0) * 100) / 100;
  expect((await SupplierModel.find().lean()).reduce((amount, supplier) => amount + supplier.balance, 0)).not.toBe(expected);
  for (const report of ['accounting', 'dashboard']) {
    const response = await api(app).get(`/api/reports/${report}`).set(auth(manager)).query({ branchId: 'br-1', from: '2020-01-01', to: '2030-12-31' });
    expect(response.status).toBe(200);
    expect(report === 'accounting' ? response.body.payables : response.body.kpis.supplierDebts).toBe(expected);
  }
});

it('restricts supplier financial summary and statement to branch purchases', async () => {
  const foreign = await purchase('br-2');
  const payment = await api(app).post('/api/purchases/payments').set(auth(admin)).send({ supplierId: 'sup-1', purchaseId: foreign.id, amount: 10, method: 'cash' });
  expect(payment.status).toBe(201);
  const own = await PurchaseModel.find({ supplierId: 'sup-1', branchId: 'br-1', status: { $ne: 'cancelled' } }).lean();
  const summary = await api(app).get('/api/suppliers/sup-1/summary').set(auth(manager));
  expect(summary.status).toBe(200);
  expect(summary.body.purchaseCount).toBe(own.length);
  expect(summary.body.balance).toBe(Math.round(own.filter(p => p.status !== 'draft').reduce((sum, p) => sum + p.remaining, 0) * 100) / 100);
  const statement = await api(app).get('/api/suppliers/sup-1/statement').set(auth(manager));
  expect(statement.status).toBe(200);
  expect(statement.body.map((row: { reference: string }) => row.reference)).not.toContain((await PurchaseModel.findById(foreign.id).lean())!.invoiceNumber);
  expect(statement.body.map((row: { reference: string }) => row.reference)).not.toContain(payment.body.reference);
});

it('restricts supplier debt overview to the caller branch', async () => {
  const purchases = await PurchaseModel.find({ branchId: 'br-1', status: { $nin: ['cancelled', 'draft'] } }).lean();
  const balances = new Map<string, number>();
  for (const p of purchases) balances.set(p.supplierId, (balances.get(p.supplierId) ?? 0) + p.remaining);
  const expected = Math.round([...balances.values()].reduce((total, balance) => total + Math.max(0, balance), 0) * 100) / 100;
  const response = await api(app).get('/api/suppliers/debt-overview').set(auth(manager));
  expect(response.status).toBe(200);
  expect(response.body.totalPayable).toBe(expected);
});
