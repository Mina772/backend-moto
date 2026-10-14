import { Router } from 'express';
import type { FilterQuery } from 'mongoose';
import type { Customer, CustomerDebt, CustomerPayment } from '@moto/shared';
import { BoolQuerySchema, CustomerPaymentCreateSchema, CustomerSaveSchema, ListQuerySchema, SpecialPriceCreateSchema } from '@moto/shared';
import { z } from 'zod';
import { CustomerDebtModel, CustomerModel, CustomerPaymentModel, SpecialPriceModel } from '../../db/models.js';
import { clientIp } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { dateRange, paginate, searchRegex, toPublic, toPublicList } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { assertBranchAccess, authorize, branchScope } from '../../middleware/authorize.js';
import { idempotency } from '../../middleware/idempotency.js';
import { q, validate } from '../../middleware/validate.js';
import { agingBuckets, customerStatement, customerSummary, daysOverdue, debtStatus, recordCustomerPayment, saveCustomer } from './service.js';

export const customersRouter = Router();
export const debtsRouter = Router();
customersRouter.use(authenticate());
debtsRouter.use(authenticate());

const CustomerQuerySchema = ListQuerySchema.extend({ type: z.string().optional(), hasDebt: BoolQuerySchema.optional(), isActive: BoolQuerySchema.optional() });

customersRouter.get('/', authorize('customers.view'), async (req, res, next) => {
  try {
    const query = q(req, CustomerQuerySchema);
    const filter: FilterQuery<Customer> = {};
    const branchId = branchScope(req, query.branchId);
    if (branchId) filter.branchId = branchId;
    if (query.type) filter.type = query.type;
    if (query.hasDebt) filter.balance = { $gt: 0 };
    if (query.isActive !== undefined) filter.isActive = query.isActive;
    const re = searchRegex(query.search);
    if (re) filter.$or = [{ 'name.ar': re }, { 'name.en': re }, { phone: re }, { code: re }, { whatsapp: re }];
    res.json(await paginate(CustomerModel, { filter, query, defaultSort: { 'name.ar': 1 } }));
  } catch (e) {
    next(e);
  }
});

customersRouter.get('/all', authorize('customers.view', 'sales.create'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, undefined);
    const filter: FilterQuery<Customer> = { isActive: true };
    if (branchId && !req.auth!.permissions.includes('branches.all')) filter.$or = [{ branchId }, { type: { $ne: 'retail' } }];
    res.json(toPublicList(await CustomerModel.find(filter).sort({ 'name.ar': 1 }).lean()));
  } catch (e) {
    next(e);
  }
});

customersRouter.get('/special-prices', authorize('customers.view', 'sales.create'), async (req, res, next) => {
  try {
    const filter = typeof req.query.customerId === 'string' ? { customerId: req.query.customerId } : {};
    res.json(toPublicList(await SpecialPriceModel.find(filter).lean()));
  } catch (e) {
    next(e);
  }
});
customersRouter.post('/special-prices', authorize('prices.edit', 'customers.credit'), validate(SpecialPriceCreateSchema), async (req, res, next) => {
  try {
    const doc = await SpecialPriceModel.create({ _id: newId('sp'), ...req.body });
    res.status(201).json(toPublic(doc.toObject()));
  } catch (e) {
    next(e);
  }
});
customersRouter.delete('/special-prices/:id', authorize('prices.edit', 'customers.credit'), async (req, res, next) => {
  try {
    await SpecialPriceModel.deleteOne({ _id: req.params.id as string });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

customersRouter.post('/', authorize('customers.edit', 'sales.create'), idempotency(), validate(CustomerSaveSchema), async (req, res, next) => {
  try {
    assertBranchAccess(req, req.body.branchId ?? req.auth!.branchId);
    if (req.body.id) {
      const customer = await CustomerModel.findById(req.body.id).lean();
      if (!customer) throw notFound('Customer not found');
      assertBranchAccess(req, customer.branchId);
    }
    res.status(201).json(await saveCustomer(req.body, req.auth!.branchId));
  } catch (e) {
    next(e);
  }
});
customersRouter.put('/:id', authorize('customers.edit'), validate(CustomerSaveSchema), async (req, res, next) => {
  try {
    const customer = await CustomerModel.findById(req.params.id as string).lean();
    if (!customer) throw notFound('Customer not found');
    assertBranchAccess(req, customer.branchId);
    assertBranchAccess(req, req.body.branchId ?? customer.branchId);
    res.json(await saveCustomer({ ...req.body, id: req.params.id as string }, req.auth!.branchId));
  } catch (e) {
    next(e);
  }
});
customersRouter.get('/:id', authorize('customers.view', 'sales.create'), async (req, res, next) => {
  try {
    const doc = await CustomerModel.findById(req.params.id as string).lean();
    if (!doc) throw notFound('Customer not found');
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});
customersRouter.get('/:id/summary', authorize('customers.view'), async (req, res, next) => {
  try {
    res.json(await customerSummary(req.params.id as string));
  } catch (e) {
    next(e);
  }
});
customersRouter.get('/:id/statement', authorize('customers.view'), async (req, res, next) => {
  try {
    res.json(await customerStatement(req.params.id as string));
  } catch (e) {
    next(e);
  }
});

// ---------- debts ----------
const DebtQuerySchema = ListQuerySchema.extend({ customerId: z.string().optional(), status: z.string().optional() });

debtsRouter.get('/', authorize('customers.credit', 'customers.view'), async (req, res, next) => {
  try {
    const query = q(req, DebtQuerySchema);
    const filter: FilterQuery<CustomerDebt> = {};
    const branchId = branchScope(req, query.branchId);
    if (branchId) filter.branchId = branchId;
    if (query.customerId) filter.customerId = query.customerId;
    if (query.status === 'paid') filter.remaining = { $lte: 0 };
    else if (query.status) filter.remaining = { $gt: 0 };
    const re = searchRegex(query.search);
    if (re) {
      const customers = await CustomerModel.find({ $or: [{ 'name.ar': re }, { 'name.en': re }] }).select('_id').lean();
      filter.$or = [{ invoiceNumber: re }, { customerId: { $in: customers.map((c) => c._id) } }];
    }
    const docs = await CustomerDebtModel.find(filter).lean();
    let rows = docs.map((d) => ({ ...toPublic(d), status: debtStatus(d), daysOverdue: daysOverdue(d.dueDate) }));
    if (query.status && query.status !== 'paid') rows = rows.filter((r) => r.status === query.status);
    rows.sort((a, b) => b.daysOverdue - a.daysOverdue || (a.dueDate < b.dueDate ? -1 : 1));
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    res.json({ data: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize });
  } catch (e) {
    next(e);
  }
});

debtsRouter.get('/stats', authorize('customers.credit', 'customers.view'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    const debts = await CustomerDebtModel.find(branchId ? { branchId } : {}).lean();
    const total = debts.reduce((a, d) => a + d.originalAmount, 0);
    const paid = debts.reduce((a, d) => a + d.paidAmount, 0);
    const remaining = debts.reduce((a, d) => a + Math.max(0, d.remaining), 0);
    const overdueList = debts.filter((d) => debtStatus(d) === 'overdue');
    const soon = Date.now() + 7 * 86400000;
    const dueSoonList = debts.filter((d) => d.remaining > 0 && new Date(d.dueDate).getTime() >= Date.now() && new Date(d.dueDate).getTime() <= soon);
    res.json({
      total,
      paid,
      remaining,
      overdue: overdueList.reduce((a, d) => a + d.remaining, 0),
      overdueCount: overdueList.length,
      dueSoon: dueSoonList.reduce((a, d) => a + d.remaining, 0),
      dueSoonCount: dueSoonList.length,
      collectionRate: total ? (paid / total) * 100 : 0,
      aging: agingBuckets(debts),
    });
  } catch (e) {
    next(e);
  }
});

const PaymentQuerySchema = ListQuerySchema.extend({ customerId: z.string().optional(), debtId: z.string().optional() });
debtsRouter.get('/payments', authorize('customers.credit', 'customers.view'), async (req, res, next) => {
  try {
    const query = q(req, PaymentQuerySchema);
    const filter: FilterQuery<CustomerPayment> = {};
    const branchId = branchScope(req, query.branchId);
    if (branchId) filter.branchId = branchId;
    if (query.customerId) filter.customerId = query.customerId;
    if (query.debtId) filter.debtId = query.debtId;
    const range = dateRange(query.from, query.to);
    if (range) filter.date = range;
    res.json(await paginate(CustomerPaymentModel, { filter, query, defaultSort: { date: -1 } }));
  } catch (e) {
    next(e);
  }
});

debtsRouter.post('/payments', authorize('customers.credit', 'sales.create'), idempotency(), validate(CustomerPaymentCreateSchema), async (req, res, next) => {
  try {
    assertBranchAccess(req, (req.body as { branchId: string }).branchId);
    const customer = await CustomerModel.findById(req.body.customerId).lean();
    if (!customer) throw notFound('Customer not found');
    assertBranchAccess(req, customer.branchId);
    res.status(201).json(await recordCustomerPayment(req.body, { userId: req.auth!.id, ip: clientIp(req) }));
  } catch (e) {
    next(e);
  }
});
