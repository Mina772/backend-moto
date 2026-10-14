import type { FilterQuery, Model, SortOrder } from 'mongoose';
import type { ListQuery, Paginated } from '@moto/shared';

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
  const out = { ...rest, id: String(_id ?? (doc as { id?: string }).id) } as Omit<T, '_id'> & { id: string } & { passwordHash?: string; refreshTokens?: unknown };
  delete out.passwordHash;
  delete out.refreshTokens;
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
  if (from) r.$gte = from;
  if (to) r.$lte = to.length === 10 ? `${to}T23:59:59.999Z` : to;
  return r;
}
