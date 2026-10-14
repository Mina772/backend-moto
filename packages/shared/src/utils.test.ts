import { describe, expect, it } from 'vitest';
import { allowedPriceTiers, applyCashMovement, buildInternalBarcode, clampPriceTier, decodeInvoiceQr, ean13CheckDigit, encodeInvoiceQr, expectedCashOf, formatInvoiceNumber, formatOfflineInvoiceNumber, isValidInternalBarcode, matchSearch, round2, tx } from './utils';

describe('price tier permissions', () => {
  it('drops the wholesale tier without the permission', () => {
    expect(allowedPriceTiers(true)).toEqual(['retail1', 'retail2', 'wholesale']);
    expect(allowedPriceTiers(false)).toEqual(['retail1', 'retail2']);
  });

  it('clamps to the fallback, then to the first allowed tier', () => {
    const limited = allowedPriceTiers(false);
    expect(clampPriceTier('wholesale', limited)).toBe('retail1');
    expect(clampPriceTier('wholesale', limited, 'retail2')).toBe('retail2');
    expect(clampPriceTier('retail2', limited)).toBe('retail2');
    expect(clampPriceTier('retail1', ['retail2'], 'wholesale')).toBe('retail2');
  });
});

describe('drawer arithmetic', () => {
  const zero = { cashSales: 0, paymentsIn: 0, paymentsOut: 0, expenses: 0, refunds: 0 };

  it('routes each movement type into its own bucket', () => {
    expect(applyCashMovement(zero, 'deposit', 100)).toMatchObject({ paymentsIn: 100 });
    expect(applyCashMovement(zero, 'payment_in', 100)).toMatchObject({ paymentsIn: 100 });
    expect(applyCashMovement(zero, 'withdrawal', 40)).toMatchObject({ paymentsOut: 40 });
    expect(applyCashMovement(zero, 'payment_out', 40)).toMatchObject({ paymentsOut: 40 });
    expect(applyCashMovement(zero, 'expense', 25)).toMatchObject({ expenses: 25 });
    expect(applyCashMovement(zero, 'refund', 15)).toMatchObject({ refunds: 15 });
    expect(applyCashMovement(zero, 'sale', 70)).toMatchObject({ cashSales: 70 });
  });

  it('expected cash adds money in and subtracts money out, rounded to 2dp', () => {
    expect(expectedCashOf({ openingBalance: 500, cashSales: 200, paymentsIn: 100, paymentsOut: 150, expenses: 50, refunds: 0 })).toBe(600);
    expect(expectedCashOf({ openingBalance: 0.1, cashSales: 0.2, paymentsIn: 0, paymentsOut: 0, expenses: 0, refunds: 0 })).toBe(0.3);
    expect(expectedCashOf({ openingBalance: 0, cashSales: 0, paymentsIn: 0, paymentsOut: 10, expenses: 0, refunds: 0 })).toBe(-10);
  });

  it('a sequence of movements matches a single expected-cash computation', () => {
    let b = zero;
    for (const [type, amount] of [['sale', 70], ['deposit', 30], ['expense', 12.5], ['refund', 7.5]] as const) b = applyCashMovement(b, type, amount);
    expect(expectedCashOf({ ...b, openingBalance: 100 })).toBe(180);
  });
});

describe('barcode engine', () => {
  it('computes the EAN-13 check digit', () => {
    expect(ean13CheckDigit('400638133393')).toBe(1); // 4006381333931
    expect(ean13CheckDigit('590123412345')).toBe(7); // 5901234123457
  });

  it('numeric prefix + 13 length yields a valid EAN-13 that round-trips validation', () => {
    const code = buildInternalBarcode('200', 17, 13);
    expect(code).toHaveLength(13);
    expect(code.startsWith('200000000017')).toBe(true);
    expect(isValidInternalBarcode(code)).toBe(true);
    expect(isValidInternalBarcode(code.slice(0, -1) + ((Number(code.at(-1)) + 1) % 10))).toBe(false);
  });

  it('alphanumeric prefix yields a Code-128 body with a check char', () => {
    const code = buildInternalBarcode('MP', 42, 10);
    expect(code).toHaveLength(10);
    expect(code.startsWith('MP0000042')).toBe(true);
    expect(isValidInternalBarcode(code)).toBe(true);
    expect(isValidInternalBarcode('MP00000421')).toBe(code === 'MP00000421');
  });

  it('sequences are unique per seq', () => {
    const set = new Set(Array.from({ length: 500 }, (_, i) => buildInternalBarcode('200', i + 1, 13)));
    expect(set.size).toBe(500);
  });
});

describe('invoice numbering', () => {
  it('online numbers are prefix + 6-digit sequence', () => {
    expect(formatInvoiceNumber('INV-', 12)).toBe('INV-000012');
  });
  it('offline numbers embed the terminal code and never collide with server numbers', () => {
    expect(formatOfflineInvoiceNumber('INV-', 'T001', 1)).toBe('INV-T001-00001');
    expect(formatOfflineInvoiceNumber('INV', 'T002', 123)).toBe('INV-T002-00123');
    expect(formatOfflineInvoiceNumber('INV-', 'T001', 1)).not.toBe(formatInvoiceNumber('INV-', 1));
  });
});

describe('invoice QR (TLV base64)', () => {
  it('encodes tags 1..6 and decodes back, including Arabic seller names', () => {
    const b64 = encodeInvoiceQr({ sellerName: 'موتو بارتس', taxNumber: '123-456-789', timestamp: '2026-10-07T10:00:00.000Z', totalWithTax: 1150, taxAmount: 150, verifyUrl: 'https://erp.local/v/abc' });
    expect(/^[A-Za-z0-9+/]+=*$/.test(b64)).toBe(true);
    const d = decodeInvoiceQr(b64);
    expect(d[1]).toBe('موتو بارتس');
    expect(d[2]).toBe('123-456-789');
    expect(d[3]).toBe('2026-10-07T10:00:00.000Z');
    expect(d[4]).toBe('1150.00');
    expect(d[5]).toBe('150.00');
    expect(d[6]).toBe('https://erp.local/v/abc');
  });
  it('omits tag 6 when no verify URL', () => {
    const d = decodeInvoiceQr(encodeInvoiceQr({ sellerName: 'X', taxNumber: '', timestamp: 't', totalWithTax: 1, taxAmount: 0 }));
    expect(d[6]).toBeUndefined();
    expect(d[2]).toBe('');
  });
});

describe('misc utils', () => {
  it('tx falls back to Arabic when English is missing', () => {
    expect(tx({ ar: 'فلتر' }, 'en')).toBe('فلتر');
    expect(tx({ ar: 'فلتر', en: 'Filter' }, 'en')).toBe('Filter');
    expect(tx({ ar: 'فلتر', en: 'Filter' }, 'ar')).toBe('فلتر');
  });
  it('round2 avoids float drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1.005)).toBe(1.01);
  });
  it('matchSearch is case/diacritic tolerant across fields', () => {
    expect(matchSearch(['فلتر زيت', 'Oil Filter'], 'filt')).toBe(true);
    expect(matchSearch(['فلتر زيت'], 'زيت')).toBe(true);
    expect(matchSearch(['فلتر زيت'], 'xyz')).toBe(false);
    expect(matchSearch(['anything'], '')).toBe(true);
  });
});
