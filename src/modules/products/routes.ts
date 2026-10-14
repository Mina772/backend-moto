import { Router } from 'express';
import type { FilterQuery } from 'mongoose';
import type { PriceHistoryEntry, Product } from '@moto/shared';
import {
  AlternativeLinkSchema, AlternativesQuerySchema, BoolQuerySchema, BrandCreateSchema, CategoryCreateSchema, CategoryReorderSchema, CategoryUpdateSchema, CompatibilitySchema, ListQuerySchema, MotorcycleModelCreateSchema, ProductBulkUpdateSchema, ProductCreateSchema, ProductMoveSchema, ProductUpdateSchema, hasPermission,
} from '@moto/shared';
import { z } from 'zod';
import { BrandModel, MotorcycleModelModel, PriceHistoryModel, ProductModel, StockLevelModel } from '../../db/models.js';
import { clientIp } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { newId, nowISO } from '../../lib/ids.js';
import { dateRange, searchRegex, toPublic, toPublicList } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize, branchScope } from '../../middleware/authorize.js';
import { q, validate } from '../../middleware/validate.js';
import { categoryTree, categoryWithDescendants, createCategory, deleteCategory, listCategories, reorderCategories, updateCategory } from './categories.js';
import { visibleCosts } from '../../lib/visibility.js';
import { createProduct, enrichProducts, getProduct, hideCost, lookupProducts, moveProducts, regenerateBarcode, suggestAlternatives, updateProduct } from './service.js';

export const productsRouter = Router();
export const catalogRouter = Router();

productsRouter.use(authenticate());
productsRouter.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => json(visibleCosts(body, req.auth!.permissions));
  next();
});
catalogRouter.use(authenticate());

const ProductQuerySchema = ListQuerySchema.extend({
  categoryId: z.string().optional(),
  brandId: z.string().optional(),
  supplierId: z.string().optional(),
  stockStatus: z.enum(['in', 'low', 'out']).optional(),
  isActive: BoolQuerySchema.optional(),
  modelId: z.string().optional(),
  includeInactive: BoolQuerySchema.optional(),
  /** When set, `categoryId` matches the whole subtree instead of just that node. */
  includeDescendants: BoolQuerySchema.optional(),
  size: z.string().optional(),
});

const PriceHistoryQuerySchema = ListQuerySchema.extend({
  productId: z.string().optional(),
  userId: z.string().optional(),
  field: z.enum(['retail1', 'retail2', 'wholesale', 'purchasePrice']).optional(),
});

productsRouter.get('/', authorize('inventory.view', 'sales.create'), async (req, res, next) => {
  try {
    const query = q(req, ProductQuerySchema);
    const filter: FilterQuery<Product> = { deletedAt: null };
    if (query.categoryId) filter.categoryId = query.includeDescendants ? { $in: await categoryWithDescendants(query.categoryId) } : query.categoryId;
    if (query.brandId) filter.brandId = query.brandId;
    if (query.supplierId) filter.supplierId = query.supplierId;
    if (query.isActive !== undefined) filter.isActive = query.isActive;
    if (query.modelId) filter.compatibleModelIds = query.modelId;
    if (query.size) filter.size = query.size;
    const re = searchRegex(query.search);
    if (re) filter.$or = [{ 'name.ar': re }, { 'name.en': re }, { sku: re }, { partNumber: re }, { size: re }, { internalBarcode: re }, { legacyBarcode: re }];

    const docs = await ProductModel.find(filter).sort({ updatedAt: -1 }).lean();
    const branchId = branchScope(req, query.branchId);
    let rows = await enrichProducts(docs.map((d) => toPublic(d) as unknown as Product), branchId);
    if (query.stockStatus) rows = rows.filter((r) => r.stockStatus === query.stockStatus);
    if (query.sortBy) {
      const key = query.sortBy as keyof typeof rows[number];
      const dir = query.sortDir === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const av = a[key] as unknown as string | number;
        const bv = b[key] as unknown as string | number;
        return av === bv ? 0 : av > bv ? dir : -dir;
      });
    }
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    res.json({ data: hideCost(rows.slice((page - 1) * pageSize, page * pageSize), req.auth!.permissions), total: rows.length, page, pageSize });
  } catch (e) {
    next(e);
  }
});

productsRouter.get('/all', authorize('inventory.view', 'sales.create', 'reports.view', 'purchases.view', 'customers.view'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    const docs = await ProductModel.find({ deletedAt: null }).sort({ 'name.ar': 1 }).lean();
    res.json(hideCost(await enrichProducts(docs.map((d) => toPublic(d) as unknown as Product), branchId), req.auth!.permissions));
  } catch (e) {
    next(e);
  }
});

productsRouter.get('/lookup', authorize('inventory.view', 'sales.create'), async (req, res, next) => {
  try {
    const term = String(req.query.term ?? '');
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    const limit = Math.min(50, Number(req.query.limit ?? 12));
    const { products, legacyHit } = await lookupProducts(term, branchId, limit);
    if (legacyHit) res.setHeader('X-Legacy-Barcode', 'true');
    res.json(hideCost(products, req.auth!.permissions));
  } catch (e) {
    next(e);
  }
});

productsRouter.get('/price-history', authorize('prices.view_cost', 'prices.edit'), async (req, res, next) => {
  try {
    const query = q(req, PriceHistoryQuerySchema);
    const filter: FilterQuery<PriceHistoryEntry> = {};
    if (query.productId) filter.productId = query.productId;
    if (query.userId) filter.userId = query.userId;
    if (query.field) filter.field = query.field;
    const scoped = branchScope(req, query.branchId);
    if (scoped) filter.branchId = scoped;
    const range = dateRange(query.from, query.to);
    if (range) filter.date = range;
    if (!hasPermission(req.auth!.permissions, 'prices.view_cost')) {
      filter.field = query.field === 'purchasePrice' ? { $in: [] } : query.field ?? { $ne: 'purchasePrice' };
    }
    const docs = await PriceHistoryModel.find(filter).sort({ date: -1 }).limit(query.pageSize ?? 500).lean();
    res.json(toPublicList(docs));
  } catch (e) {
    next(e);
  }
});

productsRouter.post('/', authorize('inventory.adjust', 'prices.edit', 'settings.edit'), validate(ProductCreateSchema), async (req, res, next) => {
  try {
    res.status(201).json(await createProduct(req.body, req.auth!.id, req.auth!.branchId, clientIp(req)));
  } catch (e) {
    next(e);
  }
});

productsRouter.post('/bulk', authorize('inventory.adjust', 'prices.edit'), validate(ProductBulkUpdateSchema), async (req, res, next) => {
  try {
    const { ids, patch } = req.body as { ids: string[]; patch: Record<string, unknown> };
    let count = 0;
    for (const id of ids) {
      await updateProduct(id, patch, { userId: req.auth!.id, branchId: req.auth!.branchId, ip: clientIp(req), permissions: req.auth!.permissions, source: 'bulk' });
      count++;
    }
    res.json({ count });
  } catch (e) {
    next(e);
  }
});

productsRouter.post('/move', authorize('inventory.adjust', 'prices.edit', 'settings.edit'), validate(ProductMoveSchema), async (req, res, next) => {
  try {
    const { ids, categoryId } = req.body as { ids: string[]; categoryId: string };
    res.json({ count: await moveProducts(ids, categoryId, req.auth!.id, req.auth!.branchId, clientIp(req)) });
  } catch (e) {
    next(e);
  }
});

productsRouter.get('/:id', authorize('inventory.view', 'sales.create'), async (req, res, next) => {
  try {
    const p = await getProduct(req.params.id as string, branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined));
    if (!p) throw notFound('Product not found');
    res.json(hideCost([p], req.auth!.permissions)[0]);
  } catch (e) {
    next(e);
  }
});

productsRouter.patch('/:id', authorize('inventory.adjust', 'prices.edit', 'settings.edit'), validate(ProductUpdateSchema), async (req, res, next) => {
  try {
    res.json(await updateProduct(req.params.id as string, req.body, { userId: req.auth!.id, branchId: req.auth!.branchId, ip: clientIp(req), permissions: req.auth!.permissions }));
  } catch (e) {
    next(e);
  }
});

productsRouter.get('/:id/stock', authorize('inventory.view', 'sales.create'), async (req, res, next) => {
  try {
    const scoped = branchScope(req);
    const levels = await StockLevelModel.find({ productId: req.params.id as string, ...(scoped ? { branchId: scoped } : {}) }).lean();
    res.json(levels.map((l) => { const { _id, ...rest } = l; void _id; return rest; }));
  } catch (e) {
    next(e);
  }
});

productsRouter.post('/:id/barcode/regenerate', authorize('settings.edit'), async (req, res, next) => {
  try {
    res.json(await regenerateBarcode(req.params.id as string, req.auth!.id, req.auth!.branchId, clientIp(req)));
  } catch (e) {
    next(e);
  }
});

productsRouter.get('/:id/alternatives', authorize('inventory.view', 'sales.create'), async (req, res, next) => {
  try {
    const { branchId, inStockOnly } = q(req, AlternativesQuerySchema);
    res.json(visibleCosts(await suggestAlternatives(req.params.id as string, branchScope(req, branchId) ?? branchId, inStockOnly), req.auth!.permissions));
  } catch (e) {
    next(e);
  }
});

productsRouter.post('/:id/compatibility', authorize('inventory.adjust', 'prices.edit'), validate(CompatibilitySchema), async (req, res, next) => {
  try {
    const { modelId, compatible } = req.body as { modelId: string; compatible: boolean };
    const doc = await ProductModel.findByIdAndUpdate(req.params.id as string, compatible ? { $addToSet: { compatibleModelIds: modelId }, $set: { updatedAt: nowISO() } } : { $pull: { compatibleModelIds: modelId }, $set: { updatedAt: nowISO() } }, { new: true }).lean();
    if (!doc) throw notFound('Product not found');
    res.json(doc.compatibleModelIds);
  } catch (e) {
    next(e);
  }
});

productsRouter.post('/:id/alternatives', authorize('inventory.adjust', 'prices.edit'), validate(AlternativeLinkSchema), async (req, res, next) => {
  try {
    const { altId, link } = req.body as { altId: string; link: boolean };
    const id = req.params.id as string;
    const op = link ? '$addToSet' : '$pull';
    await Promise.all([
      ProductModel.updateOne({ _id: id }, { [op]: { alternativeProductIds: altId }, $set: { updatedAt: nowISO() } }),
      ProductModel.updateOne({ _id: altId }, { [op]: { alternativeProductIds: id }, $set: { updatedAt: nowISO() } }),
    ]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------- catalog ----------
catalogRouter.get('/brands', async (_req, res, next) => {
  try {
    res.json(toPublicList(await BrandModel.find().sort({ 'name.ar': 1 }).lean()));
  } catch (e) {
    next(e);
  }
});
catalogRouter.post('/brands', authorize('inventory.adjust', 'prices.edit', 'settings.edit'), validate(BrandCreateSchema), async (req, res, next) => {
  try {
    const { name, country } = req.body as { name: { ar: string; en?: string }; country: { ar: string; en?: string } };
    // Idempotent on either language so the inline "+" in the product form never duplicates a brand.
    const existing = await BrandModel.findOne({ $or: [{ 'name.ar': name.ar || '\u0000' }, { 'name.en': name.en || '\u0000' }] }).lean();
    if (existing) {
      res.json(toPublic(existing));
      return;
    }
    const doc = await BrandModel.create({ _id: newId('brand'), name, country });
    res.status(201).json(toPublic(doc.toObject()));
  } catch (e) {
    next(e);
  }
});
catalogRouter.get('/categories', async (_req, res, next) => {
  try {
    res.json(await listCategories());
  } catch (e) {
    next(e);
  }
});
catalogRouter.get('/categories/tree', async (_req, res, next) => {
  try {
    res.json(await categoryTree());
  } catch (e) {
    next(e);
  }
});
catalogRouter.post('/categories', authorize('inventory.adjust', 'prices.edit', 'settings.edit'), validate(CategoryCreateSchema), async (req, res, next) => {
  try {
    const { category, created } = await createCategory(req.body);
    res.status(created ? 201 : 200).json(category);
  } catch (e) {
    next(e);
  }
});
catalogRouter.post('/categories/reorder', authorize('inventory.adjust', 'prices.edit', 'settings.edit'), validate(CategoryReorderSchema), async (req, res, next) => {
  try {
    const { parentId, ids } = req.body as { parentId: string | null; ids: string[] };
    res.json(await reorderCategories(parentId, ids));
  } catch (e) {
    next(e);
  }
});
catalogRouter.patch('/categories/:id', authorize('inventory.adjust', 'prices.edit', 'settings.edit'), validate(CategoryUpdateSchema), async (req, res, next) => {
  try {
    res.json(await updateCategory(req.params.id as string, req.body));
  } catch (e) {
    next(e);
  }
});
catalogRouter.delete('/categories/:id', authorize('settings.edit'), async (req, res, next) => {
  try {
    await deleteCategory(req.params.id as string);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
catalogRouter.get('/models', async (_req, res, next) => {
  try {
    res.json(toPublicList(await MotorcycleModelModel.find().sort({ code: 1 }).lean()));
  } catch (e) {
    next(e);
  }
});
catalogRouter.post('/models', authorize('inventory.adjust', 'settings.edit'), validate(MotorcycleModelCreateSchema), async (req, res, next) => {
  try {
    const doc = await MotorcycleModelModel.create({ _id: newId('mdl'), ...req.body });
    res.status(201).json(toPublic(doc.toObject()));
  } catch (e) {
    next(e);
  }
});
