import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import type { Model } from 'mongoose';
import { DEFAULT_SETTINGS, ROLE_PERMISSIONS, defaultLabelTemplate, defaultPrintProfiles } from '@moto/shared';
import type { RoleKey } from '@moto/shared';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import {
  AuditLogModel, BranchModel, BrandModel, CashRegisterModel, CategoryModel, CounterModel, CustomerDebtModel, CustomerModel, CustomerPaymentModel, ExpenseCategoryModel, ExpenseModel,
  LabelTemplateModel, MotorcycleModelModel, NotificationModel, PriceHistoryModel, PrintProfileModel, ProductModel, PurchaseModel, PurchaseReturnModel, QuickProductModel, RegisterSessionModel,
  RoleModel, SaleModel, SaleReturnModel, SettingsModel, SpecialPriceModel, StockAdjustmentModel, StockCountModel, StockLevelModel, StockMovementModel, SupplierModel, SupplierPaymentModel,
  TransferModel, UserModel, WarehouseModel, WhatsAppMessageModel, WhatsAppTemplateModel, stockLevelId,
} from '../../db/models.js';
import { ROLE_META } from '../../db/bootstrap.js';

export const DEMO_PASSWORD = '123456';

type WithId = { id: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;
/** Duplicate ids are expected when seeding over rows bootstrap already created; everything else still lands. */
function isDuplicateKeyError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code?: number }).code === 11000;
}

async function insert<T extends WithId>(model: AnyModel, rows: T[], extra?: (r: T) => Record<string, unknown>) {
  if (!rows.length) return;
  const docs = rows.map(({ id, ...rest }) => ({ _id: id, ...rest, ...(extra ? extra({ id, ...rest } as T) : {}) }));
  for (let i = 0; i < docs.length; i += 500) {
    try {
      await model.insertMany(docs.slice(i, i + 500), { ordered: false });
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;
    }
  }
}

export async function seedDatabase(opts: { drop?: boolean } = {}) {
  // Check before database reads or writes; fixtures may only reach the isolated test replica set.
  if (env.NODE_ENV !== 'test' || mongoose.connection.name !== 'moto-test') throw new Error('Fixtures require NODE_ENV=test and the isolated moto-test database');
  if (!opts.drop && (await UserModel.exists({}) || await SaleModel.exists({}))) throw new Error('Refusing to overwrite test records');
  const { seedData } = await import('./generate.js');
  if (opts.drop) {
    await mongoose.connection.dropDatabase();
    logger.info('database dropped');
  }
  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, env.NODE_ENV === 'test' ? 4 : env.BCRYPT_COST);

  for (const key of Object.keys(ROLE_PERMISSIONS) as RoleKey[]) {
    await RoleModel.updateOne({ _id: key }, { $set: { permissions: ROLE_PERMISSIONS[key], ...ROLE_META[key] } }, { upsert: true });
  }
  await SettingsModel.updateOne({ _id: 'app' }, { $set: { value: { ...DEFAULT_SETTINGS, invoice: { ...DEFAULT_SETTINGS.invoice, nextNumber: seedData.seq.invoice } } } }, { upsert: true });

  await insert(BranchModel, seedData.branches);
  await insert(WarehouseModel, seedData.warehouses);
  await insert(UserModel, seedData.users, () => ({ passwordHash, refreshTokens: [] }));
  await insert(SupplierModel, seedData.suppliers);
  await insert(CustomerModel, seedData.customers, (c) => ({ updatedAt: c.createdAt }));
  await insert(CashRegisterModel, seedData.cashRegisters);
  await insert(ExpenseCategoryModel, seedData.expenseCategories);
  await insert(BrandModel, seedData.brands);
  await insert(CategoryModel, seedData.categories);
  await insert(MotorcycleModelModel, seedData.motorcycleModels);
  await insert(ProductModel, seedData.products, () => ({ deletedAt: null }));
  await StockLevelModel.insertMany(seedData.stockLevels.map((l) => ({ _id: stockLevelId(l.productId, l.warehouseId), ...l, updatedAt: now })), { ordered: false });
  await insert(SaleModel, seedData.sales, (s) => ({ serverSequence: Number(s.id.split('-')[1]) }));
  await insert(SaleReturnModel, seedData.saleReturns);
  await insert(CustomerDebtModel, seedData.customerDebts);
  await insert(CustomerPaymentModel, seedData.customerPayments);
  await insert(PurchaseModel, seedData.purchases);
  await insert(SupplierPaymentModel, seedData.supplierPayments);
  await insert(PurchaseReturnModel, seedData.purchaseReturns);
  await insert(TransferModel, seedData.transfers);
  await insert(StockMovementModel, seedData.stockMovements);
  await insert(StockAdjustmentModel, seedData.stockAdjustments);
  await insert(StockCountModel, seedData.stockCounts);
  await insert(PriceHistoryModel, seedData.priceHistory);
  await insert(SpecialPriceModel, seedData.specialPrices);
  await insert(RegisterSessionModel, seedData.registerSessions);
  await insert(ExpenseModel, seedData.expenses);
  for (const { key, ...template } of seedData.whatsappTemplates) {
    await WhatsAppTemplateModel.updateOne({ _id: key }, { $set: template }, { upsert: true });
  }
  await insert(WhatsAppMessageModel, seedData.whatsappMessages);
  await insert(AuditLogModel, seedData.auditLogs);
  await insert(NotificationModel, seedData.notifications);
  await QuickProductModel.insertMany(seedData.quickProductIds.map((pid, i) => ({ _id: `qp-${i + 1}`, productId: pid, categoryId: null, branchId: null, order: i, updatedAt: now })), { ordered: false });
  if ((await PrintProfileModel.countDocuments()) === 0) await PrintProfileModel.insertMany(defaultPrintProfiles().map(({ id, ...p }) => ({ _id: id, ...p })));
  if ((await LabelTemplateModel.countDocuments()) === 0) {
    const { id, ...t } = defaultLabelTemplate();
    await LabelTemplateModel.create({ _id: id, ...t });
  }
  for (const [key, seq] of Object.entries(seedData.seq)) await CounterModel.updateOne({ _id: key }, { $max: { seq } }, { upsert: true });

  logger.info({ products: seedData.products.length, sales: seedData.sales.length, users: seedData.users.length }, 'seed complete');
}

