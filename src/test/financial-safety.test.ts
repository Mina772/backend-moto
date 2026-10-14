import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Express } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { ALL_PERMISSIONS } from '@moto/shared';
import { api, loginAs, startTestDb, stopTestDb } from './harness.js';
import { CashRegisterModel, IdempotencyModel, ProductModel, RegisterSessionModel, SaleModel, SaleReturnModel, StockLevelModel, SyncOpModel, TerminalModel, UserModel } from '../db/models.js';
import { salesWarehouseFor } from '../modules/inventory/stock.js';
import { createSale, createReturn } from '../modules/sales/service.js';
import { accounting } from '../modules/reports/service.js';
import { seedDatabase } from './fixtures/seed.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
let sales: Awaited<ReturnType<typeof loginAs>>;
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const body = () => ({ branchId: 'br-1', customerId: null, registerSessionId: null, items: [{ productId: 'prod-1', barcode: '', sku: '', name: { ar: 'audit' }, quantity: 1, listPrice: 100, unitPrice: 100, unitCost: 60, priceTier: 'retail1' as const, discount: 0, discountPercent: 0 }], invoiceDiscount: 0, payments: [{ method: 'cash' as const, amount: 100 }], type: 'cash' as const });
const push = (u: { token: string }, type: string, payload: unknown, opId = randomUUID()) => api(app).post('/api/sync/push').set(auth(u)).send({ terminalId: 'term-audit', ops: [{ opId, type, payload, clientCreatedAt: new Date().toISOString() }] });

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin'); sales = await loginAs(app, 'nour.h');
  await TerminalModel.create({ _id: 'term-audit', code: 'T-AUDIT', name: 'Audit', branchId: 'br-1', registerId: null, createdAt: new Date().toISOString() });
  for (const branchId of ['br-1', 'br-2']) {
    await CashRegisterModel.create({ _id: `reg-audit-${branchId}`, code: `AUDIT-${branchId}`, name: { ar: 'audit' }, branchId, isActive: true, currentSessionId: null });
    await StockLevelModel.updateOne({ productId: 'prod-1', warehouseId: await salesWarehouseFor(branchId) }, { $set: { quantity: 1000, reserved: 0 } });
  }
  await ProductModel.updateOne({ _id: 'prod-1' }, { $set: { prices: { retail1: 100, retail2: 100, wholesale: 100 }, purchasePrice: 60, lastPurchaseCost: 60 } });
});
afterAll(stopTestDb);

it('refuses overwriting existing test records with fixtures', async () => {
  const count = await SaleModel.countDocuments();
  const user = await UserModel.findById(admin.user.id).lean();
  await expect(seedDatabase()).rejects.toThrow('Refusing to overwrite test records');
  expect(await SaleModel.countDocuments()).toBe(count);
  expect((await UserModel.findById(admin.user.id).lean())?.passwordHash).toBe(user?.passwordHash);
});

it('requires the operation permission and confines registers to the terminal branch', async () => {
  const payload = { registerId: 'reg-audit-br-2', openingBalance: 500, sessionId: 'sess-audit-foreign' };
  const denied = await push(sales, 'register_open', payload);
  expect(denied.body.results[0].error.code).toBe('PERMISSION_DENIED');
  const foreign = await push(admin, 'register_open', payload);
  expect(foreign.body.results[0].error.code).toBe('BRANCH_DENIED');
  expect(await RegisterSessionModel.findById(payload.sessionId)).toBeNull();
});

it('blocks unauthorized and foreign-branch returns without changing the sale', async () => {
  const sale = await createSale({ ...body(), branchId: 'br-2' }, { userId: admin.user.id, permissions: ALL_PERMISSIONS });
  const payload = { saleId: sale.id, refundMethod: 'cash', items: [{ saleItemId: sale.items[0]!.id, productId: 'prod-1', quantity: 1, unitPrice: 100, refund: 0, reason: 'defective' }] };
  expect((await push(sales, 'sale_return', payload)).body.results[0].error.code).toBe('PERMISSION_DENIED');
  expect((await push(admin, 'sale_return', payload)).body.results[0].error.code).toBe('BRANCH_DENIED');
  expect((await SaleModel.findById(sale.id).lean())?.status).toBe('completed');
});

it('commits four concurrent same-key checkouts as one sale and one durable response', async () => {
  const before = await SaleModel.countDocuments(); const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 4 }, () => api(app).post('/api/sales').set(auth(admin)).set('Idempotency-Key', key).send(body())));
  expect(results.map(r => r.status)).toEqual([201, 201, 201, 201]);
  expect(new Set(results.map(r => r.body.id)).size).toBe(1);
  expect(await SaleModel.countDocuments()).toBe(before + 1);
  const stored = await IdempotencyModel.findById(`${admin.user.id}:${key}`).lean();
  expect(stored?.state).toBe('completed');
  expect(stored?.response).toMatchObject({ id: results[0]!.body.id });
});

it('recovers a crashed reservation that never committed', async () => {
  const key = randomUUID(); const payload = body();
  await IdempotencyModel.create({ _id: `${admin.user.id}:${key}`, userId: admin.user.id, requestHash: createHash('sha256').update('/api/sales' + JSON.stringify(payload)).digest('hex'), status: 201, state: 'processing', owner: 'dead-process', startedAt: new Date(Date.now() - 180_000) });
  expect((await api(app).post('/api/sales').set(auth(admin)).set('Idempotency-Key', key).send(payload)).status).toBe(201);
});

it('commits a racing same-op withdrawal once and preserves the result on replay', async () => {
  await push(admin, 'register_open', { registerId: 'reg-audit-br-1', openingBalance: 500, sessionId: 'sess-audit' });
  const opId = randomUUID(); const payload = { sessionId: 'sess-audit', type: 'withdrawal', amount: 10 };
  const results = await Promise.all([push(admin, 'cash_movement', payload, opId), push(admin, 'cash_movement', payload, opId)]);
  expect(results.map(r => r.body.results[0].status).sort()).toEqual(['applied', 'duplicate']);
  expect((await RegisterSessionModel.findById('sess-audit').lean())?.paymentsOut).toBe(10);
  expect((await push(admin, 'cash_movement', { ...payload, amount: 20 }, opId)).body.results[0].error.code).toBe('SYNC_OP_MISMATCH');
  expect((await push(admin, 'cash_movement', payload, opId)).body.results[0].status).toBe('duplicate');
});

it('never re-applies legacy money operations with an unknown commit state', async () => {
  const opId = randomUUID();
  await SyncOpModel.create({ _id: opId, terminalId: 'term-audit', type: 'cash_movement', status: 'applying' });
  const before = (await RegisterSessionModel.findById('sess-audit').lean())?.paymentsOut;
  expect((await push(admin, 'cash_movement', { sessionId: 'sess-audit', type: 'withdrawal', amount: 10 }, opId)).body.results[0].error.code).toBe('SYNC_RECOVERY_REQUIRED');
  expect((await RegisterSessionModel.findById('sess-audit').lean())?.paymentsOut).toBe(before);
});

it('resolves local sale and duplicate-product line IDs for a return sent with its sale', async () => {
  const payload = body();
  const saleOp = { opId: randomUUID(), type: 'sale', clientCreatedAt: '2026-01-01T12:00:00Z', payload: { ...payload, items: [payload.items[0], payload.items[0]], payments: [{ method: 'cash', amount: 200 }], invoiceNumber: 'INV-AUDIT-LOCAL', localId: 'lsale-audit' } };
  const retOp = { opId: randomUUID(), type: 'sale_return', clientCreatedAt: saleOp.clientCreatedAt, payload: { saleId: 'lsale-audit', invoiceNumber: 'INV-AUDIT-LOCAL', lineIndexes: [1], refundMethod: 'cash', items: [{ saleItemId: 'si-local', productId: 'prod-1', quantity: 1, unitPrice: 100, refund: 0, reason: 'defective' }] } };
  const response = await api(app).post('/api/sync/push').set(auth(admin)).send({ terminalId: 'term-audit', ops: [saleOp, retOp] });
  expect(response.body.results.map((r: { status: string }) => r.status)).toEqual(['applied', 'applied']);
  const stored = await SaleModel.findById(response.body.results[0].serverId).lean();
  expect(stored?.items.map(i => i.returnedQty)).toEqual([0, 1]);
  const snapshot = await api(app).get('/api/sync/bootstrap').query({ branchId: 'br-1', opIds: `${saleOp.opId},${retOp.opId}` }).set(auth(admin));
  expect(snapshot.body.acknowledgedOps).toHaveLength(2);
});

it('reverses revenue and cost on the refund date even across report periods', async () => {
  const date = '2090-01-01T12:00:00.000Z'; const refundDate = '2090-02-01T12:00:00.000Z';
  const sale = await createSale({ ...body(), date }, { userId: admin.user.id, permissions: ALL_PERMISSIONS });
  await createReturn({ saleId: sale.id, date: refundDate, refundMethod: 'cash', items: [{ saleItemId: sale.items[0]!.id, productId: 'prod-1', quantity: 1, unitPrice: 100, refund: 0, reason: 'defective' }] }, { userId: admin.user.id });
  const first = await accounting({ branchId: 'br-1', from: '2090-01-01', to: '2090-01-01' });
  expect(first).toMatchObject({ netSales: 100, netProfit: 40, returns: 0 });
  const second = await accounting({ branchId: 'br-1', from: '2090-02-01', to: '2090-02-01' });
  expect(second).toMatchObject({ totalSales: 0, returns: 100, netSales: -100, cogs: -60, netProfit: -40 });
  expect(await SaleReturnModel.countDocuments({ saleId: sale.id })).toBe(1);
  expect(await accounting({ branchId: 'br-1', from: '2090-01-01', to: '2090-02-01' })).toMatchObject({ netSales: 0, cogs: 0, netProfit: 0 });
});

it('reverses discounted invoice tax together with revenue after a full refund', async () => {
  const date = '2091-01-01T12:00:00.000Z';
  await SaleModel.create({ _id: 'sale-tax-refund', invoiceNumber: 'INV-TAX-REFUND', date, branchId: 'br-1', cashierId: admin.user.id,
    items: [{ id: 'line-tax-refund', productId: 'prod-1', name: { ar: 'tax' }, quantity: 1, unitPrice: 100, unitCost: 60, listPrice: 100, priceTier: 'retail1', discount: 0, subtotal: 100, returnedQty: 0 }],
    subtotal: 100, itemDiscounts: 0, invoiceDiscount: 10, tax: 12.6, total: 102.6, paid: 102.6, remaining: 0, change: 0, payments: [{ method: 'cash', amount: 102.6 }], type: 'cash', status: 'completed' });
  await createReturn({ saleId: 'sale-tax-refund', date, refundMethod: 'cash', items: [{ saleItemId: 'line-tax-refund', productId: 'prod-1', quantity: 1, unitPrice: 100, refund: 0, reason: 'defective' }] }, { userId: admin.user.id });
  expect(await accounting({ branchId: 'br-1', from: '2091-01-01', to: '2091-01-01' })).toMatchObject({ totalSales: 102.6, returns: 102.6, netSales: 0, tax: 0, cogs: 0, grossProfit: 0, netProfit: 0 });
});
