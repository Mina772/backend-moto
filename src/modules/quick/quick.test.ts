import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { CategoryModel, ProductModel, QuickProductModel } from '../../db/models.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
let cashier: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  cashier = await loginAs(app, 'cashier1');
});
afterAll(stopTestDb);

const auth = (who: { token: string }) => ({ Authorization: `Bearer ${who.token}` });

describe('quick grid permissions', () => {
  it('a cashier may read the grid but may not rearrange it', async () => {
    const read = await api(app).get('/api/quick-products').set(auth(cashier));
    expect(read.status).toBe(200);

    const created = await api(app).post('/api/quick-products/categories').set(auth(cashier)).send({ name: { ar: 'محاولة' }, order: 0 });
    expect(created.status).toBe(403);

    const reordered = await api(app).patch('/api/quick-products/reorder').set(auth(cashier)).send({ ids: [] });
    expect(reordered.status).toBe(403);
  });
});

describe('filling a quick group from its source', () => {
  it('refuses to fill a group that is not linked to anything', async () => {
    const cat = await api(app).post('/api/quick-products/categories').set(auth(admin)).send({ name: { ar: 'بدون مصدر' }, order: 0 });
    expect(cat.status).toBe(201);
    const res = await api(app).post(`/api/quick-products/categories/${cat.body.id}/fill`).set(auth(admin)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_SOURCE');
  });

  it('fills a group from a department and includes products of its sub-categories', async () => {
    const leaf = await CategoryModel.findOne({ parentId: { $ne: null } }).lean();
    const parentId = leaf!.parentId!;
    const subtree = await CategoryModel.find({ $or: [{ _id: parentId }, { ancestors: parentId }] }).select('_id').lean();
    const expected = await ProductModel.countDocuments({ isActive: true, categoryId: { $in: subtree.map((c) => c._id) } });
    expect(expected).toBeGreaterThan(0);

    const cat = await api(app).post('/api/quick-products/categories').set(auth(admin)).send({ name: { ar: 'قسم مرتبط' }, order: 1, sourceCategoryId: parentId });
    expect(cat.status).toBe(201);

    const res = await api(app).post(`/api/quick-products/categories/${cat.body.id}/fill`).set(auth(admin)).send({ limit: 24 });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(Math.min(expected, 24));

    const tiles = await QuickProductModel.find({ categoryId: cat.body.id }).lean();
    expect(tiles).toHaveLength(res.body.added);
    const allowed = new Set(subtree.map((c) => c._id));
    for (const tile of tiles) {
      const p = await ProductModel.findById(tile.productId).lean();
      expect(allowed.has(p!.categoryId)).toBe(true);
    }
  });

  it('is idempotent and never duplicates a tile', async () => {
    const leaf = await CategoryModel.findOne({ parentId: { $ne: null } }).lean();
    const cat = await api(app).post('/api/quick-products/categories').set(auth(admin)).send({ name: { ar: 'تكرار' }, order: 2, sourceCategoryId: leaf!._id });

    const first = await api(app).post(`/api/quick-products/categories/${cat.body.id}/fill`).set(auth(admin)).send({});
    for (let attempt = 0; attempt < 3; attempt++) {
      const second = await api(app).post(`/api/quick-products/categories/${cat.body.id}/fill`).set(auth(admin)).send({});
      expect(second.status).toBe(200);
      expect(second.body.added).toBe(0);
    }

    const tiles = await QuickProductModel.find({ categoryId: cat.body.id }).lean();
    expect(tiles).toHaveLength(first.body.added);
    expect(new Set(tiles.map((t) => t.productId)).size).toBe(tiles.length);
  });

  it('fills a group from a motorcycle model with that model\'s parts only', async () => {
    const withModel = await ProductModel.findOne({ isActive: true, compatibleModelIds: { $ne: [] } }).lean();
    expect(withModel).toBeTruthy();
    const modelId = withModel!.compatibleModelIds[0];

    const cat = await api(app).post('/api/quick-products/categories').set(auth(admin)).send({ name: { ar: 'موديل' }, order: 3, sourceModelId: modelId });
    const res = await api(app).post(`/api/quick-products/categories/${cat.body.id}/fill`).set(auth(admin)).send({});
    expect(res.status).toBe(200);
    expect(res.body.added).toBeGreaterThan(0);

    const tiles = await QuickProductModel.find({ categoryId: cat.body.id }).lean();
    for (const tile of tiles) {
      const p = await ProductModel.findById(tile.productId).lean();
      expect(p!.compatibleModelIds).toContain(modelId);
    }
  });

  it('replace clears the previous tiles instead of stacking on them', async () => {
    const leaf = await CategoryModel.findOne({ parentId: { $ne: null } }).lean();
    const cat = await api(app).post('/api/quick-products/categories').set(auth(admin)).send({ name: { ar: 'استبدال' }, order: 4, sourceCategoryId: leaf!._id });
    const first = await api(app).post(`/api/quick-products/categories/${cat.body.id}/fill`).set(auth(admin)).send({ limit: 2 });
    expect(first.body.added).toBeGreaterThan(0);

    const again = await api(app).post(`/api/quick-products/categories/${cat.body.id}/fill`).set(auth(admin)).send({ limit: 2, replace: true });
    expect(again.body.removed).toBe(first.body.added);
    expect(await QuickProductModel.countDocuments({ categoryId: cat.body.id })).toBe(again.body.added);
  });
});
