import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { CustomerDebtModel, CustomerModel, CustomerPaymentModel, RegisterSessionModel } from '../../db/models.js';

let app: Express;
/** Branch manager of br-1: has customers.credit but no branches.all. */
let manager: Awaited<ReturnType<typeof loginAs>>;
let myBranch: string;
let otherBranch: string;

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  manager = await loginAs(app, 'khaled.m');
  myBranch = manager.user.branchId;
  otherBranch = (await RegisterSessionModel.findOne({ branchId: { $ne: myBranch }, status: 'open' }).lean())!.branchId;
});
afterAll(stopTestDb);

const auth = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });

describe('customer payment integrity', () => {
  it('rejects a payment allocated to a debt that belongs to another customer', async () => {
    const victimDebt = await CustomerDebtModel.findOne({ remaining: { $gt: 0 } }).lean();
    const payer = await CustomerModel.findOne({ _id: { $ne: victimDebt!.customerId } }).lean();

    const res = await api(app).post('/api/debts/payments').set(auth(manager)).send({
      customerId: payer!._id,
      debtId: victimDebt!._id,
      amount: 50,
      method: 'cash',
      branchId: myBranch,
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DEBT_NOT_FOUND');
    const after = await CustomerDebtModel.findById(victimDebt!._id).lean();
    expect(after!.remaining).toBe(victimDebt!.remaining);
    expect(after!.paidAmount).toBe(victimDebt!.paidAmount);
    expect(await CustomerPaymentModel.countDocuments({ customerId: payer!._id, debtId: victimDebt!._id })).toBe(0);
  });

  it('rejects a payment booked into another branch', async () => {
    const customer = await CustomerModel.findOne({ isActive: true }).lean();
    const before = await RegisterSessionModel.findOne({ branchId: otherBranch, status: 'open' }).lean();

    const res = await api(app).post('/api/debts/payments').set(auth(manager)).send({
      customerId: customer!._id,
      debtId: null,
      amount: 75,
      method: 'cash',
      branchId: otherBranch,
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BRANCH_DENIED');
    const after = await RegisterSessionModel.findById(before!._id).lean();
    expect(after!.paymentsIn).toBe(before!.paymentsIn);
  });
});
