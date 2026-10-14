import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { toE164Digits, waMeLink } from '@moto/shared';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { AuditLogModel, RoleModel, WhatsAppMessageModel } from '../../db/models.js';
import { invalidateRoleCache } from '../auth/permissions.js';
import { provider } from './provider.js';

let app: Express;
let admin: Awaited<ReturnType<typeof loginAs>>;
let sales: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  admin = await loginAs(app, 'admin');
  sales = await loginAs(app, 'nour.h');
});
afterAll(stopTestDb);

const auth = (who: { token: string }) => ({ Authorization: `Bearer ${who.token}` });

describe('phone normalisation and wa.me links', () => {
  it('turns local numbers into bare E.164 digits', () => {
    expect(toE164Digits('01012345678')).toBe('201012345678');
    expect(toE164Digits('+20 101 234 5678')).toBe('201012345678');
    expect(toE164Digits('0020-101-234-5678')).toBe('201012345678');
    expect(toE164Digits('201012345678')).toBe('201012345678');
  });

  it('honours a different default dialling code', () => {
    expect(toE164Digits('0912345678', '249')).toBe('249912345678');
  });

  it('returns an empty string for junk rather than a broken link', () => {
    expect(toE164Digits('---')).toBe('');
  });

  it('builds a wa.me link with URL-encoded Arabic text', () => {
    const link = waMeLink('01012345678', 'فاتورتك جاهزة');
    expect(link.startsWith('https://wa.me/201012345678?text=')).toBe(true);
    expect(decodeURIComponent(link.split('text=')[1]!)).toBe('فاتورتك جاهزة');
  });
});

describe('sending', () => {
  const payload = { customerId: 'cust-1', phone: '01012345678', body: 'فاتورتك رقم INV-1', referenceId: 'sale-1' };

  it('stores the message against the normalised number and audits the send', async () => {
    const res = await api(app).post('/api/whatsapp/send').set(auth(admin)).send({ ...payload, templateKey: 'invoice' });
    expect(res.status).toBe(201);
    expect(res.body.phone).toBe('201012345678');
    expect(res.body.status).toBe('prepared');
    expect(res.body.link).toContain('https://wa.me/201012345678');

    const stored = await WhatsAppMessageModel.findById(res.body.id).lean();
    expect(stored!.customerId).toBe('cust-1');
    expect(stored!.templateKey).toBe('invoice');

    const log = await AuditLogModel.findOne({ action: 'whatsapp_send', entityId: 'cust-1' }).sort({ date: -1 }).lean();
    expect(log).toBeTruthy();
    expect(log!.after).toMatchObject({ templateKey: 'invoice', phone: '201012345678' });
  });

  it('accepts every transactional template for a user with whatsapp.send', async () => {
    for (const templateKey of ['statement', 'debt_reminder', 'payment_confirmation'] as const) {
      const res = await api(app).post('/api/whatsapp/send').set(auth(sales)).send({ ...payload, templateKey });
      expect(res.status).toBe(201);
    }
  });

  it('refuses promotions without whatsapp.promote', async () => {
    const res = await api(app).post('/api/whatsapp/send').set(auth(sales)).send({ ...payload, templateKey: 'promotion', body: 'عرض خاص' });
    expect(res.status).toBe(403);
  });

  it('allows promotions once the role is granted the permission', async () => {
    await RoleModel.updateOne({ _id: 'sales' }, { $addToSet: { permissions: 'whatsapp.promote' } });
    invalidateRoleCache();
    const granted = await loginAs(app, 'nour.h');
    const res = await api(app).post('/api/whatsapp/send').set(auth(granted)).send({ ...payload, templateKey: 'promotion', body: 'عرض خاص' });
    expect(res.status).toBe(201);
    await RoleModel.updateOne({ _id: 'sales' }, { $pull: { permissions: 'whatsapp.promote' } });
    invalidateRoleCache();
  });

  it('rejects a send from a user with no WhatsApp permission at all', async () => {
    const cashier = await loginAs(app, 'cashier1');
    const res = await api(app).post('/api/whatsapp/send').set(auth(cashier)).send({ ...payload, templateKey: 'invoice' });
    expect(res.status).toBe(403);
  });
});

describe('WhatsApp preparation and settings', () => {
  it('rejects unfilled message variables before recording or sending a message', async () => {
    const before = await WhatsAppMessageModel.countDocuments();
    const res = await api(app).post('/api/whatsapp/send').set(auth(admin)).send({ customerId: 'cust-1', phone: '01012345678', templateKey: 'payment_confirmation', body: 'Received {amount}' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNRESOLVED_TEMPLATE');
    expect(await WhatsAppMessageModel.countDocuments()).toBe(before);
  });
  it('does not resend a previously prepared or accepted message', async () => {
    const message = await WhatsAppMessageModel.findOne({ status: 'prepared' }).lean();
    const res = await api(app).post(`/api/whatsapp/messages/${message!._id}/retry`).set(auth(admin));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MESSAGE_NOT_FAILED');
  });
  it('records provider failure on retry instead of leaving the message queued', async () => {
    const message = await WhatsAppMessageModel.create({ _id: 'wa-retry-failure', customerId: 'cust-1', phone: '201012345678', templateKey: 'invoice', body: 'Actual message', userId: admin.user.id, status: 'failed', sentAt: new Date().toISOString() });
    const send = vi.spyOn(provider, 'send').mockRejectedValueOnce(new Error('Provider unreachable'));
    try {
      const res = await api(app).post(`/api/whatsapp/messages/${message._id}/retry`).set(auth(admin));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect((await WhatsAppMessageModel.findById(message._id).lean())!.status).toBe('failed');
    } finally { send.mockRestore(); }
  });
  it('does not count manually prepared messages as sent', async () => {
    const res = await api(app).get('/api/whatsapp/stats').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.sentToday).toBe(0);
    expect(res.body.deliveryRate).toBeNull();
  });
  it('requires settings.edit to change a shared template', async () => {
    const res = await api(app).put('/api/whatsapp/templates/invoice').set(auth(sales)).send({ isActive: false });
    expect(res.status).toBe(403);
  });
  it('refuses automatic alerts in manual link mode', async () => {
    const { getSettings, updateSettingsSection } = await import('../settings/service.js');
    const current = await getSettings();
    await expect(updateSettingsSection('alerts', { ...current.alerts, whatsappOnCritical: true })).rejects.toMatchObject({ code: 'WHATSAPP_CLOUD_REQUIRED' });
  });
});

describe('audit log is append-only', () => {
  it('exposes no route that edits or deletes an entry', async () => {
    const log = await AuditLogModel.findOne().lean();
    expect(log).toBeTruthy();
    for (const method of ['patch', 'put', 'delete'] as const) {
      const res = await api(app)[method](`/api/audit/${log!._id}`).set(auth(admin)).send({ action: 'login' });
      expect(res.status).toBe(404);
    }
    expect(await AuditLogModel.findById(log!._id).lean()).toBeTruthy();
  });

  it('filters by entity id so a record can be traced', async () => {
    const res = await api(app).get('/api/audit?entityId=cust-1').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect((res.body.data as { entityId: string }[]).every((a) => a.entityId === 'cust-1')).toBe(true);
  });

  it('is hidden from users without audit.view', async () => {
    const cashier = await loginAs(app, 'cashier1');
    expect((await api(app).get('/api/audit').set(auth(cashier))).status).toBe(403);
  });
});
