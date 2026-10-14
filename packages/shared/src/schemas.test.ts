import { describe, expect, it } from 'vitest';
import { AlertQuerySchema, BoolQuerySchema, InvoiceSettingsSchema, UserSaveSchema } from './schemas';
import { maxRefundFor } from './utils';

describe('BoolQuerySchema', () => {
  it('parses "false" as false (unlike z.coerce.boolean)', () => {
    expect(BoolQuerySchema.parse('false')).toBe(false);
    expect(BoolQuerySchema.parse('0')).toBe(false);
    expect(BoolQuerySchema.parse('true')).toBe(true);
    expect(BoolQuerySchema.parse(true)).toBe(true);
    expect(() => BoolQuerySchema.parse('yes')).toThrow();
  });
  it('keeps optional / default semantics in query schemas', () => {
    expect(AlertQuerySchema.parse({ resolved: 'false' }).resolved).toBe(false);
    expect(AlertQuerySchema.parse({}).resolved).toBeUndefined();
  });
});

describe('UserSaveSchema', () => {
  it('does not default status to active when omitted', () => {
    const parsed = UserSaveSchema.parse({ username: 'abc', fullName: { ar: 'x' }, role: 'cashier', branchId: 'br-1' });
    expect(parsed.status).toBeUndefined();
  });
});

describe('InvoiceSettingsSchema', () => {
  it('rejects non-numeric tax rates', () => {
    const base = { prefix: 'INV-', nextNumber: 1, footerText: { ar: '' }, showLogo: true, showTax: true, allowNegativeStock: false };
    expect(InvoiceSettingsSchema.safeParse({ ...base, taxRate: 'x' }).success).toBe(false);
    expect(InvoiceSettingsSchema.safeParse({ ...base, taxRate: 14 }).success).toBe(true);
  });
});

describe('maxRefundFor', () => {
  it('prorates the line net by invoice discount and tax', () => {
    const sale = { subtotal: 120, itemDiscounts: 0, total: 105 };
    expect(maxRefundFor(sale, { subtotal: 120, quantity: 2 }, 1)).toBe(52.5);
    expect(maxRefundFor({ subtotal: 100, itemDiscounts: 0, total: 114 }, { subtotal: 100, quantity: 1 }, 1)).toBe(114);
  });
});
