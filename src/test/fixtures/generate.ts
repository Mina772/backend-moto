import type {
  AppNotification, AuditLog, CustomerDebt, CustomerPayment, Expense, PaymentMethod, PriceHistoryEntry, Purchase, PurchaseItem, PurchaseReturn,
  RegisterSession, Sale, SaleItem, SaleReturn, SpecialPrice, StockAdjustment, StockCount, StockLevel, StockMovement, SupplierPayment, Transfer,
  TransferStatus, WhatsAppMessage, WhatsAppTemplate,
} from '@moto/shared';
import { round2 } from '@moto/shared';
import { brands, categories, motorcycleModels, products } from './catalog.js';
import { branches, cashRegisters, customers, expenseCategories, suppliers, users, warehouses } from './org.js';
import { daysAgo, daysFromNow, pad, rng } from './rng.js';

// ---------- Stock levels ----------
const stockLevels: StockLevel[] = [];
for (const p of products) {
  const idx = Number(p.id.split('-')[1]);
  for (const wh of warehouses) {
    if (wh.branchId === 'br-5') continue;
    const base = wh.isMain ? rng.int(0, p.minStock * 4) : rng.int(0, p.minStock);
    // Make some deterministic low/out-of-stock cases
    let qty = base;
    if (idx % 9 === 0 && wh.id === 'wh-1') qty = 0;
    if (idx % 11 === 0 && wh.isMain) qty = Math.max(0, Math.floor(p.minStock * 0.4));
    const loc = wh.locations[idx % wh.locations.length];
    const shelf = loc.shelves[idx % loc.shelves.length];
    const bin = shelf.bins[idx % shelf.bins.length];
    stockLevels.push({ productId: p.id, branchId: wh.branchId, warehouseId: wh.id, quantity: qty, reserved: qty > 5 && rng.chance(0.15) ? rng.int(1, 3) : 0, locationCode: loc.code, shelf: shelf.code, bin: bin.code });
  }
}

// ---------- Sales ----------
const activeProducts = products.filter((p) => p.isActive);
const cashiersByBranch: Record<string, string[]> = {
  'br-1': ['usr-7', 'usr-8', 'usr-11'],
  'br-2': ['usr-9', 'usr-12'],
  'br-3': ['usr-10', 'usr-16'],
  'br-4': ['usr-5'],
};
const activeBranchIds = ['br-1', 'br-2', 'br-3', 'br-4'];
const branchWeights: Record<string, number> = { 'br-1': 0.42, 'br-2': 0.26, 'br-3': 0.2, 'br-4': 0.12 };

function pickBranch(): string {
  const r = rng.next();
  let acc = 0;
  for (const b of activeBranchIds) {
    acc += branchWeights[b];
    if (r <= acc) return b;
  }
  return 'br-1';
}

const sales: Sale[] = [];
let invoiceSeq = 10240;

function buildSale(dayOffset: number, hour: number, minute: number, forceStatus?: Sale['status']): Sale {
  const branchId = pickBranch();
  const cashierId = rng.pick(cashiersByBranch[branchId]);
  const isCredit = rng.chance(0.22);
  const customerPool = customers.filter((c) => c.branchId === branchId && (isCredit ? c.type !== 'retail' || c.creditLimit > 0 : true));
  const customer = isCredit ? rng.pick(customerPool.length ? customerPool : customers) : rng.chance(0.35) ? rng.pick(customerPool.length ? customerPool : customers) : null;
  const useWholesale = customer?.type === 'wholesale';
  const itemCount = rng.int(1, 6);
  const picked = rng.shuffle(activeProducts).slice(0, itemCount);
  const items: SaleItem[] = picked.map((p, i) => {
    const quantity = rng.int(1, p.prices.retail1 < 100 ? 6 : 2);
    const tier = useWholesale ? 'wholesale' : customer?.type === 'workshop' ? 'retail2' : 'retail1';
    const unitPrice = p.prices[tier];
    const discountPercent = rng.chance(0.15) ? rng.pick([5, 10]) : 0;
    const gross = unitPrice * quantity;
    const discount = round2((gross * discountPercent) / 100);
    return { id: `si-${invoiceSeq}-${i}`, productId: p.id, name: p.name, barcode: p.internalBarcode, sku: p.sku, partNumber: p.partNumber, quantity, listPrice: unitPrice, unitPrice, unitCost: p.lastPurchaseCost, priceTier: tier, discount, discountPercent, subtotal: round2(gross - discount), returnedQty: 0 };
  });
  const subtotal = round2(items.reduce((a, i) => a + i.unitPrice * i.quantity, 0));
  const itemDiscounts = round2(items.reduce((a, i) => a + i.discount, 0));
  const invoiceDiscount = rng.chance(0.1) ? rng.pick([10, 20, 50]) : 0;
  const total = round2(subtotal - itemDiscounts - invoiceDiscount);
  const status: Sale['status'] = forceStatus ?? (rng.chance(0.03) ? 'cancelled' : rng.chance(0.04) ? 'partially_returned' : 'completed');
  let payments: Sale['payments'];
  let paid: number;
  let type: Sale['type'] = 'cash';
  if (isCredit && customer) {
    type = 'credit';
    const partial = rng.chance(0.4) ? round2(total * rng.pick([0.25, 0.5])) : 0;
    payments = partial ? [{ method: 'cash', amount: partial }] : [];
    paid = partial;
  } else {
    const method: PaymentMethod = rng.chance(0.68) ? 'cash' : rng.chance(0.7) ? 'card' : 'bank_transfer';
    if (rng.chance(0.08)) {
      const half = round2(total * 0.5);
      payments = [{ method: 'cash', amount: half }, { method: 'card', amount: round2(total - half), reference: `TX${rng.int(100000, 999999)}` }];
    } else {
      payments = [{ method, amount: total, reference: method !== 'cash' ? `TX${rng.int(100000, 999999)}` : undefined }];
    }
    paid = total;
  }
  const change = method_isCash(payments) && rng.chance(0.5) && type === 'cash' ? rng.pick([0, 5, 10, 20]) : 0;
  if (status === 'partially_returned') items[0].returnedQty = 1;
  const sale: Sale = {
    id: `sale-${invoiceSeq}`, invoiceNumber: `INV-${pad(invoiceSeq, 6)}`, date: daysAgo(dayOffset, hour, minute), branchId, cashierId, customerId: customer?.id ?? null,
    registerSessionId: null, items, subtotal, itemDiscounts, invoiceDiscount, tax: 0, total, paid, remaining: round2(Math.max(0, total - paid)), change, payments, type, status,
    dueDate: type === 'credit' ? daysAgo(dayOffset - 30) : undefined, syncStatus: 'synced',
  };
  invoiceSeq += 1;
  return sale;
}
function method_isCash(p: Sale['payments']) {
  return p.length === 1 && p[0].method === 'cash';
}

// 90 days of sales; more on recent days
for (let d = 89; d >= 0; d--) {
  const weekday = new Date(daysAgo(d)).getDay();
  const base = weekday === 5 ? 6 : 14; // Friday slower
  const count = rng.int(base - 4, base + 6);
  for (let i = 0; i < count; i++) {
    sales.push(buildSale(d, rng.int(9, 21), rng.int(0, 59)));
  }
}
// A couple of held invoices today
sales.push(buildSale(0, 13, 10, 'held'));
sales.push(buildSale(0, 13, 42, 'held'));
sales.sort((a, b) => (a.date < b.date ? 1 : -1));

// ---------- Sale returns ----------
const saleReturns: SaleReturn[] = sales
  .filter((s) => s.status === 'partially_returned')
  .map((s, i) => {
    const it = s.items[0];
    return {
      id: `ret-${i + 1}`, returnNumber: `RET-${pad(i + 1, 5)}`, saleId: s.id, invoiceNumber: s.invoiceNumber, date: daysAgo(Math.max(0, Math.floor((Date.now() - new Date(s.date).getTime()) / 86400000) - 2), 12, 0),
      branchId: s.branchId, userId: s.cashierId, customerId: s.customerId, items: [{ saleItemId: it.id, productId: it.productId, quantity: 1, unitPrice: it.unitPrice, refund: it.unitPrice, reason: rng.pick(['defective', 'wrong_item', 'customer_changed_mind', 'other']) }],
      refundAmount: it.unitPrice, refundMethod: 'cash',
    };
  });

// ---------- Customer debts & payments ----------
const customerDebts: CustomerDebt[] = [];
const customerPayments: CustomerPayment[] = [];
let paySeq = 1;
for (const s of sales) {
  if (s.type !== 'credit' || s.status === 'cancelled' || s.status === 'held') continue;
  const ageDays = Math.floor((new Date('2026-10-03T14:30:00').getTime() - new Date(s.date).getTime()) / 86400000);
  const downPayment = s.paid;
  let paidAmount = s.paid;
  // Older debts have more payments
  if (ageDays > 20 && rng.chance(0.55)) {
    const extra = round2(Math.min(s.total - paidAmount, s.total * rng.pick([0.25, 0.5, 1])));
    if (extra > 0) {
      paidAmount = round2(paidAmount + extra);
      customerPayments.push({ id: `cpay-${paySeq++}`, customerId: s.customerId!, debtId: `debt-${s.id}`, saleId: s.id, date: daysAgo(Math.max(0, ageDays - rng.int(5, 18)), rng.int(9, 19), rng.int(0, 59)), amount: extra, method: rng.pick(['cash', 'bank_transfer', 'cash']), reference: `RCPT-${pad(paySeq, 5)}`, userId: rng.pick(['usr-6', 'usr-2', 'usr-3']), branchId: s.branchId });
    }
  }
  if (downPayment > 0) {
    customerPayments.push({ id: `cpay-${paySeq++}`, customerId: s.customerId!, debtId: `debt-${s.id}`, saleId: s.id, date: s.date, amount: downPayment, method: 'cash', reference: s.invoiceNumber, userId: s.cashierId, branchId: s.branchId });
  }
  // Collections move the invoice too, exactly as recordCustomerPayment does.
  s.paid = paidAmount;
  s.remaining = round2(s.total - paidAmount);
  customerDebts.push({ id: `debt-${s.id}`, customerId: s.customerId!, saleId: s.id, invoiceNumber: s.invoiceNumber, invoiceDate: s.date, dueDate: s.dueDate!, originalAmount: s.total, paidAmount, remaining: round2(s.total - paidAmount), branchId: s.branchId });
}
// Recompute customer balances from debts for consistency
for (const c of customers) {
  const bal = customerDebts.filter((d) => d.customerId === c.id).reduce((a, d) => a + d.remaining, 0);
  c.balance = round2(bal);
}

// ---------- Purchases ----------
const purchases: Purchase[] = [];
const supplierPayments: SupplierPayment[] = [];
const purchaseReturns: PurchaseReturn[] = [];
let poSeq = 2040;
const activeSuppliers = suppliers.filter((s) => s.isActive);
for (let i = 0; i < 38; i++) {
  const supplier = rng.pick(activeSuppliers);
  const supplierProducts = products.filter((p) => p.supplierId === supplier.id);
  const pool = supplierProducts.length >= 3 ? supplierProducts : products;
  const picked = rng.shuffle(pool).slice(0, rng.int(2, 7));
  const dayOffset = rng.int(0, 85);
  const items: PurchaseItem[] = picked.map((p, k) => {
    const quantity = rng.int(10, 80);
    const unitCost = round2(p.purchasePrice * (1 + (rng.next() - 0.5) * 0.1));
    return { id: `pi-${poSeq}-${k}`, productId: p.id, quantity, receivedQty: 0, unitCost, subtotal: round2(quantity * unitCost) };
  });
  const subtotal = round2(items.reduce((a, x) => a + x.subtotal, 0));
  const discount = rng.chance(0.3) ? round2(subtotal * 0.02) : 0;
  const total = round2(subtotal - discount);
  let status: Purchase['status'];
  if (dayOffset < 3) status = rng.pick(['ordered', 'draft', 'ordered']);
  else if (dayOffset < 10) status = rng.pick(['partially_received', 'received', 'ordered']);
  else status = rng.chance(0.05) ? 'cancelled' : 'received';
  for (const it of items) {
    it.receivedQty = status === 'received' ? it.quantity : status === 'partially_received' ? Math.floor(it.quantity * rng.pick([0.3, 0.5, 0.7])) : 0;
  }
  const branchId = rng.pick(['br-1', 'br-1', 'br-2', 'br-3', 'br-4']);
  const wh = warehouses.find((w) => w.branchId === branchId && w.isMain)!;
  const paidRatio = status === 'received' ? rng.pick([0, 0.5, 1, 1]) : status === 'partially_received' ? rng.pick([0, 0.5]) : 0;
  const paid = round2(total * paidRatio);
  const purchase: Purchase = {
    id: `po-${poSeq}`, invoiceNumber: `PO-${pad(poSeq, 5)}`, supplierInvoiceNumber: `${supplier.code.slice(-3)}/${rng.int(1000, 9999)}`, supplierId: supplier.id, branchId, warehouseId: wh.id,
    date: daysAgo(dayOffset, rng.int(9, 16), rng.int(0, 59)), expectedDate: daysAgo(dayOffset - supplier.paymentTermsDays / 3), items, subtotal, discount, total, paid, remaining: round2(total - paid), status, userId: rng.pick(['usr-1', 'usr-2', 'usr-13']),
  };
  purchases.push(purchase);
  if (paid > 0) {
    supplierPayments.push({ id: `spay-${poSeq}`, supplierId: supplier.id, purchaseId: purchase.id, date: daysAgo(Math.max(0, dayOffset - rng.int(0, 10)), 11, 0), amount: paid, method: rng.pick(['bank_transfer', 'cash', 'bank_transfer']), reference: `PAY-${pad(poSeq, 5)}`, userId: 'usr-6' });
  }
  if (status === 'received' && rng.chance(0.1)) {
    const it = items[0];
    purchaseReturns.push({ id: `pret-${poSeq}`, returnNumber: `PRET-${pad(purchaseReturns.length + 1, 4)}`, purchaseId: purchase.id, supplierId: supplier.id, date: daysAgo(Math.max(0, dayOffset - 3), 13, 0), items: [{ productId: it.productId, quantity: rng.int(1, 5), unitCost: it.unitCost }], total: 0, userId: 'usr-13', reason: rng.pick(['تالف عند الاستلام', 'صنف مختلف عن الطلب', 'كمية زائدة']) });
    const pr = purchaseReturns[purchaseReturns.length - 1];
    pr.total = round2(pr.items.reduce((a, x) => a + x.quantity * x.unitCost, 0));
  }
  poSeq += 1;
}
purchases.sort((a, b) => (a.date < b.date ? 1 : -1));
// Supplier balances derive from purchases
for (const s of suppliers) {
  s.balance = round2(purchases.filter((p) => p.supplierId === s.id && p.status !== 'cancelled' && p.status !== 'draft').reduce((a, p) => a + p.remaining, 0));
}

// ---------- Transfers ----------
const transfers: Transfer[] = [];
const transferStatuses: TransferStatus[] = ['draft', 'requested', 'requested', 'approved', 'sent', 'received', 'completed', 'completed', 'completed', 'rejected'];
for (let i = 0; i < 22; i++) {
  const [src, dst] = rng.shuffle(activeBranchIds).slice(0, 2);
  const srcWh = warehouses.find((w) => w.branchId === src && w.isMain)!;
  const dstWh = warehouses.find((w) => w.branchId === dst && w.isMain)!;
  const status = i < 3 ? (['requested', 'approved', 'sent'] as TransferStatus[])[i] : rng.pick(transferStatuses);
  const dayOffset = i < 3 ? i : rng.int(2, 60);
  const items = rng.shuffle(activeProducts).slice(0, rng.int(1, 5)).map((p) => {
    const q = rng.int(2, 20);
    const order = ['draft', 'requested', 'approved', 'sent', 'received', 'completed'].indexOf(status);
    return { productId: p.id, requestedQty: q, sentQty: order >= 3 ? q : 0, receivedQty: order >= 4 ? (rng.chance(0.9) ? q : q - 1) : 0 };
  });
  const requestedBy = rng.pick(cashiersByBranch[dst]);
  const approver = branches.find((b) => b.id === src)!.managerId;
  const t: Transfer = {
    id: `tr-${i + 1}`, code: `TRF-${pad(i + 1, 4)}`, sourceBranchId: src, destinationBranchId: dst, sourceWarehouseId: srcWh.id, destinationWarehouseId: dstWh.id, items, status,
    requestedAt: daysAgo(dayOffset, 10, 0), requestedBy, timeline: [{ status: 'requested', at: daysAgo(dayOffset, 10, 0), by: requestedBy }],
  };
  const order = ['draft', 'requested', 'approved', 'sent', 'received', 'completed'].indexOf(status);
  if (status === 'rejected') t.timeline.push({ status: 'rejected', at: daysAgo(dayOffset, 14, 0), by: approver, note: 'الكمية غير متوفرة' });
  if (order >= 2) { t.approvedAt = daysAgo(dayOffset, 12, 0); t.approvedBy = approver; t.timeline.push({ status: 'approved', at: t.approvedAt, by: approver }); }
  if (order >= 3) { t.sentAt = daysAgo(Math.max(0, dayOffset - 1), 9, 0); t.sentBy = 'usr-13'; t.timeline.push({ status: 'sent', at: t.sentAt, by: 'usr-13' }); }
  if (order >= 4) { t.receivedAt = daysAgo(Math.max(0, dayOffset - 2), 11, 0); t.receivedBy = requestedBy; t.timeline.push({ status: 'received', at: t.receivedAt, by: requestedBy }); }
  if (order >= 5) { t.completedAt = daysAgo(Math.max(0, dayOffset - 2), 11, 30); t.timeline.push({ status: 'completed', at: t.completedAt, by: requestedBy }); }
  if (status === 'draft') t.timeline = [{ status: 'draft', at: t.requestedAt, by: requestedBy }];
  transfers.push(t);
}
transfers.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));

// ---------- Stock movements (derived + adjustments) ----------
const stockMovements: StockMovement[] = [];
let mvSeq = 1;
const runningStock: Record<string, number> = {};
const keyOf = (pid: string, wid: string) => `${pid}|${wid}`;
for (const sl of stockLevels) runningStock[keyOf(sl.productId, sl.warehouseId)] = sl.quantity + rng.int(20, 120);

const movementEvents: { date: string; productId: string; warehouseId: string; branchId: string; type: StockMovement['type']; qty: number; userId: string; ref: string }[] = [];
for (const s of sales.slice(0, 400)) {
  if (s.status === 'cancelled' || s.status === 'held') continue;
  const wh = warehouses.find((w) => w.branchId === s.branchId && !w.isMain) ?? warehouses.find((w) => w.branchId === s.branchId)!;
  for (const it of s.items) movementEvents.push({ date: s.date, productId: it.productId, warehouseId: wh.id, branchId: s.branchId, type: 'sale', qty: -it.quantity, userId: s.cashierId, ref: s.invoiceNumber });
}
for (const p of purchases) {
  if (p.status !== 'received' && p.status !== 'partially_received') continue;
  for (const it of p.items) if (it.receivedQty > 0) movementEvents.push({ date: p.date, productId: it.productId, warehouseId: p.warehouseId, branchId: p.branchId, type: 'purchase', qty: it.receivedQty, userId: 'usr-13', ref: p.invoiceNumber });
}
for (const t of transfers) {
  if (t.sentAt) for (const it of t.items) movementEvents.push({ date: t.sentAt, productId: it.productId, warehouseId: t.sourceWarehouseId, branchId: t.sourceBranchId, type: 'transfer_out', qty: -it.sentQty, userId: t.sentBy!, ref: t.code });
  if (t.receivedAt) for (const it of t.items) movementEvents.push({ date: t.receivedAt, productId: it.productId, warehouseId: t.destinationWarehouseId, branchId: t.destinationBranchId, type: 'transfer_in', qty: it.receivedQty, userId: t.receivedBy!, ref: t.code });
}
for (const r of saleReturns) {
  const wh = warehouses.find((w) => w.branchId === r.branchId)!;
  for (const it of r.items) movementEvents.push({ date: r.date, productId: it.productId, warehouseId: wh.id, branchId: r.branchId, type: 'sale_return', qty: it.quantity, userId: r.userId, ref: r.returnNumber });
}
movementEvents.sort((a, b) => (a.date < b.date ? -1 : 1));
for (const ev of movementEvents) {
  const k = keyOf(ev.productId, ev.warehouseId);
  const prev = runningStock[k] ?? 0;
  const next = Math.max(0, prev + ev.qty);
  runningStock[k] = next;
  stockMovements.push({ id: `mv-${mvSeq++}`, date: ev.date, productId: ev.productId, type: ev.type, quantity: ev.qty, previousStock: prev, newStock: next, userId: ev.userId, branchId: ev.branchId, warehouseId: ev.warehouseId, reference: ev.ref });
}
stockMovements.reverse();

const stockAdjustments: StockAdjustment[] = Array.from({ length: 14 }, (_, i) => {
  const p = rng.pick(activeProducts);
  const wh = rng.pick(warehouses.filter((w) => w.branchId !== 'br-5'));
  const direction: StockAdjustment['direction'] = rng.chance(0.65) ? 'decrease' : 'increase';
  const reason = direction === 'decrease' ? rng.pick(['damaged', 'lost', 'count_correction', 'expired'] as const) : rng.pick(['found', 'count_correction'] as const);
  const status: StockAdjustment['status'] = i < 2 ? 'pending' : 'approved';
  return { id: `adj-${i + 1}`, date: daysAgo(rng.int(0, 40), rng.int(9, 17), rng.int(0, 59)), branchId: wh.branchId, warehouseId: wh.id, productId: p.id, direction, quantity: rng.int(1, 6), reason, notes: reason === 'damaged' ? 'تلف أثناء التخزين' : reason === 'found' ? 'تم العثور عليها أثناء الجرد' : '', userId: rng.pick(['usr-13', 'usr-14', 'usr-2']), status };
}).sort((a, b) => (a.date < b.date ? 1 : -1));
for (const a of stockAdjustments) {
  if (a.status !== 'approved') continue;
  const k = keyOf(a.productId, a.warehouseId);
  const prev = runningStock[k] ?? 0;
  const q = a.direction === 'increase' ? a.quantity : -a.quantity;
  stockMovements.unshift({ id: `mv-${mvSeq++}`, date: a.date, productId: a.productId, type: a.direction === 'increase' ? 'adjustment_in' : a.reason === 'damaged' ? 'damaged' : 'adjustment_out', quantity: q, previousStock: prev, newStock: Math.max(0, prev + q), userId: a.userId, branchId: a.branchId, warehouseId: a.warehouseId, reference: a.id.toUpperCase(), notes: a.notes });
}
stockMovements.sort((a, b) => (a.date < b.date ? 1 : -1));

const stockCounts: StockCount[] = [
  { id: 'cnt-1', code: 'CNT-0001', date: daysAgo(20), branchId: 'br-1', warehouseId: 'wh-1', userId: 'usr-13', status: 'completed', items: activeProducts.slice(0, 12).map((p) => { const exp = stockLevels.find((s) => s.productId === p.id && s.warehouseId === 'wh-1')!.quantity; return { productId: p.id, expected: exp, counted: rng.chance(0.8) ? exp : exp + rng.int(-2, 2) }; }) },
  { id: 'cnt-2', code: 'CNT-0002', date: daysAgo(1), branchId: 'br-2', warehouseId: 'wh-3', userId: 'usr-9', status: 'in_progress', items: activeProducts.slice(12, 24).map((p, i) => { const exp = stockLevels.find((s) => s.productId === p.id && s.warehouseId === 'wh-3')!.quantity; return { productId: p.id, expected: exp, counted: i < 6 ? exp : null }; }) },
  { id: 'cnt-3', code: 'CNT-0003', date: daysAgo(0), branchId: 'br-3', warehouseId: 'wh-4', userId: 'usr-14', status: 'draft', items: activeProducts.slice(24, 34).map((p) => ({ productId: p.id, expected: stockLevels.find((s) => s.productId === p.id && s.warehouseId === 'wh-4')!.quantity, counted: null })) },
];

// ---------- Price history & special prices ----------
const priceHistory: PriceHistoryEntry[] = Array.from({ length: 30 }, (_, i) => {
  const p = rng.pick(activeProducts);
  const field = rng.pick(['retail1', 'wholesale', 'purchasePrice'] as const);
  const newValue = field === 'purchasePrice' ? p.purchasePrice : p.prices[field];
  const oldValue = round2(newValue * (1 - rng.pick([0.05, 0.08, 0.1, 0.12])));
  return { id: `ph-${i + 1}`, productId: p.id, field, oldValue, newValue, userId: rng.pick(['usr-1', 'usr-2', 'usr-6']), branchId: rng.pick(['br-1', 'br-2', 'br-3']), source: rng.pick(['single', 'single', 'bulk', 'purchase'] as const), date: daysAgo(rng.int(1, 120), rng.int(9, 17), rng.int(0, 59)), reason: rng.pick(['تحديث أسعار المورد', 'ارتفاع سعر الصرف', 'عرض موسمي', undefined]) };
}).sort((a, b) => (a.date < b.date ? 1 : -1));

const specialPrices: SpecialPrice[] = [
  { id: 'sp-1', customerId: 'cust-2', productId: 'prod-12', price: 135, validFrom: daysAgo(60), validTo: null },
  { id: 'sp-2', customerId: 'cust-2', productId: 'prod-1', price: 45, validFrom: daysAgo(60), validTo: null },
  { id: 'sp-3', customerId: 'cust-11', productId: 'prod-29', price: 390, validFrom: daysAgo(30), validTo: daysFromNow(60) },
  { id: 'sp-4', customerId: 'cust-11', productId: 'prod-30', price: 460, validFrom: daysAgo(30), validTo: daysFromNow(60) },
  { id: 'sp-5', customerId: 'cust-5', productId: 'prod-12', price: 138, validFrom: daysAgo(10), validTo: null },
  { id: 'sp-6', customerId: 'cust-7', productId: 'prod-3', price: 400, validFrom: daysAgo(90), validTo: daysAgo(5) },
  { id: 'sp-7', customerId: 'cust-15', productId: 'prod-22', price: 560, validFrom: daysAgo(15), validTo: null },
];

// ---------- Register sessions ----------
const registerSessions: RegisterSession[] = [];
function mkSession(id: string, registerId: string, userId: string, dayOffset: number, open: boolean): RegisterSession {
  const reg = cashRegisters.find((r) => r.id === registerId)!;
  const openingBalance = rng.pick([500, 1000, 1500, 2000]);
  const daySales = sales.filter((s) => s.branchId === reg.branchId && s.status !== 'cancelled' && s.status !== 'held' && Math.floor((new Date('2026-10-03T14:30:00').getTime() - new Date(s.date).getTime()) / 86400000) === dayOffset);
  const cashSales = round2(daySales.reduce((a, s) => a + s.payments.filter((p) => p.method === 'cash').reduce((x, p) => x + p.amount, 0), 0) / 2);
  const cardSales = round2(daySales.reduce((a, s) => a + s.payments.filter((p) => p.method === 'card').reduce((x, p) => x + p.amount, 0), 0) / 2);
  const transferSales = round2(daySales.reduce((a, s) => a + s.payments.filter((p) => p.method === 'bank_transfer').reduce((x, p) => x + p.amount, 0), 0) / 2);
  const paymentsIn = rng.chance(0.6) ? rng.pick([500, 1000, 2500]) : 0;
  const expenses = rng.chance(0.5) ? rng.pick([50, 120, 300]) : 0;
  const refunds = rng.chance(0.3) ? rng.pick([60, 110, 250]) : 0;
  const expectedCash = round2(openingBalance + cashSales + paymentsIn - expenses - refunds);
  const diff = open ? null : rng.chance(0.6) ? 0 : rng.pick([-20, -50, 10, -100, 25]);
  const movements = [
    { id: `${id}-m1`, sessionId: id, type: 'deposit' as const, amount: openingBalance, method: 'cash' as const, date: daysAgo(dayOffset, 8, 30), reference: 'OPEN', userId },
    ...daySales.slice(0, 8).map((s, i) => ({ id: `${id}-s${i}`, sessionId: id, type: 'sale' as const, amount: s.payments[0]?.amount ?? 0, method: s.payments[0]?.method ?? ('cash' as const), date: s.date, reference: s.invoiceNumber, userId })),
    ...(paymentsIn ? [{ id: `${id}-p`, sessionId: id, type: 'payment_in' as const, amount: paymentsIn, method: 'cash' as const, date: daysAgo(dayOffset, 12, 15), reference: 'RCPT', userId, notes: 'تحصيل من عميل' }] : []),
    ...(expenses ? [{ id: `${id}-e`, sessionId: id, type: 'expense' as const, amount: expenses, method: 'cash' as const, date: daysAgo(dayOffset, 14, 0), reference: 'EXP', userId, notes: 'مصروف نثري' }] : []),
    ...(refunds ? [{ id: `${id}-r`, sessionId: id, type: 'refund' as const, amount: refunds, method: 'cash' as const, date: daysAgo(dayOffset, 15, 30), reference: 'RET', userId }] : []),
  ];
  return { id, registerId, branchId: reg.branchId, userId, openedAt: daysAgo(dayOffset, 8, 30), closedAt: open ? null : daysAgo(dayOffset, 22, 0), openingBalance, cashSales, cardSales, transferSales, paymentsIn, paymentsOut: 0, expenses, refunds, expectedCash, actualCash: open ? null : round2(expectedCash + (diff ?? 0)), difference: diff, status: open ? 'open' : 'closed', movements };
}
registerSessions.push(mkSession('sess-open-1', 'reg-1', 'usr-7', 0, true));
registerSessions.push(mkSession('sess-open-2', 'reg-4', 'usr-9', 0, true));
registerSessions.push(mkSession('sess-open-3', 'reg-6', 'usr-10', 0, true));
let sessSeq = 1;
for (let d = 1; d <= 30; d++) {
  for (const [reg, usr] of [['reg-1', 'usr-7'], ['reg-2', 'usr-8'], ['reg-4', 'usr-9'], ['reg-6', 'usr-10'], ['reg-8', 'usr-5']] as const) {
    if (reg === 'reg-2' && d % 2 === 0) continue;
    registerSessions.push(mkSession(`sess-${sessSeq++}`, reg, usr, d, false));
  }
}

// ---------- Expenses ----------
const expenseDescriptions: Record<string, [string, string][]> = {
  'exc-1': [['إيجار شهر سبتمبر', 'September rent']],
  'exc-2': [['فاتورة كهرباء', 'Electricity bill'], ['فاتورة مياه', 'Water bill'], ['فاتورة إنترنت', 'Internet bill']],
  'exc-3': [['سلفة موظف', 'Employee advance'], ['مكافأة', 'Bonus']],
  'exc-4': [['شحن بضاعة من المورد', 'Shipping from supplier'], ['نقل تحويل بين الفروع', 'Inter-branch transport'], ['بنزين دراجة التوصيل', 'Delivery bike fuel']],
  'exc-5': [['صيانة تكييف', 'AC maintenance'], ['إصلاح طابعة الإيصالات', 'Receipt printer repair'], ['دهان واجهة المحل', 'Storefront painting']],
  'exc-6': [['ورق إيصالات حراري', 'Thermal receipt paper'], ['أقلام ودفاتر', 'Pens and notebooks'], ['ملصقات باركود', 'Barcode labels']],
  'exc-7': [['طباعة بانر إعلاني', 'Banner printing'], ['إعلان فيسبوك', 'Facebook ad']],
  'exc-8': [['شاي وقهوة', 'Tea and coffee'], ['مياه معدنية', 'Bottled water']],
  'exc-9': [['رسوم حكومية', 'Government fees'], ['متفرقات', 'Miscellaneous']],
};
const expenses: Expense[] = Array.from({ length: 60 }, (_, i) => {
  const cat = rng.pick(expenseCategories);
  const desc = rng.pick(expenseDescriptions[cat.id]);
  const branchId = pickBranch();
  const amount = cat.id === 'exc-1' ? rng.pick([8000, 12000, 15000]) : cat.id === 'exc-3' ? rng.pick([1500, 2000, 3000]) : cat.id === 'exc-2' ? rng.pick([450, 800, 1200]) : rng.int(50, 900);
  const reg = cashRegisters.find((r) => r.branchId === branchId);
  const status: Expense['status'] = i < 3 ? 'pending' : rng.chance(0.03) ? 'rejected' : 'approved';
  return { id: `exp-${i + 1}`, code: `EXP-${pad(i + 1, 5)}`, categoryId: cat.id, amount, branchId, registerId: amount < 1000 && reg ? reg.id : null, date: daysAgo(rng.int(0, 60), rng.int(9, 18), rng.int(0, 59)), description: { ar: desc[0], en: desc[1] }, userId: rng.pick(['usr-2', 'usr-3', 'usr-6', 'usr-7', 'usr-9']), status, receiptRef: rng.chance(0.6) ? `R-${rng.int(1000, 9999)}` : undefined };
}).sort((a, b) => (a.date < b.date ? 1 : -1));

// ---------- WhatsApp ----------
const whatsappTemplates: WhatsAppTemplate[] = [
  { key: 'invoice', name: { ar: 'إرسال فاتورة', en: 'Send invoice' }, body: { ar: 'عزيزي {customer}، شكراً لتعاملكم مع {company}. فاتورتكم رقم {invoice} بإجمالي {total} ج.م. المدفوع: {paid} ج.م، المتبقي: {remaining} ج.م.', en: 'Dear {customer}, thank you for shopping with {company}. Your invoice {invoice} totals EGP {total}. Paid: {paid}, remaining: {remaining}.' }, variables: ['customer', 'company', 'invoice', 'total', 'paid', 'remaining'], isActive: true },
  { key: 'statement', name: { ar: 'كشف حساب', en: 'Account statement' }, body: { ar: 'عزيزي {customer}، مرفق كشف حسابكم حتى تاريخ {date}. الرصيد المستحق: {balance} ج.م.', en: 'Dear {customer}, attached is your account statement as of {date}. Outstanding balance: EGP {balance}.' }, variables: ['customer', 'date', 'balance'], isActive: true },
  { key: 'debt_reminder', name: { ar: 'تذكير بالسداد', en: 'Payment reminder' }, body: { ar: 'عزيزي {customer}، نذكركم بأن فاتورة رقم {invoice} بمبلغ {remaining} ج.م مستحقة السداد منذ {days} يوم. نرجو السداد في أقرب وقت. {company}', en: 'Dear {customer}, this is a reminder that invoice {invoice} with EGP {remaining} has been due for {days} days. Please settle at your earliest convenience. {company}' }, variables: ['customer', 'invoice', 'remaining', 'days', 'company'], isActive: true },
  { key: 'payment_confirmation', name: { ar: 'تأكيد استلام دفعة', en: 'Payment confirmation' }, body: { ar: 'عزيزي {customer}، تم استلام دفعة بمبلغ {amount} ج.م بتاريخ {date}. رصيدكم الحالي: {balance} ج.م. شكراً لكم. {company}', en: 'Dear {customer}, we received your payment of EGP {amount} on {date}. Current balance: EGP {balance}. Thank you. {company}' }, variables: ['customer', 'amount', 'date', 'balance', 'company'], isActive: true },
  { key: 'promotion', name: { ar: 'عرض ترويجي', en: 'Promotion' }, body: { ar: 'عروض {company}! خصم {discount}% على {category} حتى {date}. زوروا أقرب فرع.', en: '{company} offers! {discount}% off on {category} until {date}. Visit your nearest branch.' }, variables: ['company', 'discount', 'category', 'date'], isActive: false },
];
const whatsappMessages: WhatsAppMessage[] = Array.from({ length: 40 }, (_, i) => {
  const c = rng.pick(customers.filter((x) => x.whatsapp));
  const tpl = rng.pick(whatsappTemplates.filter((t) => t.isActive));
  const status: WhatsAppMessage['status'] = i < 2 ? 'queued' : rng.pick(['sent', 'delivered', 'delivered', 'read', 'read', 'read', 'failed'] as const);
  const sentAt = daysAgo(rng.int(0, 20), rng.int(9, 20), rng.int(0, 59));
  return { id: `wa-${i + 1}`, customerId: c.id, phone: c.whatsapp, templateKey: tpl.key, body: tpl.body.ar.replace('{customer}', c.name.ar).replace('{company}', 'موتو بارتس').replace(/\{[a-z]+\}/g, () => String(rng.int(100, 9000))), status, sentAt, deliveredAt: ['delivered', 'read'].includes(status) ? sentAt : undefined, readAt: status === 'read' ? sentAt : undefined, error: status === 'failed' ? 'رقم غير مسجل على واتساب' : undefined, userId: rng.pick(['usr-6', 'usr-11', 'usr-2']) };
}).sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));

// ---------- Audit logs ----------
const auditLogs: AuditLog[] = [];
let auditSeq = 1;
const pushAudit = (partial: Omit<AuditLog, 'id' | 'ip'>) => auditLogs.push({ id: `aud-${auditSeq++}`, ip: `192.168.${rng.int(1, 4)}.${rng.int(10, 240)}`, ...partial });
for (const u of users.filter((x) => x.status === 'active')) {
  for (let d = 0; d < 5; d++) {
    pushAudit({ userId: u.id, action: 'login', entity: 'session', entityId: u.id, branchId: u.branchId, date: daysAgo(d, rng.int(7, 10), rng.int(0, 59)), before: null, after: { device: rng.pick(['Chrome / Windows', 'Edge / Windows', 'Chrome / Android']) } });
    if (d > 0) pushAudit({ userId: u.id, action: 'logout', entity: 'session', entityId: u.id, branchId: u.branchId, date: daysAgo(d, rng.int(17, 22), rng.int(0, 59)), before: null, after: null });
  }
}
for (const ph of priceHistory) pushAudit({ userId: ph.userId, action: 'price_change', entity: 'product', entityId: ph.productId, branchId: 'br-1', date: ph.date, before: { [ph.field]: ph.oldValue }, after: { [ph.field]: ph.newValue } });
for (const s of sales.filter((x) => x.status === 'cancelled')) pushAudit({ userId: branches.find((b) => b.id === s.branchId)!.managerId, action: 'invoice_cancel', entity: 'sale', entityId: s.id, branchId: s.branchId, date: s.date, before: { status: 'completed', total: s.total }, after: { status: 'cancelled' } });
for (const r of saleReturns) pushAudit({ userId: r.userId, action: 'sale_return', entity: 'sale', entityId: r.saleId, branchId: r.branchId, date: r.date, before: null, after: { returnNumber: r.returnNumber, refund: r.refundAmount } });
for (const a of stockAdjustments) pushAudit({ userId: a.userId, action: 'stock_adjustment', entity: 'product', entityId: a.productId, branchId: a.branchId, date: a.date, before: null, after: { direction: a.direction, quantity: a.quantity, reason: a.reason } });
for (const p of purchases.slice(0, 15)) pushAudit({ userId: p.userId, action: 'purchase_create', entity: 'purchase', entityId: p.id, branchId: p.branchId, date: p.date, before: null, after: { invoiceNumber: p.invoiceNumber, total: p.total } });
for (const p of customerPayments.slice(0, 20)) pushAudit({ userId: p.userId, action: 'payment', entity: 'customer', entityId: p.customerId, branchId: p.branchId, date: p.date, before: null, after: { amount: p.amount, method: p.method } });
for (const t of transfers.filter((x) => x.approvedAt)) pushAudit({ userId: t.approvedBy!, action: 'transfer_approve', entity: 'transfer', entityId: t.id, branchId: t.sourceBranchId, date: t.approvedAt!, before: { status: 'requested' }, after: { status: 'approved' } });
for (const s of registerSessions.filter((x) => x.status === 'closed').slice(0, 20)) pushAudit({ userId: s.userId, action: 'register_close', entity: 'register_session', entityId: s.id, branchId: s.branchId, date: s.closedAt!, before: { expected: s.expectedCash }, after: { actual: s.actualCash, difference: s.difference } });
pushAudit({ userId: 'usr-1', action: 'user_create', entity: 'user', entityId: 'usr-16', branchId: 'br-1', date: '2024-01-15T10:00:00.000Z', before: null, after: { username: 'rania.a', role: 'sales' } });
pushAudit({ userId: 'usr-1', action: 'user_update', entity: 'user', entityId: 'usr-16', branchId: 'br-1', date: daysAgo(12, 13, 5), before: { status: 'active' }, after: { status: 'suspended' } });
pushAudit({ userId: 'usr-1', action: 'user_update', entity: 'user', entityId: 'usr-15', branchId: 'br-1', date: daysAgo(45, 16, 10), before: { status: 'active' }, after: { status: 'inactive' } });
pushAudit({ userId: 'usr-1', action: 'permission_change', entity: 'role', entityId: 'cashier', branchId: 'br-1', date: daysAgo(8, 11, 0), before: { permissions: ['sales.view', 'sales.create'] }, after: { permissions: ['sales.view', 'sales.create', 'discounts.item'] } });
pushAudit({ userId: 'usr-1', action: 'settings_change', entity: 'settings', entityId: 'pos', branchId: 'br-1', date: daysAgo(3, 9, 40), before: { maxDiscountPercent: 10 }, after: { maxDiscountPercent: 15 } });
auditLogs.sort((a, b) => (a.date < b.date ? 1 : -1));

// ---------- Notifications ----------
const notifications: AppNotification[] = [
  { id: 'n-1', type: 'low_stock', title: { ar: 'مخزون منخفض', en: 'Low stock' }, body: { ar: '12 منتج تحت الحد الأدنى في مخزن القاهرة الرئيسي', en: '12 products below minimum in Cairo Main Warehouse' }, date: daysAgo(0, 9, 0), read: false, link: '/inventory?tab=low' },
  { id: 'n-2', type: 'debt_overdue', title: { ar: 'دين متأخر', en: 'Overdue debt' }, body: { ar: 'ورشة أبو علي تجاوزت حد الائتمان ولديها فواتير متأخرة', en: 'Abu Ali Workshop exceeded credit limit with overdue invoices' }, date: daysAgo(0, 8, 30), read: false, link: '/debts' },
  { id: 'n-3', type: 'transfer', title: { ar: 'طلب تحويل جديد', en: 'New transfer request' }, body: { ar: 'TRF-0001 بانتظار الاعتماد', en: 'TRF-0001 awaiting approval' }, date: daysAgo(0, 10, 0), read: false, link: '/transfers/tr-1' },
  { id: 'n-4', type: 'register', title: { ar: 'فرق في الخزنة', en: 'Register variance' }, body: { ar: 'عجز 50 ج.م في خزنة فيصل 1 أمس', en: 'EGP 50 shortage in Faisal Register 1 yesterday' }, date: daysAgo(1, 22, 5), read: true, link: '/cash-registers' },
  { id: 'n-5', type: 'system', title: { ar: 'نسخة احتياطية', en: 'Backup' }, body: { ar: 'تم إنشاء النسخة الاحتياطية اليومية بنجاح', en: 'Daily backup completed successfully' }, date: daysAgo(1, 3, 0), read: true },
  { id: 'n-6', type: 'transfer', title: { ar: 'تحويل تم إرساله', en: 'Transfer shipped' }, body: { ar: 'TRF-0003 في الطريق إلى فرعك', en: 'TRF-0003 is on its way to your branch' }, date: daysAgo(1, 9, 0), read: true, link: '/transfers/tr-3' },
];

// ---------- Quick products (seed grid) ----------
export const quickProductIds = ['prod-1', 'prod-12', 'prod-28', 'prod-63', 'prod-32', 'prod-4', 'prod-5', 'prod-10', 'prod-53', 'prod-59', 'prod-37', 'prod-18', 'prod-2', 'prod-3', 'prod-6', 'prod-7', 'prod-9', 'prod-11', 'prod-14', 'prod-22', 'prod-25', 'prod-29', 'prod-30', 'prod-36'];

export const seedData = {
  brands, categories, motorcycleModels, products, branches, warehouses, users, suppliers, customers, cashRegisters, expenseCategories,
  stockLevels, sales, saleReturns, customerDebts, customerPayments, purchases, supplierPayments, purchaseReturns, transfers, stockMovements, stockAdjustments, stockCounts,
  priceHistory, specialPrices, registerSessions, expenses, whatsappTemplates, whatsappMessages, auditLogs, notifications, quickProductIds,
  seq: { invoice: invoiceSeq, purchase: poSeq, transfer: transfers.length + 1, return: saleReturns.length + 1, payment: paySeq, expense: expenses.length + 1, barcode: products.length + 1, count: stockCounts.length + 1, purchaseReturn: purchaseReturns.length + 1, customer: customers.length + 1, supplier: suppliers.length + 1, saleSequence: sales.length + 1 },
};

export type SeedData = typeof seedData;
