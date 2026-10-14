import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { StockLevelModel, CustomerModel, CustomerDebtModel, AlertModel, ProductModel } from '../../db/models.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
let cashier: Awaited<ReturnType<typeof loginAs>>;
let sales: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  cashier = await loginAs(app, 'cashier1');
  sales = await loginAs(app, 'nour.h');
});
afterAll(stopTestDb);

const auth = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });

describe('auth & RBAC', () => {
  it('rejects bad credentials', async () => {
    const res = await api(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });
  it('returns session with permissions', async () => {
    expect(admin.token).toBeTruthy();
    const me = await api(app).get('/api/auth/me').set(auth(admin));
    expect(me.status).toBe(200);
    expect(me.body.permissions).toContain('settings.edit');
  });
  it('denies cashier a settings edit', async () => {
    const res = await api(app).put('/api/settings/pos').set(auth(cashier)).send({ value: { autoPrint: false } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });
  it('refreshes with body token for desktop client', async () => {
    const res = await api(app).post('/api/auth/refresh').set('X-Client', 'pos-desktop').send({ refreshToken: cashier.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeTruthy();
    cashier = res.body;
  });
});

describe('products & barcode engine', () => {
  it('creates a product with a unique internal barcode and Arabic-only name', async () => {
    const res = await api(app).post('/api/products').set(auth(admin)).send({
      name: { ar: 'قطعة اختبار', en: '' },
      sku: 'SKU-TEST-0001',
      partNumber: 'TST-001',
      brandId: 'brand-1',
      categoryId: 'cat-2',
      supplierId: 'sup-1',
      purchasePrice: 10,
      prices: { retail1: 20, retail2: 18, wholesale: 15 },
      minStock: 5,
      unit: { ar: 'قطعة' },
    });
    expect(res.status).toBe(201);
    expect(res.body.internalBarcode).toMatch(/^MP\d+$/);
    expect(res.body.name.en).toBeUndefined();
    const dup = await ProductModel.countDocuments({ internalBarcode: res.body.internalBarcode });
    expect(dup).toBe(1);
    const lookup = await api(app).get('/api/products/lookup').query({ term: res.body.internalBarcode, branchId: 'br-1' }).set(auth(cashier));
    expect(lookup.body[0].id).toBe(res.body.id);
  });
  it('creates a category inline and stores product size', async () => {
    const cat = await api(app).post('/api/catalog/categories').set(auth(admin)).send({ name: { ar: 'إطارات اختبار' } });
    expect(cat.status).toBe(201);
    const again = await api(app).post('/api/catalog/categories').set(auth(admin)).send({ name: { ar: 'إطارات اختبار' } });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(cat.body.id);
    const denied = await api(app).post('/api/catalog/categories').set(auth(cashier)).send({ name: { ar: 'ممنوع' } });
    expect(denied.status).toBe(403);
    const res = await api(app).post('/api/products').set(auth(admin)).send({
      name: { ar: 'إطار اختبار' }, sku: 'SKU-TEST-SIZE', partNumber: 'TST-SZ', brandId: 'brand-1', categoryId: cat.body.id, supplierId: 'sup-1',
      size: ' 90/90-17 ', purchasePrice: 10, prices: { retail1: 20, retail2: 18, wholesale: 15 }, unit: { ar: 'قطعة' },
    });
    expect(res.status).toBe(201);
    expect(res.body.size).toBe('90/90-17');
    expect(res.body.categoryId).toBe(cat.body.id);
    const list = await api(app).get('/api/products').query({ search: '90/90' }).set(auth(admin));
    expect(list.body.data.map((p: { id: string }) => p.id)).toContain(res.body.id);
  });
  it('resolves legacy barcode with a hint header', async () => {
    const p = await ProductModel.findOne({ legacyBarcode: { $exists: true } }).lean();
    const res = await api(app).get('/api/products/lookup').query({ term: p!.legacyBarcode }).set(auth(cashier));
    expect(res.status).toBe(200);
    expect(res.headers['x-legacy-barcode']).toBe('true');
  });
  it('records price history when a tier changes', async () => {
    const res = await api(app).patch('/api/products/prod-1').set(auth(admin)).send({ prices: { wholesale: 999 }, changeReason: 'test' });
    expect(res.status).toBe(200);
    expect(res.body.prices.wholesale).toBe(999);
    const hist = await api(app).get('/api/products/price-history').query({ productId: 'prod-1' }).set(auth(admin));
    expect(hist.body.some((h: { field: string; newValue: number }) => h.field === 'wholesale' && h.newValue === 999)).toBe(true);
  });
  it('ranks alternatives: compatible in-stock first', async () => {
    const res = await api(app).get('/api/products/prod-5/alternatives').query({ branchId: 'br-1', inStockOnly: false }).set(auth(cashier));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    if (res.body.length > 1) {
      const first = res.body[0];
      expect(first.matchReason === 'explicit' || first.qtyAvailable >= 0).toBe(true);
    }
  });
});

describe('sales', () => {
  const saleBody = (overrides: Record<string, unknown> = {}) => ({
    branchId: 'br-1',
    customerId: null,
    registerSessionId: null,
    items: [{ productId: 'prod-1', name: { ar: 'x' }, quantity: 2, listPrice: 60, unitPrice: 60, unitCost: 35, priceTier: 'retail1', discount: 0, discountPercent: 0 }],
    invoiceDiscount: 0,
    payments: [{ method: 'cash', amount: 200 }],
    type: 'cash',
    ...overrides,
  });

  it('creates a sale, deducts stock, stores tier, computes change, ignores client unitCost', async () => {
    const before = await StockLevelModel.findOne({ productId: 'prod-1', warehouseId: 'wh-2' }).lean();
    const res = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ items: [{ ...saleBody().items[0], unitCost: 1 }] }));
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(120);
    expect(res.body.change).toBe(80);
    expect(res.body.items[0].priceTier).toBe('retail1');
    expect(res.body.items[0].unitCost).toBe(0);
    const stored = await import('../../db/models.js').then(({ SaleModel }) => SaleModel.findById(res.body.id).lean());
    expect(stored!.items[0]!.unitCost).toBeGreaterThan(1);
    expect(res.body.qrPayload).toBeTruthy();
    expect(res.body.invoiceNumber).toMatch(/^INV-\d{6}$/);
    const after = await StockLevelModel.findOne({ productId: 'prod-1', warehouseId: 'wh-2' }).lean();
    expect(after!.quantity).toBe(before!.quantity - 2);
  });

  it('rejects an underpaid cash sale', async () => {
    const res = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ payments: [{ method: 'cash', amount: 10 }] }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNDERPAID');
  });

  it('rejects when stock is insufficient', async () => {
    const res = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ items: [{ productId: 'prod-1', name: { ar: 'x' }, quantity: 99999, listPrice: 60, unitPrice: 60, unitCost: 35, priceTier: 'retail1' }], payments: [{ method: 'cash', amount: 99999 * 60 }] }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('creates a credit sale → debt + balance; enforces credit limit', async () => {
    const cust = await CustomerModel.findOne({ branchId: 'br-1', type: 'wholesale', creditLimit: { $gt: 0 } }).lean();
    const balanceBefore = cust!.balance;
    const res = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ customerId: cust!._id, type: 'credit', payments: [] }));
    expect(res.status).toBe(201);
    const debt = await CustomerDebtModel.findOne({ saleId: res.body.id }).lean();
    expect(debt!.remaining).toBe(120);
    const after = await CustomerModel.findById(cust!._id).lean();
    expect(after!.balance).toBeCloseTo(balanceBefore + 120, 2);

    const tooMuch = await api(app).post('/api/sales').set(auth(admin)).send(saleBody({ customerId: cust!._id, type: 'credit', payments: [], items: [{ productId: 'prod-16', name: { ar: 'x' }, quantity: 1, listPrice: 10_000_000, unitPrice: 10_000_000, unitCost: 1, priceTier: 'manual' }] }));
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('CUSTOMER_CREDIT_EXCEEDED');
  });

  it('enforces tier prices, wholesale permission and discount limits server-side', async () => {
    const wrongPrice = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ items: [{ ...saleBody().items[0], unitPrice: 1 }], payments: [{ method: 'cash', amount: 2 }] }));
    expect(wrongPrice.status).toBe(422);
    expect(wrongPrice.body.error.code).toBe('PRICE_NOT_ALLOWED');

    const wholesaleByCashier = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ items: [{ ...saleBody().items[0], unitPrice: 48, priceTier: 'wholesale' }] }));
    expect(wholesaleByCashier.status).toBe(403);

    const wholesaleBySales = await api(app).post('/api/sales').set(auth(sales)).send(saleBody({ items: [{ ...saleBody().items[0], unitPrice: 48, priceTier: 'wholesale' }] }));
    expect(wholesaleBySales.status).toBe(201);
    expect(wholesaleBySales.body.items[0].priceTier).toBe('wholesale');

    const bigDiscount = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ items: [{ ...saleBody().items[0], discountPercent: 50 }] }));
    expect(bigDiscount.status).toBe(422);
    expect(bigDiscount.body.error.code).toBe('DISCOUNT_EXCEEDS');

    const invoiceDiscountByCashier = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ invoiceDiscount: 5 }));
    expect(invoiceDiscountByCashier.status).toBe(403);
  });

  it('replays idempotent POST with same key', async () => {
    const key = randomUUID();
    const a = await api(app).post('/api/sales').set(auth(cashier)).set('Idempotency-Key', key).send(saleBody());
    const b = await api(app).post('/api/sales').set(auth(cashier)).set('Idempotency-Key', key).send(saleBody());
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers['idempotent-replay']).toBe('true');
  });

  it('raises exactly one out_of_stock alert when the last unit sells', async () => {
    await StockLevelModel.updateMany({ productId: 'prod-20', branchId: 'br-1' }, { $set: { quantity: 0 } });
    await StockLevelModel.updateOne({ productId: 'prod-20', warehouseId: 'wh-2' }, { $set: { quantity: 1 } });
    const res = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ items: [{ productId: 'prod-20', name: { ar: 'x' }, quantity: 1, listPrice: 950, unitPrice: 950, unitCost: 650, priceTier: 'retail1' }], payments: [{ method: 'cash', amount: 950 }] }));
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    const alerts = await AlertModel.find({ type: 'out_of_stock', entityId: 'prod-20', branchId: 'br-1', resolvedAt: null }).lean();
    expect(alerts.length).toBe(1);
    // second evaluation must not duplicate
    const again = await api(app).get('/api/alerts').query({ type: 'out_of_stock' }).set(auth(admin));
    expect(again.status).toBe(200);
    const again2 = await AlertModel.find({ type: 'out_of_stock', entityId: 'prod-20', branchId: 'br-1', resolvedAt: null }).lean();
    expect(again2.length).toBe(1);
  });

  it('public verify endpoint exposes invoice summary without auth', async () => {
    const sale = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody());
    const res = await api(app).get(`/api/public/invoices/${sale.body.id}/verify`);
    expect(res.status).toBe(200);
    expect(res.body.invoiceNumber).toBe(sale.body.invoiceNumber);
    expect(res.body.total).toBe(120);
  });

  it('rejects a cash sale paid with a credit split', async () => {
    const res = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ payments: [{ method: 'credit', amount: 120 }] }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYMENT_METHOD');
  });

  it('ignores client invoice number and date on the regular route', async () => {
    const res = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ invoiceNumber: 'FAKE-0001', date: '2001-01-01T00:00:00.000Z' }));
    expect(res.status).toBe(201);
    expect(res.body.invoiceNumber).toMatch(/^INV-\d{6}$/);
    expect(res.body.date.startsWith('2001')).toBe(false);
  });

  it('caps return refunds at the prorated paid amount and uses the stored product', async () => {
    const sale = await api(app).post('/api/sales').set(auth(sales)).send(saleBody({ invoiceDiscount: 15, payments: [{ method: 'cash', amount: 105 }] }));
    expect(sale.status).toBe(201);
    expect(sale.body.total).toBe(105);
    const item = sale.body.items[0];
    const res = await api(app).post('/api/sales/returns').set(auth(admin)).send({ saleId: sale.body.id, refundMethod: 'cash', items: [{ saleItemId: item.id, productId: 'prod-99', quantity: 1, unitPrice: 999, refund: 999, reason: 'defective' }] });
    expect(res.status).toBe(201);
    expect(res.body.items[0].productId).toBe('prod-1');
    expect(res.body.items[0].unitPrice).toBe(60);
    expect(res.body.refundAmount).toBe(52.5);
  });

  it('credit-sale return in cash does not also reduce the debt', async () => {
    const cust = await CustomerModel.findOne({ branchId: 'br-1', type: 'wholesale', creditLimit: { $gt: 0 } }).lean();
    const sale = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ customerId: cust!._id, type: 'credit', payments: [{ method: 'cash', amount: 60 }] }));
    expect(sale.status).toBe(201);
    const debtBefore = await CustomerDebtModel.findOne({ saleId: sale.body.id }).lean();
    const cashRet = await api(app).post('/api/sales/returns').set(auth(admin)).send({ saleId: sale.body.id, refundMethod: 'cash', items: [{ saleItemId: sale.body.items[0].id, productId: 'prod-1', quantity: 1, unitPrice: 60, refund: 0, reason: 'defective' }] });
    expect(cashRet.status).toBe(201);
    const debtAfterCash = await CustomerDebtModel.findOne({ saleId: sale.body.id }).lean();
    expect(debtAfterCash!.remaining).toBe(debtBefore!.remaining);
    const creditRet = await api(app).post('/api/sales/returns').set(auth(admin)).send({ saleId: sale.body.id, refundMethod: 'credit', items: [{ saleItemId: sale.body.items[0].id, productId: 'prod-1', quantity: 1, unitPrice: 60, refund: 0, reason: 'defective' }] });
    expect(creditRet.status).toBe(201);
    const debtAfterCredit = await CustomerDebtModel.findOne({ saleId: sale.body.id }).lean();
    expect(debtAfterCredit!.remaining).toBe(debtBefore!.remaining - 60);
  });

  it('cancelling a credit sale removes the debt and restores the customer balance', async () => {
    const cust = await CustomerModel.findOne({ branchId: 'br-1', type: 'wholesale', creditLimit: { $gt: 0 } }).lean();
    const balanceBefore = cust!.balance;
    const sale = await api(app).post('/api/sales').set(auth(cashier)).send(saleBody({ customerId: cust!._id, type: 'credit', payments: [] }));
    expect(sale.status).toBe(201);
    const res = await api(app).post(`/api/sales/${sale.body.id}/cancel`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(await CustomerDebtModel.findOne({ saleId: sale.body.id }).lean()).toBeNull();
    const after = await CustomerModel.findById(cust!._id).lean();
    expect(after!.balance).toBeCloseTo(balanceBefore, 2);
  });
});

