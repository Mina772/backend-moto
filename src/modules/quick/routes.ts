import { Router } from 'express';
import type { QuickCategory, QuickProduct } from '@moto/shared';
import { QuickCategoryFillSchema, QuickCategorySaveSchema, QuickProductSaveSchema, ReorderSchema, SOCKET_EVENTS } from '@moto/shared';
import { z } from 'zod';
import { ProductModel, QuickCategoryModel, QuickProductModel, SaleModel, TombstoneModel } from '../../db/models.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { categoryWithDescendants } from '../products/categories.js';
import { newId, nowISO } from '../../lib/ids.js';
import { toPublic, toPublicList } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize, branchScope } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { emitGlobal } from '../../realtime/socket.js';

export const quickRouter = Router();
quickRouter.use(authenticate());

const scopeFilter = (branchId?: string) => (branchId ? { $or: [{ branchId }, { branchId: null }] } : {});
const notify = () => emitGlobal(SOCKET_EVENTS.quickProductsChanged, { at: nowISO() });

/**
 * A branch user sees global tiles but may only change their own branch's, otherwise one cashier's drag
 * would reorder the grid in every branch.
 */
function assertOwnScope(req: Parameters<typeof branchScope>[0], rowBranchId: string | null | undefined) {
  const mine = branchScope(req);
  if (!mine) return;
  if (rowBranchId !== mine) throw forbidden('This item belongs to another scope', 'BRANCH_DENIED');
}

quickRouter.get('/', authorize('sales.create', 'settings.view'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    res.json(toPublicList(await QuickProductModel.find(scopeFilter(branchId)).sort({ order: 1 }).lean()));
  } catch (e) {
    next(e);
  }
});
quickRouter.get('/categories', authorize('sales.create', 'settings.view'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    res.json(toPublicList(await QuickCategoryModel.find(scopeFilter(branchId)).sort({ order: 1 }).lean()));
  } catch (e) {
    next(e);
  }
});

quickRouter.post('/', authorize('settings.edit', 'settings.quick_grid'), validate(QuickProductSaveSchema), async (req, res, next) => {
  try {
    const { id: _ignored, ...rest } = req.body as z.infer<typeof QuickProductSaveSchema>;
    void _ignored;
    // A branch user's new tile belongs to their branch; only branches.all can create a global one.
    const branchId = branchScope(req) ?? rest.branchId ?? null;
    const max = await QuickProductModel.findOne(scopeFilter(branchId ?? undefined)).sort({ order: -1 }).lean();
    const doc = await QuickProductModel.create({ _id: newId('qp'), ...rest, branchId, order: rest.order || (max?.order ?? 0) + 1, updatedAt: nowISO() });
    notify();
    res.status(201).json(toPublic(doc.toObject()) as unknown as QuickProduct);
  } catch (e) {
    next(e);
  }
});
quickRouter.patch('/reorder', authorize('settings.edit', 'settings.quick_grid'), validate(ReorderSchema), async (req, res, next) => {
  try {
    const { ids } = req.body as z.infer<typeof ReorderSchema>;
    const mine = branchScope(req);
    const filter = mine ? { branchId: mine } : {};
    await QuickProductModel.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id, ...filter }, update: { $set: { order: i, updatedAt: nowISO() } } } })));
    notify();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
quickRouter.put('/:id', authorize('settings.edit', 'settings.quick_grid'), validate(QuickProductSaveSchema), async (req, res, next) => {
  try {
    const { id: _ignored, ...rest } = req.body as z.infer<typeof QuickProductSaveSchema>;
    void _ignored;
    const existing = await QuickProductModel.findById(req.params.id as string).lean();
    if (!existing) throw notFound('Quick product not found');
    assertOwnScope(req, existing.branchId);
    assertOwnScope(req, rest.branchId);
    const doc = await QuickProductModel.findByIdAndUpdate(req.params.id as string, { $set: { ...rest, updatedAt: nowISO() } }, { new: true }).lean();
    if (!doc) throw notFound('Quick product not found');
    notify();
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});
quickRouter.delete('/:id', authorize('settings.edit', 'settings.quick_grid'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await QuickProductModel.findById(id).lean();
    if (!existing) throw notFound('Quick product not found');
    assertOwnScope(req, existing.branchId);
    await QuickProductModel.deleteOne({ _id: id });
    await TombstoneModel.create({ _id: `qp:${id}`, coll: 'quickProducts', entityId: id, deletedAt: nowISO() });
    notify();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

quickRouter.post('/categories', authorize('settings.edit', 'settings.quick_grid'), validate(QuickCategorySaveSchema), async (req, res, next) => {
  try {
    const { id: _ignored, ...rest } = req.body as z.infer<typeof QuickCategorySaveSchema>;
    void _ignored;
    const doc = await QuickCategoryModel.create({ _id: newId('qc'), ...rest });
    notify();
    res.status(201).json(toPublic(doc.toObject()) as unknown as QuickCategory);
  } catch (e) {
    next(e);
  }
});
quickRouter.put('/categories/:id', authorize('settings.edit', 'settings.quick_grid'), validate(QuickCategorySaveSchema), async (req, res, next) => {
  try {
    const { id: _ignored, ...rest } = req.body as z.infer<typeof QuickCategorySaveSchema>;
    void _ignored;
    const doc = await QuickCategoryModel.findByIdAndUpdate(req.params.id as string, { $set: rest }, { new: true }).lean();
    if (!doc) throw notFound('Quick category not found');
    notify();
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});
/**
 * Fills a group from whatever it is linked to: a catalog department (with its sub-tree) or a
 * motorcycle model. Best sellers first, so the grid opens on what the branch actually sells.
 */
quickRouter.post('/categories/:id/fill', authorize('settings.edit', 'settings.quick_grid'), validate(QuickCategoryFillSchema), async (req, res, next) => {
  try {
    const { limit, replace } = req.body as z.infer<typeof QuickCategoryFillSchema>;
    const cat = await QuickCategoryModel.findById(req.params.id as string).lean();
    if (!cat) throw notFound('Quick category not found');
    assertOwnScope(req, cat.branchId);
    if (!cat.sourceCategoryId && !cat.sourceModelId) throw badRequest('This group is not linked to a department or a model', 'NO_SOURCE');

    const filter: Record<string, unknown> = { isActive: true, deletedAt: null };
    if (cat.sourceCategoryId) filter.categoryId = { $in: await categoryWithDescendants(cat.sourceCategoryId) };
    if (cat.sourceModelId) filter.compatibleModelIds = cat.sourceModelId;
    const products = await ProductModel.find(filter).sort({ _id: 1 }).select('_id').limit(400).lean();
    if (!products.length) return res.json({ added: 0, removed: 0 });

    const ranked = await rankBySales(products.map((p) => p._id), cat.branchId ?? undefined);
    const picked = ranked.slice(0, limit);

    let removed = 0;
    if (replace) {
      const gone = await QuickProductModel.find({ categoryId: cat._id }).select('_id').lean();
      removed = gone.length;
      await QuickProductModel.deleteMany({ categoryId: cat._id });
      if (gone.length) await TombstoneModel.insertMany(gone.map((g) => ({ _id: `qp:${g._id}`, coll: 'quickProducts', entityId: g._id, deletedAt: nowISO() })), { ordered: false }).catch(() => undefined);
    }
    const existing = new Set((await QuickProductModel.find({ categoryId: cat._id }).select('productId').lean()).map((q) => q.productId));
    const fresh = picked.filter((id) => !existing.has(id));
    const base = (await QuickProductModel.findOne(scopeFilter(cat.branchId ?? undefined)).sort({ order: -1 }).lean())?.order ?? 0;
    if (fresh.length) {
      await QuickProductModel.insertMany(
        fresh.map((productId, i) => ({ _id: newId('qp'), productId, categoryId: cat._id, branchId: cat.branchId ?? null, order: base + i + 1, updatedAt: nowISO() })),
      );
    }
    notify();
    res.json({ added: fresh.length, removed });
  } catch (e) {
    next(e);
  }
});

/** Orders candidate products by the last 90 days of sales, keeping unsold ones at the end. */
async function rankBySales(ids: string[], branchId?: string): Promise<string[]> {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const match: Record<string, unknown> = { date: { $gte: since }, status: 'completed' };
  if (branchId) match.branchId = branchId;
  const rows = await SaleModel.aggregate<{ _id: string; qty: number }>([
    { $match: match },
    { $unwind: '$items' },
    { $match: { 'items.productId': { $in: ids } } },
    { $group: { _id: '$items.productId', qty: { $sum: '$items.quantity' } } },
    { $sort: { qty: -1, _id: 1 } },
  ]);
  const rank = new Map(rows.map((r, i) => [r._id, i]));
  return [...ids].sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
}

quickRouter.delete('/categories/:id', authorize('settings.edit', 'settings.quick_grid'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    await QuickCategoryModel.deleteOne({ _id: id });
    await QuickProductModel.updateMany({ categoryId: id }, { $set: { categoryId: null, updatedAt: nowISO() } });
    await TombstoneModel.create({ _id: `qc:${id}`, coll: 'quickCategories', entityId: id, deletedAt: nowISO() });
    notify();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
