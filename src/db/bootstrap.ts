import { DEFAULT_SETTINGS, ROLE_PERMISSIONS, defaultLabelTemplate, defaultPrintProfiles } from '@moto/shared';
import type { RoleKey } from '@moto/shared';
import { logger } from '../lib/logger.js';
import { ensureCategoryTree } from '../modules/products/categories.js';
import { backfillProductBarcodes } from '../modules/products/service.js';
import { DEFAULT_WHATSAPP_TEMPLATES } from '../modules/whatsapp/templates.js';
import { LabelTemplateModel, PriceHistoryModel, PrintProfileModel, RoleModel, SettingsModel, WhatsAppTemplateModel } from './models.js';

export const ROLE_META: Record<RoleKey, { name: { ar: string; en: string }; description: { ar: string; en: string } }> = {
  admin: { name: { ar: 'مدير النظام', en: 'Administrator' }, description: { ar: 'صلاحيات كاملة على كل الفروع', en: 'Full access to all branches' } },
  branch_manager: { name: { ar: 'مدير فرع', en: 'Branch manager' }, description: { ar: 'إدارة الفرع والاعتمادات', en: 'Branch operations and approvals' } },
  accountant: { name: { ar: 'محاسب', en: 'Accountant' }, description: { ar: 'التقارير المالية والمدفوعات', en: 'Financial reports and payments' } },
  cashier: { name: { ar: 'كاشير', en: 'Cashier' }, description: { ar: 'نقطة البيع والخزنة', en: 'POS and register' } },
  sales: { name: { ar: 'مبيعات', en: 'Sales' }, description: { ar: 'بيع وجملة وعملاء', en: 'Sales, wholesale and customers' } },
  warehouse: { name: { ar: 'أمين مخزن', en: 'Warehouse' }, description: { ar: 'المخزون والاستلام والتحويلات', en: 'Inventory, receiving, transfers' } },
};

/** Idempotent system configuration only; never creates business records or accounts. */
export async function ensureBootstrap() {
  for (const key of Object.keys(ROLE_PERMISSIONS) as RoleKey[]) {
    await RoleModel.updateOne({ _id: key }, { $setOnInsert: { permissions: ROLE_PERMISSIONS[key], ...ROLE_META[key] } }, { upsert: true });
  }
  await SettingsModel.updateOne({ _id: 'app' }, { $setOnInsert: { value: DEFAULT_SETTINGS } }, { upsert: true });
  for (const { key, ...template } of DEFAULT_WHATSAPP_TEMPLATES) {
    await WhatsAppTemplateModel.updateOne({ _id: key }, { $setOnInsert: template }, { upsert: true });
  }
  if ((await PrintProfileModel.countDocuments()) === 0) {
    await PrintProfileModel.insertMany(defaultPrintProfiles().map(({ id, ...p }) => ({ _id: id, ...p })));
  }
  if ((await LabelTemplateModel.countDocuments()) === 0) {
    const { id, ...t } = defaultLabelTemplate();
    await LabelTemplateModel.create({ _id: id, ...t });
  }
  await runMigrations();
}

/** Additive, idempotent upgrades for databases created before the taxonomy/barcode/price-history changes. */
async function runMigrations() {
  await ensureCategoryTree();
  const barcodes = await backfillProductBarcodes();
  if (barcodes) logger.info({ count: barcodes }, 'backfilled internal barcodes');
  await PriceHistoryModel.updateMany({ source: { $exists: false } }, { $set: { source: 'single' } });
  await PriceHistoryModel.updateMany({ branchId: { $exists: false } }, { $set: { branchId: '' } });
  await PrintProfileModel.updateMany({ showStamp: { $exists: false } }, { $set: { showStamp: true, showReviewStamp: false } });
  // Managing the POS quick grid used to ride on settings.edit; give it to whoever already had that.
  await RoleModel.updateMany({ permissions: 'settings.edit' }, { $addToSet: { permissions: 'settings.quick_grid' } });
  await RoleModel.updateOne({ _id: 'branch_manager' }, { $addToSet: { permissions: 'settings.quick_grid' } });
}
