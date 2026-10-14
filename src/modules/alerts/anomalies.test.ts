import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Sale } from '@moto/shared';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { AlertModel, AuditLogModel } from '../../db/models.js';
import { checkSaleAnomalies, checkVoidRate } from './engine.js';
import { getSettings, updateSettingsSection } from '../settings/service.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
});
afterAll(stopTestDb);

beforeEach(async () => {
  await AlertModel.deleteMany({ type: 'unusual_operation' });
});

const sale = (over: Partial<Sale> = {}): Sale => ({
  id: 'sale-anom',
  invoiceNumber: 'INV-ANOM',
  date: new Date().toISOString(),
  branchId: 'br-1',
  cashierId: 'usr-1',
  customerId: null,
  registerSessionId: null,
  items: [{ id: 'i1', productId: 'prod-1', name: { ar: 'صنف' }, barcode: 'b', sku: 's', quantity: 1, listPrice: 100, unitPrice: 100, unitCost: 60, priceTier: 'retail1', discount: 0, discountPercent: 0, subtotal: 100, returnedQty: 0 }],
  subtotal: 100,
  itemDiscounts: 0,
  invoiceDiscount: 0,
  tax: 0,
  total: 100,
  paid: 100,
  remaining: 0,
  change: 0,
  payments: [{ method: 'cash', amount: 100 }],
  type: 'cash',
  status: 'completed',
  ...over,
});

const unresolved = () => AlertModel.find({ type: 'unusual_operation', resolvedAt: null }).lean();

describe('unusual operation alerts', () => {
  it('stays silent for an ordinary sale', async () => {
    await checkSaleAnomalies(sale());
    expect(await unresolved()).toHaveLength(0);
  });

  it('flags an invoice discount above the configured threshold', async () => {
    await checkSaleAnomalies(sale({ subtotal: 1000, invoiceDiscount: 400, total: 600 }));
    const alerts = await unresolved();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('warning');
    expect(alerts[0]!.body.ar).toContain('40.0%');
  });

  it('escalates to critical past double the threshold', async () => {
    await checkSaleAnomalies(sale({ subtotal: 1000, invoiceDiscount: 600, total: 400 }));
    const alerts = await unresolved();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('critical');
  });

  it('respects a raised threshold from settings', async () => {
    const current = (await getSettings()).alerts;
    await updateSettingsSection('alerts', { ...current, unusualDiscountPercent: 60 });
    await checkSaleAnomalies(sale({ subtotal: 1000, invoiceDiscount: 400, total: 600 }));
    expect(await unresolved()).toHaveLength(0);
    await updateSettingsSection('alerts', current);
  });

  it('flags a manual price override', async () => {
    const s = sale();
    s.items[0]!.priceTier = 'manual';
    await checkSaleAnomalies(s);
    const alerts = await unresolved();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title.ar).toContain('سعر يدوي');
  });

  it('deduplicates repeated evaluation of the same invoice', async () => {
    const s = sale({ subtotal: 1000, invoiceDiscount: 400, total: 600 });
    await checkSaleAnomalies(s);
    await checkSaleAnomalies(s);
    expect(await unresolved()).toHaveLength(1);
  });

  it('flags a cashier voiding more invoices than allowed in a day', async () => {
    const userId = 'usr-void-test';
    await AuditLogModel.deleteMany({ userId });
    const now = new Date().toISOString();
    await AuditLogModel.insertMany(
      Array.from({ length: 5 }, (_, i) => ({ _id: `aud-void-${i}`, userId, action: 'invoice_cancel', entity: 'sale', entityId: `s-${i}`, branchId: 'br-1', date: now, before: null, after: null, ip: '::1' })),
    );

    await checkVoidRate(sale(), userId);
    const alerts = await unresolved();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.body.ar).toContain('5');
  });

  it('stays silent when voids are within the daily allowance', async () => {
    const userId = 'usr-void-ok';
    await AuditLogModel.deleteMany({ userId });
    await AuditLogModel.create({ _id: 'aud-void-ok', userId, action: 'invoice_cancel', entity: 'sale', entityId: 's-0', branchId: 'br-1', date: new Date().toISOString(), before: null, after: null, ip: '::1' });
    await checkVoidRate(sale(), userId);
    expect(await unresolved()).toHaveLength(0);
  });

  it('surfaces the alert through the API for a manager', async () => {
    await checkSaleAnomalies(sale({ subtotal: 1000, invoiceDiscount: 400, total: 600 }));
    const res = await api(app).get('/api/alerts?type=unusual_operation').set({ Authorization: `Bearer ${admin.token}` });
    expect(res.status).toBe(200);
    expect((res.body.data as { type: string }[]).some((a) => a.type === 'unusual_operation')).toBe(true);
  });
});
