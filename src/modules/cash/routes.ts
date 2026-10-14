import { Router } from 'express';
import type { FilterQuery } from 'mongoose';
import type { Expense, RegisterSession } from '@moto/shared';
import { CashMovementCreateSchema, ExpenseCreateSchema, ListQuerySchema, RegisterCloseSchema, RegisterOpenSchema, round2 } from '@moto/shared';
import { z } from 'zod';
import { withTransaction } from '../../db/connect.js';
import { BranchModel, CashRegisterModel, ExpenseCategoryModel, ExpenseModel, RegisterSessionModel } from '../../db/models.js';
import { clientIp } from '../../lib/audit.js';
import { nextSeq } from '../../lib/counters.js';
import { notFound } from '../../lib/errors.js';
import { newId, nowISO } from '../../lib/ids.js';
import { dateRange, paginate, toPublic, toPublicList } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { assertBranchAccess, authorize, branchScope } from '../../middleware/authorize.js';
import { idempotency } from '../../middleware/idempotency.js';
import { q, validate } from '../../middleware/validate.js';
import { addMovement, closeSession, openSession } from './service.js';

export const cashRouter = Router();
export const expensesRouter = Router();
cashRouter.use(authenticate());
expensesRouter.use(authenticate());

/** Loading the session is what stops a caller from touching another branch's drawer by id. */
async function assertSessionAccess(req: Parameters<typeof assertBranchAccess>[0], sessionId: string) {
  const s = await RegisterSessionModel.findById(sessionId).select('branchId').lean();
  if (!s) throw notFound('Session not found');
  assertBranchAccess(req, s.branchId);
}

cashRouter.get('/registers', authorize('cash.open', 'cash.close', 'sales.create'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    res.json(toPublicList(await CashRegisterModel.find(branchId ? { branchId } : {}).sort({ code: 1 }).lean()));
  } catch (e) {
    next(e);
  }
});

const SessionQuerySchema = ListQuerySchema.extend({ registerId: z.string().optional(), status: z.enum(['open', 'closed']).optional() });
cashRouter.get('/sessions', authorize('cash.open', 'cash.close', 'reports.view'), async (req, res, next) => {
  try {
    const query = q(req, SessionQuerySchema);
    const filter: FilterQuery<RegisterSession> = {};
    const branchId = branchScope(req, query.branchId);
    if (branchId) filter.branchId = branchId;
    if (query.registerId) filter.registerId = query.registerId;
    if (query.status) filter.status = query.status;
    const range = dateRange(query.from, query.to);
    if (range) filter.openedAt = range;
    res.json(await paginate(RegisterSessionModel, { filter, query, defaultSort: { openedAt: -1 } }));
  } catch (e) {
    next(e);
  }
});

cashRouter.get('/sessions/current', authorize('sales.create', 'cash.open', 'cash.close'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined) ?? req.auth!.branchId;
    const mine = await RegisterSessionModel.findOne({ branchId, status: 'open', userId: req.auth!.id }).lean();
    const any = mine ?? (await RegisterSessionModel.findOne({ branchId, status: 'open' }).sort({ openedAt: -1 }).lean());
    res.json(any ? toPublic(any) : null);
  } catch (e) {
    next(e);
  }
});

cashRouter.post('/sessions', authorize('cash.open'), idempotency(), validate(RegisterOpenSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof RegisterOpenSchema>;
    const reg = await CashRegisterModel.findById(input.registerId).select('branchId').lean();
    if (!reg) throw notFound('Register not found');
    assertBranchAccess(req, reg.branchId);
    const s = await withTransaction((session) => openSession({ registerId: input.registerId, openingBalance: input.openingBalance, userId: req.auth!.id }, session));
    res.status(201).json(s);
  } catch (e) {
    next(e);
  }
});

cashRouter.get('/sessions/:id', authorize('cash.open', 'cash.close', 'reports.view'), async (req, res, next) => {
  try {
    const doc = await RegisterSessionModel.findById(req.params.id as string).lean();
    if (!doc) throw notFound('Session not found');
    assertBranchAccess(req, doc.branchId);
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});

cashRouter.post('/sessions/:id/movements', authorize('cash.open', 'cash.close', 'sales.create'), idempotency(), validate(CashMovementCreateSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof CashMovementCreateSchema>;
    await assertSessionAccess(req, req.params.id as string);
    const mv = await withTransaction((session) => addMovement(req.params.id as string, { ...input, userId: req.auth!.id }, session));
    res.status(201).json(mv);
  } catch (e) {
    next(e);
  }
});

cashRouter.post('/sessions/:id/close', authorize('cash.close'), idempotency(200), validate(RegisterCloseSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof RegisterCloseSchema>;
    await assertSessionAccess(req, req.params.id as string);
    const s = await withTransaction((session) => closeSession(req.params.id as string, { ...input, userId: req.auth!.id, ip: clientIp(req) }, session));
    res.json(s);
  } catch (e) {
    next(e);
  }
});

// ---------- expenses ----------
expensesRouter.get('/categories', authorize('expenses.view', 'expenses.create', 'reports.view', 'cash.close'), async (_req, res, next) => {
  try {
    res.json(toPublicList(await ExpenseCategoryModel.find().lean()));
  } catch (e) {
    next(e);
  }
});

const ExpenseQuerySchema = ListQuerySchema.extend({ categoryId: z.string().optional(), status: z.string().optional() });
expensesRouter.get('/', authorize('expenses.view'), async (req, res, next) => {
  try {
    const query = q(req, ExpenseQuerySchema);
    const filter: FilterQuery<Expense> = {};
    const branchId = branchScope(req, query.branchId);
    if (branchId) filter.branchId = branchId;
    if (query.categoryId) filter.categoryId = query.categoryId;
    if (query.status) filter.status = query.status;
    const range = dateRange(query.from, query.to);
    if (range) filter.date = range;
    res.json(await paginate(ExpenseModel, { filter, query, defaultSort: { date: -1 } }));
  } catch (e) {
    next(e);
  }
});

expensesRouter.get('/stats', authorize('expenses.view'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    const [docs, cats, branches] = await Promise.all([ExpenseModel.find({ status: 'approved', ...(branchId ? { branchId } : {}) }).lean(), ExpenseCategoryModel.find().lean(), BranchModel.find().lean()]);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const pending = await ExpenseModel.countDocuments({ status: 'pending', ...(branchId ? { branchId } : {}) });
    res.json({
      total: docs.reduce((a, e) => a + e.amount, 0),
      thisMonth: docs.filter((e) => e.date >= monthStart.toISOString()).reduce((a, e) => a + e.amount, 0),
      pending,
      byCategory: cats.map((c) => ({ name: c.name, color: c.color, value: docs.filter((e) => e.categoryId === c._id).reduce((a, e) => a + e.amount, 0) })).filter((x) => x.value > 0),
      byBranch: branches.map((b) => ({ name: b.name, value: docs.filter((e) => e.branchId === b._id).reduce((a, e) => a + e.amount, 0) })).filter((x) => x.value > 0),
    });
  } catch (e) {
    next(e);
  }
});

expensesRouter.post('/', authorize('expenses.create'), validate(ExpenseCreateSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof ExpenseCreateSchema>;
    const cat = await ExpenseCategoryModel.findById(input.categoryId).lean();
    const description = input.description.ar || input.description.en ? input.description : (cat?.name ?? { ar: '' });
    const exp = await withTransaction(async (session) => {
      const seq = await nextSeq('expense', session);
      const status: Expense['status'] = input.amount > 1000 && !req.auth!.permissions.includes('expenses.approve') ? 'pending' : 'approved';
      const e: Expense = { id: newId('exp'), code: `EXP-${String(seq).padStart(5, '0')}`, categoryId: input.categoryId, amount: round2(input.amount), branchId: input.branchId, registerId: input.registerId, date: nowISO(), description, userId: req.auth!.id, status, receiptRef: input.receiptRef };
      await ExpenseModel.create([{ ...e, _id: e.id, id: undefined }], { session });
      if (status === 'approved' && input.registerId) {
        const open = await RegisterSessionModel.findOne({ registerId: input.registerId, status: 'open' }).session(session ?? null).lean();
        if (open) await addMovement(open._id, { type: 'expense', amount: e.amount, notes: e.description.ar, userId: req.auth!.id }, session);
      }
      return e;
    });
    res.status(201).json(exp);
  } catch (e) {
    next(e);
  }
});

expensesRouter.patch('/:id/status', authorize('expenses.approve'), validate(z.object({ status: z.enum(['pending', 'approved', 'rejected']) })), async (req, res, next) => {
  try {
    const doc = await ExpenseModel.findByIdAndUpdate(req.params.id as string, { $set: { status: (req.body as { status: Expense['status'] }).status } }, { new: true }).lean();
    if (!doc) throw notFound('Expense not found');
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});
