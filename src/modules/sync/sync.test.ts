import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { RegisterSessionModel, SaleModel, SyncOpModel } from '../../db/models.js';

let app: Express;
let cashier: Awaited<ReturnType<typeof loginAs>>;
let terminalId: string;
let terminalCode: string;
const auth = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  cashier = await loginAs(app, 'cashier1');
  const t = await api(app).post('/api/terminals').set(auth(cashier)).send({ name: 'Test POS', branchId: 'br-1', registerId: 'reg-2' });
  expect(t.status).toBe(201);
  terminalId = t.body.id;
  terminalCode = t.body.code;
});
afterAll(stopTestDb);

const saleOp = (opId: string, seq: number) => ({
  opId,
  type: 'sale',
  clientCreatedAt: new Date().toISOString(),
  payload: {
    branchId: 'br-1',
    customerId: null,
    registerSessionId: null,
    invoiceNumber: `INV-${terminalCode}-${String(seq).padStart(5, '0')}`,
    items: [{ productId: 'prod-2', name: { ar: 'x' }, quantity: 1, listPrice: 70, unitPrice: 70, unitCost: 40, priceTier: 'retail1' }],
    invoiceDiscount: 0,
    payments: [{ method: 'cash', amount: 70 }],
    type: 'cash',
  },
});

describe('sync push/pull', () => {
  it('bootstrap returns a full snapshot', async () => {
    const res = await api(app).get('/api/sync/bootstrap').query({ branchId: 'br-1' }).set(auth(cashier));
    expect(res.status).toBe(200);
    expect(res.body.products.length).toBeGreaterThan(50);
    expect(res.body.stockLevels.every((l: { branchId: string }) => l.branchId === 'br-1')).toBe(true);
    expect(res.body.settings.pricing.tierLabels.retail1).toBeTruthy();
    expect(res.body.quickProducts.length).toBeGreaterThan(0);
  });

  it('ships named branches so the terminal never renders a raw branch id', async () => {
    const res = await api(app).get('/api/sync/bootstrap').query({ branchId: 'br-1' }).set(auth(cashier));
    expect(res.body.branches.length).toBeGreaterThan(1);
    expect(res.body.branches.every((b: { id: string; name: { ar: string } }) => b.id && b.name.ar)).toBe(true);
  });

  it('a shift opened outside the terminal comes back on its pull', async () => {
    const before = await api(app).get('/api/sync/bootstrap').query({ branchId: 'br-1' }).set(auth(cashier)).set('X-Terminal-Id', terminalId);
    expect(before.body.openSession).toBeNull();

    const opened = await api(app).post('/api/cash/sessions').set(auth(cashier)).send({ registerId: 'reg-2', openingBalance: 250 });
    expect(opened.status).toBe(201);

    const after = await api(app).get('/api/sync/bootstrap').query({ branchId: 'br-1' }).set(auth(cashier)).set('X-Terminal-Id', terminalId);
    expect(after.body.openSession?.id).toBe(opened.body.id);
    expect(after.body.openSession?.openingBalance).toBe(250);

    // Without the terminal header there is no register to scope to.
    const anon = await api(app).get('/api/sync/bootstrap').query({ branchId: 'br-1' }).set(auth(cashier));
    expect(anon.body.openSession).toBeNull();

    await api(app).post(`/api/cash/sessions/${opened.body.id}/close`).set(auth(cashier)).send({ actualCash: 250 });
  });

  it('applies ops once; duplicates are reported as duplicate; keeps client invoice number', async () => {
    const opId = randomUUID();
    const first = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops: [saleOp(opId, 1)] });
    expect(first.status).toBe(200);
    expect(first.body.results[0].status).toBe('applied');
    const serverId = first.body.results[0].serverId;
    const sale = await SaleModel.findById(serverId).lean();
    expect(sale!.invoiceNumber).toBe(`INV-${terminalCode}-00001`);
    expect(sale!.terminalId).toBe(terminalId);
    expect(sale!.serverSequence).toBeGreaterThan(0);

    const second = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops: [saleOp(opId, 1)] });
    expect(second.body.results[0].status).toBe('duplicate');
    expect(second.body.results[0].serverId).toBe(serverId);
    expect(await SaleModel.countDocuments({ invoiceNumber: `INV-${terminalCode}-00001` })).toBe(1);
  });

  it('rejects with machine-readable code and does not retry the same op', async () => {
    const opId = randomUUID();
    const op = saleOp(opId, 2);
    (op.payload.items[0] as { quantity: number }).quantity = 999_999;
    (op.payload.payments[0] as { amount: number }).amount = 999_999 * 70;
    const res = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops: [op] });
    expect(res.body.results[0].status).toBe('rejected');
    expect(res.body.results[0].error.code).toBe('INSUFFICIENT_STOCK');
    const again = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops: [op] });
    expect(again.body.results[0].status).toBe('rejected');
  });

  it('pull with since returns only deltas', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const res = await api(app).get('/api/sync/pull').query({ branchId: 'br-1', since }).set(auth(cashier));
    expect(res.status).toBe(200);
    // prod-2 stock level was touched by the sale above
    expect(res.body.stockLevels.some((l: { productId: string }) => l.productId === 'prod-2')).toBe(true);
    expect(res.body.products.length).toBeLessThan(70);
  });

  it('register open/close via sync with client session id', async () => {
    const sessionId = `sess-${randomUUID()}`;
    const open = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops: [{ opId: randomUUID(), type: 'register_open', clientCreatedAt: new Date().toISOString(), payload: { registerId: 'reg-2', openingBalance: 500, sessionId } }] });
    expect(open.body.results[0].status).toBe('applied');
    expect(open.body.results[0].serverId).toBe(sessionId);
    const close = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops: [{ opId: randomUUID(), type: 'register_close', clientCreatedAt: new Date().toISOString(), payload: { sessionId, actualCash: 480 } }] });
    expect(close.body.results[0].status).toBe('applied');
    const s = await api(app).get(`/api/cash/sessions/${sessionId}`).set(auth(cashier));
    expect(s.body.difference).toBe(-20);
  });

  it('register already open on the server: register_open adopts it and sales with a local session id are accepted', async () => {
    const serverOpen = await api(app).post('/api/cash/sessions').set(auth(cashier)).send({ registerId: 'reg-2', openingBalance: 100 });
    expect(serverOpen.status).toBe(201);
    const serverSessionId: string = serverOpen.body.id;

    const localSessionId = `sess-${randomUUID()}`;
    const open = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops: [{ opId: randomUUID(), type: 'register_open', clientCreatedAt: new Date().toISOString(), payload: { registerId: 'reg-2', openingBalance: 0, sessionId: localSessionId } }] });
    expect(open.body.results[0].status).toBe('applied');
    expect(open.body.results[0].serverId).toBe(serverSessionId);

    const op = saleOp(randomUUID(), 7);
    (op.payload as { registerSessionId: string | null }).registerSessionId = localSessionId;
    const sale = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops: [op] });
    expect(sale.body.results[0].status).toBe('applied');
    const saved = await SaleModel.findById(sale.body.results[0].serverId).lean();
    expect(saved!.registerSessionId).toBe(serverSessionId);

    const close = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops: [{ opId: randomUUID(), type: 'register_close', clientCreatedAt: new Date().toISOString(), payload: { sessionId: localSessionId, actualCash: 170 } }] });
    expect(close.body.results[0].status).toBe('applied');
    expect(close.body.results[0].serverId).toBe(serverSessionId);
  });

  it('crash between apply and SyncOp record: re-push is reported as duplicate, never double-applied', async () => {
    const opId = randomUUID();
    const op = saleOp(opId, 11);
    // A stale `applying` row (crash before apply) must not block the op.
    await SyncOpModel.create({ _id: opId, terminalId, type: 'sale', status: 'applying' });
    const first = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops: [op] });
    expect(first.body.results[0].status).toBe('applied');
    const serverId = first.body.results[0].serverId;
    // Crash after apply but before the row was marked: re-push hits INVOICE_EXISTS → duplicate with the real serverId.
    await SyncOpModel.updateOne({ _id: opId }, { $set: { status: 'applying' }, $unset: { serverId: 1 } });
    const again = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops: [op] });
    expect(again.body.results[0].status).toBe('duplicate');
    expect(again.body.results[0].serverId).toBe(serverId);
    expect(await SaleModel.countDocuments({ invoiceNumber: op.payload.invoiceNumber })).toBe(1);
    expect((await SyncOpModel.findById(opId).lean())!.status).toBe('applied');
  });

  it('register_close never closes another user\'s session', async () => {
    const manager = await loginAs(app, 'khaled.m');
    // Another user owns the open session on this terminal's register (reg-2).
    const other = await api(app).post('/api/cash/sessions').set(auth(manager)).send({ registerId: 'reg-2', openingBalance: 50 });
    expect(other.status).toBe(201);
    const stale = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops: [{ opId: randomUUID(), type: 'register_close', clientCreatedAt: new Date().toISOString(), payload: { sessionId: `sess-${randomUUID()}`, actualCash: 1 } }] });
    expect(stale.body.results[0].status).toBe('rejected');
    expect(stale.body.results[0].error.code).toBe('SESSION_CLOSED');
    const still = await RegisterSessionModel.findById(other.body.id).lean();
    expect(still!.status).toBe('open');
  });
});

describe('sync under contention', () => {
  it('applies each op once when a terminal retries the same batch in parallel', async () => {
    const ops = [saleOp(randomUUID(), 21), saleOp(randomUUID(), 22)];
    const pushes = await Promise.all(Array.from({ length: 3 }, () => api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops })));
    expect(pushes.every((p) => p.status === 200)).toBe(true);

    for (const op of ops) {
      const statuses = pushes.map((p) => (p.body.results as { opId: string; status: string }[]).find((r) => r.opId === op.opId)!.status);
      expect(statuses.filter((s) => s === 'applied')).toHaveLength(1);
      expect(statuses.filter((s) => s === 'duplicate')).toHaveLength(2);
      expect(await SaleModel.countDocuments({ invoiceNumber: op.payload.invoiceNumber })).toBe(1);
      expect((await SyncOpModel.findById(op.opId).lean())!.status).toBe('applied');
    }
  });

  it('refuses a push aimed at a terminal in another branch', async () => {
    const admin = await loginAs(app, 'admin');
    const foreign = await api(app).post('/api/terminals').set(auth(admin)).send({ name: 'Giza POS', branchId: 'br-2', registerId: 'reg-5' });
    expect(foreign.status).toBe(201);
    const res = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId: foreign.body.id, ops: [saleOp(randomUUID(), 31)] });
    expect(res.status).toBe(403);
    expect(await SyncOpModel.countDocuments({ terminalId: foreign.body.id })).toBe(0);
  });

  it('a push from a terminal the server no longer knows is a 404 the device can recognise', async () => {
    const res = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId: 'term-deleted', ops: [saleOp(randomUUID(), 32)] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TERMINAL_NOT_FOUND');
    expect(await SyncOpModel.countDocuments({ terminalId: 'term-deleted' })).toBe(0);
  });

  it('refuses to register a terminal on a branch that no longer exists', async () => {
    const admin = await loginAs(app, 'admin');
    const res = await api(app).post('/api/terminals').set(auth(admin)).send({ name: 'Ghost POS', branchId: 'br-gone', registerId: null });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BRANCH_NOT_FOUND');
  });

  it('applies a batch in client order even when it arrives shuffled', async () => {
    const base = Date.now();
    const mk = (seq: number, offsetMs: number) => ({ ...saleOp(randomUUID(), seq), clientCreatedAt: new Date(base + offsetMs).toISOString() });
    const first = mk(41, 0);
    const second = mk(42, 1000);
    const res = await api(app).post('/api/sync/push').set(auth(cashier)).send({ terminalId, ops: [second, first] });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { opId: string }) => r.opId)).toEqual([first.opId, second.opId]);

    const applied = await SaleModel.find({ invoiceNumber: { $in: [first.payload.invoiceNumber, second.payload.invoiceNumber] } }).sort({ serverSequence: 1 }).lean();
    expect(applied.map((s) => s.invoiceNumber)).toEqual([first.payload.invoiceNumber, second.payload.invoiceNumber]);
  });
});
