/**
 * Phase 5 — negative, boundary and edge cases on the money- and stock-moving endpoints.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { round2 } from '@moto/shared';
import { api, loginAs, startTestDb, stopTestDb } from '../test/harness.js';
import { ProductModel, SaleModel, StockLevelModel } from '../db/models.js';
import { salesWarehouseFor } from '../modules/inventory/stock.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
let cashier: Awaited<ReturnType<typeof loginAs>>;
let shopWarehouse: string;

const auth = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });
const item = (overrides: Record<string, unknown> = {}) => ({
  productId: 'prod-1', name: { ar: 'x' }, quantity: 1, listPrice: 60, unitPrice: 60, unitCost: 35, priceTier: 'retail1', discount: 0, discountPercent: 0, ...overrides,
});
const saleBody = (overrides: Record<string, unknown> = {}) => ({
  branchId: 'br-1', customerId: null, registerSessionId: null, items: [item()], invoiceDiscount: 0,
  payments: [{ method: 'cash', amount: 1000 }], type: 'cash', ...overrides,
});

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  cashier = await loginAs(app, 'cashier1');
  shopWarehouse = await salesWarehouseFor('br-1');
  await StockLevelModel.updateMany({ warehouseId: shopWarehouse }, { $set: { quantity: 5000 } });
}, 60_000);
afterAll(stopTestDb);

describe('invalid sale input', () => {
  it('rejects an empty cart', async () => {
    expect((await api(app).post('/api/sales').set(auth(admin)).send(saleBody({ items: [] }))).status).toBe(400);
  });

  it('rejects a zero or negative quantity', async () => {
    for (const quantity of [0, -3]) {
      expect((await api(app).post('/api/sales').set(auth(admin)).send(saleBody({ items: [item({ quantity })] }))).status).toBe(400);
    }
  });

  it('rejects a negative unit price or a negative discount', async () => {
    expect((await api(app).post('/api/sales').set(auth(admin)).send(saleBody({ items: [item({ unitPrice: -60 })] }))).status).toBe(400);
    expect((await api(app).post('/api/sales').set(auth(admin)).send(saleBody({ items: [item({ discount: -10 })] }))).status).toBe(400);
  });

  it('rejects malformed bodies and unknown products', async () => {
    expect((await api(app).post('/api/sales').set(auth(admin)).send({ branchId: 'br-1' })).status).toBe(400);
    expect((await api(app).post('/api/sales').set(auth(admin)).send(saleBody({ items: [item({ quantity: 'two' })] }))).status).toBe(400);
    const unknown = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({ items: [item({ productId: 'prod-does-not-exist' })] }));
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('rejects a customer that does not exist', async () => {
    const res = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({ customerId: 'cust-nope', type: 'credit', payments: [] }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CUSTOMER_NOT_FOUND');
  });

  it('rejects a sale booked against a closed register session', async () => {
    const opened = await api(app).post('/api/cash/sessions').set(auth(admin)).send({ registerId: 'reg-2', openingBalance: 0 });
    expect(opened.status).toBe(201);
    expect((await api(app).post(`/api/cash/sessions/${opened.body.id}/close`).set(auth(admin)).send({ actualCash: 0 })).status).toBe(200);
    const res = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({ registerSessionId: opened.body.id }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SESSION_CLOSED');
  });
});

describe('discount boundaries', () => {
  it('never produces an invoice worth less than nothing', async () => {
    const before = await SaleModel.countDocuments({});
    const viaItemDiscount = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({
      items: [item({ unitPrice: 0, quantity: 1, discount: 500 })],
      payments: [],
    }));
    expect(viaItemDiscount.status).toBe(422);

    const viaInvoiceDiscount = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({
      items: [item({ unitPrice: 100, quantity: 1, discount: 100, discountPercent: 100 })],
      invoiceDiscount: 100,
      payments: [],
    }));
    expect(viaInvoiceDiscount.status).toBe(422);
    expect(await SaleModel.countDocuments({})).toBe(before);
  });

  it('caps a cashier at the configured discount percentage', async () => {
    const res = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ items: [item({ discount: 59, discountPercent: 98 })] }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DISCOUNT_EXCEEDS');
  });

  it('refuses an invoice discount to a cashier who may not give one', async () => {
    const res = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ invoiceDiscount: 5 }));
    expect(res.status).toBe(403);
  });

  it('accepts a discount exactly on the limit', async () => {
    const settings = await api(app).get('/api/settings').set(auth(admin));
    const max = settings.body.pos.maxDiscountPercent as number;
    const discount = round2((60 * max) / 100);
    const res = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ items: [item({ discount, discountPercent: max })] }));
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(round2(60 - discount));
  });
});

describe('money precision', () => {
  it('keeps thirds of a pound adding up', async () => {
    await ProductModel.updateOne({ _id: 'prod-9' }, { $set: { 'prices.retail1': 0.33 } });
    const res = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({
      items: [item({ productId: 'prod-9', unitPrice: 0.33, listPrice: 0.33, quantity: 3 })],
      payments: [{ method: 'cash', amount: 1 }],
    }));
    expect(res.status).toBe(201);
    expect(res.body.subtotal).toBe(0.99);
    expect(res.body.total).toBe(0.99);
    expect(res.body.change).toBe(0.01);
  });

  it('rounds a half-piastre line the way a human would', async () => {
    const res = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({
      items: [item({ unitPrice: 10.005, listPrice: 10.005, quantity: 1, discountPercent: 50, discount: 0 })],
      payments: [{ method: 'cash', amount: 20 }],
    }));
    expect(res.status).toBe(201);
    expect(res.body.items[0].discount).toBe(5);
    expect(res.body.total).toBe(5.01);
  });

  it('survives a 150-line invoice without drifting', async () => {
    const items = Array.from({ length: 150 }, () => item({ unitPrice: 60, quantity: 1 }));
    const res = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({ items, payments: [{ method: 'cash', amount: 9000 }] }));
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(150);
    expect(res.body.total).toBe(9000);
    expect(res.body.change).toBe(0);
  });
});

describe('return boundaries', () => {
  it('refuses a return of more than was bought, and a second return of the rest', async () => {
    const sale = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({ items: [item({ productId: 'prod-10', quantity: 2 })] }));
    expect(sale.status).toBe(201);
    const line = sale.body.items[0];

    const tooMany = await api(app).post('/api/sales/returns').set(auth(admin)).send({
      saleId: sale.body.id, refundMethod: 'cash',
      items: [{ saleItemId: line.id, productId: 'prod-10', quantity: 3, unitPrice: 60, refund: 0, reason: 'defective' }],
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('RETURN_QTY_EXCEEDED');

    const body = { saleId: sale.body.id, refundMethod: 'cash', items: [{ saleItemId: line.id, productId: 'prod-10', quantity: 2, unitPrice: 60, refund: 0, reason: 'defective' }] };
    expect((await api(app).post('/api/sales/returns').set(auth(admin)).send(body)).status).toBe(201);
    expect((await api(app).post('/api/sales/returns').set(auth(admin)).send(body)).status).toBe(400);
  });

  it('blocks ambiguous paid cancellation and refuses a duplicate return after explicit reversal', async () => {
    const sale = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({ items: [item({ productId: 'prod-11' })] }));
    const ambiguous = await api(app).post(`/api/sales/${sale.body.id}/cancel`).set(auth(admin));
    expect(ambiguous.status).toBe(409); expect(ambiguous.body.error.code).toBe('REFUND_METHOD_REQUIRED');
    expect((await api(app).post(`/api/sales/${sale.body.id}/cancel`).set(auth(admin)).send({ refundMethod: 'cash' })).status).toBe(200);
    const res = await api(app).post('/api/sales/returns').set(auth(admin)).send({
      saleId: sale.body.id, refundMethod: 'cash',
      items: [{ saleItemId: sale.body.items[0].id, productId: 'prod-11', quantity: 1, unitPrice: 60, refund: 0, reason: 'defective' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RETURN_QTY_EXCEEDED');
  });

  it('caps an inflated refund request at the prorated share', async () => {
    const sale = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({ items: [item({ productId: 'prod-12', quantity: 1 })] }));
    const res = await api(app).post('/api/sales/returns').set(auth(admin)).send({
      saleId: sale.body.id, refundMethod: 'cash',
      items: [{ saleItemId: sale.body.items[0].id, productId: 'prod-12', quantity: 1, unitPrice: 60, refund: 99999, reason: 'defective' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.refundAmount).toBe(60);
  });
});

describe('tokens and permissions', () => {
  it('turns away missing, malformed and forged tokens', async () => {
    expect((await api(app).get('/api/sales')).status).toBe(401);
    expect((await api(app).get('/api/sales').set({ Authorization: 'Bearer not-a-jwt' })).status).toBe(401);
    expect((await api(app).get('/api/sales').set({ Authorization: `Bearer ${admin.token}tampered` })).status).toBe(401);
    expect((await api(app).get('/api/sales').set({ Authorization: admin.token })).status).toBe(401);
  });

  it('refuses a refresh token used as an access token', async () => {
    expect((await api(app).get('/api/sales').set({ Authorization: `Bearer ${admin.refreshToken}` })).status).toBe(401);
  });

  it('keeps a cashier out of the endpoints their role excludes', async () => {
    const denied = [
      ['get', '/api/reports/accounting?from=2026-01-01&to=2026-12-31'],
      ['get', '/api/audit'],
      ['post', '/api/products'],
      ['post', '/api/transfers'],
      ['post', '/api/purchases'],
    ] as const;
    for (const [method, url] of denied) {
      const res = method === 'get' ? await api(app).get(url).set(auth(cashier)) : await api(app).post(url).set(auth(cashier)).send({});
      expect([401, 403]).toContain(res.status);
    }
  });

  it('never leaks password hashes or refresh tokens', async () => {
    const me = await api(app).get('/api/auth/me').set(auth(admin));
    expect(me.status).toBe(200);
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|refreshTokens|\$2[aby]\$/);
    const users = await api(app).get('/api/users').set(auth(admin));
    if (users.status === 200) expect(JSON.stringify(users.body)).not.toMatch(/passwordHash|refreshTokens|\$2[aby]\$/);
  });
});

describe('query boundaries', () => {
  it('bounds the page size and rejects nonsense paging', async () => {
    const big = await api(app).get('/api/sales?pageSize=100000').set(auth(admin));
    expect(big.status).toBe(400);
    expect((await api(app).get('/api/sales?page=0').set(auth(admin))).status).toBe(400);
    expect((await api(app).get('/api/sales?page=abc').set(auth(admin))).status).toBe(400);
    const ok = await api(app).get('/api/sales?pageSize=500').set(auth(admin));
    expect(ok.status).toBe(200);
    expect(ok.body.data.length).toBeLessThanOrEqual(500);
  });

  it('treats a search term with regex characters as plain text', async () => {
    const res = await api(app).get('/api/products?search=.*').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('rejects a backwards date range with a validation error', async () => {
    const res = await api(app).get('/api/sales?from=2026-12-31&to=2026-01-01').set(auth(admin));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
  });

  it('includes the whole of the last day when the range is date-only', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await api(app).get(`/api/sales?from=${today}&to=${today}&pageSize=500`).set(auth(admin));
    expect(res.status).toBe(200);
    const sameDay = await SaleModel.countDocuments({ date: { $gte: today, $lte: `${today}T23:59:59.999Z` } });
    expect(res.body.total).toBe(sameDay);
  });
});
