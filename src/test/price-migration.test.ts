import { expect, it } from 'vitest';
import { planThreeTierPrices } from '../db/migrations/price-plan.js';
it('plans legacy prices without deleting the originals or mutating input', () => {
  const old = { retailPrice: 100, wholesalePrice: 80 };
  expect(planThreeTierPrices(old)).toEqual({ status: 'planned', prices: { retail1: 100, retail2: 100, wholesale: 80 } });
  expect(old).toEqual({ retailPrice: 100, wholesalePrice: 80 });
});
it('preserves valid current prices and blocks ambiguous legacy/current records', () => {
  expect(planThreeTierPrices({ prices: { retail1: 100, retail2: 95, wholesale: 80 }, retailPrice: 999 }).status).toBe('unchanged');
  for (const row of [{}, { retailPrice: -1, wholesalePrice: 1 }, { prices: {} }, { prices: { retail1: 0, retail2: '1', wholesale: 0 } }]) expect(planThreeTierPrices(row).status).toBe('blocked');
});
