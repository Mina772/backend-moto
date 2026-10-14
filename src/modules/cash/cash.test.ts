import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { CashRegisterModel, RegisterSessionModel } from '../../db/models.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
/** Branch manager of br-1: has cash.open/cash.close but no branches.all. */
let manager: Awaited<ReturnType<typeof loginAs>>;
let foreignSessionId: string;
let foreignRegisterId: string;

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  manager = await loginAs(app, 'khaled.m');
  const foreign = await RegisterSessionModel.findOne({ branchId: { $ne: manager.user.branchId }, status: 'open' }).lean();
  foreignSessionId = foreign!._id;
  foreignRegisterId = (await CashRegisterModel.findOne({ branchId: { $ne: manager.user.branchId }, currentSessionId: null, isActive: true }).lean())!._id;
});
afterAll(stopTestDb);

const auth = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });

describe('cash session branch isolation', () => {
  it('rejects opening a register that belongs to another branch', async () => {
    const res = await api(app).post('/api/cash/sessions').set(auth(manager)).send({ registerId: foreignRegisterId, openingBalance: 500 });
    expect(res.status).toBe(403);
    expect(await RegisterSessionModel.countDocuments({ registerId: foreignRegisterId, status: 'open' })).toBe(0);
  });

  it('rejects reading another branch\u2019s session', async () => {
    expect((await api(app).get(`/api/cash/sessions/${foreignSessionId}`).set(auth(manager))).status).toBe(403);
  });

  it('rejects posting a cash movement into another branch\u2019s session', async () => {
    const before = await RegisterSessionModel.findById(foreignSessionId).lean();
    const res = await api(app).post(`/api/cash/sessions/${foreignSessionId}/movements`).set(auth(manager)).send({ type: 'withdrawal', amount: 250, notes: 'test' });
    expect(res.status).toBe(403);
    const after = await RegisterSessionModel.findById(foreignSessionId).lean();
    expect(after!.paymentsOut).toBe(before!.paymentsOut);
    expect(after!.expectedCash).toBe(before!.expectedCash);
  });

  it('rejects closing another branch\u2019s session', async () => {
    const res = await api(app).post(`/api/cash/sessions/${foreignSessionId}/close`).set(auth(manager)).send({ actualCash: 0 });
    expect(res.status).toBe(403);
    expect((await RegisterSessionModel.findById(foreignSessionId).lean())!.status).toBe('open');
  });

  it('keeps an admin with branches.all unrestricted', async () => {
    expect((await api(app).get(`/api/cash/sessions/${foreignSessionId}`).set(auth(admin))).status).toBe(200);
  });
});

describe('cash drawer totals', () => {
  it('counts a split cash payment net of the change given once', async () => {
    const register = await CashRegisterModel.findOne({ branchId: manager.user.branchId, currentSessionId: null, isActive: true }).lean();
    const opened = await api(app).post('/api/cash/sessions').set(auth(manager)).send({ registerId: register!._id, openingBalance: 100 });
    expect(opened.status).toBe(201);

    const sale = await api(app).post('/api/sales').set(auth(manager)).send({
      branchId: manager.user.branchId,
      customerId: null,
      registerSessionId: opened.body.id,
      items: [{ productId: 'prod-1', name: { ar: 'x' }, quantity: 2, listPrice: 60, unitPrice: 60, unitCost: 35, priceTier: 'retail1', discount: 0, discountPercent: 0 }],
      invoiceDiscount: 0,
      payments: [{ method: 'cash', amount: 100 }, { method: 'cash', amount: 100 }],
      type: 'cash',
    });
    expect(sale.status).toBe(201);
    expect(sale.body.total).toBe(120);
    expect(sale.body.change).toBe(80);

    const after = await RegisterSessionModel.findById(opened.body.id).lean();
    // 200 handed over, 80 returned as change → the drawer holds the 120 sale value.
    expect(after!.cashSales).toBe(120);
    expect(after!.expectedCash).toBe(220);
  });
});
