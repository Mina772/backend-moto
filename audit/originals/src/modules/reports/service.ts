import type { AccountingSummary, DashboardData, DeadStockAction, DeadStockReport, DeadStockRow, NamedValue, Product, TimeSeriesPoint } from '@moto/shared';
import { round2 } from '@moto/shared';
import type { DeadStockQuery } from '@moto/shared';
import {
  BranchModel, CashRegisterModel, CategoryModel, CustomerDebtModel, DeadStockSnapshotModel, ExpenseCategoryModel, ExpenseModel, ProductModel, PurchaseModel, SaleModel, SaleReturnModel, StockLevelModel, StockMovementModel, SupplierModel, UserModel,
} from '../../db/models.js';
import { newId, nowISO } from '../../lib/ids.js';
import { dateRange, toPublic } from '../../lib/pagination.js';
import { categoryWithDescendants } from '../products/categories.js';
import { getSettings } from '../settings/service.js';

export interface Range {
  from: string;
  to: string;
  branchId?: string;
}

function saleProfit(s: Parameters<typeof saleAmounts>[0]) {
  return round2(saleAmounts(s).reduce((sum, item) => sum + item.profit, 0));
}

function saleAmounts(s: { total: number; tax: number; items: { subtotal: number; unitCost: number; quantity: number }[] }) {
  const base = s.items.reduce((a, i) => a + i.subtotal, 0);
  const net = round2(s.total - s.tax);
  let weight = 0;
  let allocatedNet = 0;
  let allocatedTotal = 0;
  return s.items.map((item, index) => {
    weight += item.subtotal;
    const last = index === s.items.length - 1;
    const nextNet = last ? net : round2(base ? net * weight / base : 0);
    const nextTotal = last ? s.total : round2(base ? s.total * weight / base : 0);
    const amount = round2(nextTotal - allocatedTotal);
    const revenue = round2(nextNet - allocatedNet);
    allocatedNet = nextNet;
    allocatedTotal = nextTotal;
    const cost = round2(item.unitCost * item.quantity);
    return { amount, revenue, cost, profit: round2(revenue - cost) };
  });
}

function dayKey(iso: string) {
  return iso.slice(0, 10);
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(from.slice(0, 10));
  const end = new Date(to.slice(0, 10));
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

async function salesIn(r: Range) {
  const range = dateRange(r.from, r.to)!;
  return SaleModel.find({ date: range, status: { $nin: ['held', 'cancelled'] }, ...(r.branchId ? { branchId: r.branchId } : {}) }).lean();
}

/** Returns belong to their refund date, even when the original invoice is outside the period. */
async function refundsIn(r: Range) {
  const returns = await SaleReturnModel.find({ date: dateRange(r.from, r.to)!, ...(r.branchId ? { branchId: r.branchId } : {}) }).lean();
  const originals = await SaleModel.find({ _id: { $in: returns.map(ret => ret.saleId) } }).lean();
  const byId = new Map(originals.map(sale => [sale._id, sale]));
  return returns.map(ret => {
    const sale = byId.get(ret.saleId);
    const taxFraction = sale?.total ? sale.tax / sale.total : 0;
    const tax = round2(ret.refundAmount * taxFraction);
    const revenue = round2(ret.refundAmount - tax);
    const cost = round2(ret.items.reduce((sum, item) => sum + (sale?.items.find(line => line.id === item.saleItemId)?.unitCost ?? 0) * item.quantity, 0));
    return { date: ret.date, branchId: ret.branchId, amount: ret.refundAmount, tax, revenue, cost, profit: round2(revenue - cost) };
  });
}

export async function dashboard(r: Range): Promise<DashboardData> {
  const span = new Date(r.to).getTime() - new Date(r.from).getTime();
  const prev: Range = { from: new Date(new Date(r.from).getTime() - span).toISOString(), to: new Date(new Date(r.from).getTime() - 1).toISOString(), branchId: r.branchId };
  const bf = r.branchId ? { branchId: r.branchId } : {};
  const [sales, prevSales, purchases, expenses, levels, products, debts, suppliers, branches, registers, categories] = await Promise.all([
    salesIn(r),
    salesIn(prev),
    PurchaseModel.find({ date: dateRange(r.from, r.to)!, status: { $ne: 'cancelled' }, ...bf }).lean(),
    ExpenseModel.find({ date: dateRange(r.from, r.to)!, status: 'approved', ...bf }).lean(),
    StockLevelModel.find(bf).lean(),
    ProductModel.find({ deletedAt: null }).lean(),
    CustomerDebtModel.find({ remaining: { $gt: 0 }, ...bf }).lean(),
    SupplierModel.find().lean(),
    BranchModel.find().lean(),
    CashRegisterModel.find(bf).lean(),
    CategoryModel.find().lean(),
  ]);
  const pmap = new Map(products.map((p) => [p._id, p]));
  const [refunds, prevRefunds] = await Promise.all([refundsIn(r), refundsIn(prev)]);
  const totalSales = sales.reduce((a, s) => a + s.total, 0);
  const totalProfit = sales.reduce((a, s) => a + saleProfit(s), 0) - refunds.reduce((a, ret) => a + ret.profit, 0);
  const prevTotal = prevSales.reduce((a, s) => a + s.total, 0);
  const prevProfit = prevSales.reduce((a, s) => a + saleProfit(s), 0) - prevRefunds.reduce((a, ret) => a + ret.profit, 0);

  const byProduct = new Map<string, number>();
  for (const l of levels) byProduct.set(l.productId, (byProduct.get(l.productId) ?? 0) + l.quantity);
  let inventoryValue = 0;
  let low = 0;
  let out = 0;
  for (const [pid, qty] of byProduct) {
    const p = pmap.get(pid);
    if (!p) continue;
    inventoryValue += qty * p.lastPurchaseCost;
    if (qty <= 0) out++;
    else if (qty < p.minStock) low++;
  }

  const days = eachDay(r.from, r.to);
  const series: TimeSeriesPoint[] = days.map((d) => ({ date: d, sales: 0, profit: 0, purchases: 0, expenses: 0 }));
  const sidx = new Map(days.map((d, i) => [d, i]));
  for (const s of sales) {
    const i = sidx.get(dayKey(s.date));
    if (i !== undefined) {
      series[i]!.sales += s.total;
      series[i]!.profit += saleProfit(s);
    }
  }
  for (const p of purchases) {
    const i = sidx.get(dayKey(p.date));
    if (i !== undefined) series[i]!.purchases! += p.total;
  }
  for (const ret of refunds) {
    const i = sidx.get(dayKey(ret.date));
    if (i !== undefined) series[i]!.profit -= ret.profit;
  }
  for (const e of expenses) {
    const i = sidx.get(dayKey(e.date));
    if (i !== undefined) series[i]!.expenses! += e.amount;
  }

  const topMap = new Map<string, { qty: number; revenue: number }>();
  const catMap = new Map<string, number>();
  const tierMap = new Map<string, number>();
  for (const s of sales) {
    const amounts = saleAmounts(s);
    for (const [index, it] of s.items.entries()) {
      const amount = amounts[index]!.amount;
      const t = topMap.get(it.productId) ?? { qty: 0, revenue: 0 };
      t.qty += it.quantity;
      t.revenue += amount;
      topMap.set(it.productId, t);
      const cat = pmap.get(it.productId)?.categoryId;
      if (cat) catMap.set(cat, (catMap.get(cat) ?? 0) + amount);
      tierMap.set(it.priceTier ?? 'retail1', (tierMap.get(it.priceTier ?? 'retail1') ?? 0) + amount);
    }
  }
  const tierLabels = (await getSettings()).pricing.tierLabels;
  const tierName = (k: string) => (k in tierLabels ? tierLabels[k as keyof typeof tierLabels] : k === 'special' ? { ar: 'سعر خاص', en: 'Special' } : { ar: 'يدوي', en: 'Manual' });

  const payMap = new Map<string, number>();
  for (const s of sales) {
    for (const p of s.payments) payMap.set(p.method, (payMap.get(p.method) ?? 0) + p.amount);
    if (s.type === 'credit') payMap.set('credit', (payMap.get('credit') ?? 0) + s.remaining);
  }
  const payLabel: Record<string, NamedValue['name']> = { cash: { ar: 'نقدي', en: 'Cash' }, card: { ar: 'بطاقة', en: 'Card' }, bank_transfer: { ar: 'تحويل بنكي', en: 'Bank transfer' }, credit: { ar: 'آجل', en: 'Credit' } };

  const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
  for (const d of debts) {
    const days = Math.max(0, Math.floor((Date.now() - new Date(d.dueDate).getTime()) / 86400000));
    if (days === 0) aging.current += d.remaining;
    else if (days <= 30) aging.d1_30 += d.remaining;
    else if (days <= 60) aging.d31_60 += d.remaining;
    else if (days <= 90) aging.d61_90 += d.remaining;
    else aging.d90 += d.remaining;
  }

  return {
    kpis: {
      todaySales: round2(totalSales),
      todayProfit: round2(totalProfit),
      purchases: round2(purchases.reduce((a, p) => a + p.total, 0)),
      expenses: round2(expenses.reduce((a, e) => a + e.amount, 0)),
      customerDebts: round2(debts.reduce((a, d) => a + d.remaining, 0)),
      supplierDebts: round2(suppliers.reduce((a, s) => a + s.balance, 0)),
      inventoryValue: round2(inventoryValue),
      lowStockCount: low,
      outOfStockCount: out,
      activeBranches: branches.filter((b) => b.isActive).length,
      activePosTerminals: registers.filter((rg) => rg.currentSessionId).length,
      salesChange: prevTotal ? ((totalSales - prevTotal) / prevTotal) * 100 : 0,
      profitChange: prevProfit ? ((totalProfit - prevProfit) / prevProfit) * 100 : 0,
      invoicesCount: sales.length,
    },
    salesSeries: series.map((p) => ({ ...p, sales: round2(p.sales), profit: round2(p.profit), purchases: round2(p.purchases ?? 0), expenses: round2(p.expenses ?? 0) })),
    salesByBranch: branches.map((b) => ({ name: b.name, value: round2(sales.filter((s) => s.branchId === b._id).reduce((a, s) => a + s.total, 0)) })).filter((x) => x.value > 0),
    salesByCategory: categories.map((c) => ({ name: c.name, value: round2(catMap.get(c._id) ?? 0) })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value),
    salesByTier: Array.from(tierMap.entries()).map(([k, v]) => ({ name: tierName(k), value: round2(v) })),
    topProducts: Array.from(topMap.entries())
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, 8)
      .map(([pid, v]) => ({ product: toPublic(pmap.get(pid)!) as unknown as Product, qty: v.qty, revenue: round2(v.revenue) }))
      .filter((x) => x.product),
    paymentMethods: Array.from(payMap.entries()).map(([k, v]) => ({ name: payLabel[k] ?? { ar: k }, value: round2(v) })),
    debtAging: [
      { name: { ar: 'حالي', en: 'Current' }, value: round2(aging.current) },
      { name: { ar: '1-30 يوم', en: '1-30 days' }, value: round2(aging.d1_30) },
      { name: { ar: '31-60 يوم', en: '31-60 days' }, value: round2(aging.d31_60) },
      { name: { ar: '61-90 يوم', en: '61-90 days' }, value: round2(aging.d61_90) },
      { name: { ar: '+90 يوم', en: '90+ days' }, value: round2(aging.d90) },
    ],
  };
}

export async function accounting(r: Range): Promise<AccountingSummary> {
  const bf = r.branchId ? { branchId: r.branchId } : {};
  const [sales, expenses, levels, products, debts, suppliers, cats] = await Promise.all([
    salesIn(r),
    ExpenseModel.find({ date: dateRange(r.from, r.to)!, status: 'approved', ...bf }).lean(),
    StockLevelModel.find(bf).lean(),
    ProductModel.find().lean(),
    CustomerDebtModel.find({ remaining: { $gt: 0 }, ...bf }).lean(),
    SupplierModel.find().lean(),
    ExpenseCategoryModel.find().lean(),
  ]);
  const cost = new Map(products.map((p) => [p._id, p.lastPurchaseCost]));
  const refunds = await refundsIn(r);
  const returns = round2(refunds.reduce((sum, ret) => sum + ret.amount, 0));
  const returnCost = refunds.reduce((sum, ret) => sum + ret.cost, 0);
  const totalSales = sales.reduce((a, s) => a + s.total, 0);
  const cogs = round2(sales.reduce((a, s) => a + saleAmounts(s).reduce((x, i) => x + i.cost, 0), 0) - returnCost);
  const grossProfit = round2(sales.reduce((a, s) => a + saleProfit(s), 0) - refunds.reduce((sum, ret) => sum + ret.profit, 0));
  const netSales = round2(cogs + grossProfit);
  const exp = expenses.reduce((a, e) => a + e.amount, 0);
  const days = eachDay(r.from, r.to);
  const series: TimeSeriesPoint[] = days.map((d) => ({ date: d, sales: 0, profit: 0, expenses: 0 }));
  const idx = new Map(days.map((d, i) => [d, i]));
  for (const s of sales) {
    const i = idx.get(dayKey(s.date));
    if (i !== undefined) {
      series[i]!.sales += s.total;
      series[i]!.profit += saleProfit(s);
    }
  }
  for (const e of expenses) {
    const i = idx.get(dayKey(e.date));
    if (i !== undefined) series[i]!.expenses! += e.amount;
  }
  for (const ret of refunds) {
    const i = idx.get(dayKey(ret.date));
    if (i !== undefined) series[i]!.profit -= ret.profit;
  }
  return {
    totalSales: round2(totalSales),
    returns,
    netSales,
    tax: round2(totalSales - returns - netSales),
    cogs: round2(cogs),
    grossProfit,
    expenses: round2(exp),
    netProfit: round2(grossProfit - exp),
    inventoryValue: round2(levels.reduce((a, l) => a + l.quantity * (cost.get(l.productId) ?? 0), 0)),
    receivables: round2(debts.reduce((a, d) => a + d.remaining, 0)),
    payables: round2(suppliers.reduce((a, s) => a + s.balance, 0)),
    series: series.map((p) => ({ ...p, sales: round2(p.sales), profit: round2(p.profit), expenses: round2(p.expenses ?? 0) })),
    expenseBreakdown: cats.map((c) => ({ name: c.name, color: c.color, value: round2(expenses.filter((e) => e.categoryId === c._id).reduce((a, e) => a + e.amount, 0)) })).filter((x) => x.value > 0),
  };
}

export async function salesReport(r: Range & { cashierId?: string; customerId?: string; groupBy?: string }) {
  let sales = await salesIn(r);
  if (r.cashierId) sales = sales.filter((s) => s.cashierId === r.cashierId);
  if (r.customerId) sales = sales.filter((s) => s.customerId === r.customerId);
  const groupBy = r.groupBy ?? 'day';
  const [users, branches, products, categories] = await Promise.all([UserModel.find().lean(), BranchModel.find().lean(), ProductModel.find().lean(), CategoryModel.find().lean()]);
  const umap = new Map(users.map((u) => [u._id, u.fullName]));
  const bmap = new Map(branches.map((b) => [b._id, b.name]));
  const pmap = new Map(products.map((p) => [p._id, p]));
  const cmap = new Map(categories.map((c) => [c._id, c.name]));
  const settings = await getSettings();

  const rows = new Map<string, { key: string; label: { ar: string; en?: string }; invoices: Set<string>; qty: number; sales: number; cost: number; profit: number }>();
  const add = (key: string, label: { ar: string; en?: string }, saleId: string, qty: number, amount: number, cost: number, profit: number) => {
    const row = rows.get(key) ?? { key, label, invoices: new Set<string>(), qty: 0, sales: 0, cost: 0, profit: 0 };
    row.invoices.add(saleId);
    row.qty += qty;
    row.sales += amount;
    row.cost += cost;
    row.profit += profit;
    rows.set(key, row);
  };
  for (const s of sales) {
    if (groupBy === 'product' || groupBy === 'category' || groupBy === 'tier') {
      const amounts = saleAmounts(s);
      for (const [index, it] of s.items.entries()) {
        const p = pmap.get(it.productId);
        const { amount, cost, profit } = amounts[index]!;
        if (groupBy === 'product') add(it.productId, p?.name ?? it.name, s._id, it.quantity, amount, cost, profit);
        else if (groupBy === 'category') add(p?.categoryId ?? 'other', cmap.get(p?.categoryId ?? '') ?? { ar: 'أخرى', en: 'Other' }, s._id, it.quantity, amount, cost, profit);
        else {
          const tier = it.priceTier ?? 'retail1';
          const label = tier in settings.pricing.tierLabels ? settings.pricing.tierLabels[tier as keyof typeof settings.pricing.tierLabels] : tier === 'special' ? { ar: 'سعر خاص', en: 'Special' } : { ar: 'يدوي', en: 'Manual' };
          add(tier, label, s._id, it.quantity, amount, cost, profit);
        }
      }
    } else {
      const qty = s.items.reduce((a, i) => a + i.quantity, 0);
      const cost = saleAmounts(s).reduce((a, i) => a + i.cost, 0);
      const profit = saleProfit(s);
      if (groupBy === 'cashier') add(s.cashierId, umap.get(s.cashierId) ?? { ar: s.cashierId }, s._id, qty, s.total, cost, profit);
      else if (groupBy === 'branch') add(s.branchId, bmap.get(s.branchId) ?? { ar: s.branchId }, s._id, qty, s.total, cost, profit);
      else add(dayKey(s.date), { ar: dayKey(s.date), en: dayKey(s.date) }, s._id, qty, s.total, cost, profit);
    }
  }
  const out = Array.from(rows.values())
    .map((r) => ({ key: r.key, label: r.label, invoices: r.invoices.size, qty: r.qty, sales: round2(r.sales), cost: round2(r.cost), profit: round2(r.profit) }))
    .sort((a, b) => (groupBy === 'day' ? (a.key < b.key ? -1 : 1) : b.sales - a.sales));
  const totals = out.reduce((a, r) => ({ invoices: a.invoices + r.invoices, qty: a.qty + r.qty, sales: round2(a.sales + r.sales), cost: round2(a.cost + r.cost), profit: round2(a.profit + r.profit) }), { invoices: 0, qty: 0, sales: 0, cost: 0, profit: 0 });
  totals.invoices = sales.length;
  return { rows: out, totals };
}

export async function employeePerformance(r: Range) {
  const [sales, users, returns] = await Promise.all([salesIn(r), UserModel.find().lean(), SaleReturnModel.find({ date: dateRange(r.from, r.to)!, ...(r.branchId ? { branchId: r.branchId } : {}) }).lean()]);
  return users
    .map((u) => {
      const us = sales.filter((s) => s.cashierId === u._id);
      const revenue = us.reduce((a, s) => a + s.total, 0);
      return { user: toPublic(u), invoices: us.length, revenue: round2(revenue), profit: round2(us.reduce((a, s) => a + saleProfit(s), 0)), avg: us.length ? round2(revenue / us.length) : 0, returns: returns.filter((x) => x.userId === u._id).length };
    })
    .filter((x) => x.invoices > 0)
    .sort((a, b) => b.revenue - a.revenue);
}

// ---------- dead stock ----------
export async function deadStock(qd: DeadStockQuery): Promise<DeadStockReport> {
  const settings = await getSettings();
  const idleDays = qd.idleDays ?? settings.reports.deadStockDefaultIdleDays;
  const cutoff = new Date(Date.now() - idleDays * 86400000).toISOString();
  const rate = settings.reports.annualCarryingRate;
  const lf: Record<string, unknown> = { quantity: { $gt: 0 } };
  if (qd.branchId) lf.branchId = qd.branchId;
  if (qd.warehouseId) lf.warehouseId = qd.warehouseId;
  // A department filter must cover its engine-size and part-system children too.
  const categoryIds = qd.categoryId ? await categoryWithDescendants(qd.categoryId) : null;
  const [levels, products] = await Promise.all([StockLevelModel.find(lf).lean(), ProductModel.find({ deletedAt: null, ...(categoryIds ? { categoryId: { $in: categoryIds } } : {}) }).lean()]);
  const pmap = new Map(products.map((p) => [p._id, p]));

  const byKey = new Map<string, { productId: string; branchId: string; qty: number }>();
  for (const l of levels) {
    if (!pmap.has(l.productId)) continue;
    const k = `${l.productId}|${l.branchId}`;
    const e = byKey.get(k) ?? { productId: l.productId, branchId: l.branchId, qty: 0 };
    e.qty += l.quantity;
    byKey.set(k, e);
  }
  const productIds = Array.from(new Set(Array.from(byKey.values()).map((e) => e.productId)));

  // Last sale per product/branch and last movement per product/branch (any type).
  const [lastSales, lastMoves, soldElsewhere] = await Promise.all([
    StockMovementModel.aggregate<{ _id: { productId: string; branchId: string }; last: string }>([
      { $match: { productId: { $in: productIds }, type: 'sale' } },
      { $group: { _id: { productId: '$productId', branchId: '$branchId' }, last: { $max: '$date' } } },
    ]),
    StockMovementModel.aggregate<{ _id: { productId: string; branchId: string }; last: string }>([
      { $match: { productId: { $in: productIds } } },
      { $group: { _id: { productId: '$productId', branchId: '$branchId' }, last: { $max: '$date' } } },
    ]),
    StockMovementModel.aggregate<{ _id: string; branches: string[] }>([
      { $match: { productId: { $in: productIds }, type: 'sale', date: { $gte: cutoff } } },
      { $group: { _id: '$productId', branches: { $addToSet: '$branchId' } } },
    ]),
  ]);
  const lastSaleMap = new Map(lastSales.map((x) => [`${x._id.productId}|${x._id.branchId}`, x.last]));
  const lastMoveMap = new Map(lastMoves.map((x) => [`${x._id.productId}|${x._id.branchId}`, x.last]));
  const soldElsewhereMap = new Map(soldElsewhere.map((x) => [x._id, x.branches]));

  const rows: DeadStockRow[] = [];
  for (const e of byKey.values()) {
    const p = pmap.get(e.productId)!;
    const k = `${e.productId}|${e.branchId}`;
    const lastSale = lastSaleMap.get(k) ?? null;
    if (lastSale && lastSale >= cutoff) continue;
    const lastMove = lastMoveMap.get(k) ?? null;
    const refDate = lastSale ?? p.createdAt;
    const idle = Math.floor((Date.now() - new Date(refDate).getTime()) / 86400000);
    if (idle < idleDays) continue;
    const unitCost = p.lastPurchaseCost || p.purchasePrice;
    const frozenCapital = round2(e.qty * unitCost);
    if (qd.minValue && frozenCapital < qd.minValue) continue;
    const carryingCost = round2(frozenCapital * (rate / 365) * idle);
    const others = (soldElsewhereMap.get(e.productId) ?? []).filter((b) => b !== e.branchId);
    let suggestedAction: DeadStockAction = 'discount';
    if (others.length) suggestedAction = 'transfer';
    else if (idle > idleDays * 3) suggestedAction = 'liquidate';
    else if (!lastSale && idle <= 120) suggestedAction = 'return_to_supplier';
    rows.push({ product: toPublic(p) as unknown as Product, branchId: e.branchId, qtyOnHand: e.qty, lastSaleDate: lastSale, lastMovementDate: lastMove, idleDays: idle, unitCost, frozenCapital, carryingCost, suggestedAction });
  }
  rows.sort((a, b) => b.frozenCapital - a.frozenCapital);
  const totals = rows.reduce((a, r) => ({ frozenCapital: round2(a.frozenCapital + r.frozenCapital), carryingCost: round2(a.carryingCost + r.carryingCost), itemCount: a.itemCount + 1, qty: a.qty + r.qtyOnHand }), { frozenCapital: 0, carryingCost: 0, itemCount: 0, qty: 0 });
  return { rows, totals, idleDays, annualCarryingRate: rate };
}

export async function snapshotDeadStock() {
  const settings = await getSettings();
  const branches = await BranchModel.find({ isActive: true }).lean();
  const date = nowISO();
  const idleDays = settings.reports.deadStockDefaultIdleDays;
  const all = await deadStock({ idleDays });
  await DeadStockSnapshotModel.create({ _id: newId('dss'), date, branchId: null, idleDays, ...all.totals });
  for (const b of branches) {
    const r = await deadStock({ idleDays, branchId: b._id });
    await DeadStockSnapshotModel.create({ _id: newId('dss'), date, branchId: b._id, idleDays, frozenCapital: r.totals.frozenCapital, carryingCost: r.totals.carryingCost, itemCount: r.totals.itemCount });
  }
}
