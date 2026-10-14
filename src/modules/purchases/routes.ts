import { Router } from 'express';
import type { ClientSession, FilterQuery } from 'mongoose';
import type { Purchase, PurchaseItem, PurchaseReturn, StatementLine, Supplier, SupplierPayment } from '@moto/shared';
import { BoolQuerySchema, ListQuerySchema, PurchaseCreateSchema, PurchaseReceiveSchema, PurchaseReturnCreateSchema, SupplierPaymentCreateSchema, SupplierSaveSchema, round2 } from '@moto/shared';
import { z } from 'zod';
import { withTransaction } from '../../db/connect.js';
import { ProductModel, PurchaseModel, PurchaseReturnModel, SupplierModel, SupplierPaymentModel, SupplierReimbursementModel, RegisterSessionModel } from '../../db/models.js';
import { addMovement } from '../cash/service.js';
import { audit, clientIp } from '../../lib/audit.js';
import { nextSeq } from '../../lib/counters.js';
import { HttpError, badRequest, notFound } from '../../lib/errors.js';
import { newId, nowISO } from '../../lib/ids.js';
import { dateRange, paginate, searchRegex, toPublic, toPublicList } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { assertBranchAccess, assertWarehouseAccess, authorize, branchScope } from '../../middleware/authorize.js';
import { q, validate } from '../../middleware/validate.js';
import { idempotency } from '../../middleware/idempotency.js';
import { applyMovement } from '../inventory/stock.js';
import { evaluateEventAlerts } from '../alerts/engine.js';

export const purchasesRouter = Router();
export const suppliersRouter = Router();
purchasesRouter.use(authenticate());
suppliersRouter.use(authenticate());

async function recomputeSupplierBalance(supplierId: string, session?: ClientSession) {
  const open = await PurchaseModel.find({ supplierId, status: { $nin: ['cancelled', 'draft'] } }).session(session ?? null).lean();
  const balance = round2(open.reduce((a, p) => a + p.remaining, 0));
  await SupplierModel.updateOne({ _id: supplierId }, { $set: { balance } }, { session });
  return balance;
}

async function supplierBalancesForBranch(branchId: string) {
  const rows = await PurchaseModel.aggregate<{ _id: string; balance: number }>([
    { $match: { branchId, status: { $nin: ['cancelled', 'draft'] } } },
    { $group: { _id: '$supplierId', balance: { $sum: '$remaining' } } },
  ]);
  return new Map(rows.map(row => [row._id, round2(row.balance)]));
}

const PurchaseQuerySchema = ListQuerySchema.extend({ supplierId: z.string().optional(), status: z.string().optional(), productId: z.string().optional() });

purchasesRouter.get('/', authorize('purchases.view'), async (req, res, next) => {
  try {
    const query = q(req, PurchaseQuerySchema);
    const filter: FilterQuery<Purchase> = {};
    const branchId = branchScope(req, query.branchId);
    if (branchId) filter.branchId = branchId;
    if (query.supplierId) filter.supplierId = query.supplierId;
    if (query.status) filter.status = query.status;
    if (query.productId) filter['items.productId'] = query.productId;
    const range = dateRange(query.from, query.to);
    if (range) filter.date = range;
    const re = searchRegex(query.search);
    if (re) {
      const sups = await SupplierModel.find({ $or: [{ 'name.ar': re }, { 'name.en': re }] }).select('_id').lean();
      filter.$or = [{ invoiceNumber: re }, { supplierInvoiceNumber: re }, { supplierId: { $in: sups.map((s) => s._id) } }];
    }
    res.json(await paginate(PurchaseModel, { filter, query, defaultSort: { date: -1 } }));
  } catch (e) {
    next(e);
  }
});

purchasesRouter.get('/stats', authorize('purchases.view'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, undefined);
    const docs = await PurchaseModel.find({ status: { $ne: 'cancelled' }, ...(branchId ? { branchId } : {}) }).lean();
    res.json({ count: docs.length, total: docs.reduce((a, p) => a + p.total, 0), outstanding: docs.reduce((a, p) => a + p.remaining, 0), pending: docs.filter((p) => p.status === 'ordered' || p.status === 'partially_received').length });
  } catch (e) {
    next(e);
  }
});

purchasesRouter.get('/returns', authorize('purchases.view'), async (req, res, next) => {
  try {
    const query = q(req, PurchaseQuerySchema);
    const filter: FilterQuery<PurchaseReturn> = {};
    const branchId = branchScope(req, query.branchId);
    if (branchId) filter.purchaseId = { $in: (await PurchaseModel.find({ branchId }).select('_id').lean()).map(p => p._id) };
    if (query.supplierId) filter.supplierId = query.supplierId;
    res.json(await paginate(PurchaseReturnModel, { filter, query, defaultSort: { date: -1 } }));
  } catch (e) {
    next(e);
  }
});

purchasesRouter.get('/reimbursements', authorize('purchases.view', 'purchases.pay'), async (req, res, next) => {
  try {
    const branchId = branchScope(req);
    const query = ListQuerySchema.extend({ purchaseId: z.string().min(1).optional() }).parse(req.query);
    res.json(await paginate(SupplierReimbursementModel, { filter: { ...(branchId ? { branchId } : {}), ...(query.purchaseId ? { purchaseId: query.purchaseId } : {}) }, query, defaultSort: { createdAt: -1 } }));
  } catch (e) { next(e); }
});

// A return establishes a receivable; only an explicit receipt confirms funds actually arrived.
purchasesRouter.post('/reimbursements/:id/receive', authorize('purchases.pay'), idempotency(), validate(z.object({ reference: z.string().trim().min(1).max(256), registerSessionId: z.string().min(1).optional() }).strict()), async (req, res, next) => {
  try {
    const receipt = await withTransaction(async session => {
      const r = await SupplierReimbursementModel.findById(req.params.id as string).session(session ?? null);
      if (!r) throw notFound('Supplier reimbursement not found');
      assertBranchAccess(req, r.branchId);
      if (r.status === 'received') {
        if (r.reference !== req.body.reference || r.registerSessionId !== req.body.registerSessionId) throw new HttpError(409, 'REIMBURSEMENT_ALREADY_RECEIVED', 'Receipt details cannot be changed');
        return toPublic(r.toObject());
      }
      if (r.method === 'cash') {
        const drawer = await RegisterSessionModel.findById(req.body.registerSessionId ?? '').session(session ?? null);
        if (!drawer || drawer.branchId !== r.branchId || drawer.status !== 'open') throw new HttpError(409, 'REIMBURSEMENT_DRAWER_REQUIRED', 'Select an open drawer in the source branch');
        if (!['admin', 'accountant'].includes(req.auth!.role) && drawer.userId !== req.auth!.id) throw new HttpError(403, 'DRAWER_DENIED', 'Drawer belongs to another operator');
        const movement = await addMovement(drawer._id, { type: 'deposit', amount: r.amount, userId: req.auth!.id, notes: `Supplier reimbursement ${r._id}; ${req.body.reference}` }, session);
        r.registerSessionId = movement.sessionId;
      } else if (req.body.registerSessionId) throw badRequest('Electronic receipt cannot post to a cash drawer', 'INVALID_REIMBURSEMENT_DRAWER');
      r.status = 'received'; r.reference = req.body.reference; r.receivedAt = nowISO(); r.receivedBy = req.auth!.id;
      await r.save({ session });
      await audit({ userId: req.auth!.id, action: 'purchase_return', entity: 'supplier_reimbursement', entityId: r._id, branchId: r.branchId, after: { amount: r.amount, method: r.method, reference: r.reference, registerSessionId: r.registerSessionId }, ip: clientIp(req) }, session);
      return toPublic(r.toObject());
    });
    res.json(receipt);
  } catch (e) { next(e); }
});

purchasesRouter.post('/returns', authorize('purchases.receive', 'purchases.create'), idempotency(), validate(PurchaseReturnCreateSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof PurchaseReturnCreateSchema>;
    const ret = await withTransaction(async (session) => {
      const p = await PurchaseModel.findById(input.purchaseId).session(session ?? null);
      if (!p) throw notFound('Purchase not found');
      assertBranchAccess(req, p.branchId);
      if (p.status === 'cancelled' || p.status === 'draft') throw badRequest('Purchase is not returnable', 'PURCHASE_NOT_RETURNABLE');
      if (new Set(p.items.map(i => i.productId)).size !== p.items.length && input.items.some(item => !item.purchaseItemId)) throw new HttpError(409, 'RETURN_LINE_RECONCILIATION_REQUIRED', 'Duplicate product rows require explicit purchase-line selection before returning stock or value');
      const sourceLine = (item: { productId: string; purchaseItemId?: string }) => item.purchaseItemId ? p.items.find(line => line.id === item.purchaseItemId && line.productId === item.productId) : p.items.find(line => line.productId === item.productId);
      // PurchaseItem has no returnedQty, so earlier returns are what caps this one.
      const priorReturns = await PurchaseReturnModel.find({ purchaseId: p._id }).session(session ?? null).lean();
      const alreadyReturned = new Map<string, number>();
      for (const pr of priorReturns) for (const i of pr.items) {
        if (!i.purchaseItemId && p.items.filter(line => line.productId === i.productId).length > 1) throw new HttpError(409, 'RETURN_LINE_RECONCILIATION_REQUIRED', 'Historical return cannot be assigned to a purchase line');
        const key = sourceLine(i)?.id;
        if (!key) throw new HttpError(409, 'RETURN_LINE_RECONCILIATION_REQUIRED', 'Historical return source line missing');
        alreadyReturned.set(key, (alreadyReturned.get(key) ?? 0) + i.quantity);
      }
      const returnItems = input.items.map(item => ({ ...item }));
      let rawReturnedValue = 0;
      for (const it of returnItems) {
        const pi = sourceLine(it);
        const available = round2((pi?.receivedQty ?? 0) - (alreadyReturned.get(pi?.id ?? '') ?? 0));
        if (!pi || available < it.quantity) throw badRequest(`Cannot return more than received for product ${it.productId}`, 'RETURN_QTY_EXCEEDED', { productId: it.productId, received: pi?.receivedQty ?? 0, available });
        alreadyReturned.set(pi.id, (alreadyReturned.get(pi.id) ?? 0) + it.quantity);
        it.purchaseItemId = pi.id;
        rawReturnedValue += it.quantity * pi.unitCost;
        it.unitCost = p.subtotal > 0 ? pi.unitCost * p.total / p.subtotal : 0;
      }
      const seq = await nextSeq('purchaseReturn', session);
      const priorTotal = round2(priorReturns.reduce((sum, r) => sum + r.total, 0));
      const priorRawValue = priorReturns.reduce((sum, r) => sum + r.items.reduce((value, item) => value + item.quantity * (sourceLine(item)?.unitCost ?? 0), 0), 0);
      const cumulativeValue = p.subtotal > 0 ? round2((priorRawValue + rawReturnedValue) * p.total / p.subtotal) : 0;
      const total = round2(Math.min(Math.max(0, cumulativeValue - priorTotal), Math.max(0, p.total - priorTotal)));
      const debtReduction = round2(Math.min(total, Math.max(0, p.remaining)));
      const payoutAmount = round2(total - debtReduction);
      const priorPayout = round2(priorReturns.reduce((sum, r) => sum + (r.payoutAmount ?? 0), 0));
      if (payoutAmount > 0 && !input.refundMethod || payoutAmount > round2(p.paid - priorPayout)) throw new HttpError(409, 'REFUND_RECONCILIATION_REQUIRED', 'Supplier reimbursement requires an explicit method and paid-value reconciliation');
      const ret: PurchaseReturn = { id: newId('pret'), returnNumber: `PRET-${String(seq).padStart(4, '0')}`, purchaseId: p._id, supplierId: p.supplierId, date: nowISO(), items: returnItems, total, debtReduction, payoutAmount, refundMethod: input.refundMethod, userId: req.auth!.id, reason: input.reason };
      for (const it of returnItems) await applyMovement({ productId: it.productId, warehouseId: p.warehouseId, branchId: p.branchId, delta: -it.quantity, type: 'purchase_return', userId: req.auth!.id, reference: ret.returnNumber }, session);
      p.remaining = round2(p.remaining - debtReduction);
      await p.save({ session });
      await PurchaseReturnModel.create([{ ...ret, _id: ret.id, id: undefined }], { session });
      if (payoutAmount > 0) await SupplierReimbursementModel.create([{ _id: newId('sref'), returnId: ret.id, purchaseId: p._id, supplierId: p.supplierId, branchId: p.branchId, amount: payoutAmount, method: input.refundMethod, status: 'pending', createdAt: ret.date, userId: req.auth!.id }], { session });
      await recomputeSupplierBalance(p.supplierId, session);
      await audit({ userId: req.auth!.id, action: 'purchase_return', entity: 'purchase', entityId: p._id, branchId: p.branchId, after: { returnNumber: ret.returnNumber, total, debtReduction, payoutAmount, refundMethod: input.refundMethod }, ip: clientIp(req) }, session);
      return ret;
    });
    res.status(201).json(ret);
  } catch (e) {
    next(e);
  }
});

purchasesRouter.get('/payments', authorize('purchases.view', 'purchases.pay'), async (req, res, next) => {
  try {
    const query = q(req, PurchaseQuerySchema);
    const filter: FilterQuery<SupplierPayment> = {};
    const branchId = branchScope(req, query.branchId);
    if (branchId) filter.purchaseId = { $in: (await PurchaseModel.find({ branchId }).select('_id').lean()).map(p => p._id) };
    if (query.supplierId) filter.supplierId = query.supplierId;
    const range = dateRange(query.from, query.to);
    if (range) filter.date = range;
    res.json(await paginate(SupplierPaymentModel, { filter, query, defaultSort: { date: -1 } }));
  } catch (e) {
    next(e);
  }
});

purchasesRouter.post('/payments', authorize('purchases.pay'), idempotency(), validate(SupplierPaymentCreateSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof SupplierPaymentCreateSchema>;
    const pay = await withTransaction(async (session) => {
      const now = nowISO();
      if (!(await SupplierModel.exists({ _id: input.supplierId }).session(session ?? null))) throw new HttpError(422, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
      if (input.method === 'credit') throw badRequest('A supplier payment requires a cash, card or bank-transfer tender', 'INVALID_PAYMENT_METHOD');
      const branchId = branchScope(req);
      // Scoped by supplier: paying one supplier's invoice off another's account desyncs both balances.
      const purchases = input.purchaseId
        ? await PurchaseModel.find({ _id: input.purchaseId, supplierId: input.supplierId }).session(session ?? null)
        : await PurchaseModel.find({ supplierId: input.supplierId, ...(branchId ? { branchId } : {}), remaining: { $gt: 0 }, status: { $nin: ['cancelled', 'draft'] } }).sort({ date: 1 }).session(session ?? null);
      if (input.purchaseId && purchases.length === 0) throw new HttpError(422, 'PURCHASE_NOT_FOUND', 'Purchase not found for this supplier');
      for (const purchase of purchases) {
        assertBranchAccess(req, purchase.branchId);
        if (purchase.status === 'cancelled' || purchase.status === 'draft') throw badRequest('Purchase is not payable', 'PURCHASE_NOT_PAYABLE');
      }
      const payable = round2(purchases.reduce((amount, purchase) => amount + Math.max(0, purchase.remaining), 0));
      if (input.amount > payable) throw new HttpError(422, 'OVERPAYMENT', 'Payment exceeds the outstanding payable balance');
      let left = input.amount;
      const allocations: { purchaseId: string; amount: number }[] = [];
      for (const p of purchases) {
        if (left <= 0) break;
        const apply = round2(Math.min(p.remaining, left));
        p.paid = round2(p.paid + apply);
        p.remaining = round2(p.remaining - apply);
        await p.save({ session });
        allocations.push({ purchaseId: p._id, amount: apply });
        left = round2(left - apply);
      }
      const pay: SupplierPayment = { id: newId('spay'), supplierId: input.supplierId, purchaseId: input.purchaseId, date: now, amount: input.amount, method: input.method, reference: input.reference || `PAY-${Date.now().toString(36).toUpperCase()}`, userId: req.auth!.id, notes: input.notes };
      await SupplierPaymentModel.create(allocations.map((allocation, i) => ({ ...pay, _id: i === 0 ? pay.id : newId('spay'), id: undefined, purchaseId: allocation.purchaseId, amount: allocation.amount })), { session, ordered: true });
      await recomputeSupplierBalance(input.supplierId, session);
      await audit({ userId: req.auth!.id, action: 'payment', entity: 'supplier', entityId: input.supplierId, branchId: req.auth!.branchId, after: { amount: input.amount, method: input.method }, ip: clientIp(req) }, session);
      return pay;
    });
    res.status(201).json(pay);
  } catch (e) {
    next(e);
  }
});

purchasesRouter.post('/', authorize('purchases.create'), validate(PurchaseCreateSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof PurchaseCreateSchema>;
    assertBranchAccess(req, input.branchId);
    await assertWarehouseAccess(req, input.warehouseId);
    const purchase = await withTransaction(async (session) => {
      if (!(await SupplierModel.exists({ _id: input.supplierId, isActive: true }).session(session ?? null))) throw new HttpError(422, 'SUPPLIER_NOT_FOUND', 'Active supplier not found');
      const supplierInvoiceNumber = input.supplierInvoiceNumber.trim();
      if (supplierInvoiceNumber) {
        // A supplier write serializes concurrent creates on the replica set, without installing
        // a unique index on unknown historical records. All create paths use this transaction.
        await SupplierModel.updateOne({ _id: input.supplierId }, { $inc: { invoiceGuardVersion: 1 } }, { session, strict: false });
        if (await PurchaseModel.exists({ supplierId: input.supplierId, $expr: { $eq: [{ $trim: { input: { $ifNull: ['$supplierInvoiceNumber', ''] } } }, supplierInvoiceNumber] } }).session(session ?? null)) throw new HttpError(409, 'SUPPLIER_INVOICE_EXISTS', 'Supplier invoice number already exists across the company');
      }
      const productIds = [...new Set(input.items.map(item => item.productId))];
      const productCount = await ProductModel.countDocuments({ _id: { $in: productIds }, isActive: true, deletedAt: null }).session(session ?? null);
      if (productCount !== productIds.length) throw new HttpError(422, 'PRODUCT_NOT_FOUND', 'Purchase contains an unknown or inactive product');
      const seq = await nextSeq('purchase', session);
      const now = nowISO();
      const items: PurchaseItem[] = input.items.map((i) => ({ id: newId('pi'), productId: i.productId, quantity: i.quantity, receivedQty: 0, unitCost: i.unitCost, subtotal: round2(i.quantity * i.unitCost) }));
      const subtotal = round2(items.reduce((a, i) => a + i.subtotal, 0));
      const total = round2(subtotal - input.discount);
      if (total < 0) throw new HttpError(422, 'INVALID_TOTAL', 'Purchase discount exceeds the invoice subtotal');
      if (input.paid > total) throw new HttpError(422, 'OVERPAYMENT', 'Purchase payment exceeds the invoice total');
      const p: Purchase = {
        id: newId('po'),
        invoiceNumber: `PO-${String(seq).padStart(5, '0')}`,
        supplierInvoiceNumber,
        supplierId: input.supplierId,
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        date: now,
        expectedDate: input.expectedDate || now,
        items,
        subtotal,
        discount: input.discount,
        total,
        paid: input.paid,
        remaining: round2(total - input.paid),
        status: input.status,
        userId: req.auth!.id,
        notes: input.notes,
      };
      await PurchaseModel.create([{ ...p, _id: p.id, id: undefined }], { session });
      if (input.paid > 0) await SupplierPaymentModel.create([{ _id: newId('spay'), supplierId: input.supplierId, purchaseId: p.id, date: now, amount: input.paid, method: 'cash', reference: p.invoiceNumber, userId: req.auth!.id }], { session });
      await recomputeSupplierBalance(input.supplierId, session);
      await audit({ userId: req.auth!.id, action: 'purchase_create', entity: 'purchase', entityId: p.id, branchId: input.branchId, after: { invoiceNumber: p.invoiceNumber, total }, ip: clientIp(req) }, session);
      return p;
    });
    res.status(201).json(purchase);
  } catch (e) {
    next(e);
  }
});

purchasesRouter.get('/:id', authorize('purchases.view'), async (req, res, next) => {
  try {
    const doc = await PurchaseModel.findById(req.params.id as string).lean();
    if (!doc) throw notFound('Purchase not found');
    assertBranchAccess(req, doc.branchId);
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});

purchasesRouter.post('/:id/receive', authorize('purchases.receive'), validate(PurchaseReceiveSchema), async (req, res, next) => {
  try {
    const { quantities } = req.body as z.infer<typeof PurchaseReceiveSchema>;
    const result = await withTransaction(async (session) => {
      const p = await PurchaseModel.findById(req.params.id as string).session(session ?? null);
      if (!p) throw notFound('Purchase not found');
      assertBranchAccess(req, p.branchId);
      if (p.status === 'cancelled') throw badRequest('Purchase cancelled', 'PURCHASE_CANCELLED');
      for (const it of p.items) {
        const want = quantities[it.id] ?? 0;
        const qty = Math.min(want, it.quantity - it.receivedQty);
        if (qty <= 0) continue;
        it.receivedQty += qty;
        await applyMovement({ productId: it.productId, warehouseId: p.warehouseId, branchId: p.branchId, delta: qty, type: 'purchase', userId: req.auth!.id, reference: p.invoiceNumber }, session);
        await ProductModel.updateOne({ _id: it.productId }, { $set: { lastPurchaseCost: it.unitCost, updatedAt: nowISO() } }, { session });
      }
      p.status = p.items.every((i) => i.receivedQty >= i.quantity) ? 'received' : 'partially_received';
      p.markModified('items');
      await p.save({ session });
      return toPublic(p.toObject()) as unknown as Purchase;
    });
    for (const it of result.items) void evaluateEventAlerts({ kind: 'stock', productId: it.productId, branchId: result.branchId });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

purchasesRouter.post('/:id/cancel', authorize('purchases.create'), idempotency(), validate(z.object({ refundMethod: z.enum(['cash', 'card', 'bank_transfer']).optional() }).default({})), async (req, res, next) => {
  try {
    const purchase = await withTransaction(async (session) => {
      const p = await PurchaseModel.findById(req.params.id as string).session(session ?? null);
      if (!p) throw notFound('Purchase not found');
      assertBranchAccess(req, p.branchId);
      if (p.status === 'received' || p.status === 'partially_received') throw badRequest('Received purchases cannot be cancelled', 'PURCHASE_RECEIVED');
      if (p.status === 'cancelled') return toPublic(p.toObject());
      if (p.paid > 0 && !req.body.refundMethod) throw new HttpError(409, 'REFUND_METHOD_REQUIRED', 'Select the supplier reimbursement method before cancellation');
      if (await PurchaseReturnModel.exists({ purchaseId: p._id }).session(session ?? null)) throw new HttpError(409, 'REFUND_RECONCILIATION_REQUIRED', 'Existing returns require reconciliation');
      const before = { status: p.status };
      if (p.paid > 0 || p.remaining > 0) {
        const seq = await nextSeq('purchaseReturn', session);
        const ret = { _id: newId('pret'), returnNumber: `PRET-${String(seq).padStart(4, '0')}`, purchaseId: p._id, supplierId: p.supplierId, date: nowISO(), items: [], total: p.total, debtReduction: p.remaining, payoutAmount: p.paid, refundMethod: req.body.refundMethod, userId: req.auth!.id, reason: 'Order cancellation', reversal: 'cancellation' };
        await PurchaseReturnModel.create([ret], { session });
        if (p.paid > 0) await SupplierReimbursementModel.create([{ _id: newId('sref'), returnId: ret._id, purchaseId: p._id, supplierId: p.supplierId, branchId: p.branchId, amount: p.paid, method: req.body.refundMethod, status: 'pending', createdAt: ret.date, userId: req.auth!.id }], { session });
      }
      p.status = 'cancelled';
      p.remaining = 0;
      await p.save({ session });
      await recomputeSupplierBalance(p.supplierId, session);
      await audit({ userId: req.auth!.id, action: 'invoice_cancel', entity: 'purchase', entityId: p._id, branchId: p.branchId, before, after: { status: 'cancelled' }, ip: clientIp(req) }, session);
      return toPublic(p.toObject());
    });
    res.json(purchase);
  } catch (e) {
    next(e);
  }
});

// ---------- suppliers ----------
const SupplierQuerySchema = ListQuerySchema.extend({ hasBalance: BoolQuerySchema.optional(), isActive: BoolQuerySchema.optional() });
suppliersRouter.get('/', authorize('suppliers.view', 'purchases.view'), async (req, res, next) => {
  try {
    const query = q(req, SupplierQuerySchema);
    const filter: FilterQuery<Supplier> = {};
    const branchId = branchScope(req);
    const balances = branchId ? await supplierBalancesForBranch(branchId) : null;
    if (query.hasBalance) {
      if (balances) filter._id = { $in: [...balances].filter(([, balance]) => balance > 0).map(([id]) => id) };
      else filter.balance = { $gt: 0 };
    }
    if (query.isActive !== undefined) filter.isActive = query.isActive;
    const re = searchRegex(query.search);
    if (re) filter.$or = [{ 'name.ar': re }, { 'name.en': re }, { phone: re }, { code: re }];
    const result = await paginate(SupplierModel, { filter, query, defaultSort: { 'name.ar': 1 } });
    if (balances) for (const supplier of result.data) supplier.balance = balances.get((supplier as unknown as Supplier).id) ?? 0;
    res.json(result);
  } catch (e) {
    next(e);
  }
});
suppliersRouter.get('/all', authorize('suppliers.view', 'purchases.view', 'inventory.view'), async (req, res, next) => {
  try {
    const suppliers = toPublicList(await SupplierModel.find({ isActive: true }).sort({ 'name.ar': 1 }).lean()) as unknown as Supplier[];
    const branchId = branchScope(req);
    if (branchId) {
      const balances = await supplierBalancesForBranch(branchId);
      for (const supplier of suppliers) supplier.balance = balances.get(supplier.id) ?? 0;
    }
    res.json(suppliers);
  } catch (e) {
    next(e);
  }
});
suppliersRouter.get('/debt-overview', authorize('suppliers.view', 'purchases.view'), async (req, res, next) => {
  try {
    const sups = toPublicList(await SupplierModel.find().lean()) as unknown as Supplier[];
    const branchId = branchScope(req);
    if (branchId) {
      const balances = await supplierBalancesForBranch(branchId);
      for (const supplier of sups) supplier.balance = balances.get(supplier.id) ?? 0;
    }
    const withBal = sups.filter((s) => s.balance > 0).sort((a, b) => b.balance - a.balance);
    res.json({ totalPayable: round2(withBal.reduce((a, s) => a + s.balance, 0)), count: withBal.length, top: withBal.slice(0, 5), suppliers: sups });
  } catch (e) {
    next(e);
  }
});
suppliersRouter.post('/', authorize('suppliers.edit'), validate(SupplierSaveSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof SupplierSaveSchema>;
    const seq = await nextSeq('supplier');
    const doc = await SupplierModel.create({ _id: newId('sup'), code: `SUP-${String(seq).padStart(3, '0')}`, ...input, contactPerson: input.contactPerson ?? { ar: '' }, address: input.address ?? { ar: '' }, balance: 0, createdAt: nowISO() });
    res.status(201).json(toPublic(doc.toObject()));
  } catch (e) {
    next(e);
  }
});
suppliersRouter.put('/:id', authorize('suppliers.edit'), validate(SupplierSaveSchema), async (req, res, next) => {
  try {
    const { id: _ignored, ...rest } = req.body as z.infer<typeof SupplierSaveSchema>;
    void _ignored;
    const doc = await SupplierModel.findByIdAndUpdate(req.params.id as string, { $set: rest }, { new: true }).lean();
    if (!doc) throw notFound('Supplier not found');
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});
suppliersRouter.get('/:id', authorize('suppliers.view', 'purchases.view'), async (req, res, next) => {
  try {
    const doc = await SupplierModel.findById(req.params.id as string).lean();
    if (!doc) throw notFound('Supplier not found');
    const supplier = toPublic(doc);
    const branchId = branchScope(req);
    if (branchId) supplier.balance = (await supplierBalancesForBranch(branchId)).get(supplier.id) ?? 0;
    res.json(supplier);
  } catch (e) {
    next(e);
  }
});
suppliersRouter.get('/:id/summary', authorize('suppliers.view', 'purchases.view'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const branchId = branchScope(req);
    const purchaseIds = branchId ? (await PurchaseModel.find({ supplierId: id, branchId }).select('_id').lean()).map(p => p._id) : null;
    const relatedFilter = purchaseIds ? { purchaseId: { $in: purchaseIds } } : {};
    const [sup, purchases, payments, returns, productsCount] = await Promise.all([
      SupplierModel.findById(id).lean(),
      PurchaseModel.find({ supplierId: id, status: { $ne: 'cancelled' }, ...(branchId ? { branchId } : {}) }).lean(),
      SupplierPaymentModel.find({ supplierId: id, ...relatedFilter }).lean(),
      PurchaseReturnModel.find({ supplierId: id, ...relatedFilter }).lean(),
      ProductModel.countDocuments({ supplierId: id, deletedAt: null }),
    ]);
    if (!sup) throw notFound('Supplier not found');
    res.json({
      totalPurchases: purchases.reduce((a, p) => a + p.total, 0),
      totalPaid: payments.reduce((a, p) => a + p.amount, 0),
      totalReturns: returns.reduce((a, r) => a + r.total, 0),
      balance: branchId ? round2(purchases.filter(p => p.status !== 'draft').reduce((sum, p) => sum + p.remaining, 0)) : sup.balance,
      purchaseCount: purchases.length,
      lastPurchase: purchases.map((p) => p.date).sort().pop() ?? null,
      productsCount,
    });
  } catch (e) {
    next(e);
  }
});
suppliersRouter.get('/:id/statement', authorize('suppliers.view', 'purchases.view'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const branchId = branchScope(req);
    const purchaseIds = branchId ? (await PurchaseModel.find({ supplierId: id, branchId }).select('_id').lean()).map(p => p._id) : null;
    const relatedFilter = purchaseIds ? { purchaseId: { $in: purchaseIds } } : {};
    const [purchases, payments, returns] = await Promise.all([
      PurchaseModel.find({ supplierId: id, status: { $ne: 'draft' }, ...(branchId ? { branchId } : {}) }).lean(),
      SupplierPaymentModel.find({ supplierId: id, ...relatedFilter }).lean(),
      PurchaseReturnModel.find({ supplierId: id, ...relatedFilter }).lean(),
    ]);
    const lines: Omit<StatementLine, 'balance'>[] = [
      ...purchases.filter(p => p.status !== 'cancelled' || returns.some(r => r.purchaseId === p._id && r.reversal === 'cancellation')).map((p) => ({ date: p.date, type: 'invoice' as const, reference: p.invoiceNumber, debit: 0, credit: p.total })),
      ...payments.map((p) => ({ date: p.date, type: 'payment' as const, reference: p.reference, debit: p.amount, credit: 0 })),
      ...returns.map((r) => ({ date: r.date, type: 'return' as const, reference: r.returnNumber, debit: r.debtReduction ?? r.total, credit: 0 })),
    ].sort((a, b) => (a.date < b.date ? -1 : 1));
    let bal = 0;
    const out = lines.map((l) => {
      bal = round2(bal + l.credit - l.debit);
      return { ...l, balance: bal };
    });
    res.json(out.reverse());
  } catch (e) {
    next(e);
  }
});
