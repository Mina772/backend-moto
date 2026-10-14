import { describe, expect, it } from 'vitest';
import { visibleCosts } from './visibility';

describe('cost visibility at response boundaries', () => {
  const data = { products: [{ lastPurchaseCost: 40, purchasePrice: 35 }], items: [{ unitCost: 40, unitPrice: 100 }], grossProfit: 60, netProfit: 55, cogs: 40, total: 100 };
  it('redacts nested costs while preserving prices and stored inputs', () => {
    const result = visibleCosts(data, ['sales.create']);
    expect(result.products[0]!.lastPurchaseCost).toBe(0);
    expect(result.items[0]).toEqual({ unitCost: 0, unitPrice: 100 });
    expect(result.grossProfit).toBe(0);
    expect(result.cogs).toBe(0);
    expect(result.total).toBe(100);
    expect(data.items[0]!.unitCost).toBe(40);
  });
  it('keeps costs available to authorized users', () => {
    expect(visibleCosts(data, ['prices.view_cost'])).toBe(data);
  });
});
