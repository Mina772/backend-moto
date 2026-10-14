import type { Category, CategoryNode } from '@moto/shared';
import type { CategoryCreateInput, CategoryUpdateInput } from '@moto/shared';
import { CategoryModel, ProductModel } from '../../db/models.js';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { toPublic } from '../../lib/pagination.js';

const pub = (d: unknown) => toPublic(d as { _id: string }) as unknown as Category;

export const ROOT_DEPARTMENTS: { id: string; name: { ar: string; en: string } }[] = [
  { id: 'cat-dep-2w', name: { ar: 'موتر 2 عجلة', en: '2-Wheel Motorcycles' } },
  { id: 'cat-dep-3w', name: { ar: 'موتر 3 عجلة', en: '3-Wheel Motorcycles' } },
  { id: 'cat-dep-sport', name: { ar: 'موتر رياضي', en: 'Sport Motorcycles' } },
  { id: 'cat-dep-accessories', name: { ar: 'الزينة والإكسسوارات', en: 'Accessories & Decoration' } },
];

async function allCategories(): Promise<Category[]> {
  const docs = await CategoryModel.find().sort({ sortOrder: 1, 'name.ar': 1 }).lean();
  return docs.map(pub);
}

/** Resolves the ancestor chain for a prospective parent, rejecting cycles and unknown parents. */
async function ancestorsFor(parentId: string | null, selfId?: string): Promise<string[]> {
  if (!parentId) return [];
  const parent = await CategoryModel.findById(parentId).lean();
  if (!parent) throw unprocessable('Parent category not found', 'INVALID_PARENT', { field: 'parentId' });
  const chain = [...(parent.ancestors ?? []), parentId];
  if (selfId && chain.includes(selfId)) throw unprocessable('A category cannot be moved inside itself', 'CATEGORY_CYCLE', { field: 'parentId' });
  return chain;
}

export async function listCategories(): Promise<Category[]> {
  return allCategories();
}

/** Flat ids of a node plus every descendant — used to scope product queries to a whole department. */
export async function categoryWithDescendants(categoryId: string): Promise<string[]> {
  const descendants = await CategoryModel.find({ ancestors: categoryId }).select('_id').lean();
  return [categoryId, ...descendants.map((d) => d._id)];
}

export async function categoryTree(): Promise<CategoryNode[]> {
  const cats = await allCategories();
  const counts = await ProductModel.aggregate<{ _id: string; n: number }>([{ $match: { deletedAt: null } }, { $group: { _id: '$categoryId', n: { $sum: 1 } } }]);
  const countMap = new Map(counts.map((c) => [c._id, c.n]));

  const nodes = new Map<string, CategoryNode>(
    cats.map((c) => [c.id, { ...c, depth: c.ancestors.length, productCount: countMap.get(c.id) ?? 0, totalProductCount: countMap.get(c.id) ?? 0, children: [] }]),
  );
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
    for (const a of node.ancestors) {
      const anc = nodes.get(a);
      if (anc) anc.totalProductCount += node.productCount;
    }
  }
  const sortRec = (list: CategoryNode[]): CategoryNode[] => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.ar.localeCompare(b.name.ar, 'ar'));
    for (const n of list) sortRec(n.children);
    return list;
  };
  return sortRec(roots);
}

export async function createCategory(input: CategoryCreateInput): Promise<{ category: Category; created: boolean }> {
  const ancestors = await ancestorsFor(input.parentId);
  const existing = await CategoryModel.findOne({ parentId: input.parentId, $or: [{ 'name.ar': input.name.ar || '\u0000' }, { 'name.en': input.name.en || '\u0000' }] }).lean();
  if (existing) return { category: pub(existing), created: false };
  const sortOrder = input.sortOrder ?? (await CategoryModel.countDocuments({ parentId: input.parentId }));
  const doc = await CategoryModel.create({ _id: newId('cat'), name: input.name, parentId: input.parentId, ancestors, sortOrder, isActive: input.isActive });
  return { category: pub(doc.toObject()), created: true };
}

export async function updateCategory(id: string, patch: CategoryUpdateInput): Promise<Category> {
  const doc = await CategoryModel.findById(id);
  if (!doc) throw notFound('Category not found');
  if (patch.name) doc.name = patch.name;
  if (patch.sortOrder !== undefined) doc.sortOrder = patch.sortOrder;
  if (patch.isActive !== undefined) doc.isActive = patch.isActive;

  if (patch.parentId !== undefined && patch.parentId !== doc.parentId) {
    const ancestors = await ancestorsFor(patch.parentId, id);
    const oldChain = [...doc.ancestors, id];
    doc.parentId = patch.parentId;
    doc.ancestors = ancestors;
    // Rewrite the prefix of every descendant chain so the subtree moves with the node.
    const subtree = await CategoryModel.find({ ancestors: id }).lean();
    for (const child of subtree) {
      const tail = child.ancestors.slice(oldChain.length);
      await CategoryModel.updateOne({ _id: child._id }, { $set: { ancestors: [...ancestors, id, ...tail] } });
    }
  }
  await doc.save();
  return pub(doc.toObject());
}

export async function reorderCategories(parentId: string | null, ids: string[]): Promise<Category[]> {
  const siblings = await CategoryModel.find({ parentId }).select('_id').lean();
  const known = new Set(siblings.map((s) => s._id));
  if (ids.some((i) => !known.has(i))) throw badRequest('Reorder list must only contain direct children of the parent', 'INVALID_REORDER');
  await Promise.all(ids.map((id, i) => CategoryModel.updateOne({ _id: id }, { $set: { sortOrder: i } })));
  return allCategories();
}

export async function deleteCategory(id: string): Promise<void> {
  const ids = await categoryWithDescendants(id);
  const products = await ProductModel.countDocuments({ categoryId: { $in: ids }, deletedAt: null });
  if (products > 0) throw conflict(`Category still holds ${products} product(s)`, 'CATEGORY_NOT_EMPTY', { products });
  await CategoryModel.deleteMany({ _id: { $in: ids } });
}

/** Idempotent: backfills tree fields on legacy rows and guarantees the four root departments exist. */
export async function ensureCategoryTree(): Promise<void> {
  await CategoryModel.updateMany({ ancestors: { $exists: false } }, { $set: { ancestors: [] } });
  await CategoryModel.updateMany({ sortOrder: { $exists: false } }, { $set: { sortOrder: 0 } });
  await CategoryModel.updateMany({ isActive: { $exists: false } }, { $set: { isActive: true } });

  // Recompute chains for rows that predate the `ancestors` column.
  const all = await CategoryModel.find().select('_id parentId ancestors').lean();
  const byId = new Map(all.map((c) => [c._id, c]));
  for (const c of all) {
    const chain: string[] = [];
    let cursor = c.parentId;
    const guard = new Set<string>([c._id]);
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      chain.unshift(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    if (chain.join('/') !== (c.ancestors ?? []).join('/')) await CategoryModel.updateOne({ _id: c._id }, { $set: { ancestors: chain } });
  }

  for (const [i, dep] of ROOT_DEPARTMENTS.entries()) {
    await CategoryModel.updateOne(
      { _id: dep.id },
      { $setOnInsert: { name: dep.name, parentId: null, ancestors: [], sortOrder: 100 + i, isActive: true } },
      { upsert: true },
    );
  }
}
