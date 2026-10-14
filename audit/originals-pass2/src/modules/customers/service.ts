import type { ClientSession } from 'mongoose';
import type { Customer, CustomerDebt, CustomerPayment, DebtStatus, StatementLine } from '@moto/shared';
import { SOCKET_EVENTS, round2 } from '@moto/shared';
import type { CustomerPaymentCreateInput, CustomerSaveInput } from '@moto/shared';
import { afterCommit, withTransaction } from '../../db/connect.js';
import { CustomerDebtModel, CustomerModel, CustomerPaymentModel, RegisterSessionModel, SaleModel, SaleReturnModel, SpecialPriceModel } from '../../db/models.js';
import { audit } from '../../lib/audit.js';
import { nextSeq } from '../../lib/counters.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { newId, nowISO } from '../../lib/ids.js';
import { toPublic } from '../../lib/pagination.js';
import { emitToBranch } from '../../realtime/socket.js';
import { recomputeExpectedCash } from '../sales/service.js';

export function debtStatus(d: Pick<CustomerDebt, 'remaining' | 'dueDate' | 'paidAmount'>): DebtStatus {
  if (d.remaining <= 0) return 'paid';
  if (new Date(d.dueDate).getTime() < Date.now()) return 'overdue';
  if (d.paidAmount > 0) return 'partial';
  return 'open';
}

export function daysOverdue(dueDate: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(dueDate).getTime()) / 86400000));
}

export function agingBuckets(debts: Pick<CustomerDebt, 'remaining' | 'dueDate'>[]) {
  const b = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
  for (const d of debts) {
    if (d.remaining <= 0) continue;
    const days = daysOverdue(d.dueDate);
    if (days === 0) b.current += d.remaining;
    else if (days <= 30) b.d1_30 += d.remaining;
    else if (days <= 60) b.d31_60 += d.remaining;
    else if (days <= 90) b.d61_90 += d.remaining;
    else b.d90 += d.remaining;
  }
  return b;
}

export async function saveCustomer(input: CustomerSaveInput, defaultBranchId: string, opts: { clientId?: string; session?: ClientSession } = {}): Promise<Customer> {
  return withTransaction(async (activeSession) => {
    const session = opts.session ?? activeSession;
    const now = nowISO();
    if (input.id) {
      const doc = await CustomerModel.findById(input.id).session(session ?? null);
      if (!doc) throw notFound('Customer not found');
      const { id: _id, ...rest } = input;
      void _id;
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) doc.set(k, v);
      doc.updatedAt = now;
      await doc.save({ session });
      return toPublic(doc.toObject()) as unknown as Customer;
    }
    const seq = await nextSeq('customer', session);
    const docs = await CustomerModel.create([{
      _id: opts.clientId ?? newId('cust'),
      code: `C-${String(seq).padStart(4, '0')}`,
      name: input.name,
      phone: input.phone,
      whatsapp: input.whatsapp || input.phone,
      address: input.address ?? { ar: '' },
      type: input.type,
      creditLimit: input.creditLimit,
      balance: 0,
      branchId: input.branchId ?? defaultBranchId,
      isActive: input.isActive ?? true,
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
    }], { session });
    const doc = docs[0]!;
    return toPublic(doc.toObject()) as unknown as Customer;
  });
}

export async function specialPriceFor(customerId: string | null, productId: string): Promise<number | null> {
  if (!customerId) return null;
  const now = nowISO();
  const sp = await SpecialPriceModel.findOne({ customerId, productId, validFrom: { $lte: now }, $or: [{ validTo: null }, { validTo: { $gte: now } }] }).lean();
  return sp?.price ?? null;
}

export async function recordCustomerPayment(input: CustomerPaymentCreateInput, ctx: { userId: string; ip?: string }): Promise<CustomerPayment> {
  const payment = await withTransaction(async (session) => {
    const customer = await CustomerModel.findById(input.customerId).session(session ?? null);
    if (!customer) throw new HttpError(422, 'CUSTOMER_NOT_FOUND', 'Customer not found');
    const now = input.date ?? nowISO();
    const seq = await nextSeq('payment', session);
    const reference = input.reference || `RCPT-${String(seq).padStart(5, '0')}`;

    // Scoped by customer: allocating one customer's money to another's debt would desync both balances.
    const debts = input.debtId
      ? await CustomerDebtModel.find({ _id: input.debtId, customerId: input.customerId }).session(session ?? null)
      : await CustomerDebtModel.find({ customerId: input.customerId, remaining: { $gt: 0 } }).sort({ dueDate: 1 }).session(session ?? null);
    if (input.debtId && debts.length === 0) throw new HttpError(422, 'DEBT_NOT_FOUND', 'Debt not found for this customer');

    let left = input.amount;
    let appliedSaleId: string | null = null;
    for (const d of debts) {
      if (left <= 0) break;
      const apply = round2(Math.min(d.remaining, left));
      if (apply <= 0) continue;
      d.paidAmount = round2(d.paidAmount + apply);
      d.remaining = round2(d.remaining - apply);
      await d.save({ session });
      await SaleModel.updateOne({ _id: d.saleId }, { $inc: { paid: apply, remaining: -apply } }, { session });
      appliedSaleId ??= d.saleId;
      left = round2(left - apply);
    }

    const allDebts = await CustomerDebtModel.find({ customerId: input.customerId }).session(session ?? null).lean();
    const priorCredit = Math.min(0, customer.balance);
    customer.balance = round2(allDebts.reduce((a, d) => a + Math.max(0, d.remaining), 0) - left + priorCredit);
    customer.updatedAt = now;
    await customer.save({ session });

    const payment: CustomerPayment = { id: newId('cpay'), customerId: input.customerId, debtId: input.debtId ?? null, saleId: input.debtId ? (debts[0]?.saleId ?? null) : appliedSaleId, date: now, amount: input.amount, method: input.method, reference, userId: ctx.userId, branchId: input.branchId, notes: input.notes };
    await CustomerPaymentModel.create([{ ...payment, _id: payment.id, id: undefined }], { session });

    if (input.method === 'cash') {
      const sess = await RegisterSessionModel.findOne({ branchId: input.branchId, status: 'open', userId: ctx.userId }).session(session ?? null) ?? await RegisterSessionModel.findOne({ branchId: input.branchId, status: 'open' }).session(session ?? null);
      if (sess) {
        sess.paymentsIn = round2(sess.paymentsIn + input.amount);
        sess.movements = [...(sess.movements ?? []), { id: newId('cm'), sessionId: sess._id, type: 'payment_in', amount: input.amount, method: 'cash', date: now, reference, userId: ctx.userId, notes: input.notes }];
        sess.expectedCash = recomputeExpectedCash(sess);
        sess.markModified('movements');
        await sess.save({ session });
      }
    }
    await audit({ userId: ctx.userId, action: 'payment', entity: 'customer', entityId: input.customerId, branchId: input.branchId, after: { amount: input.amount, method: input.method, reference }, ip: ctx.ip, date: now }, session);
    return payment;
  });
  afterCommit(() => emitToBranch(payment.branchId, SOCKET_EVENTS.debtChanged, { customerId: payment.customerId }));
  return payment;
}

export async function customerStatement(customerId: string): Promise<StatementLine[]> {
  const [sales, payments, returns] = await Promise.all([
    SaleModel.find({ customerId, type: 'credit', status: { $nin: ['held', 'cancelled'] } }).lean(),
    CustomerPaymentModel.find({ customerId }).lean(),
    SaleReturnModel.find({ customerId, refundMethod: 'credit' }).lean(),
  ]);
  const lines: Omit<StatementLine, 'balance'>[] = [
    ...sales.map((s) => ({ date: s.date, type: 'invoice' as const, reference: s.invoiceNumber, debit: s.total, credit: 0 })),
    ...payments.map((p) => ({ date: p.date, type: 'payment' as const, reference: p.reference, debit: 0, credit: p.amount })),
    ...returns.map((r) => ({ date: r.date, type: 'return' as const, reference: r.returnNumber, debit: 0, credit: r.refundAmount })),
  ].sort((a, b) => (a.date < b.date ? -1 : 1));
  let bal = 0;
  const out = lines.map((l) => {
    bal = round2(bal + l.debit - l.credit);
    return { ...l, balance: bal };
  });
  return out.reverse();
}

export async function customerSummary(customerId: string) {
  const [customer, sales, payments, debts] = await Promise.all([
    CustomerModel.findById(customerId).lean(),
    SaleModel.find({ customerId, status: { $nin: ['held', 'cancelled'] } }).lean(),
    CustomerPaymentModel.find({ customerId }).lean(),
    CustomerDebtModel.find({ customerId }).lean(),
  ]);
  if (!customer) throw notFound('Customer not found');
  const totalPurchases = round2(sales.reduce((a, s) => a + s.total, 0));
  const totalPaid = round2(payments.reduce((a, p) => a + p.amount, 0));
  const overdueCount = debts.filter((d) => debtStatus(d) === 'overdue').length;
  const lastPurchase = sales.map((s) => s.date).sort().pop() ?? null;
  return { totalPurchases, totalPaid, balance: customer.balance, invoiceCount: sales.length, lastPurchase, aging: agingBuckets(debts), overdueCount, availableCredit: Math.max(0, customer.creditLimit - customer.balance) };
}

export function withSession<T>(fn: (s?: ClientSession) => Promise<T>) {
  return withTransaction(fn);
}
