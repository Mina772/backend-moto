import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Category, CategoryNode } from '@moto/shared';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { CategoryModel, PriceHistoryModel, ProductModel, StockLevelModel } from '../../db/models.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
let cashier: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  cashier = await loginAs(app, 'cashier1');
});
afterAll(stopTestDb);

const auth = (who = admin) => ({ Authorization: `Bearer ${who.token}` });

describe('category taxonomy', () => {
  it('seeds the four root departments with engine-size children', async () => {
    const res = await api(app).get('/api/catalog/categories/tree').set(auth());
    expect(res.status).toBe(200);
    const roots = res.body as CategoryNode[];
    for (const id of ['cat-dep-2w', 'cat-dep-3w', 'cat-dep-sport', 'cat-dep-accessories']) {
      expect(roots.some((r) => r.id === id)).toBe(true);
    }
    const twoWheel = roots.find((r) => r.id === 'cat-dep-2w')!;
    expect(twoWheel.children.map((c) => c.name.ar)).toEqual(expect.arrayContaining(['125cc', '150cc', '200cc']));
    // A department carries the products of every descendant, not only its own.
    expect(twoWheel.totalProductCount).toBeGreaterThan(twoWheel.productCount);
  });

  it('creates a nested category and fills in the ancestor chain', async () => {
    const res = await api(app).post('/api/catalog/categories').set(auth()).send({ name: { ar: 'كاربراتير', en: 'Carburettor' }, parentId: 'cat-dep-2w-125' });
    expect(res.status).toBe(201);
    const created = res.body as Category;
    expect(created.ancestors).toEqual(['cat-dep-2w', 'cat-dep-2w-125']);
    expect(created.isActive).toBe(true);

    // Same name under the same parent is idempotent rather than a duplicate.
    const again = await api(app).post('/api/catalog/categories').set(auth()).send({ name: { ar: 'كاربراتير' }, parentId: 'cat-dep-2w-125' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(created.id);
  });

  it('accepts an English-only category name', async () => {
    const res = await api(app).post('/api/catalog/categories').set(auth()).send({ name: { en: 'Racing Kits' }, parentId: 'cat-dep-sport' });
    expect(res.status).toBe(201);
    expect(res.body.name.en).toBe('Racing Kits');
  });

  it('moves a subtree and rewrites descendant ancestor chains', async () => {
    const parent = await api(app).post('/api/catalog/categories').set(auth()).send({ name: { ar: 'مجموعة أ' }, parentId: 'cat-dep-2w' });
    const child = await api(app).post('/api/catalog/categories').set(auth()).send({ name: { ar: 'مجموعة ب' }, parentId: parent.body.id });
    expect(child.body.ancestors).toEqual(['cat-dep-2w', parent.body.id]);

    const moved = await api(app).patch(`/api/catalog/categories/${parent.body.id}`).set(auth()).send({ parentId: 'cat-dep-3w' });
    expect(moved.status).toBe(200);
    expect(moved.body.ancestors).toEqual(['cat-dep-3w']);
    const reloaded = await CategoryModel.findById(child.body.id).lean();
    expect(reloaded!.ancestors).toEqual(['cat-dep-3w', parent.body.id]);
  });

  it('refuses to move a category inside its own subtree', async () => {
    const res = await api(app).patch('/api/catalog/categories/cat-dep-2w').set(auth()).send({ parentId: 'cat-dep-2w-125' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CATEGORY_CYCLE');
  });

  it('blocks deleting a category that still holds products', async () => {
    const res = await api(app).delete('/api/catalog/categories/cat-dep-2w').set(auth());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATEGORY_NOT_EMPTY');
    expect(await CategoryModel.exists({ _id: 'cat-dep-2w' })).toBeTruthy();
  });

  it('deletes an empty category', async () => {
    const created = await api(app).post('/api/catalog/categories').set(auth()).send({ name: { ar: 'قسم مؤقت' }, parentId: null });
    expect((await api(app).delete(`/api/catalog/categories/${created.body.id}`).set(auth())).status).toBe(200);
    expect(await CategoryModel.exists({ _id: created.body.id })).toBeNull();
  });

  it('a cashier cannot create or delete categories', async () => {
    expect((await api(app).post('/api/catalog/categories').set(auth(cashier)).send({ name: { ar: 'ممنوع' }, parentId: null })).status).toBe(403);
    expect((await api(app).delete('/api/catalog/categories/cat-dep-sport').set(auth(cashier))).status).toBe(403);
  });
});

describe('brands', () => {
  it('creates a brand, is idempotent on the name, and shows up in the list', async () => {
    const res = await api(app).post('/api/catalog/brands').set(auth()).send({ name: { ar: 'جيتكو', en: 'Jetco' }, country: { ar: 'مصر' } });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    const again = await api(app).post('/api/catalog/brands').set(auth()).send({ name: { ar: 'جيتكو' } });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(res.body.id);

    const list = await api(app).get('/api/catalog/brands').set(auth());
    expect((list.body as { id: string }[]).filter((b) => b.id === res.body.id)).toHaveLength(1);
  });

  it('accepts an English-only brand name and rejects an empty one', async () => {
    expect((await api(app).post('/api/catalog/brands').set(auth()).send({ name: { en: 'Castrol' } })).status).toBe(201);
    expect((await api(app).post('/api/catalog/brands').set(auth()).send({ name: { ar: '' } })).status).toBe(400);
  });

  it('a cashier cannot create a brand', async () => {
    expect((await api(app).post('/api/catalog/brands').set(auth(cashier)).send({ name: { ar: 'ممنوع' } })).status).toBe(403);
  });
});

describe('browsing products by department', () => {
  it('returns only the node itself by default and the whole subtree on request', async () => {
    const direct = await api(app).get('/api/products?categoryId=cat-dep-2w&pageSize=200').set(auth());
    const subtree = await api(app).get('/api/products?categoryId=cat-dep-2w&includeDescendants=true&pageSize=200').set(auth());
    expect(direct.status).toBe(200);
    expect(subtree.body.total).toBeGreaterThan(direct.body.total);
  });

  it('moves products between categories and records the change in the audit log', async () => {
    const list = await api(app).get('/api/products?categoryId=cat-dep-2w-125-cat-1&includeDescendants=true&pageSize=3').set(auth());
    const ids = (list.body.data as { id: string }[]).map((p) => p.id);
    expect(ids.length).toBeGreaterThan(0);

    const res = await api(app).post('/api/products/move').set(auth()).send({ ids, categoryId: 'cat-dep-3w-200-cat-1' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(ids.length);
    const moved = await ProductModel.find({ _id: { $in: ids } }).lean();
    expect(moved.every((p) => p.categoryId === 'cat-dep-3w-200-cat-1')).toBe(true);

    const audit = await api(app).get(`/api/audit?entityId=${ids[0]}`).set(auth());
    expect(audit.status).toBe(200);
    expect((audit.body.data as { action: string }[]).some((a) => a.action === 'category_change')).toBe(true);
  });

  it('rejects a move into a category that does not exist', async () => {
    const res = await api(app).post('/api/products/move').set(auth()).send({ ids: ['prod-1'], categoryId: 'cat-nope' });
    expect(res.status).toBe(422);
  });
});

describe('low stock reporting', () => {
  const productId = 'prod-1';

  async function setBranchQty(branchId: string, warehouseId: string, qty: number) {
    await StockLevelModel.updateOne({ productId, warehouseId }, { $set: { quantity: qty, branchId } });
  }

  it('flags a product that has exactly reached its minimum, per branch', async () => {
    const product = await ProductModel.findById(productId).lean();
    const min = product!.minStock;
    const levels = await StockLevelModel.find({ productId }).lean();
    const target = levels[0]!;
    await StockLevelModel.updateMany({ productId }, { $set: { quantity: 0 } });
    await setBranchQty(target.branchId, target.warehouseId, min);

    const res = await api(app).get(`/api/inventory/overview?branchId=${target.branchId}`).set(auth());
    expect(res.status).toBe(200);
    const row = (res.body.rows as { productId: string; quantity: number; minStock: number; status: string }[]).find((r) => r.productId === productId);
    expect(row).toBeDefined();
    expect(row!.quantity).toBe(min);
    expect(row!.minStock).toBe(min);
    expect(row!.status).toBe('low');
    expect(res.body.lowCount).toBeGreaterThan(0);
  });

  it('surfaces a branch that is short even when the company-wide total looks healthy', async () => {
    const levels = await StockLevelModel.find({ productId }).lean();
    const product = await ProductModel.findById(productId).lean();
    const [short, plenty] = [levels[0]!, levels.find((l) => l.branchId !== levels[0]!.branchId)!];
    await setBranchQty(short.branchId, short.warehouseId, 1);
    await setBranchQty(plenty.branchId, plenty.warehouseId, product!.minStock * 20);

    const all = await api(app).get('/api/inventory/overview').set(auth());
    const row = (all.body.rows as { productId: string; status: string; lowBranches: string[] }[]).find((r) => r.productId === productId)!;
    expect(row.status).toBe('in');
    expect(row.lowBranches).toContain(short.branchId);
    // The headline count must not hide it behind the healthy company-wide total.
    expect(all.body.lowCount).toBeGreaterThan(0);

    const scoped = await api(app).get(`/api/inventory/overview?branchId=${short.branchId}`).set(auth());
    const scopedRow = (scoped.body.rows as { productId: string; status: string }[]).find((r) => r.productId === productId)!;
    expect(scopedRow.status).toBe('low');
  });

  it('counts a branch with zero stock as out even when other branches are full', async () => {
    const levels = await StockLevelModel.find({ productId }).lean();
    const product = await ProductModel.findById(productId).lean();
    const [empty, plenty] = [levels[0]!, levels.find((l) => l.branchId !== levels[0]!.branchId)!];
    await setBranchQty(empty.branchId, empty.warehouseId, 0);
    await setBranchQty(plenty.branchId, plenty.warehouseId, product!.minStock * 20);

    const res = await api(app).get('/api/inventory/overview').set(auth());
    const row = (res.body.rows as { productId: string; outBranches: string[] }[]).find((r) => r.productId === productId)!;
    expect(row.outBranches).toContain(empty.branchId);
    expect(res.body.outCount).toBeGreaterThan(0);
  });

  it('keeps the product list filter in step with the overview', async () => {
    const product = await ProductModel.findById(productId).lean();
    const levels = await StockLevelModel.find({ productId }).lean();
    const target = levels[0]!;
    await StockLevelModel.updateMany({ productId, branchId: target.branchId }, { $set: { quantity: 0 } });
    await setBranchQty(target.branchId, target.warehouseId, product!.minStock);

    const branchId = target.branchId;
    const res = await api(app).get(`/api/products?stockStatus=low&branchId=${branchId}&pageSize=200`).set(auth());
    expect(res.status).toBe(200);
    expect((res.body.data as { id: string }[]).some((p) => p.id === productId)).toBe(true);
  });
});

describe('price history', () => {
  it('records branch, user and source for a single price edit', async () => {
    const before = await ProductModel.findById('prod-2').lean();
    const res = await api(app).patch('/api/products/prod-2').set(auth()).send({ prices: { retail1: before!.prices.retail1 + 25 }, changeReason: 'اختبار' });
    expect(res.status).toBe(200);

    const entry = await PriceHistoryModel.findOne({ productId: 'prod-2', field: 'retail1' }).sort({ date: -1 }).lean();
    expect(entry).toMatchObject({
      oldValue: before!.prices.retail1,
      newValue: before!.prices.retail1 + 25,
      userId: admin.user.id,
      branchId: admin.user.branchId,
      source: 'single',
      reason: 'اختبار',
    });
  });

  it('records one immutable entry per product on a bulk update', async () => {
    const ids = ['prod-3', 'prod-4'];
    const before = await ProductModel.find({ _id: { $in: ids } }).lean();
    const countBefore = await PriceHistoryModel.countDocuments({ productId: { $in: ids } });

    const res = await api(app).post('/api/products/bulk').set(auth()).send({ ids, patch: { prices: { wholesale: 999 } } });
    expect(res.status).toBe(200);

    const entries = await PriceHistoryModel.find({ productId: { $in: ids }, source: 'bulk', newValue: 999 }).lean();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.oldValue).sort()).toEqual(before.map((p) => p.prices.wholesale).sort());
    expect(await PriceHistoryModel.countDocuments({ productId: { $in: ids } })).toBe(countBefore + 2);
  });

  it('never alters the cost price when a selling price changes', async () => {
    const before = await ProductModel.findById('prod-5').lean();
    await api(app).patch('/api/products/prod-5').set(auth()).send({ prices: { retail2: 777 } });
    const after = await ProductModel.findById('prod-5').lean();
    expect(after!.purchasePrice).toBe(before!.purchasePrice);
    expect(after!.lastPurchaseCost).toBe(before!.lastPurchaseCost);
  });

  it('filters history by product and tier', async () => {
    const res = await api(app).get('/api/products/price-history?productId=prod-2&field=retail1').set(auth());
    expect(res.status).toBe(200);
    expect((res.body as { productId: string; field: string }[]).every((e) => e.productId === 'prod-2' && e.field === 'retail1')).toBe(true);
  });
});
