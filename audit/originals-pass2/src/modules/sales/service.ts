import type { ClientSession } from 'mongoose';
import type { CashMovement, Customer, PaymentMethod, Permission, Sale, SaleItem, SaleReturn, SaleReturnItem } from '@moto/shared';
import { SOCKET_EVENTS, encodeInvoiceQr, expectedCashOf, formatInvoiceNumber, maxRefundFor, round2, tx } from '@moto/shared';
import type { SaleCreateInput, SaleReturnCreateInput } from '@moto/shared';
import { env } from '../../config/env.js';
import { afterCommit, withTransaction } from '../../db/connect.js';
import { CustomerDebtModel, CustomerModel, CustomerPaymentModel, ProductModel, RegisterSessionModel, SaleModel, SaleReturnModel, SpecialPriceModel } from '../../db/models.js';
import { audit } from '../../lib/audit.js';
import { nextSeq } from '../../lib/counters.js';
import { HttpError, badRequest, notFound } from '../../lib/errors.js';
import { newId, nowISO } from '../../lib/ids.js';
import { toPublic } from '../../lib/pagination.js';
import { emitToBranch } from '../../realtime/socket.js';
import { applyMovement, salesWarehouseFor } from '../inventory/stock.js';
import { getSettings } from '../settings/service.js';
import { evaluateEventAlerts } from '../alerts/engine.js';

export interface SaleContext {
  userId: string;
  ip?: string;
  /** For offline-created sales: keep client invoice number and date. */
  terminalId?: string | null;
  /** Caller's resolved permissions; used to enforce tier/discount rules server-side. */
  permissions?: readonly Permission[];
}

export function recomputeExpectedCash(s: { openingBalance: number; cashSales: number; paymentsIn: number; paymentsOut: number; expenses: number; refunds: number }) {
  return expectedCashOf(s);
}

/** The sale's own session if still open, else the user's/branch's current open session. */
async function openSessionFor(branchId: string, userId: string, preferredId: string | null | undefined, session?: ClientSession) {
  if (preferredId) {
    const own = await RegisterSessionModel.findById(preferredId).session(session ?? null);
    if (own && own.status === 'open') return own;
  }
  return (
    (await RegisterSessionModel.findOne({ branchId, status: 'open', userId }).session(session ?? null)) ??
    (await RegisterSessionModel.findOne({ branchId, status: 'open' }).session(session ?? null))
  );
}

async function buildQrPayload(sale: Pick<Sale, 'invoiceNumber' | 'date' | 'total' | 'tax'>, session?: ClientSession) {
  const settings = await getSettings(session);
  return encodeInvoiceQr({
    sellerName: tx(settings.company.name, 'ar'),
    taxNumber: settings.company.taxNumber,
    timestamp: sale.date,
    totalWithTax: sale.total,
    taxAmount: sale.tax,
    // Invoice number (not sale id) so offline-generated QRs resolve once synced.
    verifyUrl: `${env.PUBLIC_URL.replace(/\/$/, '')}/v/${encodeURIComponent(sale.invoiceNumber)}`,
  });
}

export async function createSale(input: SaleCreateInput, ctx: SaleContext): Promise<Sale> {
  const sale = await withTransaction(async (session) => {
    const settings = await getSettings(session);
    const now = input.date ?? nowISO();
    const status = input.status ?? 'completed';
    if (status !== 'completed' && status !== 'held') throw badRequest('A new sale must be completed or held', 'INVALID_SALE_STATUS');

    const productIds = input.items.map((i) => i.productId);
    const products = await ProductModel.find({ _id: { $in: productIds } }).session(session ?? null).lean();
    const pmap = new Map(products.map((p) => [p._id, p]));
    const perms = ctx.permissions ?? [];
    const can = (p: Permission) => perms.includes(p);
    const maxDiscountPct = can('discounts.unlimited') ? 100 : settings.pos.maxDiscountPercent;
    const specials = input.customerId
      ? await SpecialPriceModel.find({ customerId: input.customerId, productId: { $in: productIds }, validFrom: { $lte: now }, $or: [{ validTo: null }, { validTo: { $gte: now } }] }).session(session ?? null).lean()
      : [];
    const specialFor = new Map(specials.map((s) => [s.productId, s.price]));

    const items: SaleItem[] = input.items.map((i) => {
      const p = pmap.get(i.productId);
      if (!p || !p.isActive || p.deletedAt) throw new HttpError(422, 'PRODUCT_NOT_FOUND', `Active product ${i.productId} not found`);
      if (i.priceTier === 'wholesale' && !can('prices.wholesale')) throw new HttpError(403, 'PERMISSION_DENIED', 'prices.wholesale required');
      // Manual prices need prices.wholesale/prices.edit; everyone else must use a tier price or the customer's special price.
      const canManual = can('prices.wholesale') || can('prices.edit');
      const special = specialFor.get(i.productId);
      const allowedPrices = [p.prices.retail1, p.prices.retail2, ...(can('prices.wholesale') ? [p.prices.wholesale] : []), ...(special != null ? [special] : [])];
      if (!canManual && !allowedPrices.some((v) => Math.abs(v - i.unitPrice) < 0.005)) throw new HttpError(422, 'PRICE_NOT_ALLOWED', `Unit price ${i.unitPrice} is not an allowed tier price for ${i.productId}`, { productId: i.productId, allowedPrices });
      const gross = i.unitPrice * i.quantity;
      const discount = i.discount || round2((gross * (i.discountPercent ?? 0)) / 100);
      const pct = gross ? (discount / gross) * 100 : 0;
      if (discount > 0 && !can('discounts.item')) throw new HttpError(403, 'PERMISSION_DENIED', 'discounts.item required');
      // A free line has no percentage to measure, so the cap below would wave any discount through.
      if (discount > gross + 0.01) throw new HttpError(422, 'DISCOUNT_EXCEEDS', `Line discount ${discount} exceeds the line total ${round2(gross)}`, { productId: i.productId });
      if (pct > maxDiscountPct + 0.01) throw new HttpError(422, 'DISCOUNT_EXCEEDS', `Line discount ${round2(pct)}% exceeds the allowed ${maxDiscountPct}%`, { productId: i.productId, maxDiscountPct });
      return {
        id: newId('si'),
        productId: i.productId,
        name: i.name?.ar ? { ar: i.name.ar, en: i.name.en } : p.name,
        barcode: i.barcode || p.internalBarcode,
        sku: i.sku || p.sku,
        partNumber: i.partNumber ?? p.partNumber,
        quantity: i.quantity,
        listPrice: i.listPrice ?? i.unitPrice,
        unitPrice: i.unitPrice,
        unitCost: p.lastPurchaseCost || p.purchasePrice,
        priceTier: i.priceTier ?? 'retail1',
        discount,
        discountPercent: i.discountPercent ?? (gross ? round2((discount / gross) * 100) : 0),
        subtotal: round2(gross - discount),
        returnedQty: 0,
      };
    });

    const subtotal = round2(items.reduce((a, i) => a + i.unitPrice * i.quantity, 0));
    const itemDiscounts = round2(items.reduce((a, i) => a + i.discount, 0));
    const invoiceDiscount = round2(input.invoiceDiscount ?? 0);
    if (invoiceDiscount > 0) {
      if (!can('discounts.invoice')) throw new HttpError(403, 'PERMISSION_DENIED', 'discounts.invoice required');
      if (invoiceDiscount > round2((subtotal * maxDiscountPct) / 100) + 0.01) throw new HttpError(422, 'DISCOUNT_EXCEEDS', `Invoice discount exceeds the allowed ${maxDiscountPct}%`, { maxDiscountPct });
    }
    const taxable = round2(subtotal - itemDiscounts - invoiceDiscount);
    const tax = settings.invoice.showTax ? round2((taxable * settings.invoice.taxRate) / 100) : 0;
    const total = round2(taxable + tax);
    if (total < 0) throw new HttpError(422, 'INVALID_TOTAL', 'Invoice total cannot be negative', { total });
    if (input.type === 'cash' && input.payments.some((p) => p.method === 'credit')) throw badRequest('Cash sale cannot be paid on credit', 'INVALID_PAYMENT_METHOD');
    const paidRaw = round2(input.payments.filter((p) => p.method !== 'credit').reduce((a, p) => a + p.amount, 0));
    const cashTendered = round2(input.payments.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0));
    // Only physical cash can be returned as change. Credit overpayments need an explicit allocation workflow.
    if (paidRaw > total && (input.type === 'credit' || round2(paidRaw - total) > cashTendered)) {
      throw new HttpError(422, 'OVERPAYMENT', 'Excess payment must be covered by cash change; credit sales cannot be overpaid');
    }
    const change = input.type === 'cash' ? round2(Math.max(0, paidRaw - total)) : 0;
    const paid = round2(Math.min(paidRaw, total));
    const remaining = round2(Math.max(0, total - paid));

    if (input.type === 'cash' && status === 'completed' && paid < total) throw badRequest('Cash sale must be fully paid', 'UNDERPAID');

    let customer: (Customer & { _id: string }) | null = null;
    if (input.customerId) {
      const c = await CustomerModel.findById(input.customerId).session(session ?? null).lean();
      if (!c) throw new HttpError(422, 'CUSTOMER_NOT_FOUND', 'Customer not found');
      customer = c as unknown as Customer & { _id: string };
    }
    if (input.type === 'credit') {
      if (!customer) throw new HttpError(422, 'CUSTOMER_REQUIRED', 'Credit sales require a customer');
      if (customer.creditLimit > 0 && customer.balance + remaining > customer.creditLimit) {
        throw new HttpError(422, 'CUSTOMER_CREDIT_EXCEEDED', 'Customer credit limit exceeded', { balance: customer.balance, creditLimit: customer.creditLimit, remaining });
      }
    }

    const registerSessionId = input.registerSessionId ?? null;
    if (registerSessionId && status === 'completed') {
      const sess = await RegisterSessionModel.findById(registerSessionId).session(session ?? null).lean();
      if (!sess || sess.status !== 'open') throw new HttpError(422, 'SESSION_CLOSED', 'Register session is closed');
      if (sess.branchId !== input.branchId) throw new HttpError(403, 'BRANCH_DENIED', 'Register session belongs to another branch');
    }

    let invoiceNumber = input.invoiceNumber;
    if (!invoiceNumber) {
      const seq = await nextSeq('invoice', session);
      invoiceNumber = formatInvoiceNumber(settings.invoice.prefix, seq);
    } else if (await SaleModel.exists({ invoiceNumber }).session(session ?? null)) {
      throw new HttpError(409, 'INVOICE_EXISTS', `Invoice ${invoiceNumber} already exists`);
    }
    const serverSequence = status === 'completed' ? await nextSeq('saleSequence', session) : undefined;
    const id = newId('sale');
    const dueDate = input.type === 'credit' ? new Date(new Date(now).getTime() + 30 * 86400000).toISOString() : undefined;

    const sale: Sale = {
      id,
      invoiceNumber,
      serverSequence,
      date: now,
      branchId: input.branchId,
      cashierId: input.cashierId ?? ctx.userId,
      customerId: customer?._id ?? null,
      registerSessionId,
      terminalId: input.terminalId ?? ctx.terminalId ?? null,
      items,
      subtotal,
      itemDiscounts,
      invoiceDiscount,
      tax,
      total,
      paid,
      remaining,
      change,
      payments: input.payments,
      type: input.type,
      status,
      notes: input.notes,
      dueDate,
      syncStatus: 'synced',
    };
    sale.qrPayload = await buildQrPayload(sale, session);

    if (status === 'completed') {
      const warehouseId = await salesWarehouseFor(input.branchId, session);
      for (const it of items) {
        await applyMovement({ productId: it.productId, warehouseId, branchId: input.branchId, delta: -it.quantity, type: 'sale', userId: sale.cashierId, reference: invoiceNumber, date: now }, session);
      }

      if (input.type === 'credit' && customer) {
        await CustomerDebtModel.create([{ _id: `debt-${id}`, customerId: customer._id, saleId: id, invoiceNumber, invoiceDate: now, dueDate, originalAmount: total, paidAmount: paid, remaining, branchId: input.branchId }], { session });
        await CustomerModel.updateOne({ _id: customer._id }, { $inc: { balance: remaining }, $set: { updatedAt: now } }, { session });
        if (paid > 0) {
          await CustomerPaymentModel.create(
            [{ _id: newId('cpay'), customerId: customer._id, debtId: `debt-${id}`, saleId: id, date: now, amount: paid, method: input.payments[0]?.method ?? 'cash', reference: invoiceNumber, userId: sale.cashierId, branchId: input.branchId }],
            { session },
          );
        }
      }

      if (registerSessionId) {
        const sess = await RegisterSessionModel.findById(registerSessionId).session(session ?? null);
        if (sess) {
          // Change comes out of the cash tendered once, even when it was tendered over several cash lines.
          let changeLeft = change;
          for (const p of input.payments) {
            let amt = p.amount;
            if (p.method === 'cash' && changeLeft > 0) {
              const take = Math.min(changeLeft, amt);
              amt = round2(amt - take);
              changeLeft = round2(changeLeft - take);
            }
            if (p.method === 'cash') sess.cashSales = round2(sess.cashSales + amt);
            else if (p.method === 'card') sess.cardSales = round2(sess.cardSales + amt);
            else if (p.method === 'bank_transfer') sess.transferSales = round2(sess.transferSales + amt);
            const mv: CashMovement = { id: newId('cm'), sessionId: sess._id, type: 'sale', amount: amt, method: p.method, date: now, reference: invoiceNumber, userId: sale.cashierId };
            sess.movements = [...(sess.movements ?? []), mv];
          }
          sess.expectedCash = recomputeExpectedCash(sess);
          sess.markModified('movements');
          await sess.save({ session });
        }
      }
    }

    await SaleModel.create([{ ...sale, _id: id, id: undefined }], { session });
    return sale;
  });

  afterCommit(() => {
    if (sale.status === 'completed') {
      emitToBranch(sale.branchId, SOCKET_EVENTS.saleCreated, { id: sale.id, invoiceNumber: sale.invoiceNumber, branchId: sale.branchId, total: sale.total, type: sale.type, cashierId: sale.cashierId });
      if (sale.type === 'credit') emitToBranch(sale.branchId, SOCKET_EVENTS.debtChanged, { customerId: sale.customerId });
      void evaluateEventAlerts({ kind: 'sale', sale });
    }
  });
  return sale;
}

export async function cancelSale(id: string, ctx: SaleContext): Promise<Sale> {
  const result = await withTransaction(async (session) => {
    const doc = await SaleModel.findById(id).session(session ?? null);
    if (!doc) throw notFound('Sale not found');
    if (doc.status === 'cancelled') return toPublic(doc.toObject()) as unknown as Sale;
    if (doc.status === 'held') {
      await doc.deleteOne({ session });
      return { ...(toPublic(doc.toObject()) as unknown as Sale), status: 'cancelled' as const };
    }
    // Existing returns already reversed revenue, stock and refunds. Keep that history and use further returns.
    if (doc.items.some((item) => item.returnedQty > 0) || await SaleReturnModel.exists({ saleId: id }).session(session ?? null)) {
      throw new HttpError(409, 'SALE_HAS_RETURNS', 'An invoice with returns cannot be cancelled; return its remaining items instead');
    }
    const warehouseId = await salesWarehouseFor(doc.branchId, session);
    for (const it of doc.items) {
      const qty = it.quantity - it.returnedQty;
      if (qty > 0) await applyMovement({ productId: it.productId, warehouseId, branchId: doc.branchId, delta: qty, type: 'sale_return', userId: ctx.userId, reference: `${doc.invoiceNumber}-CANCEL`, allowNegative: true }, session);
    }
    const now = nowISO();
    const debt = await CustomerDebtModel.findOne({ saleId: id }).session(session ?? null);
    if (debt) {
      if (debt.remaining > 0) await CustomerModel.updateOne({ _id: debt.customerId }, { $inc: { balance: -debt.remaining }, $set: { updatedAt: now } }, { session });
      await CustomerPaymentModel.deleteMany({ saleId: id }, { session });
      await debt.deleteOne({ session });
    }
    // Reverse cash taken for this sale in the current open session so expectedCash stays correct.
    const cashTaken = round2(doc.payments.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0) - doc.change);
    if (cashTaken > 0) {
      const sess = await openSessionFor(doc.branchId, ctx.userId, doc.registerSessionId, session);
      if (sess) {
        sess.refunds = round2(sess.refunds + cashTaken);
        sess.movements = [...(sess.movements ?? []), { id: newId('cm'), sessionId: sess._id, type: 'refund', amount: cashTaken, method: 'cash', date: now, reference: `${doc.invoiceNumber}-CANCEL`, userId: ctx.userId }];
        sess.expectedCash = recomputeExpectedCash(sess);
        sess.markModified('movements');
        await sess.save({ session });
      }
    }
    const before = { status: doc.status, total: doc.total };
    doc.status = 'cancelled';
    await doc.save({ session });
    await audit({ userId: ctx.userId, action: 'invoice_cancel', entity: 'sale', entityId: id, branchId: doc.branchId, before, after: { status: 'cancelled' }, ip: ctx.ip }, session);
    return toPublic(doc.toObject()) as unknown as Sale;
  });
  emitToBranch(result.branchId, SOCKET_EVENTS.saleCreated, { id: result.id, cancelled: true, branchId: result.branchId });
  void evaluateEventAlerts({ kind: 'void', sale: result, userId: ctx.userId });
  return result;
}

export async function createReturn(input: SaleReturnCreateInput, ctx: SaleContext): Promise<SaleReturn> {
  const ret = await withTransaction(async (session) => {
    const sale = await SaleModel.findById(input.saleId).session(session ?? null);
    if (!sale) throw new HttpError(422, 'SALE_NOT_FOUND', 'Sale not found');
    if (sale.status === 'cancelled' || sale.status === 'held') throw badRequest('Sale cannot be returned', 'SALE_NOT_RETURNABLE');
    const now = input.date ?? nowISO();

    const items: SaleReturnItem[] = [];
    const priorReturns = await SaleReturnModel.find({ saleId: sale._id }).session(session ?? null).lean();
    let refundable = round2(Math.max(0, sale.total - priorReturns.reduce((total, ret) => total + ret.refundAmount, 0)));
    for (const r of input.items) {
      const si = sale.items.find((x) => x.id === r.saleItemId);
      if (!si) throw badRequest(`Sale item ${r.saleItemId} not found`, 'SALE_ITEM_NOT_FOUND');
      if (si.returnedQty + r.quantity > si.quantity) throw badRequest('Return quantity exceeds sold quantity', 'RETURN_QTY_EXCEEDED', { saleItemId: si.id });
      const maxRefund = maxRefundFor(sale, si, r.quantity);
      const refund = Math.min(r.refund > 0 ? Math.min(round2(r.refund), maxRefund) : maxRefund, refundable);
      refundable = round2(refundable - refund);
      si.returnedQty = round2(si.returnedQty + r.quantity);
      items.push({ saleItemId: si.id, productId: si.productId, quantity: r.quantity, unitPrice: si.unitPrice, refund, reason: r.reason });
    }
    sale.markModified('items');
    const refundAmount = round2(items.reduce((a, i) => a + i.refund, 0));
    const seq = await nextSeq('return', session);
    const returnNumber = `RET-${String(seq).padStart(5, '0')}`;

    const warehouseId = await salesWarehouseFor(sale.branchId, session);
    for (const it of items) {
      await applyMovement({ productId: it.productId, warehouseId, branchId: sale.branchId, delta: it.quantity, type: 'sale_return', userId: ctx.userId, reference: returnNumber, date: now, allowNegative: true }, session);
    }

    sale.status = sale.items.every((i) => i.returnedQty >= i.quantity) ? 'returned' : 'partially_returned';
    await sale.save({ session });

    // Credit refunds reduce the outstanding debt; cash/card refunds pay the customer out instead (never both).
    if (sale.type === 'credit' && sale.customerId && input.refundMethod === 'credit') {
      const debt = await CustomerDebtModel.findOne({ saleId: sale._id }).session(session ?? null);
      if (debt && debt.remaining > 0) {
        const reduce = round2(Math.min(debt.remaining, refundAmount));
        debt.remaining = round2(debt.remaining - reduce);
        debt.originalAmount = round2(debt.originalAmount - reduce);
        await debt.save({ session });
        await SaleModel.updateOne({ _id: sale._id }, { $inc: { remaining: -reduce } }, { session });
        await CustomerModel.updateOne({ _id: sale.customerId }, { $inc: { balance: -reduce }, $set: { updatedAt: now } }, { session });
      }
    }

    if (input.refundMethod === 'cash') {
      const sess = await openSessionFor(sale.branchId, ctx.userId, sale.registerSessionId, session);
      if (sess) {
        sess.refunds = round2(sess.refunds + refundAmount);
        sess.movements = [...(sess.movements ?? []), { id: newId('cm'), sessionId: sess._id, type: 'refund', amount: refundAmount, method: 'cash', date: now, reference: returnNumber, userId: ctx.userId }];
        sess.expectedCash = recomputeExpectedCash(sess);
        sess.markModified('movements');
        await sess.save({ session });
      }
    }

    const ret: SaleReturn = { id: newId('ret'), returnNumber, saleId: sale._id, invoiceNumber: sale.invoiceNumber, date: now, branchId: sale.branchId, userId: ctx.userId, customerId: sale.customerId, items, refundAmount, refundMethod: input.refundMethod as PaymentMethod, notes: input.notes };
    await SaleReturnModel.create([{ ...ret, _id: ret.id, id: undefined }], { session });
    await audit({ userId: ctx.userId, action: 'sale_return', entity: 'sale', entityId: sale._id, branchId: sale.branchId, after: { returnNumber, refund: refundAmount }, ip: ctx.ip, date: now }, session);
    return ret;
  });
  afterCommit(() => {
    emitToBranch(ret.branchId, SOCKET_EVENTS.saleCreated, { id: ret.saleId, returned: true, branchId: ret.branchId });
    void evaluateEventAlerts({ kind: 'return', saleReturn: ret });
  });
  return ret;
}
