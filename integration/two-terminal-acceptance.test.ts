/// <reference lib="dom" />
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { api, loginAs, startTestDb, stopTestDb } from '../src/test/harness.js';
import { SaleModel, SaleReturnModel, StockLevelModel } from '../src/db/models.js';
import { LocalDb } from '../../pos-desktop/src/main/db/database';
import { SyncWorker } from '../../pos-desktop/src/main/sync/worker';
import { createLocalOps } from '../../pos-desktop/src/main/sync/localOps';
import { createApiClient } from '../../pos-desktop/packages/api-client/src/client';
import type { SaleCreateInput, SyncPushRequest } from '@moto/shared';
import { SaleCreateSchema } from '@moto/shared';
let server: Server; let url: string; let token: string;
const folder = mkdtempSync(path.join(tmpdir(), 'moto-two-terminals-'));
const binding = path.resolve(import.meta.dirname, '../../pos-desktop/native/better_sqlite3.node');
beforeAll(async () => {
  const app = await startTestDb({ seed: true }); token = (await loginAs(app, 'admin')).token;
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  await StockLevelModel.updateMany({ productId: 'prod-1', branchId: 'br-1' }, { $set: { quantity: 0, reserved: 0 } });
  await StockLevelModel.updateOne({ productId: 'prod-1', warehouseId: 'wh-2' }, { $set: { quantity: 1 } });
  expect((await api(app).get('/api/sync/bootstrap').set('Authorization', `Bearer ${token}`).query({ branchId: 'br-1' })).body.salesWarehouseId).toBe('wh-2');
});
afterAll(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); await stopTestDb(); });
it('reconciles two offline terminals, a lost response, rejection, retry, return and file restart against the real API', async () => {
  const adminApi = createApiClient({ baseUrl: url, getToken: () => token });
  const terminals = await Promise.all(['A', 'B'].map(name => adminApi.sync.registerTerminal({ name: `audit-${name}`, branchId: 'br-1', registerId: null, appVersion: 'audit-pass2' })));
  let online = false; let loseResponse = false;
  const seen: { request: SyncPushRequest; statuses: string[] }[] = [];
  const devices = terminals.map((terminal, i) => {
    const file = path.join(folder, `${i}.sqlite`); let db = new LocalDb(file, { nativeBinding: binding });
    const client = createApiClient({ baseUrl: url, getToken: () => token, headers: { 'X-Terminal-Id': terminal.id }, fetchImpl: async (input, init) => {
      if (!online) throw new Error('synthetic disconnected network');
      const response = await fetch(input, init);
      if (String(input).endsWith('/sync/push')) {
        const result = await response.clone().json() as { results: { status: string }[] }; seen.push({ request: JSON.parse(String(init?.body)), statuses: result.results.map(r => r.status) });
        if (loseResponse) { loseResponse = false; throw new Error('synthetic lost response after server commit'); }
      }
      return response;
    } });
    const workerFor = () => new SyncWorker({ db, api: () => client, terminalId: () => terminal.id, branchId: () => 'br-1', setTimer: () => null, clearTimer: () => undefined });
    let worker = workerFor();
    const ops = () => createLocalOps({ db, worker, terminalCode: () => terminal.code, terminalId: () => terminal.id, branchId: () => 'br-1', userId: () => 'u-admin', publicUrl: () => url });
    return { get db() { return db; }, get worker() { return worker; }, client, ops, restart() { worker.stop(); db.close(); db = new LocalDb(file, { nativeBinding: binding }); worker = workerFor(); }, close() { worker.stop(); db.close(); } };
  });
  const [a, b] = devices;
  try {
    online = true; await a.worker.bootstrap(a.client, 'br-1'); await b.worker.bootstrap(b.client, 'br-1'); online = false;
    const body: SaleCreateInput = SaleCreateSchema.parse({ branchId: 'br-1', items: [{ productId: 'prod-1', quantity: 1, unitPrice: 100, name: { ar: 'synthetic' } }], type: 'cash', payments: [{ method: 'cash', amount: 100 }] });
    const saleA = await a.ops().createSale(body); const saleB = await b.ops().createSale(body);
    expect(a.db.product('prod-1', 'br-1')!.available).toBe(0); expect(b.db.product('prod-1', 'br-1')!.available).toBe(0);
    a.restart(); b.restart(); expect(a.db.counts().pending).toBe(1); expect(b.db.counts().pending).toBe(1);
    online = true; loseResponse = true; await a.worker.syncNow(); expect(a.db.counts().pending).toBe(1);
    a.restart(); await a.worker.syncNow(); expect(a.db.counts().pending).toBe(0);
    expect(seen.some(r => r.statuses.includes('duplicate'))).toBe(true);
    expect(await SaleModel.countDocuments({ invoiceNumber: saleA.invoiceNumber })).toBe(1);
    await b.worker.syncNow(); expect(b.db.counts().rejected).toBe(1); expect(b.db.sale(saleB.id)!.syncStatus).toBe('failed');
    expect(await SaleModel.countDocuments({ invoiceNumber: saleB.invoiceNumber })).toBe(0);
    await expect(b.ops().createSaleReturn({ saleId: saleB.id, refundMethod: 'cash', items: [{ saleItemId: saleB.items[0].id, productId: 'prod-1', quantity: 1, unitPrice: 100, refund: 0, reason: 'defective' }] })).rejects.toThrow('RECONCILIATION_REQUIRED');
    // Disconnect to enqueue a return, then restart before pushing it.
    online = false;
    await a.ops().createSaleReturn({ saleId: saleA.id, refundMethod: 'cash', items: [{ saleItemId: saleA.items[0].id, productId: 'prod-1', quantity: 1, unitPrice: 100, refund: 0, reason: 'defective' }] });
    a.restart(); online = true; loseResponse = true; await a.worker.syncNow();
    expect(a.db.counts().pending).toBe(1); a.restart(); await a.worker.syncNow();
    const authoritative = (await SaleModel.findOne({ invoiceNumber: saleA.invoiceNumber }).lean())!;
    expect(await SaleReturnModel.countDocuments({ saleId: authoritative._id })).toBe(1);
    expect(authoritative.status).toBe('returned'); expect(authoritative.items[0].returnedQty).toBe(1); expect(a.db.returnsForSale(saleA.id)).toHaveLength(1);
    expect(a.db.returnsForSale(saleA.id)[0].status).toBe('applied');
    const rejected = b.db.outbox().find(op => op.status === 'rejected')!; b.db.retryOp(rejected.opId, randomUUID());
    b.restart(); await b.worker.syncNow(); expect(b.db.counts()).toEqual({ pending: 0, rejected: 0 });
    expect(await SaleModel.countDocuments({ invoiceNumber: saleB.invoiceNumber })).toBe(1);
    expect((await StockLevelModel.findOne({ productId: 'prod-1', warehouseId: 'wh-2' }).lean())!.quantity).toBe(0);
    await a.worker.syncNow(); expect(a.db.product('prod-1', 'br-1')!.available).toBe(0); expect(b.db.product('prod-1', 'br-1')!.available).toBe(0);
    a.restart(); b.restart(); expect(a.db.counts().pending + b.db.counts().pending).toBe(0); expect(a.db.returnsForSale(saleA.id)).toHaveLength(1);
    const rejectedReturnOp = randomUUID();
    a.db.enqueue({ opId: rejectedReturnOp, type: 'sale_return', createdAt: new Date().toISOString(), summary: 'synthetic excess return', payload: { saleId: authoritative._id, refundMethod: 'cash', items: [{ saleItemId: authoritative.items[0].id, productId: 'prod-1', quantity: 1, unitPrice: 100, refund: 0, reason: 'defective' }] } });
    await a.worker.syncNow(); expect(a.db.outbox().find(op => op.opId === rejectedReturnOp)).toMatchObject({ status: 'rejected' });
    a.restart(); expect(a.db.counts().rejected).toBe(1); expect(() => a.db.assertCanWipe()).toThrow('UNSYNCED_OPERATIONS');
    expect(await SaleReturnModel.countDocuments({ saleId: authoritative._id })).toBe(1);
    expect((await StockLevelModel.findOne({ productId: 'prod-1', warehouseId: 'wh-2' }).lean())!.quantity).toBe(0);
  } finally { devices.forEach(d => d.close()); }
});
