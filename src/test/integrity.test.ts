/**
 * Phase 6 — data integrity. Every assertion here recomputes the expected value from the
 * source records instead of trusting the figure the application stored.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { round2 } from '@moto/shared';
import { api, loginAs, startTestDb, stopTestDb } from '../test/harness.js';
import {
  CustomerDebtModel, CustomerModel, CustomerPaymentModel, ProductModel, PurchaseModel, PurchaseReturnModel,
  RegisterSessionModel, SaleModel, SaleReturnModel, StockLevelModel, StockMovementModel, SupplierModel, WarehouseModel,
} from '../db/models.js';
import { getSettings } from '../modules/settings/service.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
let sessionId: string;
let levelsBefore: Map<string, number>;
let movementIdsBefore: Set<string>;

const auth = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });
const key = () => ({ 'Idempotency-Key': Math.random().toString(36).slice(2) });

/** Runs one of every money- or stock-moving operation so the invariants below have something to check. */
async function exerciseTheSystem() {
  const warehouse = (await WarehouseModel.findOne({ branchId: 'br-1', isActive: true }).lean())!._id;

  const session = await api(app).post('/api/cash/sessions').set(auth(admin)).set(key()).send({ registerId: 'reg-2', openingBalance: 1000 });
  expect(session.status).toBe(201);
  sessionId = session.body.id;

  const cashSale = await api(app).post('/api/sales').set(auth(admin)).set(key()).send({
    branchId: 'br-1', customerId: null, registerSessionId: sessionId,
    items: [{ productId: 'prod-1', name: { ar: 'x' }, quantity: 2, listPrice: 60, unitPrice: 60, unitCost: 35, priceTier: 'retail1', discount: 0, discountPercent: 0 }],
    invoiceDiscount: 0, payments: [{ method: 'cash', amount: 200 }], type: 'cash',
  });
  expect(cashSale.status).toBe(201);

  const ret = await api(app).post('/api/sales/returns').set(auth(admin)).set(key()).send({
    saleId: cashSale.body.id, refundMethod: 'cash',
    items: [{ saleItemId: cashSale.body.items[0].id, productId: 'prod-1', quantity: 1, unitPrice: 60, refund: 0, reason: 'defective' }],
  });
  expect(ret.status).toBe(201);

  const customer = (await CustomerModel.findOne({ creditLimit: { $gt: 0 }, isActive: true }).sort({ creditLimit: -1 }).lean())!;
  const creditSale = await api(app).post('/api/sales').set(auth(admin)).set(key()).send({
    branchId: 'br-1', customerId: customer._id, registerSessionId: sessionId,
    items: [{ productId: 'prod-2', name: { ar: 'y' }, quantity: 3, listPrice: 80, unitPrice: 80, unitCost: 40, priceTier: 'retail1', discount: 0, discountPercent: 0 }],
    invoiceDiscount: 0, payments: [{ method: 'cash', amount: 50 }], type: 'credit',
  });
  expect(creditSale.status).toBe(201);

  const payment = await api(app).post('/api/debts/payments').set(auth(admin)).set(key()).send({
    customerId: customer._id, debtId: `debt-${creditSale.body.id}`, amount: 40, method: 'cash', branchId: 'br-1',
  });
  expect(payment.status).toBe(201);

  const po = await api(app).post('/api/purchases').set(auth(admin)).send({
    supplierId: 'sup-2', supplierInvoiceNumber: 'SINV-INTEG', branchId: 'br-1', warehouseId: warehouse,
    expectedDate: new Date().toISOString(), items: [{ productId: 'prod-3', quantity: 10, unitCost: 25 }], discount: 0, paid: 100, status: 'ordered',
  });
  expect(po.status).toBe(201);
  expect((await api(app).post(`/api/purchases/${po.body.id}/receive`).set(auth(admin)).send({ quantities: { [po.body.items[0].id]: 10 } })).status).toBe(200);
  expect((await api(app).post('/api/purchases/returns').set(auth(admin)).send({ purchaseId: po.body.id, items: [{ productId: 'prod-3', quantity: 2, unitCost: 25 }], reason: 'damaged' })).status).toBe(201);
  expect((await api(app).post('/api/purchases/payments').set(auth(admin)).send({ supplierId: 'sup-2', purchaseId: po.body.id, amount: 60, method: 'cash', reference: '' })).status).toBe(201);

  expect((await api(app).post('/api/inventory/adjustments').set(auth(admin)).send({
    branchId: 'br-1', warehouseId: warehouse, productId: 'prod-4', direction: 'increase', quantity: 7, reason: 'found',
  })).status).toBe(201);

  const sourceMain = (await WarehouseModel.findOne({ branchId: 'br-1', isMain: true }).lean())!._id;
  const stocked = (await StockLevelModel.findOne({ warehouseId: sourceMain, quantity: { $gte: 5 } }).lean())!;
  const transfer = await api(app).post('/api/transfers').set(auth(admin)).send({
    sourceBranchId: 'br-1', destinationBranchId: 'br-2', items: [{ productId: stocked.productId, requestedQty: 3 }], submit: true,
  });
  expect(transfer.status).toBe(201);
  for (const next of ['approved', 'sent', 'received', 'completed']) {
    expect((await api(app).post(`/api/transfers/${transfer.body.id}/advance`).set(auth(admin)).send({ next })).status).toBe(200);
  }

  expect((await api(app).post(`/api/cash/sessions/${sessionId}/movements`).set(auth(admin)).set(key()).send({ type: 'expense', amount: 35, notes: 'integrity' })).status).toBe(201);
}

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  levelsBefore = new Map((await StockLevelModel.find().lean()).map((l) => [l._id, l.quantity]));
  movementIdsBefore = new Set((await StockMovementModel.find().select('_id').lean()).map((m) => m._id));
  await exerciseTheSystem();
}, 60_000);
afterAll(stopTestDb);

describe('stock ledger', () => {
  it('every stock level moved by exactly the sum of its new movements', async () => {
    const newMovements = (await StockMovementModel.find().lean()).filter((m) => !movementIdsBefore.has(m._id));
    expect(newMovements.length).toBeGreaterThan(0);

    const expectedDelta = new Map<string, number>();
    for (const m of newMovements) {
      const id = `${m.productId}@${m.warehouseId}`;
      expectedDelta.set(id, round2((expectedDelta.get(id) ?? 0) + m.quantity));
    }

    const mismatches: string[] = [];
    for (const level of await StockLevelModel.find().lean()) {
      const id = `${level.productId}@${level.warehouseId}`;
      const actual = round2(level.quantity - (levelsBefore.get(level._id) ?? 0));
      const expected = expectedDelta.get(id) ?? 0;
      if (Math.abs(actual - expected) > 0.001) mismatches.push(`${id}: level moved ${actual}, movements say ${expected}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('records previousStock → newStock consistently on every new movement', async () => {
    const bad = (await StockMovementModel.find().lean())
      .filter((m) => !movementIdsBefore.has(m._id))
      .filter((m) => Math.abs(round2(m.previousStock + m.quantity) - m.newStock) > 0.001)
      .map((m) => `${m._id} ${m.previousStock}+${m.quantity}≠${m.newStock}`);
    expect(bad).toEqual([]);
  });
});

describe('sale arithmetic', () => {
  it('recomputes every sale total from its own line items', async () => {
    const settings = await getSettings();
    const bad: string[] = [];
    for (const s of await SaleModel.find({ status: { $ne: 'held' } }).lean()) {
      const subtotal = round2(s.items.reduce((a, i) => a + i.unitPrice * i.quantity, 0));
      const itemDiscounts = round2(s.items.reduce((a, i) => a + i.discount, 0));
      const taxable = round2(subtotal - itemDiscounts - s.invoiceDiscount);
      const tax = settings.invoice.showTax ? round2((taxable * settings.invoice.taxRate) / 100) : 0;
      const total = round2(taxable + tax);
      if (Math.abs(subtotal - s.subtotal) > 0.011 || Math.abs(itemDiscounts - s.itemDiscounts) > 0.011 || Math.abs(total - s.total) > 0.011) {
        bad.push(`${s.invoiceNumber}: stored ${s.subtotal}/${s.itemDiscounts}/${s.total}, recomputed ${subtotal}/${itemDiscounts}/${total}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('keeps every line subtotal equal to price × quantity − discount', async () => {
    const bad: string[] = [];
    for (const s of await SaleModel.find().lean()) {
      for (const i of s.items) {
        if (Math.abs(round2(i.unitPrice * i.quantity - i.discount) - i.subtotal) > 0.011) bad.push(`${s.invoiceNumber}/${i.id}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('never carries a paid + remaining that disagrees with the total', async () => {
    const bad = (await SaleModel.find({ status: { $in: ['completed', 'partially_returned', 'returned'] } }).lean())
      .filter((s) => round2(s.paid + s.remaining) - s.total > 0.011)
      .map((s) => `${s.invoiceNumber}: ${s.paid}+${s.remaining} > ${s.total}`);
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe('returns', () => {
  it('matches each sale item\u2019s returnedQty to the recorded return documents', async () => {
    const returnedBySaleItem = new Map<string, number>();
    for (const r of await SaleReturnModel.find().lean()) {
      for (const i of r.items) returnedBySaleItem.set(`${r.saleId}/${i.saleItemId}`, (returnedBySaleItem.get(`${r.saleId}/${i.saleItemId}`) ?? 0) + i.quantity);
    }
    const bad: string[] = [];
    for (const s of await SaleModel.find({ status: { $in: ['partially_returned', 'returned'] } }).lean()) {
      for (const i of s.items) {
        const fromDocs = returnedBySaleItem.get(`${s._id}/${i.id}`) ?? 0;
        if (Math.abs(fromDocs - i.returnedQty) > 0.001) bad.push(`${s.invoiceNumber}/${i.id}: item says ${i.returnedQty}, returns say ${fromDocs}`);
        if (i.returnedQty > i.quantity) bad.push(`${s.invoiceNumber}/${i.id}: returned ${i.returnedQty} of ${i.quantity}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('never refunds more than the sale was worth', async () => {
    const refundBySale = new Map<string, number>();
    for (const r of await SaleReturnModel.find().lean()) refundBySale.set(r.saleId, round2((refundBySale.get(r.saleId) ?? 0) + r.refundAmount));
    const bad: string[] = [];
    for (const [saleId, refunded] of refundBySale) {
      const sale = await SaleModel.findById(saleId).lean();
      if (sale && refunded - sale.total > 0.011) bad.push(`${sale.invoiceNumber}: refunded ${refunded} of ${sale.total}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe('receivables', () => {
  it('keeps originalAmount = paidAmount + remaining on every debt', async () => {
    const bad = (await CustomerDebtModel.find().lean())
      .filter((d) => Math.abs(round2(d.paidAmount + d.remaining) - d.originalAmount) > 0.011)
      .map((d) => `${d.invoiceNumber}: ${d.paidAmount}+${d.remaining}≠${d.originalAmount}`);
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('matches every customer balance to the sum of their outstanding debts', async () => {
    const debts = await CustomerDebtModel.find().lean();
    const owed = new Map<string, number>();
    for (const d of debts) owed.set(d.customerId, round2((owed.get(d.customerId) ?? 0) + Math.max(0, d.remaining)));
    const bad: string[] = [];
    for (const c of await CustomerModel.find({ _id: { $in: Array.from(owed.keys()) } }).lean()) {
      const expected = owed.get(c._id) ?? 0;
      if (c.balance >= 0 && Math.abs(c.balance - expected) > 0.011) bad.push(`${c.code}: balance ${c.balance}, debts ${expected}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('keeps a credit sale\u2019s remaining in step with its debt', async () => {
    const bad: string[] = [];
    for (const d of await CustomerDebtModel.find().lean()) {
      const sale = await SaleModel.findById(d.saleId).lean();
      if (sale && sale.status !== 'cancelled' && Math.abs(sale.remaining - d.remaining) > 0.011) bad.push(`${d.invoiceNumber}: sale ${sale.remaining}, debt ${d.remaining}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('never allocates more payment than the debt was worth', async () => {
    const paid = new Map<string, number>();
    for (const p of await CustomerPaymentModel.find({ debtId: { $ne: null } }).lean()) paid.set(p.debtId!, round2((paid.get(p.debtId!) ?? 0) + p.amount));
    const bad: string[] = [];
    for (const d of await CustomerDebtModel.find({ _id: { $in: Array.from(paid.keys()) } }).lean()) {
      if ((paid.get(d._id) ?? 0) - d.originalAmount > 0.011) bad.push(`${d.invoiceNumber}: paid ${paid.get(d._id)} of ${d.originalAmount}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe('payables', () => {
  it('matches every supplier balance to the sum of their open purchases', async () => {
    const purchases = await PurchaseModel.find({ status: { $nin: ['cancelled', 'draft'] } }).lean();
    const owed = new Map<string, number>();
    for (const p of purchases) owed.set(p.supplierId, round2((owed.get(p.supplierId) ?? 0) + p.remaining));
    const bad: string[] = [];
    for (const s of await SupplierModel.find().lean()) {
      const expected = round2(owed.get(s._id) ?? 0);
      if (Math.abs(s.balance - expected) > 0.011) bad.push(`${s.code ?? s._id}: balance ${s.balance}, purchases ${expected}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('never receives or returns more than a purchase ordered', async () => {
    const returned = new Map<string, number>();
    for (const r of await PurchaseReturnModel.find().lean()) {
      for (const i of r.items) returned.set(`${r.purchaseId}/${i.productId}`, (returned.get(`${r.purchaseId}/${i.productId}`) ?? 0) + i.quantity);
    }
    const bad: string[] = [];
    for (const p of await PurchaseModel.find().lean()) {
      for (const i of p.items) {
        if (i.receivedQty - i.quantity > 0.001) bad.push(`${p.invoiceNumber}/${i.productId}: received ${i.receivedQty} of ${i.quantity}`);
        if ((returned.get(`${p._id}/${i.productId}`) ?? 0) - i.receivedQty > 0.001) bad.push(`${p.invoiceNumber}/${i.productId}: returned more than received`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe('cash drawer', () => {
  it('derives expectedCash from the session totals', async () => {
    const bad = (await RegisterSessionModel.find().lean())
      .filter((s) => Math.abs(round2(s.openingBalance + s.cashSales + s.paymentsIn - s.paymentsOut - s.expenses - s.refunds) - s.expectedCash) > 0.011)
      .map((s) => `${s._id}: expected ${s.expectedCash}`);
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('backs the exercised session\u2019s totals with its own movement log', async () => {
    const s = (await RegisterSessionModel.findById(sessionId).lean())!;
    const sum = (predicate: (m: (typeof s.movements)[number]) => boolean) =>
      round2((s.movements ?? []).filter(predicate).reduce((a, m) => a + m.amount, 0));
    expect(sum((m) => m.type === 'sale' && m.method === 'cash')).toBe(s.cashSales);
    expect(sum((m) => m.type === 'refund')).toBe(s.refunds);
    expect(sum((m) => m.type === 'expense')).toBe(s.expenses);
    // The opening float is already in openingBalance; its movement must not be counted again.
    expect(sum((m) => (m.type === 'payment_in' || m.type === 'deposit') && m.reference !== 'OPEN')).toBe(s.paymentsIn);
  });

  it('matches the drawer\u2019s cash sales to the sales booked against it', async () => {
    const s = (await RegisterSessionModel.findById(sessionId).lean())!;
    const sales = await SaleModel.find({ registerSessionId: sessionId, status: { $ne: 'held' } }).lean();
    const cashIn = round2(sales.reduce((a, sale) => a + sale.payments.filter((p) => p.method === 'cash').reduce((b, p) => b + p.amount, 0) - sale.change, 0));
    expect(s.cashSales).toBe(cashIn);
  });
});

describe('referential integrity', () => {
  it('leaves no orphaned references behind', async () => {
    const [productIds, warehouseIds, customerIds, supplierIds, saleIds] = await Promise.all([
      ProductModel.find().select('_id').lean().then((r) => new Set(r.map((x) => x._id))),
      WarehouseModel.find().select('_id').lean().then((r) => new Set(r.map((x) => x._id))),
      CustomerModel.find().select('_id').lean().then((r) => new Set(r.map((x) => x._id))),
      SupplierModel.find().select('_id').lean().then((r) => new Set(r.map((x) => x._id))),
      SaleModel.find().select('_id').lean().then((r) => new Set(r.map((x) => x._id))),
    ]);
    const orphans: string[] = [];
    for (const l of await StockLevelModel.find().lean()) {
      if (!productIds.has(l.productId)) orphans.push(`stockLevel ${l._id} → missing product`);
      if (!warehouseIds.has(l.warehouseId)) orphans.push(`stockLevel ${l._id} → missing warehouse`);
    }
    for (const d of await CustomerDebtModel.find().lean()) {
      if (!customerIds.has(d.customerId)) orphans.push(`debt ${d._id} → missing customer`);
      if (!saleIds.has(d.saleId)) orphans.push(`debt ${d._id} → missing sale`);
    }
    for (const p of await PurchaseModel.find().lean()) {
      if (!supplierIds.has(p.supplierId)) orphans.push(`purchase ${p._id} → missing supplier`);
      if (!warehouseIds.has(p.warehouseId)) orphans.push(`purchase ${p._id} → missing warehouse`);
    }
    for (const s of await SaleModel.find({ customerId: { $ne: null } }).select('customerId invoiceNumber').lean()) {
      if (!customerIds.has(s.customerId!)) orphans.push(`sale ${s.invoiceNumber} → missing customer`);
    }
    for (const r of await SaleReturnModel.find().lean()) {
      if (!saleIds.has(r.saleId)) orphans.push(`return ${r.returnNumber} → missing sale`);
    }
    expect(orphans.slice(0, 10)).toEqual([]);
  });
});
