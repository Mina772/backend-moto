import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { PurchaseModel, QuickProductModel, SaleModel, StockCountModel, StockLevelModel, TransferModel, WarehouseModel } from '../../db/models.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
/** Branch manager of br-1: full operational rights, but no branches.all. */
let manager: Awaited<ReturnType<typeof loginAs>>;
let myBranch: string;
let otherBranch: string;
let otherWarehouse: string;

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  manager = await loginAs(app, 'khaled.m');
  myBranch = manager.user.branchId;
  const foreign = await WarehouseModel.findOne({ branchId: { $ne: myBranch }, isActive: true }).lean();
  otherBranch = foreign!.branchId;
  otherWarehouse = foreign!._id;
});
afterAll(stopTestDb);

const auth = (who: { token: string }) => ({ Authorization: `Bearer ${who.token}` });
const DENIED = [403, 404];

describe('a branch user cannot write into another branch', () => {
  it('rejects a stock adjustment aimed at a foreign warehouse', async () => {
    const before = await StockLevelModel.findOne({ warehouseId: otherWarehouse }).lean();
    const res = await api(app).post('/api/inventory/adjustments').set(auth(manager)).send({
      branchId: otherBranch,
      warehouseId: otherWarehouse,
      productId: before!.productId,
      direction: 'increase',
      quantity: 99,
      reason: 'found',
    });
    expect(res.status).toBe(403);
    const after = await StockLevelModel.findOne({ _id: before!._id }).lean();
    expect(after!.quantity).toBe(before!.quantity);
  });

  it('rejects an adjustment that forges branchId while pointing at a foreign warehouse', async () => {
    const level = await StockLevelModel.findOne({ warehouseId: otherWarehouse }).lean();
    const res = await api(app).post('/api/inventory/adjustments').set(auth(manager)).send({
      branchId: myBranch,
      warehouseId: otherWarehouse,
      productId: level!.productId,
      direction: 'decrease',
      quantity: 1,
      reason: 'lost',
    });
    expect(res.status).toBe(403);
  });

  it('rejects creating a stock count for another branch', async () => {
    const res = await api(app).post('/api/inventory/counts').set(auth(manager)).send({ branchId: otherBranch, warehouseId: otherWarehouse, productIds: ['prod-1'] });
    expect(res.status).toBe(403);
  });

  it('rejects reading and finishing another branch\u2019s count', async () => {
    const foreign = await StockCountModel.findOne({ branchId: otherBranch }).lean();
    expect(foreign).toBeTruthy();
    expect((await api(app).get(`/api/inventory/counts/${foreign!._id}`).set(auth(manager))).status).toBe(403);
    expect((await api(app).post(`/api/inventory/counts/${foreign!._id}/finish`).set(auth(manager))).status).toBe(403);
    expect((await StockCountModel.findById(foreign!._id).lean())!.status).toBe(foreign!.status);
  });

  it('rejects creating or receiving a purchase for another branch', async () => {
    const create = await api(app).post('/api/purchases').set(auth(manager)).send({
      supplierId: 'sup-1',
      branchId: otherBranch,
      warehouseId: otherWarehouse,
      expectedDate: new Date().toISOString(),
      items: [{ productId: 'prod-1', quantity: 1, unitCost: 10 }],
      discount: 0,
      paid: 0,
      status: 'ordered',
    });
    expect(create.status).toBe(403);

    const foreignPo = await PurchaseModel.findOne({ branchId: otherBranch }).lean();
    if (foreignPo) {
      expect(DENIED).toContain((await api(app).get(`/api/purchases/${foreignPo._id}`).set(auth(manager))).status);
      expect((await api(app).post(`/api/purchases/${foreignPo._id}/receive`).set(auth(manager)).send({ quantities: {} })).status).toBe(403);
    }
  });

  it('rejects reading or cancelling another branch\u2019s sale', async () => {
    const foreignSale = await SaleModel.findOne({ branchId: otherBranch, status: 'completed' }).lean();
    expect(foreignSale).toBeTruthy();
    expect((await api(app).get(`/api/sales/${foreignSale!._id}`).set(auth(manager))).status).toBe(403);
    expect((await api(app).post(`/api/sales/${foreignSale!._id}/cancel`).set(auth(manager))).status).toBe(403);
    expect((await SaleModel.findById(foreignSale!._id).lean())!.status).toBe('completed');
  });

  it('rejects returning against another branch\u2019s sale', async () => {
    const foreignSale = await SaleModel.findOne({ branchId: otherBranch, status: 'completed' }).lean();
    const item = foreignSale!.items[0] as { id: string; productId: string; unitPrice: number };
    const res = await api(app).post('/api/sales/returns').set(auth(manager)).send({
      saleId: foreignSale!._id,
      branchId: otherBranch,
      items: [{ saleItemId: item.id, productId: item.productId, quantity: 1, unitPrice: item.unitPrice, refund: item.unitPrice, reason: 'defective' }],
      refundMethod: 'cash',
    });
    expect(res.status).toBe(403);
  });

  it('rejects a transfer between two branches the user does not belong to', async () => {
    const third = await WarehouseModel.findOne({ branchId: { $nin: [myBranch, otherBranch] }, isActive: true }).lean();
    expect(third).toBeTruthy();
    const res = await api(app).post('/api/transfers').set(auth(manager)).send({
      sourceBranchId: otherBranch,
      destinationBranchId: third!.branchId,
      items: [{ productId: 'prod-1', requestedQty: 1 }],
      submit: true,
    });
    expect(res.status).toBe(403);
  });

  it('allows a transfer that involves the user\u2019s own branch', async () => {
    const res = await api(app).post('/api/transfers').set(auth(manager)).send({
      sourceBranchId: myBranch,
      destinationBranchId: otherBranch,
      items: [{ productId: 'prod-1', requestedQty: 1 }],
      submit: true,
    });
    expect(res.status).toBe(201);
  });

  it('rejects advancing a transfer between two foreign branches', async () => {
    const third = await WarehouseModel.findOne({ branchId: { $nin: [myBranch, otherBranch] }, isActive: true }).lean();
    const foreign = await TransferModel.create({
      _id: 'tr-foreign-test',
      code: 'TRF-9999',
      sourceBranchId: otherBranch,
      destinationBranchId: third!.branchId,
      sourceWarehouseId: otherWarehouse,
      destinationWarehouseId: third!._id,
      items: [{ productId: 'prod-1', requestedQty: 1, sentQty: 0, receivedQty: 0 }],
      status: 'requested',
      requestedAt: new Date().toISOString(),
      requestedBy: 'usr-1',
      timeline: [],
    });
    expect((await api(app).get(`/api/transfers/${foreign._id}`).set(auth(manager))).status).toBe(403);
    expect((await api(app).post(`/api/transfers/${foreign._id}/advance`).set(auth(manager)).send({ next: 'approved' })).status).toBe(403);
  });

  it('rejects reading another branch\u2019s warehouse detail and stats', async () => {
    expect((await api(app).get(`/api/warehouses/${otherWarehouse}`).set(auth(manager))).status).toBe(403);
    expect((await api(app).get(`/api/warehouses/${otherWarehouse}/stats`).set(auth(manager))).status).toBe(403);
  });

  it('ignores a forged branchId on the current register session', async () => {
    const res = await api(app).get(`/api/cash/sessions/current?branchId=${otherBranch}`).set(auth(manager));
    expect(res.status).toBe(200);
    if (res.body) expect(res.body.branchId).toBe(myBranch);
  });

  it('scopes per-product movement history to the caller\u2019s branch', async () => {
    const res = await api(app).get('/api/inventory/movements/product/prod-1?limit=500').set(auth(manager));
    expect(res.status).toBe(200);
    expect((res.body as { branchId: string }[]).every((m) => m.branchId === myBranch)).toBe(true);
  });

  it('keeps an admin with branches.all unrestricted', async () => {
    expect((await api(app).get(`/api/warehouses/${otherWarehouse}`).set(auth(admin))).status).toBe(200);
    const foreignSale = await SaleModel.findOne({ branchId: otherBranch }).lean();
    expect((await api(app).get(`/api/sales/${foreignSale!._id}`).set(auth(admin))).status).toBe(200);
  });
});

describe('quick grid scope', () => {
  it('a branch user reordering does not touch global tiles', async () => {
    const globals = await QuickProductModel.find({ branchId: null }).sort({ order: 1 }).lean();
    expect(globals.length).toBeGreaterThan(1);
    const before = globals.map((g) => ({ id: g._id, order: g.order }));

    const res = await api(app).patch('/api/quick-products/reorder').set(auth(manager)).send({ ids: globals.map((g) => g._id).reverse() });
    expect(res.status).toBe(200);

    for (const b of before) {
      expect((await QuickProductModel.findById(b.id).lean())!.order).toBe(b.order);
    }
  });

  it('a branch user creating a tile gets it scoped to their own branch', async () => {
    const res = await api(app).post('/api/quick-products').set(auth(manager)).send({ productId: 'prod-3', categoryId: null, branchId: null, order: 0 });
    expect(res.status).toBe(201);
    expect(res.body.branchId).toBe(myBranch);
  });

  it('a branch user cannot delete a global tile', async () => {
    const global = await QuickProductModel.findOne({ branchId: null }).lean();
    expect((await api(app).delete(`/api/quick-products/${global!._id}`).set(auth(manager))).status).toBe(403);
    expect(await QuickProductModel.findById(global!._id).lean()).toBeTruthy();
  });
});
