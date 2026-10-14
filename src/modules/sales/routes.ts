import { Router } from 'express';
import type { FilterQuery } from 'mongoose';
import rateLimit from 'express-rate-limit';
import type { InvoiceVerification, Sale, SaleCreateInput, SaleReturn } from '@moto/shared';
import { ListQuerySchema, SaleCreateSchema, SaleReturnCreateSchema } from '@moto/shared';
import { z } from 'zod';
import { CustomerModel, SaleModel, SaleReturnModel } from '../../db/models.js';
import { clientIp } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { dateRange, paginate, searchRegex, toPublic } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { assertBranchAccess, authorize, branchScope } from '../../middleware/authorize.js';
import { idempotency } from '../../middleware/idempotency.js';
import { q, validate } from '../../middleware/validate.js';
import { getSettings } from '../settings/service.js';
import { visibleCosts } from '../../lib/visibility.js';
import { cancelSale, createReturn, createSale } from './service.js';
import { businessDay, dayStart } from '../../lib/businessTime.js';

export const salesRouter = Router();
export const publicRouter = Router();

salesRouter.use(authenticate());
salesRouter.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => json(visibleCosts(body, req.auth!.permissions));
  next();
});

const SaleQuerySchema = ListQuerySchema.extend({
  cashierId: z.string().optional(),
  customerId: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  method: z.string().optional(),
  productId: z.string().optional(),
});

salesRouter.get('/', authorize('sales.view'), async (req, res, next) => {
  try {
    const query = q(req, SaleQuerySchema);
    const filter: FilterQuery<Sale> = { status: { $ne: 'held' } };
    const branchId = branchScope(req, query.branchId);
    if (branchId) filter.branchId = branchId;
    if (query.cashierId) filter.cashierId = query.cashierId;
    if (query.customerId) filter.customerId = query.customerId;
    if (query.status) filter.status = query.status;
    if (query.type) filter.type = query.type;
    if (query.productId) filter['items.productId'] = query.productId;
    if (query.method) filter.$or = [{ 'payments.method': query.method }, ...(query.method === 'credit' ? [{ type: 'credit' }] : [])];
    const range = dateRange(query.from, query.to);
    if (range) filter.date = range;
    const re = searchRegex(query.search);
    if (re) {
      const customers = await CustomerModel.find({ $or: [{ 'name.ar': re }, { 'name.en': re }, { phone: re }] }).select('_id').lean();
      filter.$and = [{ $or: [{ invoiceNumber: re }, { customerId: { $in: customers.map((c) => c._id) } }, { notes: re }] }];
    }
    res.json(await paginate(SaleModel, { filter, query, defaultSort: { date: -1 } }));
  } catch (e) {
    next(e);
  }
});

salesRouter.get('/stats', authorize('sales.view'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    const filter: FilterQuery<Sale> = { status: { $nin: ['held', 'cancelled'] } };
    if (branchId) filter.branchId = branchId;
    const todayStart = new Date(dayStart(businessDay(Date.now())));
    const [agg] = await SaleModel.aggregate<{ count: number; total: number; cash: number; credit: number; todayCount: number; todayTotal: number }>([
      { $match: filter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          total: { $sum: '$total' },
          cash: { $sum: { $cond: [{ $eq: ['$type', 'cash'] }, '$total', 0] } },
          credit: { $sum: { $cond: [{ $eq: ['$type', 'credit'] }, '$total', 0] } },
          todayCount: { $sum: { $cond: [{ $gte: ['$date', todayStart.toISOString()] }, 1, 0] } },
          todayTotal: { $sum: { $cond: [{ $gte: ['$date', todayStart.toISOString()] }, '$total', 0] } },
        },
      },
    ]);
    const s = agg ?? { count: 0, total: 0, cash: 0, credit: 0, todayCount: 0, todayTotal: 0 };
    res.json({ ...s, avg: s.count ? s.total / s.count : 0 });
  } catch (e) {
    next(e);
  }
});

salesRouter.get('/held', authorize('sales.create'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined) ?? req.auth!.branchId;
    const docs = await SaleModel.find({ status: 'held', branchId }).sort({ date: -1 }).lean();
    res.json(docs.map(toPublic));
  } catch (e) {
    next(e);
  }
});

salesRouter.get('/by-number', authorize('sales.view'), async (req, res, next) => {
  try {
    const num = String(req.query.num ?? '');
    const branchId = branchScope(req);
    const doc = await SaleModel.findOne({ ...(branchId ? { branchId } : {}), invoiceNumber: num, status: { $nin: ['held', 'cancelled'] } }).lean();
    res.json(doc ? toPublic(doc) : null);
  } catch (e) {
    next(e);
  }
});

salesRouter.get('/returns', authorize('sales.view'), async (req, res, next) => {
  try {
    const query = q(req, ListQuerySchema);
    const filter: FilterQuery<SaleReturn> = {};
    const branchId = branchScope(req, query.branchId);
    if (branchId) filter.branchId = branchId;
    const range = dateRange(query.from, query.to);
    if (range) filter.date = range;
    const re = searchRegex(query.search);
    if (re) filter.$or = [{ returnNumber: re }, { invoiceNumber: re }];
    res.json(await paginate(SaleReturnModel, { filter, query, defaultSort: { date: -1 } }));
  } catch (e) {
    next(e);
  }
});

salesRouter.post('/returns', authorize('returns.create'), idempotency(), validate(SaleReturnCreateSchema), async (req, res, next) => {
  try {
    const sale = await SaleModel.findById((req.body as { saleId: string }).saleId).select('branchId').lean();
    if (!sale) throw notFound('Sale not found');
    assertBranchAccess(req, sale.branchId);
    res.status(201).json(await createReturn(req.body, { userId: req.auth!.id, ip: clientIp(req) }));
  } catch (e) {
    next(e);
  }
});

salesRouter.post('/', authorize('sales.create'), idempotency(), validate(SaleCreateSchema), async (req, res, next) => {
  try {
    assertBranchAccess(req, (req.body as { branchId: string }).branchId);
    // Client-chosen invoice numbers/dates are only honoured for paired terminals (offline sync path).
    const { invoiceNumber, date, offline, ...body } = req.body as SaleCreateInput;
    const input: SaleCreateInput = req.terminalId ? { ...body, invoiceNumber, date, offline } : body;
    const sale = await createSale({ ...input, cashierId: req.auth!.id }, { userId: req.auth!.id, ip: clientIp(req), terminalId: req.terminalId, permissions: req.auth!.permissions });
    res.status(201).json(sale);
  } catch (e) {
    next(e);
  }
});

salesRouter.get('/:id', authorize('sales.view'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const doc = (await SaleModel.findById(id).lean()) ?? (await SaleModel.findOne({ invoiceNumber: id }).lean());
    if (!doc) throw notFound('Sale not found');
    assertBranchAccess(req, doc.branchId);
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});

salesRouter.post('/:id/resume', authorize('sales.create'), async (req, res, next) => {
  try {
    const held = await SaleModel.findOne({ _id: req.params.id as string, status: 'held' }).select('branchId').lean();
    if (!held) throw notFound('Held sale not found');
    assertBranchAccess(req, held.branchId);
    const doc = await SaleModel.findOneAndDelete({ _id: req.params.id as string, status: 'held' }).lean();
    if (!doc) throw notFound('Held sale not found');
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});

salesRouter.post('/:id/cancel', authorize('sales.cancel'), validate(z.object({ refundMethod: z.enum(['cash', 'card', 'bank_transfer', 'credit']).optional() }).default({})), async (req, res, next) => {
  try {
    const sale = await SaleModel.findById(req.params.id as string).select('branchId').lean();
    if (!sale) throw notFound('Sale not found');
    assertBranchAccess(req, sale.branchId);
    res.json(await cancelSale(req.params.id as string, { userId: req.auth!.id, ip: clientIp(req) }, req.body.refundMethod));
  } catch (e) {
    next(e);
  }
});

// ---------- public verification (QR) ----------
const verifyLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
// `:id` is the invoice number (what the QR carries — identical for offline and server sales) or a sale id.
publicRouter.get('/invoices/:id/verify', verifyLimiter, async (req, res, next) => {
  try {
    const key = req.params.id as string;
    const doc = (await SaleModel.findOne({ invoiceNumber: key }).lean()) ?? (await SaleModel.findById(key).lean());
    if (!doc || doc.status === 'held') throw notFound('Invoice not found');
    const settings = await getSettings();
    const out: InvoiceVerification = {
      invoiceNumber: doc.invoiceNumber,
      date: doc.date,
      sellerName: settings.company.name,
      taxNumber: settings.company.taxNumber,
      total: doc.total,
      tax: doc.tax,
      status: doc.status,
      itemsCount: doc.items.length,
    };
    res.json(out);
  } catch (e) {
    next(e);
  }
});
