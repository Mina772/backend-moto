import type { Alert, AlertSeverity, AlertType, LocalizedText, Sale, SaleReturn, StockCount, RegisterSession } from '@moto/shared';
import { SOCKET_EVENTS, tx } from '@moto/shared';
import { AlertModel, AuditLogModel, CustomerDebtModel, CustomerModel, ProductModel, PurchaseModel, SaleReturnModel, StockLevelModel, SupplierModel, WhatsAppMessageModel } from '../../db/models.js';
import { newId, nowISO } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { toPublic } from '../../lib/pagination.js';
import { emitToBranch } from '../../realtime/socket.js';
import { getSettings } from '../settings/service.js';
import { env } from '../../config/env.js';
import { sendWhatsApp } from '../whatsapp/provider.js';

export interface RaiseAlertInput {
  type: AlertType;
  severity: AlertSeverity;
  title: LocalizedText;
  body: LocalizedText;
  entity: string;
  entityId: string;
  branchId: string | null;
  dedupeKey: string;
  link?: string;
}

/** Creates an alert unless an unresolved one with the same dedupeKey exists. Returns the alert if created. */
export async function raiseAlert(input: RaiseAlertInput): Promise<Alert | null> {
  const settings = await getSettings();
  if (settings.alerts.enabled[input.type] === false) return null;
  const exists = await AlertModel.findOne({ dedupeKey: input.dedupeKey, resolvedAt: null }).lean();
  if (exists) return null;
  try {
    const doc = await AlertModel.create({ _id: newId('alrt'), ...input, createdAt: nowISO(), readBy: [], resolvedAt: null });
    const alert = toPublic(doc.toObject()) as unknown as Alert;
    emitToBranch(alert.branchId, SOCKET_EVENTS.notificationNew, alert);
    if (alert.severity === 'critical' && settings.alerts.whatsappOnCritical && settings.alerts.whatsappManagerPhone && env.WHATSAPP_MODE === 'cloud') {
      void sendWhatsApp({ phone: settings.alerts.whatsappManagerPhone, body: `${tx(alert.title, 'ar')}: ${tx(alert.body, 'ar')}`, customerId: 'system', templateKey: 'promotion', userId: 'system' }).catch(() => undefined);
    }
    return alert;
  } catch (e) {
    // Unique index race: another writer created it first.
    if (typeof e === 'object' && e && 'code' in e && (e as { code: number }).code === 11000) return null;
    throw e;
  }
}

/** Resolves unresolved alerts matching a dedupeKey (e.g. stock replenished). */
export async function resolveByKey(dedupeKey: string) {
  await AlertModel.updateMany({ dedupeKey, resolvedAt: null }, { $set: { resolvedAt: nowISO() } });
}

// ---------- rule helpers ----------

export async function checkStockForProduct(productId: string, branchId: string) {
  const [product, levels] = await Promise.all([ProductModel.findById(productId).lean(), StockLevelModel.find({ productId, branchId }).lean()]);
  if (!product || !product.isActive) return;
  const qty = levels.reduce((a, l) => a + l.quantity, 0);
  const name = product.name;
  if (qty <= 0) {
    await resolveByKey(`low_stock:${productId}:${branchId}`);
    await raiseAlert({
      type: 'out_of_stock',
      severity: 'critical',
      title: { ar: 'نفاد مخزون', en: 'Out of stock' },
      body: { ar: `${name.ar} نفد من فرعك`, en: `${tx(name, 'en')} is out of stock in your branch` },
      entity: 'product',
      entityId: productId,
      branchId,
      dedupeKey: `out_of_stock:${productId}:${branchId}`,
      link: `/products/${productId}`,
    });
  } else {
    await resolveByKey(`out_of_stock:${productId}:${branchId}`);
    if (qty <= product.minStock) {
      await raiseAlert({
        type: 'low_stock',
        severity: 'warning',
        title: { ar: 'وصول لحد إعادة الطلب', en: 'Reorder level reached' },
        body: { ar: `${name.ar}: المتبقي ${qty} (الحد ${product.minStock})`, en: `${tx(name, 'en')}: ${qty} left (min ${product.minStock})` },
        entity: 'product',
        entityId: productId,
        branchId,
        dedupeKey: `low_stock:${productId}:${branchId}`,
        link: `/products/${productId}`,
      });
    } else {
      await resolveByKey(`low_stock:${productId}:${branchId}`);
    }
  }
}

export async function checkOverdueDebts() {
  const now = nowISO();
  const overdue = await CustomerDebtModel.find({ remaining: { $gt: 0 }, dueDate: { $lt: now } }).lean();
  const byCustomer = new Map<string, { total: number; count: number; branchId: string; oldest: string }>();
  for (const d of overdue) {
    const e = byCustomer.get(d.customerId) ?? { total: 0, count: 0, branchId: d.branchId, oldest: d.dueDate };
    e.total += d.remaining;
    e.count += 1;
    if (d.dueDate < e.oldest) e.oldest = d.dueDate;
    byCustomer.set(d.customerId, e);
  }
  const customers = await CustomerModel.find({ _id: { $in: Array.from(byCustomer.keys()) } }).lean();
  for (const c of customers) {
    const e = byCustomer.get(c._id)!;
    const days = Math.floor((Date.now() - new Date(e.oldest).getTime()) / 86400000);
    await raiseAlert({
      type: 'debt_overdue_customer',
      severity: days > 60 ? 'critical' : 'warning',
      title: { ar: 'دين عميل متأخر', en: 'Overdue customer debt' },
      body: { ar: `${c.name.ar}: ${e.count} فاتورة بإجمالي ${e.total.toFixed(2)} متأخرة ${days} يوم`, en: `${tx(c.name, 'en')}: ${e.count} invoice(s) totaling ${e.total.toFixed(2)} overdue ${days} days` },
      entity: 'customer',
      entityId: c._id,
      branchId: e.branchId,
      dedupeKey: `debt_overdue_customer:${c._id}`,
      link: `/customers/${c._id}`,
    });
  }
  // Resolve for customers no longer overdue
  const open = await AlertModel.find({ type: 'debt_overdue_customer', resolvedAt: null }).lean();
  for (const a of open) if (!byCustomer.has(a.entityId)) await resolveByKey(a.dedupeKey);

  const suppliers = await SupplierModel.find({ isActive: true }).lean();
  for (const s of suppliers) {
    const cutoff = new Date(Date.now() - s.paymentTermsDays * 86400000).toISOString();
    const due = await PurchaseModel.find({ supplierId: s._id, remaining: { $gt: 0 }, status: { $in: ['received', 'partially_received'] }, date: { $lt: cutoff } }).lean();
    const key = `debt_overdue_supplier:${s._id}`;
    if (!due.length) {
      await resolveByKey(key);
      continue;
    }
    const total = due.reduce((a, p) => a + p.remaining, 0);
    await raiseAlert({
      type: 'debt_overdue_supplier',
      severity: 'warning',
      title: { ar: 'مستحقات مورد متأخرة', en: 'Overdue supplier payable' },
      body: { ar: `${s.name.ar}: ${due.length} فاتورة بإجمالي ${total.toFixed(2)} تجاوزت مدة السداد`, en: `${tx(s.name, 'en')}: ${due.length} invoice(s) totaling ${total.toFixed(2)} past payment terms` },
      entity: 'supplier',
      entityId: s._id,
      branchId: null,
      dedupeKey: key,
      link: `/suppliers/${s._id}`,
    });
  }
}

export async function checkAllStock() {
  const products = await ProductModel.find({ isActive: true, deletedAt: null }).lean();
  const levels = await StockLevelModel.find().lean();
  const byKey = new Map<string, number>();
  for (const l of levels) byKey.set(`${l.productId}|${l.branchId}`, (byKey.get(`${l.productId}|${l.branchId}`) ?? 0) + l.quantity);
  const branches = new Set(levels.map((l) => l.branchId));
  for (const p of products) {
    for (const b of branches) {
      const qty = byKey.get(`${p._id}|${b}`);
      if (qty === undefined) continue;
      if (qty <= p.minStock) await checkStockForProduct(p._id, b);
    }
  }
}

export async function checkCountVariance(count: StockCount) {
  const settings = await getSettings();
  const threshold = settings.alerts.countVarianceThresholdPct;
  const expected = count.items.reduce((a, i) => a + i.expected, 0);
  const counted = count.items.reduce((a, i) => a + (i.counted ?? i.expected), 0);
  if (!expected) return;
  const pct = Math.abs((counted - expected) / expected) * 100;
  if (pct > threshold) {
    await raiseAlert({
      type: 'count_variance',
      severity: pct > threshold * 3 ? 'critical' : 'warning',
      title: { ar: 'فروقات جرد', en: 'Stock count variance' },
      body: { ar: `جرد ${count.code}: فرق ${pct.toFixed(1)}% (متوقع ${expected} / معدود ${counted})`, en: `Count ${count.code}: ${pct.toFixed(1)}% variance (expected ${expected} / counted ${counted})` },
      entity: 'stock_count',
      entityId: count.id,
      branchId: count.branchId,
      dedupeKey: `count_variance:${count.id}`,
      link: `/inventory/counts/${count.id}`,
    });
  }
}

export async function checkLargeReturn(ret: SaleReturn) {
  const settings = await getSettings();
  const dayStart = new Date(ret.date);
  dayStart.setHours(0, 0, 0, 0);
  const todays = await SaleReturnModel.countDocuments({ userId: ret.userId, date: { $gte: dayStart.toISOString() } });
  const big = ret.refundAmount > settings.alerts.largeReturnAmount;
  const many = todays > settings.alerts.maxReturnsPerCashierPerDay;
  if (!big && !many) return;
  await raiseAlert({
    type: 'large_return',
    severity: big ? 'critical' : 'warning',
    title: { ar: 'مرتجع غير معتاد', en: 'Unusual return' },
    body: big
      ? { ar: `مرتجع ${ret.returnNumber} بقيمة ${ret.refundAmount.toFixed(2)} يتجاوز الحد`, en: `Return ${ret.returnNumber} of ${ret.refundAmount.toFixed(2)} exceeds threshold` }
      : { ar: `${todays} مرتجعات اليوم لنفس الكاشير`, en: `${todays} returns today by the same cashier` },
    entity: 'sale_return',
    entityId: ret.id,
    branchId: ret.branchId,
    dedupeKey: big ? `large_return:${ret.id}` : `large_return:cashier:${ret.userId}:${dayStart.toISOString().slice(0, 10)}`,
    link: `/sales/${ret.saleId}`,
  });
}

/** Flags operations a manager should look at: deep discounts, manual price overrides and repeated voids. */
export async function checkSaleAnomalies(sale: Sale) {
  const settings = await getSettings();
  const base = sale.subtotal;
  const discount = sale.itemDiscounts + sale.invoiceDiscount;
  const pct = base > 0 ? (discount / base) * 100 : 0;

  if (pct > settings.alerts.unusualDiscountPercent) {
    await raiseAlert({
      type: 'unusual_operation',
      severity: pct > settings.alerts.unusualDiscountPercent * 2 ? 'critical' : 'warning',
      title: { ar: 'خصم غير معتاد', en: 'Unusual discount' },
      body: { ar: `فاتورة ${sale.invoiceNumber}: خصم ${pct.toFixed(1)}% (${discount.toFixed(2)})`, en: `Invoice ${sale.invoiceNumber}: ${pct.toFixed(1)}% discount (${discount.toFixed(2)})` },
      entity: 'sale',
      entityId: sale.id,
      branchId: sale.branchId,
      dedupeKey: `unusual_discount:${sale.id}`,
      link: `/sales/${sale.id}`,
    });
  }

  const overrides = sale.items.filter((i) => i.priceTier === 'manual');
  if (overrides.length) {
    await raiseAlert({
      type: 'unusual_operation',
      severity: 'warning',
      title: { ar: 'تعديل سعر يدوي', en: 'Manual price override' },
      body: { ar: `فاتورة ${sale.invoiceNumber}: ${overrides.length} صنف بسعر يدوي`, en: `Invoice ${sale.invoiceNumber}: ${overrides.length} line(s) priced manually` },
      entity: 'sale',
      entityId: sale.id,
      branchId: sale.branchId,
      dedupeKey: `manual_price:${sale.id}`,
      link: `/sales/${sale.id}`,
    });
  }
}

export async function checkVoidRate(sale: Sale, userId: string) {
  const settings = await getSettings();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const day = dayStart.toISOString().slice(0, 10);
  const voids = await AuditLogModel.countDocuments({ action: 'invoice_cancel', userId, date: { $gte: dayStart.toISOString() } });
  if (voids <= settings.alerts.maxVoidsPerCashierPerDay) return;
  await raiseAlert({
    type: 'unusual_operation',
    severity: 'critical',
    title: { ar: 'إلغاءات متكررة', en: 'Repeated invoice voids' },
    body: { ar: `${voids} فاتورة ملغاة اليوم لنفس المستخدم (آخرها ${sale.invoiceNumber})`, en: `${voids} invoices voided today by the same user (latest ${sale.invoiceNumber})` },
    entity: 'user',
    entityId: userId,
    branchId: sale.branchId,
    dedupeKey: `voids:${userId}:${day}`,
    link: `/audit-logs?action=invoice_cancel`,
  });
}

export async function checkRegisterVariance(sess: RegisterSession) {
  const settings = await getSettings();
  if (sess.difference == null || Math.abs(sess.difference) <= settings.alerts.registerVarianceAmount) return;
  await raiseAlert({
    type: 'register_variance',
    severity: Math.abs(sess.difference) > settings.alerts.registerVarianceAmount * 4 ? 'critical' : 'warning',
    title: { ar: 'فرق في الخزنة', en: 'Register variance' },
    body: { ar: `فرق ${sess.difference.toFixed(2)} عند إغلاق الوردية`, en: `Difference of ${sess.difference.toFixed(2)} on session close` },
    entity: 'register_session',
    entityId: sess.id,
    branchId: sess.branchId,
    dedupeKey: `register_variance:${sess.id}`,
    link: `/cash-registers/sessions/${sess.id}`,
  });
}

export async function raiseSyncRejected(terminalId: string, branchId: string, opId: string, code: string, message: string) {
  try {
    await raiseAlert({
      type: 'sync_rejected',
      severity: 'critical',
      title: { ar: 'عملية مزامنة مرفوضة', en: 'Sync operation rejected' },
      body: { ar: `الطرفية ${terminalId}: ${code} — ${message}`, en: `Terminal ${terminalId}: ${code} — ${message}` },
      entity: 'sync_op',
      entityId: opId,
      branchId,
      dedupeKey: `sync_rejected:${opId}`,
    });
  } catch (e) {
    // Fire-and-forget from the sync route; an alert failure must never surface as an unhandled rejection.
    logger.warn({ err: e, opId }, 'sync_rejected alert failed');
  }
}

export type AlertEvent =
  | { kind: 'sale'; sale: Sale }
  | { kind: 'return'; saleReturn: SaleReturn }
  | { kind: 'count'; count: StockCount }
  | { kind: 'register_close'; session: RegisterSession }
  | { kind: 'stock'; productId: string; branchId: string }
  | { kind: 'void'; sale: Sale; userId: string };

export async function evaluateEventAlerts(ev: AlertEvent) {
  try {
    switch (ev.kind) {
      case 'sale':
        for (const pid of new Set(ev.sale.items.map((i) => i.productId))) await checkStockForProduct(pid, ev.sale.branchId);
        await checkSaleAnomalies(ev.sale);
        break;
      case 'void':
        await checkVoidRate(ev.sale, ev.userId);
        break;
      case 'return':
        await checkLargeReturn(ev.saleReturn);
        break;
      case 'count':
        await checkCountVariance(ev.count);
        break;
      case 'register_close':
        await checkRegisterVariance(ev.session);
        break;
      case 'stock':
        await checkStockForProduct(ev.productId, ev.branchId);
        break;
    }
  } catch (e) {
    logger.warn({ err: e }, 'alert evaluation failed');
  }
}

export async function runScheduledAlerts() {
  await checkAllStock();
  await checkOverdueDebts();
  void WhatsAppMessageModel;
}
