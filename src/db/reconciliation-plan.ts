import type { Db } from 'mongodb';

/** Read-only source reconciliation. Issues are proposals for review, never repair instructions. */
export async function reconciliationPlan(db: Db) {
  const issues: { code: string; sourceId: string }[] = [];
  const counts: Record<string, number> = {};
  for (const name of ['sales', 'salereturns', 'customerpayments', 'customerdebts', 'purchases', 'purchasereturns', 'supplierpayments', 'supplierreimbursements', 'products']) counts[name] = await db.collection(name).countDocuments();
  const purchases = await db.collection('purchases').find({}, { projection: { supplierId: 1, supplierInvoiceNumber: 1, total: 1, paid: 1, remaining: 1, status: 1 } }).toArray();
  const purchaseIds = new Set(purchases.map(p => String(p._id))), duplicate = new Map<string, string>();
  for (const p of purchases) {
    const returns = await db.collection('purchasereturns').find({ purchaseId: p._id }, { projection: { total: 1, debtReduction: 1, payoutAmount: 1 } }).toArray();
    const receipts = await db.collection('supplierpayments').find({ purchaseId: p._id }, { projection: { amount: 1 } }).toArray();
    const sum = (rows: Record<string, unknown>[], key: string) => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);
    if (Math.abs(sum(receipts, 'amount') - Number(p.paid)) > .011) issues.push({ code: 'PURCHASE_RECEIPTS_PAID_MISMATCH', sourceId: String(p._id) });
    if (returns.some(r => r.debtReduction == null || r.payoutAmount == null)) issues.push({ code: 'LEGACY_RETURN_ALLOCATION_REVIEW', sourceId: String(p._id) });
    else if (p.status !== 'draft' && Math.abs(Number(p.total) - Number(p.paid) - sum(returns, 'debtReduction') - Number(p.remaining)) > .011) issues.push({ code: 'PURCHASE_REMAINING_SOURCE_MISMATCH', sourceId: String(p._id) });
    if (sum(returns, 'payoutAmount') > Number(p.paid) + .011 || sum(returns, 'total') > Number(p.total) + .011) issues.push({ code: 'PURCHASE_RETURN_CAP_EXCEEDED', sourceId: String(p._id) });
    const invoice = typeof p.supplierInvoiceNumber === 'string' ? p.supplierInvoiceNumber.trim().toLowerCase() : '';
    if (invoice) { const key = `${p.supplierId}:${invoice}`; if (duplicate.has(key)) issues.push({ code: 'COMPANY_SUPPLIER_INVOICE_DUPLICATE', sourceId: String(p._id) }); else duplicate.set(key, String(p._id)); }
  }
  for await (const r of db.collection('purchasereturns').find({}, { projection: { purchaseId: 1, payoutAmount: 1 } })) {
    if (!purchaseIds.has(String(r.purchaseId))) issues.push({ code: 'ORPHAN_PURCHASE_RETURN', sourceId: String(r._id) });
    if (Number(r.payoutAmount ?? 0) > 0 && !(await db.collection('supplierreimbursements').findOne({ returnId: r._id }, { projection: { _id: 1 } }))) issues.push({ code: 'SUPPLIER_RECEIVABLE_EVIDENCE_MISSING', sourceId: String(r._id) });
  }
  for await (const debt of db.collection('customerdebts').find({}, { projection: { saleId: 1, remaining: 1 } })) {
    const sale = await db.collection('sales').findOne({ _id: debt.saleId }, { projection: { remaining: 1 } });
    if (!sale) issues.push({ code: 'ORPHAN_CUSTOMER_DEBT', sourceId: String(debt._id) });
    else if (Math.abs(Number(sale.remaining) - Number(debt.remaining)) > .011) issues.push({ code: 'SALE_DEBT_REMAINING_MISMATCH', sourceId: String(debt._id) });
  }
  const precision = ['total', 'paid', 'remaining', 'amount', 'payoutAmount', 'debtReduction'];
  for (const name of ['sales', 'salereturns', 'customerpayments', 'customerdebts', 'purchases', 'purchasereturns', 'supplierpayments', 'supplierreimbursements']) {
    for await (const row of db.collection(name).find({}, { projection: Object.fromEntries(precision.map(f => [f, 1])) })) {
      if (precision.some(field => row[field] != null && (!Number.isFinite(row[field]) || row[field] < 0 || Math.abs(row[field] * 100 - Math.round(row[field] * 100)) > .000001))) issues.push({ code: 'FINANCIAL_PRECISION_REVIEW', sourceId: String(row._id) });
    }
  }
  return { mode: 'read-only', counts, issues, mutationCount: 0, coverage: 'Purchase receipts/remaining/returns/caps/company duplicates/receivable evidence, debt sources and cent precision. Customer credit allocations, statement opening balances and journals still require representative review.' };
}
