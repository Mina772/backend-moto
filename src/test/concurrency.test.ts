/**
 * Phase 4 — integration failure modes: retried requests, duplicate submissions and
 * simultaneous writes to the same stock, drawer and invoice counter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { api, loginAs, startTestDb, stopTestDb } from '../test/harness.js';
import { PurchaseModel, RegisterSessionModel, SaleModel, StockLevelModel, WarehouseModel } from '../db/models.js';
import { salesWarehouseFor } from '../modules/inventory/stock.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
let shopWarehouse: string;

const auth = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });

const saleBody = (overrides: Record<string, unknown> = {}) => ({
  branchId: 'br-1',
  customerId: null,
  registerSessionId: null,
  items: [{ productId: 'prod-1', name: { ar: 'x' }, quantity: 5, listPrice: 60, unitPrice: 60, unitCost: 35, priceTier: 'retail1', discount: 0, discountPercent: 0 }],
  invoiceDiscount: 0,
  payments: [{ method: 'cash', amount: 300 }],
  type: 'cash',
  ...overrides,
});

async function setStock(productId: string, quantity: number) {
  await StockLevelModel.updateOne({ productId, warehouseId: shopWarehouse }, { $set: { quantity, reserved: 0 } }, { upsert: true });
}
const stockOf = async (productId: string) => (await StockLevelModel.findOne({ productId, warehouseId: shopWarehouse }).lean())!.quantity;

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  shopWarehouse = await salesWarehouseFor('br-1');
}, 60_000);
afterAll(stopTestDb);

describe('simultaneous checkout', () => {
  it('lets exactly one of five racing sales take the last units', async () => {
    await setStock('prod-1', 5);
    const attempts = await Promise.all(Array.from({ length: 5 }, () => api(app).post('/api/sales').set(auth(admin)).send(saleBody())));

    const created = attempts.filter((r) => r.status === 201);
    const rejected = attempts.filter((r) => r.status === 422 && r.body.error?.code === 'INSUFFICIENT_STOCK');
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    expect(await stockOf('prod-1')).toBe(0);
    expect(await SaleModel.countDocuments({ _id: { $in: created.map((r) => r.body.id as string) } })).toBe(1);
  });

  it('leaves no sale document behind when stock runs out', async () => {
    await setStock('prod-2', 1);
    const before = await SaleModel.countDocuments({});
    const res = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({
      items: [{ productId: 'prod-2', name: { ar: 'y' }, quantity: 9, listPrice: 60, unitPrice: 60, unitCost: 35, priceTier: 'retail1', discount: 0, discountPercent: 0 }],
      payments: [{ method: 'cash', amount: 600 }],
    }));
    expect(res.status).toBe(422);
    expect(await SaleModel.countDocuments({})).toBe(before);
    expect(await stockOf('prod-2')).toBe(1);
  });

  it('hands every racing sale its own invoice number', async () => {
    await setStock('prod-3', 500);
    const body = saleBody({ items: [{ productId: 'prod-3', name: { ar: 'z' }, quantity: 1, listPrice: 60, unitPrice: 60, unitCost: 35, priceTier: 'retail1', discount: 0, discountPercent: 0 }], payments: [{ method: 'cash', amount: 300 }] });
    const results = await Promise.all(Array.from({ length: 8 }, () => api(app).post('/api/sales').set(auth(admin)).send(body)));
    const numbers = results.filter((r) => r.status === 201).map((r) => r.body.invoiceNumber as string);
    expect(numbers).toHaveLength(8);
    expect(new Set(numbers).size).toBe(8);
  });
});

describe('retried requests', () => {
  it('replays a checkout carrying the same idempotency key instead of selling twice', async () => {
    await setStock('prod-4', 100);
    const key = randomUUID();
    const body = saleBody({ items: [{ productId: 'prod-4', name: { ar: 'k' }, quantity: 2, listPrice: 60, unitPrice: 60, unitCost: 35, priceTier: 'retail1', discount: 0, discountPercent: 0 }], payments: [{ method: 'cash', amount: 300 }] });

    const first = await api(app).post('/api/sales').set(auth(admin)).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    const second = await api(app).post('/api/sales').set(auth(admin)).set('Idempotency-Key', key).send(body);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(await stockOf('prod-4')).toBe(98);
    expect(await SaleModel.countDocuments({ invoiceNumber: first.body.invoiceNumber })).toBe(1);
  });

  it('refuses to reuse an idempotency key for a different payload', async () => {
    const key = randomUUID();
    await setStock('prod-5', 100);
    const first = await api(app).post('/api/sales').set(auth(admin)).set('Idempotency-Key', key).send(saleBody({ items: [{ productId: 'prod-5', name: { ar: 'm' }, quantity: 1, listPrice: 60, unitPrice: 60, unitCost: 35, priceTier: 'retail1', discount: 0, discountPercent: 0 }], payments: [{ method: 'cash', amount: 300 }] }));
    expect(first.status).toBe(201);
    const second = await api(app).post('/api/sales').set(auth(admin)).set('Idempotency-Key', key).send(saleBody({ items: [{ productId: 'prod-5', name: { ar: 'm' }, quantity: 4, listPrice: 60, unitPrice: 60, unitCost: 35, priceTier: 'retail1', discount: 0, discountPercent: 0 }], payments: [{ method: 'cash', amount: 300 }] }));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
    expect(await stockOf('prod-5')).toBe(99);
  });

  it('never returns more than was sold when the same return is submitted twice', async () => {
    await setStock('prod-6', 50);
    const sale = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({
      items: [{ productId: 'prod-6', name: { ar: 'r' }, quantity: 2, listPrice: 60, unitPrice: 60, unitCost: 35, priceTier: 'retail1', discount: 0, discountPercent: 0 }],
      payments: [{ method: 'cash', amount: 300 }],
    }));
    expect(sale.status).toBe(201);
    const body = { saleId: sale.body.id, refundMethod: 'cash', items: [{ saleItemId: sale.body.items[0].id, productId: 'prod-6', quantity: 2, unitPrice: 60, refund: 0, reason: 'defective' }] };

    const [a, b] = await Promise.all([
      api(app).post('/api/sales/returns').set(auth(admin)).send(body),
      api(app).post('/api/sales/returns').set(auth(admin)).send(body),
    ]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);

    const stored = await SaleModel.findById(sale.body.id).lean();
    expect(stored!.items[0]!.returnedQty).toBe(2);
    expect(await stockOf('prod-6')).toBe(50);
  });

  it('never receives more than was ordered when receiving is retried', async () => {
    const warehouse = (await WarehouseModel.findOne({ branchId: 'br-1', isActive: true }).lean())!._id;
    const po = await api(app).post('/api/purchases').set(auth(admin)).send({
      supplierId: 'sup-1', supplierInvoiceNumber: 'SINV-RETRY', branchId: 'br-1', warehouseId: warehouse,
      expectedDate: new Date().toISOString(), items: [{ productId: 'prod-7', quantity: 6, unitCost: 20 }], discount: 0, paid: 0, status: 'ordered',
    });
    expect(po.status).toBe(201);
    const before = (await StockLevelModel.findOne({ productId: 'prod-7', warehouseId: warehouse }).lean())?.quantity ?? 0;
    const receive = () => api(app).post(`/api/purchases/${po.body.id}/receive`).set(auth(admin)).send({ quantities: { [po.body.items[0].id]: 6 } });

    expect((await receive()).status).toBe(200);
    expect((await receive()).status).toBe(200);

    const stored = await PurchaseModel.findById(po.body.id).lean();
    expect(stored!.items[0]!.receivedQty).toBe(6);
    expect((await StockLevelModel.findOne({ productId: 'prod-7', warehouseId: warehouse }).lean())!.quantity).toBe(before + 6);
  });
});

describe('cash drawer under contention', () => {
  it('closes a session once even when the request is sent twice', async () => {
    const opened = await api(app).post('/api/cash/sessions').set(auth(admin)).send({ registerId: 'reg-5', openingBalance: 300 });
    expect(opened.status).toBe(201);
    const [a, b] = await Promise.all([
      api(app).post(`/api/cash/sessions/${opened.body.id}/close`).set(auth(admin)).send({ actualCash: 300 }),
      api(app).post(`/api/cash/sessions/${opened.body.id}/close`).set(auth(admin)).send({ actualCash: 300 }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = await RegisterSessionModel.findById(opened.body.id).lean();
    expect(stored!.status).toBe('closed');
    expect(stored!.difference).toBe(0);
    expect(stored!.closedAt).toBeTruthy();
  });

  it('keeps the drawer total exact across simultaneous cash movements', async () => {
    const opened = await api(app).post('/api/cash/sessions').set(auth(admin)).send({ registerId: 'reg-7', openingBalance: 1000 });
    expect(opened.status).toBe(201);
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      api(app).post(`/api/cash/sessions/${opened.body.id}/movements`).set(auth(admin)).send({ type: 'expense', amount: 10 })));
    expect(results.every((r) => r.status === 201)).toBe(true);

    const stored = await RegisterSessionModel.findById(opened.body.id).lean();
    expect(stored!.expenses).toBe(60);
    expect(stored!.expectedCash).toBe(940);
    expect((stored!.movements ?? []).filter((m) => m.type === 'expense')).toHaveLength(6);
  });
});
