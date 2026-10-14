import { afterAll, beforeAll, expect, it } from 'vitest';
import { ensureBootstrap } from './bootstrap.js';
import { startTestDb, stopTestDb } from '../test/harness.js';
import { BranchModel, CustomerModel, ProductModel, SaleModel, SettingsModel, StockLevelModel, UserModel, WhatsAppMessageModel, WhatsAppTemplateModel } from './models.js';

beforeAll(async () => { await startTestDb(); });
afterAll(stopTestDb);

it('repeated startup leaves business collections empty and company identity unconfigured', async () => {
  await ensureBootstrap();
  await ensureBootstrap();
  for (const model of [BranchModel, CustomerModel, ProductModel, SaleModel, StockLevelModel, UserModel, WhatsAppMessageModel]) {
    expect(await model.countDocuments()).toBe(0);
  }
  const settings = (await SettingsModel.findById('app').lean())!.value;
  expect(settings.company).toMatchObject({ name: { ar: '', en: '' }, taxNumber: '', commercialRegister: '', phone: '', email: '', address: { ar: '', en: '' }, vatRegistered: false });
  expect(settings.receipt.headerLines).toEqual([]);
  expect(settings.receipt.brandLogos).toEqual([]);
  expect(settings.receipt.warrantyNotes).toEqual([]);
  expect(await WhatsAppTemplateModel.countDocuments()).toBe(5);
});

it('startup preserves operator-entered company details', async () => {
  await SettingsModel.updateOne({ _id: 'app' }, { $set: { 'value.company.name.ar': 'اسم النشاط الفعلي', 'value.company.taxNumber': 'real-tax-number' } });
  await ensureBootstrap();
  const settings = (await SettingsModel.findById('app').lean())!.value;
  expect(settings.company.name.ar).toBe('اسم النشاط الفعلي');
  expect(settings.company.taxNumber).toBe('real-tax-number');
});

it('preserves message formats edited by the operator', async () => {
  await WhatsAppTemplateModel.updateOne({ _id: 'invoice' }, { $set: { 'body.ar': 'النص المعدل', isActive: false } });
  await ensureBootstrap();
  const template = await WhatsAppTemplateModel.findById('invoice').lean();
  expect(template!.body.ar).toBe('النص المعدل');
  expect(template!.isActive).toBe(false);
});
