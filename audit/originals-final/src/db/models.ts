import { model, Schema, type Model } from 'mongoose';
import type {
  Alert, AppNotification, AppSettings, AuditLog, Branch, Brand, CashRegister, Category, Customer, CustomerDebt, CustomerPayment, DeadStockSnapshot,
  Expense, ExpenseCategory, LabelTemplate, MotorcycleModel, PriceHistoryEntry, PrintProfile, Product, Purchase, PurchaseReturn, QuickCategory,
  QuickProduct, RegisterSession, RoleKey, Sale, SaleReturn, SpecialPrice, StockAdjustment, StockCount, StockLevel, StockMovement, Supplier,
  SupplierPayment, Terminal, Transfer, User, Warehouse, WhatsAppMessage, WhatsAppTemplate, Permission,
} from '@moto/shared';
import { defineSchema, LocalizedTextSchema, Mixed } from './schema-helpers.js';

type Doc<T> = Omit<T, 'id'> & { _id: string };

// ---------- org ----------
export interface RefreshTokenEntry { hash: string; client: string; createdAt: string }
export interface UserDoc extends Doc<User> {
  passwordHash: string;
  /** One entry per signed-in device (web cookie + desktop body token coexist). */
  refreshTokens: RefreshTokenEntry[];
}
export const UserModel: Model<UserDoc> = model<UserDoc>(
  'User',
  defineSchema<UserDoc>({
    username: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    refreshTokens: { type: [{ _id: false, hash: String, client: String, createdAt: String }], default: [] },
    fullName: { type: LocalizedTextSchema, required: true },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    role: { type: String, required: true },
    branchId: { type: String, required: true, index: true },
    status: { type: String, default: 'active' },
    avatarColor: { type: String, default: '#2563eb' },
    lastLogin: { type: String, default: null },
    createdAt: { type: String, required: true },
    extraPermissions: { type: [String], default: undefined },
  }),
);

export interface RoleDoc { _id: RoleKey; permissions: Permission[]; name: { ar: string; en?: string }; description: { ar: string; en?: string } }
export const RoleModel: Model<RoleDoc> = model<RoleDoc>(
  'Role',
  defineSchema<RoleDoc>({
    permissions: { type: [String], default: [] },
    name: { type: LocalizedTextSchema, required: true },
    description: { type: LocalizedTextSchema, required: true },
  }),
);

export const BranchModel: Model<Doc<Branch>> = model<Doc<Branch>>(
  'Branch',
  defineSchema<Doc<Branch>>({
    code: { type: String, required: true, unique: true },
    name: { type: LocalizedTextSchema, required: true },
    city: { type: LocalizedTextSchema, required: true },
    address: { type: LocalizedTextSchema, required: true },
    phone: { type: String, default: '' },
    managerId: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    posTerminals: { type: Number, default: 1 },
    openedAt: { type: String, required: true },
  }),
);

export const WarehouseModel: Model<Doc<Warehouse>> = model<Doc<Warehouse>>(
  'Warehouse',
  defineSchema<Doc<Warehouse>>({
    code: { type: String, required: true, unique: true },
    name: { type: LocalizedTextSchema, required: true },
    branchId: { type: String, required: true, index: true },
    isActive: { type: Boolean, default: true },
    isMain: { type: Boolean, default: false },
    locations: { type: Mixed, default: [] },
    capacity: { type: Number, default: 0 },
  }),
);

export const CashRegisterModel: Model<Doc<CashRegister>> = model<Doc<CashRegister>>(
  'CashRegister',
  defineSchema<Doc<CashRegister>>({
    code: { type: String, required: true, unique: true },
    name: { type: LocalizedTextSchema, required: true },
    branchId: { type: String, required: true, index: true },
    isActive: { type: Boolean, default: true },
    currentSessionId: { type: String, default: null },
  }),
);

export const TerminalModel: Model<Doc<Terminal>> = model<Doc<Terminal>>(
  'Terminal',
  defineSchema<Doc<Terminal>>({
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    branchId: { type: String, required: true, index: true },
    registerId: { type: String, default: null },
    lastSeenAt: { type: String, default: null },
    appVersion: { type: String },
    createdAt: { type: String, required: true },
  }),
);

// ---------- catalog ----------
export const BrandModel: Model<Doc<Brand>> = model<Doc<Brand>>('Brand', defineSchema<Doc<Brand>>({ name: { type: LocalizedTextSchema, required: true }, country: { type: LocalizedTextSchema, required: true } }));
const categorySchema = defineSchema<Doc<Category>>({
  name: { type: LocalizedTextSchema, required: true },
  parentId: { type: String, default: null, index: true },
  ancestors: { type: [String], default: [], index: true },
  sortOrder: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
});
categorySchema.index({ parentId: 1, sortOrder: 1 });
export const CategoryModel: Model<Doc<Category>> = model<Doc<Category>>('Category', categorySchema);
export const MotorcycleModelModel: Model<Doc<MotorcycleModel>> = model<Doc<MotorcycleModel>>(
  'MotorcycleModel',
  defineSchema<Doc<MotorcycleModel>>({
    code: { type: String, required: true, unique: true },
    name: { type: LocalizedTextSchema, required: true },
    manufacturer: { type: String, default: '' },
    engineCc: { type: Number, default: 0 },
    years: { type: String, default: '' },
  }),
);

const productSchema = defineSchema<Doc<Product>>({
  name: { type: LocalizedTextSchema, required: true },
  internalBarcode: { type: String, required: true, unique: true },
  legacyBarcode: { type: String, index: true, sparse: true, unique: true },
  sku: { type: String, required: true, index: true },
  partNumber: { type: String, default: '', index: true },
  brandId: { type: String, required: true, index: true },
  categoryId: { type: String, required: true, index: true },
  supplierId: { type: String, default: '', index: true },
  size: { type: String },
  image: { type: String },
  purchasePrice: { type: Number, default: 0 },
  lastPurchaseCost: { type: Number, default: 0 },
  prices: {
    type: new Schema({ retail1: { type: Number, default: 0 }, retail2: { type: Number, default: 0 }, wholesale: { type: Number, default: 0 } }, { _id: false }),
    required: true,
  },
  minStock: { type: Number, default: 10 },
  unit: { type: LocalizedTextSchema, required: true },
  compatibleModelIds: { type: [String], default: [], index: true },
  alternativeProductIds: { type: [String], default: [] },
  isActive: { type: Boolean, default: true, index: true },
  createdAt: { type: String, required: true },
  updatedAt: { type: String, required: true, index: true },
  deletedAt: { type: String, default: null },
});
productSchema.index({ 'name.ar': 'text', 'name.en': 'text', sku: 'text', partNumber: 'text', internalBarcode: 'text' }, { default_language: 'none' });
export const ProductModel: Model<Doc<Product>> = model<Doc<Product>>('Product', productSchema);

const stockLevelSchema = defineSchema<StockLevel & { _id: string }>({
  productId: { type: String, required: true, index: true },
  branchId: { type: String, required: true, index: true },
  warehouseId: { type: String, required: true, index: true },
  quantity: { type: Number, default: 0 },
  reserved: { type: Number, default: 0 },
  locationCode: { type: String, default: 'A' },
  shelf: { type: String, default: 'A1' },
  bin: { type: String, default: 'A1-1' },
  updatedAt: { type: String },
});
stockLevelSchema.index({ productId: 1, warehouseId: 1 }, { unique: true });
export const StockLevelModel: Model<StockLevel & { _id: string }> = model('StockLevel', stockLevelSchema);
export const stockLevelId = (productId: string, warehouseId: string) => `sl-${productId}-${warehouseId}`;

const stockMovementSchema = defineSchema<Doc<StockMovement>>({
  date: { type: String, required: true, index: true },
  productId: { type: String, required: true, index: true },
  type: { type: String, required: true, index: true },
  quantity: { type: Number, required: true },
  previousStock: { type: Number, required: true },
  newStock: { type: Number, required: true },
  userId: { type: String, required: true },
  branchId: { type: String, required: true, index: true },
  warehouseId: { type: String, required: true, index: true },
  reference: { type: String, default: '' },
  notes: { type: String },
});
stockMovementSchema.index({ productId: 1, type: 1, date: -1 });
export const StockMovementModel: Model<Doc<StockMovement>> = model<Doc<StockMovement>>('StockMovement', stockMovementSchema);

export const StockAdjustmentModel: Model<Doc<StockAdjustment>> = model<Doc<StockAdjustment>>(
  'StockAdjustment',
  defineSchema<Doc<StockAdjustment>>({
    date: { type: String, required: true, index: true },
    branchId: { type: String, required: true, index: true },
    warehouseId: { type: String, required: true },
    productId: { type: String, required: true, index: true },
    direction: { type: String, required: true },
    quantity: { type: Number, required: true },
    reason: { type: String, required: true },
    notes: { type: String, default: '' },
    userId: { type: String, required: true },
    status: { type: String, default: 'approved' },
  }),
);

export const StockCountModel: Model<Doc<StockCount>> = model<Doc<StockCount>>(
  'StockCount',
  defineSchema<Doc<StockCount>>({
    code: { type: String, required: true, unique: true },
    date: { type: String, required: true },
    branchId: { type: String, required: true, index: true },
    warehouseId: { type: String, required: true },
    userId: { type: String, required: true },
    status: { type: String, default: 'draft' },
    items: { type: Mixed, default: [] },
  }),
);

export const PriceHistoryModel: Model<Doc<PriceHistoryEntry>> = model<Doc<PriceHistoryEntry>>(
  'PriceHistory',
  defineSchema<Doc<PriceHistoryEntry>>({
    productId: { type: String, required: true, index: true },
    field: { type: String, required: true, index: true },
    oldValue: { type: Number, required: true },
    newValue: { type: Number, required: true },
    userId: { type: String, required: true, index: true },
    branchId: { type: String, default: '' },
    source: { type: String, default: 'single' },
    date: { type: String, required: true, index: true },
    reason: { type: String },
  }),
);

export const SpecialPriceModel: Model<Doc<SpecialPrice>> = model<Doc<SpecialPrice>>(
  'SpecialPrice',
  defineSchema<Doc<SpecialPrice>>({
    customerId: { type: String, required: true, index: true },
    productId: { type: String, required: true, index: true },
    price: { type: Number, required: true },
    validFrom: { type: String, required: true },
    validTo: { type: String, default: null },
  }),
);

// ---------- parties ----------
export const CustomerModel: Model<Doc<Customer>> = model<Doc<Customer>>(
  'Customer',
  defineSchema<Doc<Customer>>({
    code: { type: String, required: true, unique: true },
    name: { type: LocalizedTextSchema, required: true },
    phone: { type: String, default: '', index: true },
    whatsapp: { type: String, default: '' },
    address: { type: LocalizedTextSchema, required: true },
    type: { type: String, default: 'retail' },
    creditLimit: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    branchId: { type: String, required: true, index: true },
    isActive: { type: Boolean, default: true },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, index: true },
    notes: { type: String },
  }),
);

export const SupplierModel: Model<Doc<Supplier>> = model<Doc<Supplier>>(
  'Supplier',
  defineSchema<Doc<Supplier>>({
    code: { type: String, required: true, unique: true },
    name: { type: LocalizedTextSchema, required: true },
    contactPerson: { type: LocalizedTextSchema, required: true },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    address: { type: LocalizedTextSchema, required: true },
    balance: { type: Number, default: 0 },
    paymentTermsDays: { type: Number, default: 30 },
    isActive: { type: Boolean, default: true },
    createdAt: { type: String, required: true },
  }),
);

// ---------- sales ----------
const saleSchema = defineSchema<Doc<Sale>>({
  invoiceNumber: { type: String, required: true, unique: true },
  serverSequence: { type: Number, index: true },
  date: { type: String, required: true, index: true },
  branchId: { type: String, required: true, index: true },
  cashierId: { type: String, required: true, index: true },
  customerId: { type: String, default: null, index: true },
  registerSessionId: { type: String, default: null, index: true },
  terminalId: { type: String, default: null },
  items: { type: Mixed, default: [] },
  subtotal: { type: Number, default: 0 },
  itemDiscounts: { type: Number, default: 0 },
  invoiceDiscount: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  paid: { type: Number, default: 0 },
  remaining: { type: Number, default: 0 },
  change: { type: Number, default: 0 },
  payments: { type: Mixed, default: [] },
  type: { type: String, required: true },
  status: { type: String, required: true, index: true },
  notes: { type: String },
  dueDate: { type: String },
  qrPayload: { type: String },
  syncStatus: { type: String, default: 'synced' },
});
saleSchema.index({ branchId: 1, date: -1 });
saleSchema.index({ 'items.productId': 1, date: -1 });
export const SaleModel: Model<Doc<Sale>> = model<Doc<Sale>>('Sale', saleSchema);

export const SaleReturnModel: Model<Doc<SaleReturn>> = model<Doc<SaleReturn>>(
  'SaleReturn',
  defineSchema<Doc<SaleReturn>>({
    returnNumber: { type: String, required: true, unique: true },
    saleId: { type: String, required: true, index: true },
    invoiceNumber: { type: String, required: true },
    date: { type: String, required: true, index: true },
    branchId: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    customerId: { type: String, default: null },
    items: { type: Mixed, default: [] },
    refundAmount: { type: Number, default: 0 },
    refundMethod: { type: String, default: 'cash' },
    notes: { type: String },
  }),
);

export const CustomerDebtModel: Model<Doc<CustomerDebt>> = model<Doc<CustomerDebt>>(
  'CustomerDebt',
  defineSchema<Doc<CustomerDebt>>({
    customerId: { type: String, required: true, index: true },
    saleId: { type: String, required: true, unique: true },
    invoiceNumber: { type: String, required: true },
    invoiceDate: { type: String, required: true },
    dueDate: { type: String, required: true, index: true },
    originalAmount: { type: Number, required: true },
    paidAmount: { type: Number, default: 0 },
    remaining: { type: Number, default: 0, index: true },
    branchId: { type: String, required: true, index: true },
  }),
);

export const CustomerPaymentModel: Model<Doc<CustomerPayment>> = model<Doc<CustomerPayment>>(
  'CustomerPayment',
  defineSchema<Doc<CustomerPayment>>({
    customerId: { type: String, required: true, index: true },
    debtId: { type: String, default: null },
    saleId: { type: String, default: null },
    date: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    method: { type: String, required: true },
    reference: { type: String, default: '' },
    userId: { type: String, required: true },
    branchId: { type: String, required: true, index: true },
    notes: { type: String },
  }),
);

// ---------- purchases ----------
export const PurchaseModel: Model<Doc<Purchase>> = model<Doc<Purchase>>(
  'Purchase',
  defineSchema<Doc<Purchase>>({
    invoiceNumber: { type: String, required: true, unique: true },
    supplierInvoiceNumber: { type: String, default: '' },
    supplierId: { type: String, required: true, index: true },
    branchId: { type: String, required: true, index: true },
    warehouseId: { type: String, required: true },
    date: { type: String, required: true, index: true },
    expectedDate: { type: String, default: '' },
    items: { type: Mixed, default: [] },
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    remaining: { type: Number, default: 0 },
    status: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    notes: { type: String },
  }),
);

export const PurchaseReturnModel: Model<Doc<PurchaseReturn>> = model<Doc<PurchaseReturn>>(
  'PurchaseReturn',
  defineSchema<Doc<PurchaseReturn>>({
    returnNumber: { type: String, required: true, unique: true },
    purchaseId: { type: String, required: true, index: true },
    supplierId: { type: String, required: true, index: true },
    date: { type: String, required: true },
    items: { type: Mixed, default: [] },
    total: { type: Number, default: 0 },
    userId: { type: String, required: true },
    reason: { type: String, default: '' },
  }),
);

export const SupplierPaymentModel: Model<Doc<SupplierPayment>> = model<Doc<SupplierPayment>>(
  'SupplierPayment',
  defineSchema<Doc<SupplierPayment>>({
    supplierId: { type: String, required: true, index: true },
    purchaseId: { type: String, default: null },
    date: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    method: { type: String, required: true },
    reference: { type: String, default: '' },
    userId: { type: String, required: true },
    notes: { type: String },
  }),
);

// ---------- transfers ----------
export const TransferModel: Model<Doc<Transfer>> = model<Doc<Transfer>>(
  'Transfer',
  defineSchema<Doc<Transfer>>({
    code: { type: String, required: true, unique: true },
    sourceBranchId: { type: String, required: true, index: true },
    destinationBranchId: { type: String, required: true, index: true },
    sourceWarehouseId: { type: String, required: true },
    destinationWarehouseId: { type: String, required: true },
    items: { type: Mixed, default: [] },
    status: { type: String, required: true, index: true },
    requestedAt: { type: String, required: true, index: true },
    requestedBy: { type: String, required: true },
    approvedAt: { type: String },
    approvedBy: { type: String },
    sentAt: { type: String },
    sentBy: { type: String },
    receivedAt: { type: String },
    receivedBy: { type: String },
    completedAt: { type: String },
    notes: { type: String },
    timeline: { type: Mixed, default: [] },
  }),
);

// ---------- cash ----------
export const RegisterSessionModel: Model<Doc<RegisterSession>> = model<Doc<RegisterSession>>(
  'RegisterSession',
  defineSchema<Doc<RegisterSession>>({
    registerId: { type: String, required: true, index: true },
    branchId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    openedAt: { type: String, required: true, index: true },
    closedAt: { type: String, default: null },
    openingBalance: { type: Number, default: 0 },
    cashSales: { type: Number, default: 0 },
    cardSales: { type: Number, default: 0 },
    transferSales: { type: Number, default: 0 },
    paymentsIn: { type: Number, default: 0 },
    paymentsOut: { type: Number, default: 0 },
    expenses: { type: Number, default: 0 },
    refunds: { type: Number, default: 0 },
    expectedCash: { type: Number, default: 0 },
    actualCash: { type: Number, default: null },
    difference: { type: Number, default: null },
    status: { type: String, default: 'open', index: true },
    movements: { type: Mixed, default: [] },
    notes: { type: String },
  }),
);

export const ExpenseCategoryModel: Model<Doc<ExpenseCategory>> = model<Doc<ExpenseCategory>>('ExpenseCategory', defineSchema<Doc<ExpenseCategory>>({ name: { type: LocalizedTextSchema, required: true }, color: { type: String, default: '#2563eb' } }));

export const ExpenseModel: Model<Doc<Expense>> = model<Doc<Expense>>(
  'Expense',
  defineSchema<Doc<Expense>>({
    code: { type: String, required: true, unique: true },
    categoryId: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    branchId: { type: String, required: true, index: true },
    registerId: { type: String, default: null },
    date: { type: String, required: true, index: true },
    description: { type: LocalizedTextSchema, required: true },
    userId: { type: String, required: true },
    status: { type: String, default: 'approved' },
    receiptRef: { type: String },
  }),
);

// ---------- whatsapp ----------
export const WhatsAppTemplateModel: Model<Omit<WhatsAppTemplate, 'key'> & { _id: string }> = model(
  'WhatsAppTemplate',
  defineSchema<Omit<WhatsAppTemplate, 'key'> & { _id: string }>({
    name: { type: LocalizedTextSchema, required: true },
    body: { type: LocalizedTextSchema, required: true },
    variables: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
  }),
);

export const WhatsAppMessageModel: Model<Doc<WhatsAppMessage>> = model<Doc<WhatsAppMessage>>(
  'WhatsAppMessage',
  defineSchema<Doc<WhatsAppMessage>>({
    customerId: { type: String, required: true, index: true },
    phone: { type: String, required: true },
    templateKey: { type: String, required: true },
    body: { type: String, required: true },
    status: { type: String, default: 'queued', index: true },
    sentAt: { type: String, required: true, index: true },
    deliveredAt: { type: String },
    readAt: { type: String },
    error: { type: String },
    link: { type: String },
    userId: { type: String, required: true },
    referenceId: { type: String },
  }),
);

// ---------- audit / notifications / alerts ----------
export const AuditLogModel: Model<Doc<AuditLog>> = model<Doc<AuditLog>>(
  'AuditLog',
  defineSchema<Doc<AuditLog>>({
    userId: { type: String, required: true, index: true },
    action: { type: String, required: true, index: true },
    entity: { type: String, required: true, index: true },
    entityId: { type: String, required: true },
    branchId: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },
    before: { type: Mixed, default: null },
    after: { type: Mixed, default: null },
    ip: { type: String, default: '' },
  }),
);

export const NotificationModel: Model<Doc<AppNotification>> = model<Doc<AppNotification>>(
  'Notification',
  defineSchema<Doc<AppNotification>>({
    type: { type: String, required: true },
    title: { type: LocalizedTextSchema, required: true },
    body: { type: LocalizedTextSchema, required: true },
    date: { type: String, required: true, index: true },
    read: { type: Boolean, default: false },
    link: { type: String },
  }),
);

const alertSchema = defineSchema<Doc<Alert>>({
  type: { type: String, required: true, index: true },
  severity: { type: String, required: true, index: true },
  title: { type: LocalizedTextSchema, required: true },
  body: { type: LocalizedTextSchema, required: true },
  entity: { type: String, required: true },
  entityId: { type: String, required: true },
  branchId: { type: String, default: null, index: true },
  createdAt: { type: String, required: true, index: true },
  readBy: { type: [String], default: [] },
  resolvedAt: { type: String, default: null, index: true },
  dedupeKey: { type: String, required: true },
  link: { type: String },
});
// Only one unresolved alert per dedupeKey.
alertSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { resolvedAt: null } });
export const AlertModel: Model<Doc<Alert>> = model<Doc<Alert>>('Alert', alertSchema);

// ---------- settings / printing / labels / quick ----------
export interface SettingsDoc { _id: string; value: AppSettings }
export const SettingsModel: Model<SettingsDoc> = model<SettingsDoc>('Settings', defineSchema<SettingsDoc>({ value: { type: Mixed, required: true } }));

export const PrintProfileModel: Model<Doc<PrintProfile>> = model<Doc<PrintProfile>>(
  'PrintProfile',
  defineSchema<Doc<PrintProfile>>({
    name: { type: String, required: true },
    branchId: { type: String, default: null, index: true },
    paper: { type: String, required: true },
    detail: { type: String, required: true },
    showLogo: { type: Boolean, default: true },
    showQr: { type: Boolean, default: true },
    showCompatibility: { type: Boolean, default: false },
    showPartNumber: { type: Boolean, default: true },
    showCashier: { type: Boolean, default: true },
    showCustomerBalance: { type: Boolean, default: false },
    showStamp: { type: Boolean, default: true },
    showReviewStamp: { type: Boolean, default: false },
    copies: { type: Number, default: 1 },
    footer: { type: LocalizedTextSchema, required: true },
    printerName: { type: String },
    isDefault: { type: Boolean, default: false },
  }),
);

export const LabelTemplateModel: Model<Doc<LabelTemplate>> = model<Doc<LabelTemplate>>(
  'LabelTemplate',
  defineSchema<Doc<LabelTemplate>>({
    name: { type: String, required: true },
    widthMm: { type: Number, required: true },
    heightMm: { type: Number, required: true },
    dpi: { type: Number, default: 203 },
    elements: { type: Mixed, default: [] },
    isDefault: { type: Boolean, default: false },
    branchId: { type: String, default: null, index: true },
  }),
);

export const QuickCategoryModel: Model<Doc<QuickCategory>> = model<Doc<QuickCategory>>(
  'QuickCategory',
  defineSchema<Doc<QuickCategory>>({
    name: { type: LocalizedTextSchema, required: true },
    order: { type: Number, default: 0 },
    color: { type: String },
    branchId: { type: String, default: null, index: true },
    sourceCategoryId: { type: String, default: null },
    sourceModelId: { type: String, default: null },
  }),
);

export const QuickProductModel: Model<Doc<QuickProduct> & { updatedAt: string }> = model(
  'QuickProduct',
  defineSchema<Doc<QuickProduct> & { updatedAt: string }>({
    productId: { type: String, required: true, index: true },
    categoryId: { type: String, default: null },
    branchId: { type: String, default: null, index: true },
    order: { type: Number, default: 0 },
    color: { type: String },
    label: { type: LocalizedTextSchema },
    updatedAt: { type: String, required: true },
  }),
);

export const DeadStockSnapshotModel: Model<Doc<DeadStockSnapshot>> = model<Doc<DeadStockSnapshot>>(
  'DeadStockSnapshot',
  defineSchema<Doc<DeadStockSnapshot>>({
    date: { type: String, required: true, index: true },
    branchId: { type: String, default: null, index: true },
    idleDays: { type: Number, required: true },
    frozenCapital: { type: Number, default: 0 },
    carryingCost: { type: Number, default: 0 },
    itemCount: { type: Number, default: 0 },
  }),
);

// ---------- infra ----------
export interface CounterDoc { _id: string; seq: number }
export const CounterModel: Model<CounterDoc> = model<CounterDoc>('Counter', defineSchema<CounterDoc>({ seq: { type: Number, default: 0 } }));

export interface IdempotencyDoc { _id: string; userId: string; requestHash: string; status: number; response: unknown; state?: string; owner?: string; startedAt?: Date; createdAt: Date }
const idemSchema = defineSchema<IdempotencyDoc>({
  userId: { type: String, required: true },
  requestHash: { type: String, required: true },
  status: { type: Number, required: true },
  response: { type: Mixed },
  state: { type: String },
  owner: { type: String },
  startedAt: { type: Date },
  createdAt: { type: Date, default: () => new Date(), expires: 60 * 60 * 24 * 7 },
});
export const IdempotencyModel: Model<IdempotencyDoc> = model<IdempotencyDoc>('IdempotencyKey', idemSchema);

export interface SyncOpDoc { _id: string; terminalId: string; type: string; status: string; requestHash?: string; userId?: string; localId?: string; serverId?: string; error?: { code: string; message: string }; createdAt: Date }
export const SyncOpModel: Model<SyncOpDoc> = model<SyncOpDoc>(
  'SyncOp',
  defineSchema<SyncOpDoc>({
    terminalId: { type: String, required: true, index: true },
    type: { type: String, required: true },
    status: { type: String, required: true },
    requestHash: { type: String },
    userId: { type: String },
    localId: { type: String, index: true },
    serverId: { type: String },
    error: { type: Mixed },
    createdAt: { type: Date, default: () => new Date(), expires: 60 * 60 * 24 * 90 },
  }),
);

export interface TombstoneDoc { _id: string; coll: string; entityId: string; deletedAt: string }
export const TombstoneModel: Model<TombstoneDoc> = model<TombstoneDoc>(
  'Tombstone',
  defineSchema<TombstoneDoc>({ coll: { type: String, required: true, index: true }, entityId: { type: String, required: true }, deletedAt: { type: String, required: true, index: true } }),
);
