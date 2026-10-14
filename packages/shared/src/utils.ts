import type { CashMovementType, Customer, CustomerType, Locale, LocalizedText, PriceTier, Product, ProductPrices, SalePriceTier } from './types';

/** The buckets a register session accumulates; `expectedCash` is always derived from them. */
export interface CashBuckets {
  cashSales: number;
  paymentsIn: number;
  paymentsOut: number;
  expenses: number;
  refunds: number;
}

/** Resolve a bilingual string; English falls back to Arabic. */
export function tx(text: LocalizedText | null | undefined, locale: Locale = 'ar'): string {
  if (!text) return '';
  if (locale === 'en') return text.en || text.ar || '';
  return text.ar || text.en || '';
}

export function localizedSearchFields(text: LocalizedText | null | undefined): (string | undefined)[] {
  return text ? [text.ar, text.en] : [];
}

export function round2(n: number): number {
  // EPSILON nudge so values like 1.005 (stored as 1.00499…) round half-up as humans expect.
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Share of a sale's net line total the customer actually paid (after invoice discount, incl. tax). */
export function refundFactor(sale: { subtotal: number; itemDiscounts: number; total: number }): number {
  const net = round2(sale.subtotal - sale.itemDiscounts);
  return net > 0 ? sale.total / net : 1;
}

/** Maximum refund for returning `qty` units of a sale item, prorated by invoice discount and tax. */
export function maxRefundFor(sale: { subtotal: number; itemDiscounts: number; total: number }, item: { subtotal: number; quantity: number; returnedQty?: number }, qty: number): number {
  const returned = item.returnedQty ?? 0;
  const unitRefund = (item.subtotal / item.quantity) * refundFactor(sale);
  // Round cumulative amounts, then subtract: three partial refunds must not create an extra cent.
  return round2(round2(unitRefund * Math.min(item.quantity, returned + qty)) - round2(unitRefund * returned));
}

/** Legacy records used refundMethod for the whole return; new records store its cash-equivalent payout separately. */
export function returnPayout(ret: { refundAmount: number; refundMethod: string; payoutAmount?: number }): number {
  return ret.payoutAmount ?? (ret.refundMethod === 'credit' ? 0 : ret.refundAmount);
}

export function sum<T>(arr: readonly T[], pick: (x: T) => number): number {
  return arr.reduce((acc, x) => acc + pick(x), 0);
}

export function pad(n: number, len = 4): string {
  return String(n).padStart(len, '0');
}

export function matchSearch(haystack: (string | number | undefined | null)[], q: string | undefined): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return haystack.some((h) => h != null && String(h).toLowerCase().includes(needle));
}

// ---------- pricing ----------
/**
 * Normalises a local or international number to bare E.164 digits (no `+`), which is what `wa.me` expects.
 * `defaultCountry` is the dialling code used when the number starts with a national trunk `0`.
 */
export function toE164Digits(phone: string, defaultCountry = '20'): string {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith('+') || trimmed.startsWith('00');
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('00')) digits = digits.slice(2);
  if (!digits) return '';
  if (hasPlus) return digits;
  if (digits.startsWith('0')) return `${defaultCountry}${digits.slice(1)}`;
  if (digits.startsWith(defaultCountry)) return digits;
  return `${defaultCountry}${digits}`;
}

/** WhatsApp Web / app deep link with pre-filled text. */
export function waMeLink(phone: string, body: string, defaultCountry = '20'): string {
  const digits = toE164Digits(phone, defaultCountry);
  return `https://wa.me/${digits}?text=${encodeURIComponent(body)}`;
}

/** Single source of truth for the reorder rule: reaching `minStock` already counts as low. */
export function stockStatusOf(qty: number, minStock: number): 'in' | 'low' | 'out' {
  return qty <= 0 ? 'out' : minStock > 0 && qty <= minStock ? 'low' : 'in';
}

export const PRICE_TIERS: PriceTier[] = ['retail1', 'retail2', 'wholesale'];

export function defaultTierForCustomer(type: CustomerType | null | undefined, fallback: PriceTier = 'retail1'): PriceTier {
  if (type === 'wholesale') return 'wholesale';
  if (type === 'workshop') return 'retail2';
  return fallback;
}

/** Tiers a user is allowed to sell at; the wholesale tier needs `prices.wholesale`. */
export function allowedPriceTiers(canWholesale: boolean): PriceTier[] {
  return canWholesale ? [...PRICE_TIERS] : PRICE_TIERS.filter((t) => t !== 'wholesale');
}

/** Keeps a tier inside `allowed` so the price shown is always the price charged. */
export function clampPriceTier(tier: PriceTier, allowed: readonly PriceTier[], fallback: PriceTier = 'retail1'): PriceTier {
  if (allowed.includes(tier)) return tier;
  if (allowed.includes(fallback)) return fallback;
  return allowed[0] ?? 'retail1';
}

export function tierPrice(prices: ProductPrices, tier: PriceTier): number {
  return prices[tier];
}

/** Cash the drawer should hold. Single source of truth for the API and the offline terminal. */
export function expectedCashOf(s: CashBuckets & { openingBalance: number }): number {
  return round2(s.openingBalance + s.cashSales + s.paymentsIn - s.paymentsOut - s.expenses - s.refunds);
}

/** Routes one movement into its bucket. Pure — the caller persists the result. */
export function applyCashMovement(s: CashBuckets, type: CashMovementType, amount: number): CashBuckets {
  const next: CashBuckets = { cashSales: s.cashSales, paymentsIn: s.paymentsIn, paymentsOut: s.paymentsOut, expenses: s.expenses, refunds: s.refunds };
  switch (type) {
    case 'deposit':
    case 'payment_in':
      next.paymentsIn = round2(next.paymentsIn + amount);
      break;
    case 'withdrawal':
    case 'payment_out':
      next.paymentsOut = round2(next.paymentsOut + amount);
      break;
    case 'expense':
      next.expenses = round2(next.expenses + amount);
      break;
    case 'refund':
      next.refunds = round2(next.refunds + amount);
      break;
    case 'sale':
      next.cashSales = round2(next.cashSales + amount);
      break;
  }
  return next;
}

export function resolveSalePrice(input: {
  product: Pick<Product, 'prices'>;
  tier: PriceTier;
  customer?: Pick<Customer, 'type'> | null;
  specialPrice?: number | null;
}): { price: number; tier: SalePriceTier } {
  if (input.specialPrice != null) return { price: input.specialPrice, tier: 'special' };
  return { price: tierPrice(input.product.prices, input.tier), tier: input.tier };
}

// ---------- barcode ----------
/** EAN/UPC modulo-10 check digit for a numeric string. */
export function ean13CheckDigit(digits12: string): number {
  let s = 0;
  for (let i = 0; i < digits12.length; i++) {
    const d = Number(digits12[i]);
    s += i % 2 === 0 ? d : d * 3;
  }
  return (10 - (s % 10)) % 10;
}

/** Luhn-style mod-10 over any alphanumeric by mapping chars to codes. */
export function alnumCheckChar(body: string): string {
  let s = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    const v = c >= 48 && c <= 57 ? c - 48 : (c % 36);
    s += i % 2 === 0 ? v * 3 : v;
  }
  return String((10 - (s % 10)) % 10);
}

/**
 * Builds the system barcode. If prefix is numeric and total length is 13 the result is a valid EAN-13,
 * otherwise a Code-128 friendly alphanumeric with a trailing check char.
 */
export function buildInternalBarcode(prefix: string, seq: number, length: number): string {
  const bodyLen = Math.max(1, length - prefix.length - 1);
  const body = `${prefix}${pad(seq, bodyLen)}`;
  if (/^\d+$/.test(body) && body.length === 12) return body + ean13CheckDigit(body);
  return body + alnumCheckChar(body);
}

export function isValidInternalBarcode(code: string): boolean {
  if (code.length < 2) return false;
  const body = code.slice(0, -1);
  const check = code.slice(-1);
  if (/^\d+$/.test(code) && code.length === 13) return String(ean13CheckDigit(body)) === check;
  return alnumCheckChar(body) === check;
}

// ---------- invoice numbering ----------
export function formatInvoiceNumber(prefix: string, seq: number): string {
  return `${prefix}${pad(seq, 6)}`;
}

export function formatOfflineInvoiceNumber(prefix: string, terminalCode: string, localSeq: number): string {
  const p = prefix.endsWith('-') ? prefix : `${prefix}-`;
  return `${p}${terminalCode}-${pad(localSeq, 5)}`;
}

// ---------- QR / e-invoice (ZATCA-style TLV) ----------
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

function bytesToBase64(bytes: number[]): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + (b1 === undefined ? '=' : alphabet[(n >> 6) & 63]) + (b2 === undefined ? '=' : alphabet[n & 63]);
  }
  return out;
}

export interface InvoiceQrFields {
  sellerName: string;
  taxNumber: string;
  timestamp: string;
  totalWithTax: number;
  taxAmount: number;
  verifyUrl?: string;
}

/** Encodes invoice fields as TLV (tag 1..6) and returns Base64. */
export function encodeInvoiceQr(f: InvoiceQrFields): string {
  const entries: [number, string][] = [
    [1, f.sellerName],
    [2, f.taxNumber],
    [3, f.timestamp],
    [4, f.totalWithTax.toFixed(2)],
    [5, f.taxAmount.toFixed(2)],
  ];
  if (f.verifyUrl) entries.push([6, f.verifyUrl]);
  const bytes: number[] = [];
  for (const [tag, value] of entries) {
    const v = utf8Bytes(value);
    bytes.push(tag, v.length & 0xff, ...v);
  }
  return bytesToBase64(bytes);
}

export function decodeInvoiceQr(b64: string): Partial<Record<1 | 2 | 3 | 4 | 5 | 6, string>> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/=+$/, '');
  const bytes: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    buf = (buf << 6) | alphabet.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
  }
  const out: Partial<Record<1 | 2 | 3 | 4 | 5 | 6, string>> = {};
  let i = 0;
  while (i + 1 < bytes.length) {
    const tag = bytes[i] as 1 | 2 | 3 | 4 | 5 | 6;
    const len = bytes[i + 1] ?? 0;
    const slice = bytes.slice(i + 2, i + 2 + len);
    out[tag] = typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(new Uint8Array(slice)) : String.fromCharCode(...slice);
    i += 2 + len;
  }
  return out;
}

// ---------- misc ----------
export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else if (i === 19) s += hex[(Math.random() * 4) | 8];
    else s += hex[(Math.random() * 16) | 0];
  }
  return s;
}

export function mmToPx(mm: number, dpi: number): number {
  return (mm / 25.4) * dpi;
}

export function pxToMm(px: number, dpi: number): number {
  return (px * 25.4) / dpi;
}
