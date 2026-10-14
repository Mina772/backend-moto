import { badRequest } from './errors.js';

export const BUSINESS_TIME_ZONE = 'Africa/Cairo';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const starts = new Map<string, number>();

export function businessDay(instant: string | number): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw badRequest('Invalid date', 'INVALID_DATE_RANGE');
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function validDay(day: string): number {
  const time = Date.parse(`${day}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== day) throw badRequest('Invalid calendar date', 'INVALID_DATE_RANGE');
  return time;
}

export function nextDay(day: string): string { return new Date(validDay(day) + 86400000).toISOString().slice(0, 10); }

/** First instant of a Cairo calendar day, including midnight DST gaps/overlaps. */
export function dayStart(day: string): number {
  if (starts.has(day)) return starts.get(day)!;
  const utc = validDay(day);
  let lo = utc - 86400000, hi = utc + 86400000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (businessDay(mid) < day) lo = mid + 1; else hi = mid;
  }
  if (starts.size > 1000) starts.clear();
  starts.set(day, lo);
  return lo;
}

export function rangeInstant(value: string, end = false): string {
  if (value.length === 10) return new Date(end ? dayStart(nextDay(value)) - 1 : dayStart(value)).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw badRequest('Timestamp must include a timezone', 'INVALID_DATE_RANGE');
  validDay(value.slice(0, 10));
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw badRequest('Invalid timestamp', 'INVALID_DATE_RANGE');
  return new Date(time).toISOString();
}
