import type { ClientSession } from 'mongoose';
import type { StockLevel, StockMovementType } from '@moto/shared';
import { SOCKET_EVENTS } from '@moto/shared';
import { StockLevelModel, StockMovementModel, WarehouseModel, stockLevelId } from '../../db/models.js';
import { HttpError } from '../../lib/errors.js';
import { newId, nowISO } from '../../lib/ids.js';
import { emitToBranch } from '../../realtime/socket.js';
import { getSettings } from '../settings/service.js';

export interface MovementInput {
  productId: string;
  warehouseId: string;
  branchId: string;
  /** Positive adds stock, negative removes. */
  delta: number;
  type: StockMovementType;
  userId: string;
  reference: string;
  notes?: string;
  date?: string;
  /** Overrides settings.invoice.allowNegativeStock. */
  allowNegative?: boolean;
}

export interface MovementResult {
  level: StockLevel;
  previous: number;
  next: number;
}

const pendingEmits = new Map<string, { productId: string; branchId: string; warehouseId: string; quantity: number }>();
let emitTimer: NodeJS.Timeout | null = null;
function queueStockEmit(l: { productId: string; branchId: string; warehouseId: string; quantity: number }) {
  pendingEmits.set(`${l.productId}|${l.warehouseId}`, l);
  if (!emitTimer) {
    emitTimer = setTimeout(() => {
      const items = Array.from(pendingEmits.values());
      pendingEmits.clear();
      emitTimer = null;
      const byBranch = new Map<string, typeof items>();
      for (const i of items) byBranch.set(i.branchId, [...(byBranch.get(i.branchId) ?? []), i]);
      for (const [branchId, levels] of byBranch) emitToBranch(branchId, SOCKET_EVENTS.stockChanged, { branchId, levels });
    }, 150);
  }
}

/**
 * Single gateway for every stock change: writes the movement and updates the level atomically.
 * Throws INSUFFICIENT_STOCK when going negative and negative stock is not allowed.
 */
export async function applyMovement(input: MovementInput, session?: ClientSession): Promise<MovementResult> {
  const id = stockLevelId(input.productId, input.warehouseId);
  const allowNegative = input.allowNegative ?? (await getSettings(session)).invoice.allowNegativeStock;

  const existing = await StockLevelModel.findById(id).session(session ?? null).lean();
  if (!existing) {
    await StockLevelModel.create([{ _id: id, productId: input.productId, branchId: input.branchId, warehouseId: input.warehouseId, quantity: 0, reserved: 0, locationCode: 'A', shelf: 'A1', bin: 'A1-1', updatedAt: nowISO() }], { session });
  }
  // Atomic $inc with a quantity guard so concurrent sales cannot oversell even without a transaction.
  const guard = allowNegative || input.delta >= 0 ? {} : { quantity: { $gte: -input.delta } };
  const level = await StockLevelModel.findOneAndUpdate({ _id: id, ...guard }, { $inc: { quantity: input.delta }, $set: { updatedAt: nowISO() } }, { new: true, session: session ?? null });
  if (!level) {
    const current = (await StockLevelModel.findById(id).session(session ?? null).lean())?.quantity ?? 0;
    throw new HttpError(422, 'INSUFFICIENT_STOCK', `Insufficient stock for product ${input.productId}`, { productId: input.productId, available: current, requested: -input.delta });
  }
  const next = level.quantity;
  const previous = next - input.delta;

  await StockMovementModel.create(
    [
      {
        _id: newId('mv'),
        date: input.date ?? nowISO(),
        productId: input.productId,
        type: input.type,
        quantity: input.delta,
        previousStock: previous,
        newStock: next,
        userId: input.userId,
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        reference: input.reference,
        notes: input.notes,
      },
    ],
    { session },
  );

  queueStockEmit({ productId: input.productId, branchId: input.branchId, warehouseId: input.warehouseId, quantity: next });
  const obj = level.toObject() as unknown as StockLevel & { _id?: string };
  delete obj._id;
  return { level: obj, previous, next };
}

/** Sales deduct from the branch's shop (non-main) warehouse, falling back to any warehouse of that branch. */
export async function salesWarehouseFor(branchId: string, session?: ClientSession): Promise<string> {
  const whs = await WarehouseModel.find({ branchId, isActive: true }).sort({ _id: 1 }).session(session ?? null).lean();
  const shop = whs.find((w) => !w.isMain) ?? whs[0];
  if (!shop) throw new HttpError(422, 'NO_WAREHOUSE', `Branch ${branchId} has no warehouse`);
  return shop._id;
}

export async function mainWarehouseFor(branchId: string, session?: ClientSession): Promise<string> {
  const whs = await WarehouseModel.find({ branchId, isActive: true }).sort({ _id: 1 }).session(session ?? null).lean();
  const wh = whs.find((w) => w.isMain) ?? whs[0];
  if (!wh) throw new HttpError(422, 'NO_WAREHOUSE', `Branch ${branchId} has no warehouse`);
  return wh._id;
}

export async function branchQuantity(productId: string, branchId: string, session?: ClientSession): Promise<number> {
  const levels = await StockLevelModel.find({ productId, branchId }).session(session ?? null).lean();
  return levels.reduce((a, l) => a + l.quantity, 0);
}

export interface ProductStock {
  total: number;
  byBranch: Record<string, number>;
  byWarehouse: Record<string, number>;
  /** "rack · shelf · bin" per branch, taken from the warehouse holding the most stock. */
  locationByBranch: Record<string, string>;
}

export async function stockByProduct(productIds?: string[]): Promise<Map<string, ProductStock>> {
  const filter = productIds ? { productId: { $in: productIds } } : {};
  const levels = await StockLevelModel.find(filter).sort({ quantity: -1 }).lean();
  const map = new Map<string, ProductStock>();
  for (const l of levels) {
    const e = map.get(l.productId) ?? { total: 0, byBranch: {}, byWarehouse: {}, locationByBranch: {} };
    e.total += l.quantity;
    e.byBranch[l.branchId] = (e.byBranch[l.branchId] ?? 0) + l.quantity;
    e.byWarehouse[l.warehouseId] = (e.byWarehouse[l.warehouseId] ?? 0) + l.quantity;
    const label = [l.locationCode, l.shelf, l.bin].filter(Boolean).join(' · ');
    if (label && !e.locationByBranch[l.branchId]) e.locationByBranch[l.branchId] = label;
    map.set(l.productId, e);
  }
  return map;
}
