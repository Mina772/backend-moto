export function planThreeTierPrices(doc: Record<string, unknown>) {
  const current = doc.prices;
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (current != null) {
    if (typeof current !== 'object' || !['retail1', 'retail2', 'wholesale'].every(key => valid((current as Record<string, unknown>)[key]))) return { status: 'blocked' as const, reason: 'Malformed existing three-tier prices; manual review required' };
    return { status: 'unchanged' as const };
  }
  if (!valid(doc.retailPrice) || !valid(doc.wholesalePrice)) return { status: 'blocked' as const, reason: 'Missing or invalid original retailPrice/wholesalePrice' };
  // The old schema has one retail tier; preserve it in both retail tiers until explicitly repriced.
  return { status: 'planned' as const, prices: { retail1: doc.retailPrice, retail2: doc.retailPrice, wholesale: doc.wholesalePrice } };
}
