import type { FilterQuery, Model, SortOrder } from 'mongoose';
import type { ListQuery, Paginated } from '@moto/shared';
import { rangeInstant } from './businessTime.js';
import { badRequest } from './errors.js';

export interface PaginateOptions<T> {
  filter: FilterQuery<T>;
  query: ListQuery;
  defaultSort?: Record<string, SortOrder>;
  sortMap?: Record<string, string>;
  maxPageSize?: number;
}

export async function paginate<T>(model: Model<T>, opts: PaginateOptions<T>): Promise<Paginated<T>> {
  const page = Math.max(1, Number(opts.query.page ?? 1));
  const pageSize = Math.min(opts.maxPageSize ?? 500, Math.max(1, Number(opts.query.pageSize ?? 20)));
  const sortField = opts.query.sortBy ? (opts.sortMap?.[opts.query.sortBy] ?? opts.query.sortBy) : undefined;
  const sort: Record<string, SortOrder> = sortField ? { [sortField]: opts.query.sortDir === 'desc' ? -1 : 1 } : (opts.defaultSort ?? { _id: -1 });
  const [total, docs] = await Promise.all([
    model.countDocuments(opts.filter),
    model
      .find(opts.filter)
      .sort(sort)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
  ]);
  return { data: docs.map(toPublic) as T[], total, page, pageSize };
}

/** `_id` → `id` for lean docs. */
export function toPublic<T extends { _id?: unknown }>(doc: T): Omit<T, '_id'> & { id: string } {
  const { _id, ...rest } = doc as T & { _id?: string; id?: string };
  const out = { ...rest, id: String(_id ?? (doc as { id?: string }).id) } as Omit<T, '_id'> & { id: string } & { passwordHash?: string; refreshTokens?: unknown; authVersion?: number };
  delete out.passwordHash;
  delete out.refreshTokens;
  delete out.authVersion;
  return out;
}

export function toPublicList<T extends { _id?: unknown }>(docs: T[]) {
  return docs.map(toPublic);
}

export function searchRegex(term: string | undefined) {
  if (!term?.trim()) return undefined;
  return new RegExp(term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

export function dateRange(from?: string, to?: string): { $gte?: string; $lte?: string } | undefined {
  if (!from && !to) return undefined;
  const r: { $gte?: string; $lte?: string } = {};
  if (from) r.$gte = rangeInstant(from);
  if (to) r.$lte = rangeInstant(to, true);
  if (r.$gte && r.$lte && r.$gte > r.$lte) throw badRequest('Start date exceeds end date', 'INVALID_DATE_RANGE');
  return r;
}
