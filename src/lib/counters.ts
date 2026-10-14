import type { ClientSession } from 'mongoose';
import { CounterModel } from '../db/models.js';

export type CounterKey = 'invoice' | 'return' | 'purchase' | 'purchaseReturn' | 'transfer' | 'count' | 'barcode' | 'expense' | 'payment' | 'saleSequence' | 'customer' | 'supplier' | 'terminal';

/** Atomically increments and returns the next sequence value. */
export async function nextSeq(key: CounterKey, session?: ClientSession): Promise<number> {
  const doc = await CounterModel.findByIdAndUpdate(key, { $inc: { seq: 1 } }, { new: true, upsert: true, session }).lean();
  return doc!.seq;
}

export async function ensureCounterAtLeast(key: CounterKey, value: number) {
  await CounterModel.updateOne({ _id: key }, { $max: { seq: value } }, { upsert: true });
}
