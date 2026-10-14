import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { PurchaseModel, StockLevelModel, SupplierModel, WarehouseModel } from '../../db/models.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
/** Branch manager of br-1: purchases.create/receive, no branches.all. */
let manager: Awaited<ReturnType<typeof loginAs>>;
let myBranch: string;
let myWarehouse: string;

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  manager = await loginAs(app, 'khaled.m');
  myBranch = manager.user.branchId;
  myWarehouse = (await WarehouseModel.findOne({ branchId: myBranch, isActive: true }).lean())!._id;
});
afterAll(stopTestDb);

const auth = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });

/** Creates a PO in the manager's branch and receives `qty` of prod-1. */
async function receivedPurchase(qty: number, unitCost = 40) {
  const po = await api(app).post('/api/purchases').set(auth(manager)).send({
    supplierId: 'sup-1',
    supplierInvoiceNumber: `SINV-${Date.now()}`,
    branchId: myBranch,
    warehouseId: myWarehouse,
    expectedDate: new Date().toISOString(),
    items: [{ productId: 'prod-1', quantity: qty, unitCost }],
    discount: 0,
    paid: 0,
    status: 'ordered',
  });
  expect(po.status).toBe(201);
  const recv = await api(app).post(`/api/purchases/${po.body.id}/receive`).set(auth(manager)).send({ quantities: { [po.body.items[0].id]: qty } });
  expect(recv.status).toBe(200);
  return po.body as { id: string; items: { id: string }[]; invoiceNumber: string };
}

describe('purchase returns', () => {
  it('cannot return more than the net received quantity across several returns', async () => {
    const po = await receivedPurchase(4);
    const body = { purchaseId: po.id, items: [{ productId: 'prod-1', quantity: 4, unitCost: 40 }], reason: 'damaged' };

    const first = await api(app).post('/api/purchases/returns').set(auth(manager)).send(body);
    expect(first.status).toBe(201);
    const stockAfterFirst = await StockLevelModel.findOne({ productId: 'prod-1', warehouseId: myWarehouse }).lean();
    const purchaseAfterFirst = await PurchaseModel.findById(po.id).lean();

    const second = await api(app).post('/api/purchases/returns').set(auth(manager)).send(body);
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('RETURN_QTY_EXCEEDED');

    const stockAfterSecond = await StockLevelModel.findOne({ productId: 'prod-1', warehouseId: myWarehouse }).lean();
    expect(stockAfterSecond!.quantity).toBe(stockAfterFirst!.quantity);
    expect((await PurchaseModel.findById(po.id).lean())!.remaining).toBe(purchaseAfterFirst!.remaining);
  });

  it('rejects returning against another branch\u2019s purchase', async () => {
    const foreignWarehouse = await WarehouseModel.findOne({ branchId: { $ne: myBranch }, isActive: true }).lean();
    const po = await api(app).post('/api/purchases').set(auth(admin)).send({
      supplierId: 'sup-1',
      supplierInvoiceNumber: `SINV-F-${Date.now()}`,
      branchId: foreignWarehouse!.branchId,
      warehouseId: foreignWarehouse!._id,
      expectedDate: new Date().toISOString(),
      items: [{ productId: 'prod-1', quantity: 3, unitCost: 40 }],
      discount: 0,
      paid: 0,
      status: 'ordered',
    });
    expect(po.status).toBe(201);
    expect((await api(app).post(`/api/purchases/${po.body.id}/receive`).set(auth(admin)).send({ quantities: { [po.body.items[0].id]: 3 } })).status).toBe(200);
    const before = await StockLevelModel.findOne({ productId: 'prod-1', warehouseId: foreignWarehouse!._id }).lean();

    const res = await api(app).post('/api/purchases/returns').set(auth(manager)).send({
      purchaseId: po.body.id,
      items: [{ productId: 'prod-1', quantity: 3, unitCost: 40 }],
      reason: 'damaged',
    });
    expect(res.status).toBe(403);
    expect((await StockLevelModel.findOne({ _id: before!._id }).lean())!.quantity).toBe(before!.quantity);
  });
});

describe('supplier payments', () => {
  it('rejects allocating a payment to another supplier\u2019s purchase', async () => {
    const po = await receivedPurchase(2, 50);
    const otherSupplier = await SupplierModel.findOne({ _id: { $ne: 'sup-1' } }).lean();
    const before = await PurchaseModel.findById(po.id).lean();
    expect(before!.remaining).toBeGreaterThan(0);

    const res = await api(app).post('/api/purchases/payments').set(auth(admin)).send({
      supplierId: otherSupplier!._id,
      purchaseId: po.id,
      amount: 50,
      method: 'cash',
      reference: '',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PURCHASE_NOT_FOUND');
    const after = await PurchaseModel.findById(po.id).lean();
    expect(after!.paid).toBe(before!.paid);
    expect(after!.remaining).toBe(before!.remaining);
  });
});
