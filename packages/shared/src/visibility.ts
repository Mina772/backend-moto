import type { Permission } from './types';
import { hasPermission } from './permissions';

/** Redact response copies without changing the costs used by ledgers or local storage. */
export function visibleCosts<T>(value: T, permissions: readonly Permission[]): T {
  if (hasPermission(permissions, 'prices.view_cost')) return value;
  const fields = new Set(['purchasePrice', 'lastPurchaseCost', 'unitCost', 'cost', 'cogs', 'profit', 'grossProfit', 'netProfit', 'frozenCapital', 'carryingCost', 'inventoryValue', 'todayProfit', 'profitChange']);
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (!input || typeof input !== 'object' || input instanceof Date) return input;
    return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, fields.has(key) ? 0 : visit(entry)]));
  };
  return visit(value) as T;
}
