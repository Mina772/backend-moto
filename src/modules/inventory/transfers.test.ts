import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { StockLevelModel, TransferModel, WarehouseModel } from '../../db/models.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
});
afterAll(stopTestDb);

const auth = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });
const qty = async (productId: string, warehouseId: string) => (await StockLevelModel.findOne({ productId, warehouseId }).lean())?.quantity ?? 0;

describe('transfer quantities', () => {
  it('moves stock from the selected active source warehouse', async () => {
    const source = await WarehouseModel.findOne({ branchId: 'br-1', isActive: true, isMain: false }).lean();
    const before = await qty('prod-3', source!._id);
    const created = await api(app).post('/api/transfers').set(auth(admin)).send({ sourceBranchId: 'br-1', sourceWarehouseId: source!._id, destinationBranchId: 'br-2', items: [{ productId: 'prod-3', requestedQty: 1 }], submit: true });
    expect(created.status).toBe(201);
    expect(created.body.sourceWarehouseId).toBe(source!._id);
    await api(app).post(`/api/transfers/${created.body.id}/advance`).set(auth(admin)).send({ next: 'approved' });
    const sent = await api(app).post(`/api/transfers/${created.body.id}/advance`).set(auth(admin)).send({ next: 'sent' });
    expect(sent.status).toBe(200);
    expect(await qty('prod-3', source!._id)).toBe(before - 1);
  });
  it('rejects a source warehouse in another branch', async () => {
    const source = await WarehouseModel.findOne({ branchId: 'br-2', isActive: true }).lean();
    const result = await api(app).post('/api/transfers').set(auth(admin)).send({ sourceBranchId: 'br-1', sourceWarehouseId: source!._id, destinationBranchId: 'br-2', items: [{ productId: 'prod-1', requestedQty: 1 }] });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_WAREHOUSE');
  });
  it('never moves more than requested or more than was sent', async () => {
    const created = await api(app).post('/api/transfers').set(auth(admin)).send({
      sourceBranchId: 'br-1',
      destinationBranchId: 'br-2',
      items: [{ productId: 'prod-1', requestedQty: 2 }],
      submit: true,
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const src = created.body.sourceWarehouseId as string;
    const dst = created.body.destinationWarehouseId as string;
    const srcBefore = await qty('prod-1', src);
    const dstBefore = await qty('prod-1', dst);

    expect((await api(app).post(`/api/transfers/${id}/advance`).set(auth(admin)).send({ next: 'approved' })).status).toBe(200);

    // Shipping clerk over-ships: only the requested quantity may leave the source.
    const sent = await api(app).post(`/api/transfers/${id}/advance`).set(auth(admin)).send({ next: 'sent', quantities: { 'prod-1': 50 } });
    expect(sent.status).toBe(200);
    expect(sent.body.items[0].sentQty).toBe(2);
    expect(await qty('prod-1', src)).toBe(srcBefore - 2);

    // Receiving clerk over-receives: stock must not be created at the destination.
    const received = await api(app).post(`/api/transfers/${id}/advance`).set(auth(admin)).send({ next: 'received', quantities: { 'prod-1': 50 } });
    expect(received.status).toBe(200);
    expect(received.body.items[0].receivedQty).toBe(2);
    expect(await qty('prod-1', dst)).toBe(dstBefore + 2);

    const stored = await TransferModel.findById(id).lean();
    expect(stored!.items[0]!.sentQty).toBe(2);
    expect(stored!.items[0]!.receivedQty).toBe(2);
  });

  it('allows a short shipment and a matching short receipt', async () => {
    const created = await api(app).post('/api/transfers').set(auth(admin)).send({
      sourceBranchId: 'br-1',
      destinationBranchId: 'br-2',
      items: [{ productId: 'prod-2', requestedQty: 4 }],
      submit: true,
    });
    const id = created.body.id as string;
    const dst = created.body.destinationWarehouseId as string;
    const dstBefore = await qty('prod-2', dst);

    await api(app).post(`/api/transfers/${id}/advance`).set(auth(admin)).send({ next: 'approved' });
    const sent = await api(app).post(`/api/transfers/${id}/advance`).set(auth(admin)).send({ next: 'sent', quantities: { 'prod-2': 3 } });
    expect(sent.body.items[0].sentQty).toBe(3);
    const received = await api(app).post(`/api/transfers/${id}/advance`).set(auth(admin)).send({ next: 'received', quantities: { 'prod-2': 1 } });
    expect(received.body.items[0].receivedQty).toBe(1);
    expect(await qty('prod-2', dst)).toBe(dstBefore + 1);
  });
});
