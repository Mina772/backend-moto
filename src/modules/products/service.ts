import type { ClientSession } from 'mongoose';
import type { AlternativeSuggestion, MotorcycleModel, Permission, PriceField, PriceHistoryEntry, Product, ProductPrices, Warehouse } from '@moto/shared';
import { buildInternalBarcode, hasPermission, stockStatusOf } from '@moto/shared';
import type { ProductCreateInput, ProductPlacementInput, ProductUpdateInput } from '@moto/shared';
import { CategoryModel, MotorcycleModelModel, PriceHistoryModel, ProductModel, StockLevelModel, WarehouseModel, stockLevelId } from '../../db/models.js';
import { nextSeq } from '../../lib/counters.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { newId, nowISO } from '../../lib/ids.js';
import { toPublic } from '../../lib/pagination.js';
import { audit } from '../../lib/audit.js';
import { getSettings } from '../settings/service.js';
import { salesWarehouseFor, stockByProduct } from '../inventory/stock.js';

export interface ProductWithStock extends Product {
  totalStock: number;
  branchStock: Record<string, number>;
  stockStatus: 'in' | 'low' | 'out';
  /** Quantity and location in the warehouse that checkout actually deducts from. */
  saleStock?: number;
  saleLocation?: string;
  /** Shelf in the scoped branch, so POS and labels can point staff at the part. */
  location?: string;
}

export { stockStatusOf };

/** Strip cost fields unless the caller may see them (`prices.view_cost`). */
export function hideCost<T extends { purchasePrice: number; lastPurchaseCost: number }>(rows: T[], permissions: readonly Permission[]): T[] {
  if (hasPermission(permissions, 'prices.view_cost')) return rows;
  return rows.map((r) => ({ ...r, purchasePrice: 0, lastPurchaseCost: 0 }));
}

export async function enrichProducts(products: Product[], branchId?: string): Promise<ProductWithStock[]> {
  const stock = await stockByProduct(products.map((p) => p.id));
  const saleWarehouse = branchId ? await salesWarehouseFor(branchId).catch(() => null) : null;
  const saleLevels = saleWarehouse ? await StockLevelModel.find({ warehouseId: saleWarehouse, productId: { $in: products.map((p) => p.id) } }).lean() : [];
  const saleMap = new Map(saleLevels.map((l) => [l.productId, l]));
  return products.map((p) => {
    const s = stock.get(p.id) ?? { total: 0, byBranch: {}, byWarehouse: {}, locationByBranch: {} };
    const scoped = branchId ? (s.byBranch[branchId] ?? 0) : s.total;
    const location = branchId ? s.locationByBranch[branchId] : Object.values(s.locationByBranch)[0];
    const saleLevel = saleMap.get(p.id);
    return { ...p, totalStock: scoped, branchStock: s.byBranch, stockStatus: stockStatusOf(scoped, p.minStock), location,
      ...(branchId ? { saleStock: saleLevel?.quantity ?? 0, saleLocation: saleLevel ? [saleLevel.locationCode, saleLevel.shelf, saleLevel.bin].filter(Boolean).join(' · ') || undefined : undefined } : {}),
    };
  });
}

export async function generateInternalBarcode(session?: ClientSession): Promise<string> {
  const settings = await getSettings(session);
  for (let i = 0; i < 20; i++) {
    const seq = await nextSeq('barcode', session);
    const code = buildInternalBarcode(settings.barcode.internalPrefix, seq, settings.barcode.length);
    const exists = await ProductModel.exists({ internalBarcode: code }).session(session ?? null);
    if (!exists) return code;
  }
  throw conflict('Could not allocate a unique barcode', 'BARCODE_ALLOC');
}

/** Gives every legacy row a unique system barcode (and an SKU when it had none). */
export async function backfillProductBarcodes(): Promise<number> {
  const missing = await ProductModel.find({ $or: [{ internalBarcode: { $exists: false } }, { internalBarcode: null }, { internalBarcode: '' }] }).select('_id sku').lean();
  for (const p of missing) {
    const code = await generateInternalBarcode();
    await ProductModel.updateOne({ _id: p._id }, { $set: { internalBarcode: code, ...(p.sku ? {} : { sku: code }) } });
  }
  return missing.length;
}

/** Two products sharing a manufacturer barcode would make a scan ambiguous. */
async function assertLegacyBarcodeFree(legacyBarcode: string | undefined, excludeId?: string) {
  const code = legacyBarcode?.trim();
  if (!code) return;
  const clash = await ProductModel.findOne({ legacyBarcode: code, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).select('_id').lean();
  if (clash) throw conflict('This barcode is already assigned to another product', 'BARCODE_EXISTS', { productId: clash._id });
}

const DEFAULT_PLACEMENT = { locationCode: 'A', shelf: 'A1', bin: 'A1-1' };
const DEFAULT_UNIT = { ar: 'قطعة', en: 'Piece' };

/** Validates a placement against the warehouse structure (free text is allowed when the warehouse defines none). */
async function resolvePlacement(placement: ProductPlacementInput) {
  const wh = await WarehouseModel.findById(placement.warehouseId).lean();
  if (!wh || !wh.isActive) throw unprocessable('Warehouse not found or inactive', 'INVALID_PLACEMENT', { field: 'warehouseId' });
  const locations = (wh.locations ?? []) as Warehouse['locations'];
  if (locations.some((l) => l.shelves?.length)) {
    const loc = locations.find((l) => l.code === placement.locationCode && l.shelves.some((s) => s.code === placement.shelf));
    const shelf = loc?.shelves.find((s) => s.code === placement.shelf);
    if (!loc || !shelf) throw unprocessable('Shelf does not exist in this warehouse', 'INVALID_PLACEMENT', { field: 'shelf' });
    if (placement.bin && !shelf.bins.some((b) => b.code === placement.bin)) throw unprocessable('Bin does not exist on this shelf', 'INVALID_PLACEMENT', { field: 'bin' });
  }
  return { warehouse: wh, location: { locationCode: placement.locationCode, shelf: placement.shelf, bin: placement.bin } };
}

/** Moves the product to a shelf in one warehouse, creating the (zero) stock level if needed. */
async function applyPlacement(productId: string, placement: ProductPlacementInput, now: string) {
  const { warehouse, location } = await resolvePlacement(placement);
  await StockLevelModel.updateOne(
    { productId, warehouseId: warehouse._id },
    { $set: { ...location, updatedAt: now }, $setOnInsert: { _id: stockLevelId(productId, warehouse._id), branchId: warehouse.branchId, quantity: 0, reserved: 0 } },
    { upsert: true },
  );
}

export async function createProduct(input: ProductCreateInput, userId: string, branchId = '', ip = ''): Promise<ProductWithStock> {
  const { placement, ...data } = input;
  if (data.sku && (await ProductModel.exists({ sku: data.sku }))) throw conflict('SKU already exists', 'SKU_EXISTS');
  await assertLegacyBarcodeFree(data.legacyBarcode);
  if (placement) await resolvePlacement(placement);
  const now = nowISO();
  const internalBarcode = await generateInternalBarcode();
  const id = newId('prod');
  await ProductModel.create({
    _id: id,
    ...data,
    sku: data.sku || internalBarcode,
    internalBarcode,
    unit: data.unit.ar || data.unit.en ? data.unit : DEFAULT_UNIT,
    prices: {
      retail1: data.prices.retail1,
      retail2: data.prices.retail2 ?? data.prices.retail1,
      wholesale: data.prices.wholesale ?? data.prices.retail1,
    },
    lastPurchaseCost: data.lastPurchaseCost ?? data.purchasePrice,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  // Zero stock level in every active warehouse so the product is visible everywhere.
  const warehouses = await WarehouseModel.find({ isActive: true }).lean();
  if (warehouses.length) {
    await StockLevelModel.insertMany(
      warehouses.map((w) => {
        const location = placement && placement.warehouseId === w._id ? { locationCode: placement.locationCode, shelf: placement.shelf, bin: placement.bin } : DEFAULT_PLACEMENT;
        return { _id: stockLevelId(id, w._id), productId: id, branchId: w.branchId, warehouseId: w._id, quantity: 0, reserved: 0, ...location, updatedAt: now };
      }),
      { ordered: false },
    );
  }
  await audit({ userId, action: 'product_create', entity: 'product', entityId: id, branchId, after: { name: data.name, sku: data.sku || internalBarcode, internalBarcode, categoryId: data.categoryId }, ip });
  return (await getProduct(id))!;
}

const PRICE_FIELDS: PriceField[] = ['retail1', 'retail2', 'wholesale', 'purchasePrice'];

export interface UpdateProductContext {
  userId: string;
  branchId: string;
  ip: string;
  permissions: readonly Permission[];
  source?: PriceHistoryEntry['source'];
}

export async function updateProduct(id: string, patch: ProductUpdateInput, ctx: UpdateProductContext): Promise<ProductWithStock> {
  const { userId, branchId, ip, permissions, source = 'single' } = ctx;
  const doc = await ProductModel.findById(id);
  if (!doc) throw notFound('Product not found');
  const { changeReason, placement, ...rest } = patch;
  const before = doc.toObject();
  const now = nowISO();

  // Only the tiers the caller actually sent may change; an absent tier must never reset to 0.
  const sentPrices = Object.fromEntries(Object.entries(rest.prices ?? {}).filter(([, v]) => v !== undefined));
  const nextPrices: ProductPrices = { ...before.prices, ...sentPrices };
  const changes: { field: PriceField; oldValue: number; newValue: number }[] = [];
  for (const f of PRICE_FIELDS) {
    const oldV = f === 'purchasePrice' ? before.purchasePrice : before.prices[f];
    const newV = f === 'purchasePrice' ? (rest.purchasePrice ?? before.purchasePrice) : nextPrices[f];
    if (newV !== undefined && newV !== oldV) changes.push({ field: f, oldValue: oldV, newValue: newV });
  }
  // Stock clerks may edit a product but pricing stays with prices.edit, so nothing slips through this route.
  if (changes.length && !hasPermission(permissions, 'prices.edit')) {
    throw forbidden('Changing prices requires prices.edit', 'FORBIDDEN');
  }
  if (rest.legacyBarcode !== undefined) await assertLegacyBarcodeFree(rest.legacyBarcode, id);

  if (placement) await applyPlacement(id, placement, now);
  Object.assign(doc, rest, { prices: nextPrices, updatedAt: now });
  await doc.save();

  const nonPrice = Object.keys(rest).filter((k) => k !== 'prices' && k !== 'purchasePrice');
  if (nonPrice.length) {
    await audit({
      userId,
      action: rest.categoryId && rest.categoryId !== before.categoryId ? 'category_change' : 'product_update',
      entity: 'product',
      entityId: id,
      branchId,
      before: Object.fromEntries(nonPrice.map((k) => [k, (before as Record<string, unknown>)[k]])),
      after: Object.fromEntries(nonPrice.map((k) => [k, (rest as Record<string, unknown>)[k]])),
      ip,
    });
  }

  if (changes.length) {
    await PriceHistoryModel.insertMany(changes.map((c) => ({ _id: newId('ph'), productId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, userId, branchId, source, date: now, reason: changeReason })));
    await audit({
      userId,
      action: 'price_change',
      entity: 'product',
      entityId: id,
      branchId,
      before: Object.fromEntries(changes.map((c) => [c.field, c.oldValue])),
      after: Object.fromEntries(changes.map((c) => [c.field, c.newValue])),
      ip,
    });
  }
  return (await getProduct(id))!;
}

/** Refiles products under another category; the category must exist. */
export async function moveProducts(ids: string[], categoryId: string, userId: string, branchId: string, ip: string): Promise<number> {
  if (!(await CategoryModel.exists({ _id: categoryId }))) throw unprocessable('Category not found', 'INVALID_CATEGORY', { field: 'categoryId' });
  const before = await ProductModel.find({ _id: { $in: ids }, deletedAt: null }).select('_id categoryId').lean();
  if (!before.length) return 0;
  const now = nowISO();
  await ProductModel.updateMany({ _id: { $in: before.map((p) => p._id) } }, { $set: { categoryId, updatedAt: now } });
  await Promise.all(
    before
      .filter((p) => p.categoryId !== categoryId)
      .map((p) => audit({ userId, action: 'category_change', entity: 'product', entityId: p._id, branchId, before: { categoryId: p.categoryId }, after: { categoryId }, ip })),
  );
  return before.length;
}

export async function getProduct(id: string, branchId?: string): Promise<ProductWithStock | null> {
  const doc = await ProductModel.findById(id).lean();
  if (!doc) return null;
  const [p] = await enrichProducts([toPublic(doc) as unknown as Product], branchId);
  return p ?? null;
}

/** Resolve a scanned/typed code: internal barcode → sku → legacy barcode. */
export async function lookupProducts(term: string, branchId?: string, limit = 12): Promise<{ products: ProductWithStock[]; legacyHit: boolean }> {
  const t = term.trim();
  if (!t) return { products: [], legacyHit: false };
  const exact = await ProductModel.findOne({ deletedAt: null, $or: [{ internalBarcode: t }, { sku: new RegExp(`^${escapeRe(t)}$`, 'i') }] }).lean();
  if (exact) return { products: await enrichProducts([toPublic(exact) as unknown as Product], branchId), legacyHit: false };
  const legacy = await ProductModel.findOne({ deletedAt: null, legacyBarcode: t }).lean();
  if (legacy) return { products: await enrichProducts([toPublic(legacy) as unknown as Product], branchId), legacyHit: true };
  const re = new RegExp(escapeRe(t), 'i');
  const docs = await ProductModel.find({ deletedAt: null, isActive: true, $or: [{ 'name.ar': re }, { 'name.en': re }, { sku: re }, { partNumber: re }, { internalBarcode: re }] })
    .limit(limit)
    .lean();
  return { products: await enrichProducts(docs.map((d) => toPublic(d) as unknown as Product), branchId), legacyHit: false };
}

export function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function regenerateBarcode(id: string, userId: string, branchId: string, ip: string): Promise<ProductWithStock> {
  const doc = await ProductModel.findById(id);
  if (!doc) throw notFound('Product not found');
  const before = doc.internalBarcode;
  doc.internalBarcode = await generateInternalBarcode();
  doc.updatedAt = nowISO();
  await doc.save();
  await audit({ userId, action: 'barcode_regenerate', entity: 'product', entityId: id, branchId, before: { internalBarcode: before }, after: { internalBarcode: doc.internalBarcode }, ip });
  return (await getProduct(id))!;
}

function partFamily(partNumber: string): string {
  const parts = partNumber.split('-');
  return parts.length > 1 ? parts.slice(0, 2).join('-') : partNumber.slice(0, Math.max(3, Math.floor(partNumber.length * 0.6)));
}

function yearOverlap(a: string, b: string): boolean {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  if (pa.length < 2 || pb.length < 2 || pa.some(Number.isNaN) || pb.some(Number.isNaN)) return a === b;
  return pa[0]! <= pb[1]! && pb[0]! <= pa[1]!;
}

/**
 * Ranked alternatives: explicit links > same category + shared compatible model (year overlap) > same part family.
 * In-stock items first within each tier.
 */
export async function suggestAlternatives(productId: string, branchId: string, inStockOnly: boolean): Promise<AlternativeSuggestion[]> {
  const base = await ProductModel.findById(productId).lean();
  if (!base) throw notFound('Product not found');
  const family = partFamily(base.partNumber ?? '');
  const candidates = await ProductModel.find({
    _id: { $ne: productId },
    deletedAt: null,
    isActive: true,
    $or: [
      { _id: { $in: base.alternativeProductIds } },
      { categoryId: base.categoryId, compatibleModelIds: { $in: base.compatibleModelIds } },
      ...(family.length >= 3 ? [{ partNumber: new RegExp(`^${escapeRe(family)}`, 'i'), categoryId: base.categoryId }] : []),
    ],
  }).lean();
  if (!candidates.length) return [];

  const warehouseId = await salesWarehouseFor(branchId).catch(() => null);
  const saleLevels = warehouseId ? await StockLevelModel.find({ warehouseId }).lean() : [];
  const saleMap = new Map(saleLevels.map((l) => [l.productId, l]));
  const [stock, models] = await Promise.all([stockByProduct(candidates.map((c) => c._id)), MotorcycleModelModel.find({ _id: { $in: base.compatibleModelIds } }).lean()]);
  const modelMap = new Map<string, MotorcycleModel>(models.map((m) => [m._id, toPublic(m) as unknown as MotorcycleModel]));
  const baseModels = base.compatibleModelIds.map((id) => modelMap.get(id)).filter((m): m is MotorcycleModel => Boolean(m));

  const rank = { explicit: 0, compat_same_model: 1, part_family: 2 } as const;
  const out: AlternativeSuggestion[] = candidates.map((c) => {
    const s = stock.get(c._id) ?? { total: 0, byBranch: {}, byWarehouse: {}, locationByBranch: {} };
    const sharedIds = c.compatibleModelIds.filter((id) => base.compatibleModelIds.includes(id));
    const shared = sharedIds.map((id) => modelMap.get(id)).filter((m): m is MotorcycleModel => Boolean(m));
    let matchReason: AlternativeSuggestion['matchReason'];
    if (base.alternativeProductIds.includes(c._id)) matchReason = 'explicit';
    else if (shared.length && c.categoryId === base.categoryId) matchReason = 'compat_same_model';
    else matchReason = 'part_family';
    const otherBranches = Object.entries(s.byBranch)
      .filter(([b, q]) => b !== branchId && q > 0)
      .map(([b, q]) => ({ branchId: b, qty: q }));
    return { product: toPublic(c) as unknown as Product, qtyAvailable: saleMap.get(c._id)?.quantity ?? 0, matchReason, sharedModels: shared, prices: c.prices, otherBranches, location: saleMap.has(c._id) ? [saleMap.get(c._id)!.locationCode, saleMap.get(c._id)!.shelf, saleMap.get(c._id)!.bin].filter(Boolean).join(' · ') || undefined : undefined };
  });

  const yearScore = (a: AlternativeSuggestion) => a.sharedModels.filter((m) => baseModels.some((bm) => bm.id === m.id && yearOverlap(bm.years, m.years))).length;
  const filtered = inStockOnly ? out.filter((a) => a.qtyAvailable > 0 || a.otherBranches.length > 0) : out;
  return filtered.sort((a, b) => {
    const inA = a.qtyAvailable > 0 ? 0 : 1;
    const inB = b.qtyAvailable > 0 ? 0 : 1;
    if (inA !== inB) return inA - inB;
    if (rank[a.matchReason] !== rank[b.matchReason]) return rank[a.matchReason] - rank[b.matchReason];
    return yearScore(b) - yearScore(a) || b.qtyAvailable - a.qtyAvailable;
  });
}
