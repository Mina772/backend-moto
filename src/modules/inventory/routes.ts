import { Router } from 'express';
import type { FilterQuery } from 'mongoose';
import type { StockAdjustment, StockCount, StockMovement, Transfer, TransferStatus, Warehouse } from '@moto/shared';
import { AdjustmentCreateSchema, CountCreateSchema, CountItemUpdateSchema, ListQuerySchema, TransferAdvanceSchema, TransferCreateSchema, WarehouseSaveSchema, hasPermission } from '@moto/shared';
import { z } from 'zod';
import { withTransaction } from '../../db/connect.js';
import { ProductModel, StockAdjustmentModel, StockCountModel, StockLevelModel, StockMovementModel, TransferModel, WarehouseModel, stockLevelId } from '../../db/models.js';
import { audit, clientIp } from '../../lib/audit.js';
import { nextSeq } from '../../lib/counters.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { newId, nowISO } from '../../lib/ids.js';
import { dateRange, paginate, searchRegex, toPublic, toPublicList } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { assertBranchAccess, assertWarehouseAccess, authorize, branchScope } from '../../middleware/authorize.js';
import { q, validate } from '../../middleware/validate.js';
import { evaluateEventAlerts } from '../alerts/engine.js';
import { stockStatusOf } from '../products/service.js';
import { applyMovement, mainWarehouseFor } from './stock.js';

export const inventoryRouter = Router();
export const warehousesRouter = Router();
export const transfersRouter = Router();
inventoryRouter.use(authenticate());
warehousesRouter.use(authenticate());
transfersRouter.use(authenticate());

const stripId = <T extends { _id: string }>(d: T) => {
  const { _id, ...rest } = d;
  void _id;
  return rest;
};

/** A transfer spans two branches; the caller must belong to one of them. */
function assertTransferAccess(req: Parameters<typeof assertBranchAccess>[0], sourceBranchId: string, destinationBranchId: string) {
  const mine = branchScope(req);
  if (!mine) return;
  if (mine !== sourceBranchId && mine !== destinationBranchId) throw forbidden('Branch access denied', 'BRANCH_DENIED');
}

inventoryRouter.get('/overview', authorize('inventory.view'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    const warehouseId = typeof req.query.warehouseId === 'string' ? req.query.warehouseId : undefined;
    const filter: FilterQuery<{ branchId: string; warehouseId: string }> = {};
    if (branchId) filter.branchId = branchId;
    if (warehouseId) filter.warehouseId = warehouseId;
    const [levels, products] = await Promise.all([StockLevelModel.find(filter).lean(), ProductModel.find({ deletedAt: null }).lean()]);
    const pmap = new Map(products.map((p) => [p._id, p]));
    const rowsMap = new Map<string, { productId: string; quantity: number; reserved: number; value: number; minStock: number; status: 'in' | 'low' | 'out'; byBranch: Record<string, number>; byWarehouse: Record<string, number> }>();
    for (const l of levels) {
      const p = pmap.get(l.productId);
      if (!p) continue;
      const r = rowsMap.get(l.productId) ?? { productId: l.productId, quantity: 0, reserved: 0, value: 0, minStock: p.minStock, status: 'in' as const, byBranch: {}, byWarehouse: {} };
      r.quantity += l.quantity;
      r.reserved += l.reserved;
      if (hasPermission(req.auth!.permissions, 'prices.view_cost')) r.value += l.quantity * p.lastPurchaseCost;
      r.byBranch[l.branchId] = (r.byBranch[l.branchId] ?? 0) + l.quantity;
      r.byWarehouse[l.warehouseId] = (r.byWarehouse[l.warehouseId] ?? 0) + l.quantity;
      rowsMap.set(l.productId, r);
    }
    // Products with no stock level anywhere are still out of stock and must show in the report.
    for (const p of products) {
      if (!rowsMap.has(p._id) && !warehouseId && !branchId) {
        rowsMap.set(p._id, { productId: p._id, quantity: 0, reserved: 0, value: 0, minStock: p.minStock, status: 'out', byBranch: {}, byWarehouse: {} });
      }
    }
    // `status` follows the scoped quantity. Without a branch filter a healthy company-wide total used to hide
    // branches that are actually below their reorder level, so `lowBranches`/`outBranches` report them explicitly.
    const rows = Array.from(rowsMap.values()).map((r) => {
      const perBranch = Object.entries(r.byBranch).map(([b, qty]) => [b, stockStatusOf(qty, r.minStock)] as const);
      return {
        ...r,
        status: stockStatusOf(r.quantity, r.minStock),
        lowBranches: perBranch.filter(([, s]) => s === 'low').map(([b]) => b),
        outBranches: perBranch.filter(([, s]) => s === 'out').map(([b]) => b),
      };
    });
    // A product counts as low/out when it is short anywhere in scope, not only when the aggregate is short.
    const isLow = (r: (typeof rows)[number]) => r.status === 'low' || r.lowBranches.length > 0;
    const isOut = (r: (typeof rows)[number]) => r.status === 'out' || r.outBranches.length > 0;
    res.json({
      rows,
      totalValue: rows.reduce((a, r) => a + r.value, 0),
      totalQty: rows.reduce((a, r) => a + r.quantity, 0),
      lowCount: rows.filter((r) => isLow(r) && !isOut(r)).length,
      outCount: rows.filter(isOut).length,
      skuCount: rows.length,
    });
  } catch (e) {
    next(e);
  }
});

inventoryRouter.get('/levels', authorize('inventory.view', 'sales.create'), async (req, res, next) => {
  try {
    const filter: Record<string, string> = {};
    for (const k of ['productId', 'branchId', 'warehouseId'] as const) if (typeof req.query[k] === 'string') filter[k] = req.query[k] as string;
    const scoped = branchScope(req, filter.branchId);
    if (scoped) filter.branchId = scoped;
    res.json((await StockLevelModel.find(filter).lean()).map(stripId));
  } catch (e) {
    next(e);
  }
});

const MovementQuerySchema = ListQuerySchema.extend({ productId: z.string().optional(), warehouseId: z.string().optional(), type: z.string().optional(), userId: z.string().optional() });
inventoryRouter.get('/movements', authorize('inventory.view'), async (req, res, next) => {
  try {
    const query = q(req, MovementQuerySchema);
    const filter: FilterQuery<StockMovement> = {};
    const branchId = branchScope(req, query.branchId);
    if (branchId) filter.branchId = branchId;
    if (query.productId) filter.productId = query.productId;
    if (query.warehouseId) filter.warehouseId = query.warehouseId;
    if (query.type) filter.type = query.type;
    if (query.userId) filter.userId = query.userId;
    const range = dateRange(query.from, query.to);
    if (range) filter.date = range;
    const re = searchRegex(query.search);
    if (re) {
      const prods = await ProductModel.find({ $or: [{ 'name.ar': re }, { 'name.en': re }, { sku: re }] }).select('_id').lean();
      filter.$or = [{ reference: re }, { productId: { $in: prods.map((p) => p._id) } }];
    }
    res.json(await paginate(StockMovementModel, { filter, query, defaultSort: { date: -1 } }));
  } catch (e) {
    next(e);
  }
});

inventoryRouter.get('/movements/product/:productId', authorize('inventory.view'), async (req, res, next) => {
  try {
    const limit = Math.min(500, Number(req.query.limit ?? 50));
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    const filter: FilterQuery<StockMovement> = { productId: req.params.productId as string };
    if (branchId) filter.branchId = branchId;
    res.json(toPublicList(await StockMovementModel.find(filter).sort({ date: -1 }).limit(limit).lean()));
  } catch (e) {
    next(e);
  }
});

inventoryRouter.get('/adjustments', authorize('inventory.view'), async (req, res, next) => {
  try {
    const query = q(req, ListQuerySchema);
    const filter: FilterQuery<StockAdjustment> = {};
    const branchId = branchScope(req, query.branchId);
    if (branchId) filter.branchId = branchId;
    res.json(await paginate(StockAdjustmentModel, { filter, query, defaultSort: { date: -1 } }));
  } catch (e) {
    next(e);
  }
});

inventoryRouter.post('/adjustments', authorize('inventory.adjust'), validate(AdjustmentCreateSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof AdjustmentCreateSchema>;
    assertBranchAccess(req, input.branchId);
    await assertWarehouseAccess(req, input.warehouseId);
    const adj = await withTransaction(async (session) => {
      const delta = input.direction === 'increase' ? input.quantity : -input.quantity;
      const type = input.direction === 'increase' ? 'adjustment_in' : input.reason === 'damaged' ? 'damaged' : 'adjustment_out';
      const id = newId('adj');
      await applyMovement({ productId: input.productId, warehouseId: input.warehouseId, branchId: input.branchId, delta, type, userId: req.auth!.id, reference: id.toUpperCase(), notes: input.notes }, session);
      const doc: StockAdjustment = { id, date: nowISO(), branchId: input.branchId, warehouseId: input.warehouseId, productId: input.productId, direction: input.direction, quantity: input.quantity, reason: input.reason, notes: input.notes, userId: req.auth!.id, status: 'approved' };
      await StockAdjustmentModel.create([{ ...doc, _id: id, id: undefined }], { session });
      await audit({ userId: req.auth!.id, action: 'stock_adjustment', entity: 'product', entityId: input.productId, branchId: input.branchId, after: { direction: input.direction, quantity: input.quantity, reason: input.reason }, ip: clientIp(req) }, session);
      return doc;
    });
    void evaluateEventAlerts({ kind: 'stock', productId: input.productId, branchId: input.branchId });
    res.status(201).json(adj);
  } catch (e) {
    next(e);
  }
});

// ---------- counts ----------
inventoryRouter.get('/counts', authorize('inventory.view'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, undefined);
    res.json(toPublicList(await StockCountModel.find(branchId ? { branchId } : {}).sort({ date: -1 }).lean()));
  } catch (e) {
    next(e);
  }
});
inventoryRouter.post('/counts', authorize('inventory.count'), validate(CountCreateSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof CountCreateSchema>;
    assertBranchAccess(req, input.branchId);
    await assertWarehouseAccess(req, input.warehouseId);
    const seq = await nextSeq('count');
    const levels = await StockLevelModel.find({ warehouseId: input.warehouseId, productId: { $in: input.productIds } }).lean();
    const items = input.productIds.map((pid) => ({ productId: pid, expected: levels.find((l) => l.productId === pid)?.quantity ?? 0, counted: null }));
    const doc = await StockCountModel.create({ _id: newId('cnt'), code: `CNT-${String(seq).padStart(4, '0')}`, date: nowISO(), branchId: input.branchId, warehouseId: input.warehouseId, userId: req.auth!.id, status: 'in_progress', items });
    res.status(201).json(toPublic(doc.toObject()));
  } catch (e) {
    next(e);
  }
});
inventoryRouter.get('/counts/:id', authorize('inventory.view'), async (req, res, next) => {
  try {
    const doc = await StockCountModel.findById(req.params.id as string).lean();
    if (!doc) throw notFound('Count not found');
    assertBranchAccess(req, doc.branchId);
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});
inventoryRouter.patch('/counts/:id/items', authorize('inventory.count'), validate(CountItemUpdateSchema), async (req, res, next) => {
  try {
    const { productId, counted } = req.body as z.infer<typeof CountItemUpdateSchema>;
    const doc = await StockCountModel.findById(req.params.id as string);
    if (!doc) throw notFound('Count not found');
    assertBranchAccess(req, doc.branchId);
    if (doc.status === 'completed') throw badRequest('Count already completed', 'COUNT_COMPLETED');
    const it = doc.items.find((i) => i.productId === productId);
    if (!it) throw badRequest('Product not in count', 'NOT_IN_COUNT');
    it.counted = counted;
    doc.status = 'in_progress';
    doc.markModified('items');
    await doc.save();
    res.json(toPublic(doc.toObject()));
  } catch (e) {
    next(e);
  }
});
inventoryRouter.post('/counts/:id/finish', authorize('inventory.count'), async (req, res, next) => {
  try {
    const count = await withTransaction(async (session) => {
      const doc = await StockCountModel.findById(req.params.id as string).session(session ?? null);
      if (!doc) throw notFound('Count not found');
      assertBranchAccess(req, doc.branchId);
      if (doc.status === 'completed') return toPublic(doc.toObject()) as unknown as StockCount;
      for (const it of doc.items) {
        if (it.counted == null || it.counted === it.expected) continue;
        const level = await StockLevelModel.findById(stockLevelId(it.productId, doc.warehouseId)).session(session ?? null).lean();
        const current = level?.quantity ?? 0;
        await applyMovement({ productId: it.productId, warehouseId: doc.warehouseId, branchId: doc.branchId, delta: it.counted - current, type: 'count', userId: req.auth!.id, reference: doc.code, allowNegative: true }, session);
      }
      doc.status = 'completed';
      await doc.save({ session });
      return toPublic(doc.toObject()) as unknown as StockCount;
    });
    void evaluateEventAlerts({ kind: 'count', count });
    res.json(count);
  } catch (e) {
    next(e);
  }
});

// ---------- warehouses ----------
warehousesRouter.get('/', authorize('inventory.view', 'sales.create', 'reports.view', 'purchases.view'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    res.json(toPublicList(await WarehouseModel.find(branchId ? { branchId } : {}).sort({ code: 1 }).lean()));
  } catch (e) {
    next(e);
  }
});
warehousesRouter.post('/', authorize('inventory.adjust', 'branches.edit'), validate(WarehouseSaveSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof WarehouseSaveSchema>;
    assertBranchAccess(req, input.branchId);
    const doc = await WarehouseModel.create({ _id: newId('wh'), ...input, isMain: input.isMain ?? false, locations: [] });
    res.status(201).json(toPublic(doc.toObject()));
  } catch (e) {
    next(e);
  }
});
warehousesRouter.put('/:id', authorize('inventory.adjust', 'branches.edit'), validate(WarehouseSaveSchema), async (req, res, next) => {
  try {
    const { id: _ignored, ...rest } = req.body as z.infer<typeof WarehouseSaveSchema>;
    void _ignored;
    await assertWarehouseAccess(req, req.params.id as string);
    assertBranchAccess(req, rest.branchId);
    const doc = await WarehouseModel.findByIdAndUpdate(req.params.id as string, { $set: rest }, { new: true }).lean();
    if (!doc) throw notFound('Warehouse not found');
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});
warehousesRouter.get('/:id', authorize('inventory.view'), async (req, res, next) => {
  try {
    const doc = await WarehouseModel.findById(req.params.id as string).lean();
    if (!doc) throw notFound('Warehouse not found');
    assertBranchAccess(req, doc.branchId);
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});
warehousesRouter.get('/:id/stats', authorize('inventory.view'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const [wh, levels, products] = await Promise.all([WarehouseModel.findById(id).lean(), StockLevelModel.find({ warehouseId: id }).lean(), ProductModel.find({ deletedAt: null }).lean()]);
    if (!wh) throw notFound('Warehouse not found');
    assertBranchAccess(req, wh.branchId);
    const pmap = new Map(products.map((p) => [p._id, p]));
    let qty = 0;
    let value = 0;
    let low = 0;
    let out = 0;
    for (const l of levels) {
      const p = pmap.get(l.productId);
      if (!p) continue;
      qty += l.quantity;
      if (hasPermission(req.auth!.permissions, 'prices.view_cost')) value += l.quantity * p.lastPurchaseCost;
      if (l.quantity <= 0) out++;
      else if (l.quantity < p.minStock) low++;
    }
    res.json({ skuCount: levels.length, qty, value, low, out, utilization: wh.capacity ? Math.min(100, (qty / wh.capacity) * 100) : 0 });
  } catch (e) {
    next(e);
  }
});

// ---------- transfers ----------
const TransferQuerySchema = ListQuerySchema.extend({ status: z.string().optional(), direction: z.enum(['in', 'out']).optional() });
transfersRouter.get('/', authorize('inventory.transfer', 'inventory.view'), async (req, res, next) => {
  try {
    const query = q(req, TransferQuerySchema);
    const filter: FilterQuery<Transfer> = {};
    const branchId = branchScope(req, query.branchId);
    if (branchId) {
      if (query.direction === 'in') filter.destinationBranchId = branchId;
      else if (query.direction === 'out') filter.sourceBranchId = branchId;
      else filter.$or = [{ sourceBranchId: branchId }, { destinationBranchId: branchId }];
    }
    if (query.status) filter.status = query.status;
    const re = searchRegex(query.search);
    if (re) filter.code = re;
    res.json(await paginate(TransferModel, { filter, query, defaultSort: { requestedAt: -1 } }));
  } catch (e) {
    next(e);
  }
});
transfersRouter.post('/', authorize('inventory.transfer'), validate(TransferCreateSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof TransferCreateSchema>;
    if (input.sourceBranchId === input.destinationBranchId) throw badRequest('Source and destination must differ', 'SAME_BRANCH');
    // A branch user may only move stock to or from their own branch, never between two others.
    assertTransferAccess(req, input.sourceBranchId, input.destinationBranchId);
    const [defaultSrcWh, dstWh] = await Promise.all([mainWarehouseFor(input.sourceBranchId), mainWarehouseFor(input.destinationBranchId)]);
    const srcWh = input.sourceWarehouseId ?? defaultSrcWh;
    if (input.sourceWarehouseId) {
      const selected = await WarehouseModel.findOne({ _id: srcWh, branchId: input.sourceBranchId, isActive: true }).lean();
      if (!selected) throw badRequest('Source warehouse does not belong to the source branch or is inactive', 'INVALID_WAREHOUSE');
    }
    const seq = await nextSeq('transfer');
    const now = nowISO();
    const status: TransferStatus = input.submit ? 'requested' : 'draft';
    const doc = await TransferModel.create({
      _id: newId('tr'),
      code: `TRF-${String(seq).padStart(4, '0')}`,
      sourceBranchId: input.sourceBranchId,
      destinationBranchId: input.destinationBranchId,
      sourceWarehouseId: srcWh,
      destinationWarehouseId: dstWh,
      items: input.items.map((i) => ({ productId: i.productId, requestedQty: i.requestedQty, sentQty: 0, receivedQty: 0 })),
      status,
      requestedAt: now,
      requestedBy: req.auth!.id,
      notes: input.notes,
      timeline: [{ status, at: now, by: req.auth!.id }],
    });
    res.status(201).json(toPublic(doc.toObject()));
  } catch (e) {
    next(e);
  }
});
transfersRouter.get('/:id', authorize('inventory.transfer', 'inventory.view'), async (req, res, next) => {
  try {
    const doc = await TransferModel.findById(req.params.id as string).lean();
    if (!doc) throw notFound('Transfer not found');
    assertTransferAccess(req, doc.sourceBranchId, doc.destinationBranchId);
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});

const ORDER: TransferStatus[] = ['draft', 'requested', 'approved', 'sent', 'received', 'completed'];
transfersRouter.post('/:id/advance', authorize('inventory.transfer'), validate(TransferAdvanceSchema), async (req, res, next) => {
  try {
    const { next: nextStatus, note, quantities } = req.body as z.infer<typeof TransferAdvanceSchema>;
    const result = await withTransaction(async (session) => {
      const t = await TransferModel.findById(req.params.id as string).session(session ?? null);
      if (!t) throw notFound('Transfer not found');
      assertTransferAccess(req, t.sourceBranchId, t.destinationBranchId);
      const now = nowISO();
      const uid = req.auth!.id;
      const cur = ORDER.indexOf(t.status);
      const nxt = ORDER.indexOf(nextStatus);
      const validStep = nextStatus === 'rejected' ? t.status === 'requested' || t.status === 'approved' : nxt !== -1 && nxt === cur + 1;
      if (!validStep) throw badRequest(`Cannot move from ${t.status} to ${nextStatus}`, 'INVALID_TRANSITION');
      if ((nextStatus === 'approved' || nextStatus === 'rejected') && !req.auth!.permissions.includes('inventory.transfer_approve')) throw badRequest('Approval permission required', 'PERMISSION_DENIED');

      if (nextStatus === 'approved') {
        for (const it of t.items) {
          const reserved = await StockLevelModel.updateOne({ _id: stockLevelId(it.productId, t.sourceWarehouseId), $expr: { $gte: [{ $subtract: ['$quantity', '$reserved'] }, it.requestedQty] } }, { $inc: { reserved: it.requestedQty } }, { session });
          if (reserved.modifiedCount !== 1) throw badRequest('Insufficient available stock to reserve this transfer', 'INSUFFICIENT_STOCK');
        }
        t.approvedAt = now;
        t.approvedBy = uid;
        await audit({ userId: uid, action: 'transfer_approve', entity: 'transfer', entityId: t._id, branchId: t.sourceBranchId, before: { status: t.status }, after: { status: 'approved' }, ip: clientIp(req) }, session);
      } else if (nextStatus === 'sent') {
        for (const it of t.items) {
          // Short shipments are normal; shipping more than was approved is not.
          it.sentQty = Math.min(quantities?.[it.productId] ?? it.requestedQty, it.requestedQty);
          await StockLevelModel.updateOne({ _id: stockLevelId(it.productId, t.sourceWarehouseId) }, { $inc: { reserved: -it.requestedQty } }, { session });
          await applyMovement({ productId: it.productId, warehouseId: t.sourceWarehouseId, branchId: t.sourceBranchId, delta: -it.sentQty, type: 'transfer_out', userId: uid, reference: t.code }, session);
        }
        t.sentAt = now;
        t.sentBy = uid;
      } else if (nextStatus === 'received') {
        for (const it of t.items) {
          // Receiving more than was shipped would mint stock that never left the source.
          it.receivedQty = Math.min(quantities?.[it.productId] ?? it.sentQty, it.sentQty);
          await applyMovement({ productId: it.productId, warehouseId: t.destinationWarehouseId, branchId: t.destinationBranchId, delta: it.receivedQty, type: 'transfer_in', userId: uid, reference: t.code }, session);
        }
        t.receivedAt = now;
        t.receivedBy = uid;
      } else if (nextStatus === 'completed') {
        t.completedAt = now;
      } else if (nextStatus === 'rejected') {
        if (t.status === 'approved') for (const it of t.items) await StockLevelModel.updateOne({ _id: stockLevelId(it.productId, t.sourceWarehouseId) }, { $inc: { reserved: -it.requestedQty } }, { session });
      }
      t.status = nextStatus;
      t.timeline = [...t.timeline, { status: nextStatus, at: now, by: uid, note }];
      t.markModified('items');
      t.markModified('timeline');
      await t.save({ session });
      return toPublic(t.toObject()) as unknown as Transfer;
    });
    if (nextStatus === 'received') for (const it of result.items) void evaluateEventAlerts({ kind: 'stock', productId: it.productId, branchId: result.destinationBranchId });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export { stripId };
export type { Warehouse };
