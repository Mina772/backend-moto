import { expect, it } from 'vitest';
import { businessDay, dayStart, nextDay } from './businessTime.js';
import { dateRange } from './pagination.js';

it('uses Cairo calendar boundaries rather than UTC dates', () => {
  expect(dateRange('2026-10-12', '2026-10-12')).toEqual({ $gte: '2026-10-11T21:00:00.000Z', $lte: '2026-10-12T20:59:59.999Z' });
  expect(businessDay('2026-10-11T22:30:00.000Z')).toBe('2026-10-12');
  expect(dateRange('2026-10-12T00:00:00+03:00', '2026-10-12T23:59:59+03:00')).toEqual({ $gte: '2026-10-11T21:00:00.000Z', $lte: '2026-10-12T20:59:59.000Z' });
});
it('handles both 23-hour spring and 25-hour autumn Cairo days', () => {
  expect(dayStart(nextDay('2026-04-24')) - dayStart('2026-04-24')).toBe(23 * 3600000);
  expect(dayStart(nextDay('2026-10-29')) - dayStart('2026-10-29')).toBe(25 * 3600000);
});
it('rejects malformed, impossible, ambiguous and reversed ranges', () => {
  for (const day of ['bad', '2026-02-30', '2026-13-01', '2026-10-12T12:00:00']) expect(() => dateRange(day, '2026-10-15')).toThrow();
  expect(() => dateRange('2026-10-15', '2026-10-12')).toThrow();
});
