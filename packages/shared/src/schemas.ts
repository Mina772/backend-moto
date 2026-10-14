import { z } from 'zod';

// ---------- primitives ----------
export const IdSchema = z.string().min(1);
export const ISODateSchema = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/));
export const MoneySchema = z.coerce.number().finite();
export const LocaleSchema = z.enum(['ar', 'en']);
/** Query-string boolean: `z.coerce.boolean()` would turn "false" into true. */
export const BoolQuerySchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/** Arabic required, English optional (empty string is normalised to undefined). */
export const LocalizedTextSchema = z.object({
  ar: z.string().trim().min(1),
  en: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export const LocalizedTextLooseSchema = z.object({
  ar: z.string().trim().default(''),
  en: z.string().trim().optional().transform((v) => (v ? v : undefined)),
});

/** Catalogue names: either language alone is enough, but one of them must be present. */
export const BilingualNameSchema = LocalizedTextLooseSchema.refine((v) => Boolean(v.ar || v.en), {
  message: 'At least one name (Arabic or English) is required',
  path: ['ar'],
});

export const ListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(500).optional(),
    search: z.string().optional(),
    sortBy: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
    branchId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  })
  .passthrough();

// ---------- enums ----------
export const RoleKeySchema = z.enum(['admin', 'branch_manager', 'accountant', 'cashier', 'sales', 'warehouse']);
export const PermissionSchema = z.enum([
  'sales.view', 'sales.create', 'sales.cancel', 'sales.print',
  'discounts.item', 'discounts.invoice', 'discounts.unlimited',
  'prices.view_cost', 'prices.edit', 'prices.wholesale',
  'returns.create', 'returns.approve',
  'inventory.view', 'inventory.adjust', 'inventory.count', 'inventory.transfer', 'inventory.transfer_approve',
  'purchases.view', 'purchases.create', 'purchases.receive', 'purchases.pay',
  'customers.view', 'customers.edit', 'customers.credit',
  'suppliers.view', 'suppliers.edit',
  'reports.view', 'reports.financial',
  'expenses.view', 'expenses.create', 'expenses.approve',
  'users.view', 'users.edit', 'users.roles',
  'branches.view', 'branches.edit', 'branches.all',
  'settings.view', 'settings.edit', 'settings.quick_grid',
  'cash.open', 'cash.close', 'audit.view', 'whatsapp.send', 'whatsapp.promote',
]);
export const UserStatusSchema = z.enum(['active', 'inactive', 'suspended']);
export const PriceTierSchema = z.enum(['retail1', 'retail2', 'wholesale']);
export const SalePriceTierSchema = z.enum(['retail1', 'retail2', 'wholesale', 'special', 'manual']);
export const PaymentMethodSchema = z.enum(['cash', 'card', 'bank_transfer', 'credit']);
export const SaleTypeSchema = z.enum(['cash', 'credit']);
export const SaleStatusSchema = z.enum(['completed', 'held', 'cancelled', 'returned', 'partially_returned']);
export const CustomerTypeSchema = z.enum(['retail', 'wholesale', 'workshop']);
export const ReturnReasonSchema = z.enum(['defective', 'wrong_item', 'customer_changed_mind', 'duplicate', 'other']);
export const AdjustmentReasonSchema = z.enum(['damaged', 'expired', 'lost', 'found', 'count_correction', 'other']);
export const TransferStatusSchema = z.enum(['draft', 'requested', 'approved', 'sent', 'received', 'completed', 'rejected']);
export const CashMovementTypeSchema = z.enum(['sale', 'payment_in', 'payment_out', 'expense', 'deposit', 'withdrawal', 'refund']);
export const PaperKindSchema = z.enum(['thermal80', 'thermal58', 'a4', 'a5']);
export const PrintDetailSchema = z.enum(['detailed', 'compact']);
export const AlertTypeSchema = z.enum([
  'low_stock', 'out_of_stock', 'debt_overdue_customer', 'debt_overdue_supplier',
  'count_variance', 'large_return', 'register_variance', 'unusual_operation', 'sync_rejected', 'system',
]);
export const AlertSeveritySchema = z.enum(['info', 'warning', 'critical']);
export const LabelElementTypeSchema = z.enum(['companyName', 'logo', 'productName', 'price', 'barcode', 'customText', 'sku', 'partNumber', 'location']);

// ---------- auth ----------
export const LoginSchema = z.object({ username: z.string().trim().min(1), password: z.string().min(1) });
export const ChangePasswordSchema = z.object({ current: z.string().min(1), next: z.string().min(6) });
export const RefreshSchema = z.object({ refreshToken: z.string().min(1).optional() }).default({});

// ---------- products ----------
/** Only the base retail price is a real input; the other tiers fall back to it when left empty. */
export const ProductPricesSchema = z.object({
  retail1: MoneySchema.min(0),
  retail2: MoneySchema.min(0).optional(),
  wholesale: MoneySchema.min(0).optional(),
});

/** Where the product sits inside one warehouse (location → shelf → bin). */
export const ProductPlacementSchema = z.object({
  warehouseId: IdSchema,
  locationCode: z.string().trim().max(20).default(''),
  shelf: z.string().trim().min(1).max(20),
  bin: z.string().trim().max(20).default(''),
});

export const ProductCreateSchema = z.object({
  name: BilingualNameSchema,
  /** Generated from the barcode counter when omitted. */
  sku: z.string().trim().min(3).optional(),
  partNumber: z.string().trim().default(''),
  brandId: IdSchema,
  categoryId: IdSchema,
  supplierId: z.string().trim().default(''),
  size: z.string().trim().max(60).optional(),
  image: z.string().optional(),
  purchasePrice: MoneySchema.min(0),
  lastPurchaseCost: MoneySchema.min(0).optional(),
  prices: ProductPricesSchema,
  minStock: z.coerce.number().int().min(0).default(10),
  unit: LocalizedTextLooseSchema.default({ ar: '' }),
  compatibleModelIds: z.array(IdSchema).default([]),
  alternativeProductIds: z.array(IdSchema).default([]),
  isActive: z.boolean().default(true),
  legacyBarcode: z.string().trim().optional(),
  placement: ProductPlacementSchema.optional(),
});
export const ProductUpdateSchema = ProductCreateSchema.partial().extend({ prices: ProductPricesSchema.partial().optional(), changeReason: z.string().optional() });
export const ProductBulkUpdateSchema = z.object({ ids: z.array(IdSchema).min(1), patch: ProductUpdateSchema });
export const CompatibilitySchema = z.object({ modelId: IdSchema, compatible: z.boolean() });
export const AlternativeLinkSchema = z.object({ altId: IdSchema, link: z.boolean() });
export const CategoryCreateSchema = z.object({
  name: BilingualNameSchema,
  parentId: IdSchema.nullable().default(null),
  sortOrder: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().default(true),
});
export const CategoryUpdateSchema = z.object({
  name: BilingualNameSchema.optional(),
  parentId: IdSchema.nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});
export const CategoryReorderSchema = z.object({ parentId: IdSchema.nullable().default(null), ids: z.array(IdSchema).min(1) });
export const ProductMoveSchema = z.object({ ids: z.array(IdSchema).min(1), categoryId: IdSchema });
export const BrandCreateSchema = z.object({
  name: BilingualNameSchema,
  country: LocalizedTextLooseSchema.default({ ar: '' }),
});
export const MotorcycleModelCreateSchema = z.object({
  code: z.string().trim().min(1),
  name: BilingualNameSchema,
  manufacturer: z.string().trim().default(''),
  engineCc: z.coerce.number().int().min(0).default(0),
  years: z.string().trim().default(''),
});

// ---------- sales ----------
export const PaymentSplitSchema = z.object({ method: PaymentMethodSchema, amount: MoneySchema.min(0), reference: z.string().optional() });

export const SaleItemInputSchema = z.object({
  productId: IdSchema,
  name: LocalizedTextLooseSchema,
  barcode: z.string().default(''),
  sku: z.string().default(''),
  partNumber: z.string().optional(),
  quantity: z.coerce.number().positive(),
  /** Pre-discount reference price; defaults to unitPrice when the caller does not track one. */
  listPrice: MoneySchema.min(0).optional(),
  unitPrice: MoneySchema.min(0),
  unitCost: MoneySchema.min(0).default(0),
  priceTier: SalePriceTierSchema.default('retail1'),
  discount: MoneySchema.min(0).default(0),
  discountPercent: z.coerce.number().min(0).max(100).default(0),
});

export const SaleCreateSchema = z.object({
  branchId: IdSchema,
  cashierId: IdSchema.optional(),
  customerId: IdSchema.nullable().default(null),
  registerSessionId: IdSchema.nullable().default(null),
  terminalId: IdSchema.nullable().optional(),
  items: z.array(SaleItemInputSchema).min(1),
  invoiceDiscount: MoneySchema.min(0).default(0),
  payments: z.array(PaymentSplitSchema).default([]),
  type: SaleTypeSchema,
  status: SaleStatusSchema.optional(),
  notes: z.string().optional(),
  /** Client-generated invoice number for offline sales (PREFIX-TERMINAL-SEQ). */
  invoiceNumber: z.string().optional(),
  date: z.string().optional(),
  offline: z.boolean().optional(),
});

export const SaleReturnItemSchema = z.object({
  saleItemId: IdSchema,
  productId: IdSchema,
  quantity: z.coerce.number().positive(),
  unitPrice: MoneySchema.min(0),
  refund: MoneySchema.min(0),
  reason: ReturnReasonSchema,
});
export const SaleReturnCreateSchema = z.object({
  saleId: IdSchema,
  items: z.array(SaleReturnItemSchema).min(1),
  refundMethod: PaymentMethodSchema,
  settlement: z.literal('debt_first').optional(),
  notes: z.string().optional(),
  date: z.string().optional(),
});

// ---------- customers / suppliers ----------
export const CustomerSaveSchema = z.object({
  id: IdSchema.optional(),
  name: LocalizedTextSchema,
  phone: z.string().trim().default(''),
  whatsapp: z.string().trim().optional(),
  address: LocalizedTextLooseSchema.optional(),
  type: CustomerTypeSchema.default('retail'),
  creditLimit: MoneySchema.min(0).default(0),
  branchId: IdSchema.optional(),
  isActive: z.boolean().optional(),
  notes: z.string().optional(),
});
export const SpecialPriceCreateSchema = z.object({
  customerId: IdSchema,
  productId: IdSchema,
  price: MoneySchema.min(0),
  validFrom: z.string(),
  validTo: z.string().nullable().default(null),
});
export const CustomerPaymentCreateSchema = z.object({
  customerId: IdSchema,
  debtId: IdSchema.nullable().default(null),
  amount: MoneySchema.positive(),
  method: PaymentMethodSchema,
  reference: z.string().default(''),
  branchId: IdSchema,
  notes: z.string().optional(),
  date: z.string().optional(),
});
export const SupplierSaveSchema = z.object({
  id: IdSchema.optional(),
  name: LocalizedTextSchema,
  contactPerson: LocalizedTextLooseSchema.optional(),
  phone: z.string().trim().default(''),
  email: z.string().trim().email().or(z.literal('')).default(''),
  address: LocalizedTextLooseSchema.optional(),
  paymentTermsDays: z.coerce.number().int().min(0).default(30),
  isActive: z.boolean().optional(),
});

// ---------- inventory ----------
export const AdjustmentCreateSchema = z.object({
  branchId: IdSchema,
  warehouseId: IdSchema,
  productId: IdSchema,
  direction: z.enum(['increase', 'decrease']),
  quantity: z.coerce.number().positive(),
  reason: AdjustmentReasonSchema,
  notes: z.string().default(''),
});
export const CountCreateSchema = z.object({ branchId: IdSchema, warehouseId: IdSchema, productIds: z.array(IdSchema).min(1) });
export const CountItemUpdateSchema = z.object({ productId: IdSchema, counted: z.coerce.number().min(0).nullable() });
export const WarehouseSaveSchema = z.object({
  id: IdSchema.optional(),
  code: z.string().trim().min(1),
  name: LocalizedTextSchema,
  branchId: IdSchema,
  isActive: z.boolean().default(true),
  isMain: z.boolean().optional(),
  capacity: z.coerce.number().int().min(0).default(0),
});
export const TransferCreateSchema = z.object({
  sourceBranchId: IdSchema,
  destinationBranchId: IdSchema,
  sourceWarehouseId: IdSchema.optional(),
  items: z.array(z.object({ productId: IdSchema, requestedQty: z.coerce.number().positive() })).min(1),
  notes: z.string().optional(),
  submit: z.boolean().default(true),
});
export const TransferAdvanceSchema = z.object({
  next: TransferStatusSchema,
  note: z.string().optional(),
  quantities: z.record(z.coerce.number().min(0)).optional(),
});

// ---------- purchases ----------
export const PurchaseCreateSchema = z.object({
  supplierId: IdSchema,
  supplierInvoiceNumber: z.string().default(''),
  branchId: IdSchema,
  warehouseId: IdSchema,
  expectedDate: z.string().optional(),
  items: z.array(z.object({ productId: IdSchema, quantity: z.coerce.number().positive(), unitCost: MoneySchema.min(0) })).min(1),
  discount: MoneySchema.min(0).default(0),
  paid: MoneySchema.min(0).default(0),
  notes: z.string().optional(),
  status: z.enum(['draft', 'ordered']).default('ordered'),
});
export const PurchaseReceiveSchema = z.object({ quantities: z.record(z.coerce.number().min(0)) });
export const PurchaseReturnCreateSchema = z.object({
  purchaseId: IdSchema,
  items: z.array(z.object({ productId: IdSchema, purchaseItemId: IdSchema.optional(), quantity: z.coerce.number().finite().positive(), unitCost: MoneySchema.min(0) })).min(1),
  refundMethod: z.enum(['cash', 'card', 'bank_transfer']).optional(),
  reason: z.string().default(''),
});
export const SupplierPaymentCreateSchema = z.object({
  supplierId: IdSchema,
  purchaseId: IdSchema.nullable().default(null),
  amount: MoneySchema.positive(),
  method: PaymentMethodSchema,
  reference: z.string().default(''),
  notes: z.string().optional(),
});

// ---------- cash ----------
export const RegisterOpenSchema = z.object({ registerId: IdSchema, openingBalance: MoneySchema.min(0), terminalId: IdSchema.optional() });
export const RegisterCloseSchema = z.object({ actualCash: MoneySchema.min(0), notes: z.string().optional() });
export const CashMovementCreateSchema = z.object({
  type: CashMovementTypeSchema,
  amount: MoneySchema.positive(),
  notes: z.string().optional(),
});
export const ExpenseCreateSchema = z.object({
  categoryId: IdSchema,
  amount: MoneySchema.positive(),
  branchId: IdSchema,
  registerId: IdSchema.nullable().default(null),
  /** Falls back to the expense category name when left empty. */
  description: LocalizedTextLooseSchema.default({ ar: '' }),
  receiptRef: z.string().optional(),
});

// ---------- users / branches ----------
export const UserSaveSchema = z.object({
  id: IdSchema.optional(),
  username: z.string().trim().min(3),
  fullName: LocalizedTextSchema,
  email: z.string().trim().email().or(z.literal('')).default(''),
  phone: z.string().trim().default(''),
  role: RoleKeySchema,
  branchId: IdSchema,
  status: UserStatusSchema.optional(),
  password: z.string().min(6).optional(),
  extraPermissions: z.array(PermissionSchema).optional(),
});
export const RolePermissionsSchema = z.object({ permissions: z.array(PermissionSchema) });
export const BranchSaveSchema = z.object({
  id: IdSchema.optional(),
  code: z.string().trim().min(1),
  name: LocalizedTextSchema,
  city: LocalizedTextLooseSchema.optional(),
  address: LocalizedTextLooseSchema.optional(),
  phone: z.string().default(''),
  managerId: IdSchema.optional(),
  isActive: z.boolean().optional(),
  posTerminals: z.coerce.number().int().min(0).default(1),
});

// ---------- settings ----------
export const SettingsSectionSchema = z.enum(['company', 'currency', 'invoice', 'receipt', 'barcode', 'pos', 'pricing', 'reports', 'notifications', 'alerts']);
export const SettingsUpdateSchema = z.object({ value: z.record(z.unknown()) });

const LocalizedTextRequiredSchema = z.object({ ar: z.string(), en: z.string().optional() });
export const CompanySettingsSchema = z.object({
  name: LocalizedTextRequiredSchema,
  taxNumber: z.string(),
  commercialRegister: z.string(),
  phone: z.string(),
  email: z.string(),
  address: LocalizedTextRequiredSchema,
  logoUrl: z.string().optional(),
  vatRegistered: z.boolean(),
  invoiceLegalText: LocalizedTextRequiredSchema,
});
export const CurrencySettingsSchema = z.object({
  code: z.string().min(1),
  symbol: LocalizedTextRequiredSchema,
  decimals: z.number().int().min(0).max(4),
  symbolPosition: z.enum(['before', 'after']),
});
export const InvoiceSettingsSchema = z.object({
  prefix: z.string(),
  nextNumber: z.number().int().min(1),
  footerText: LocalizedTextRequiredSchema,
  showLogo: z.boolean(),
  showTax: z.boolean(),
  taxRate: z.number().min(0).max(100),
  allowNegativeStock: z.boolean(),
});
export const ReceiptSettingsSchema = z.object({
  paperWidth: z.union([z.literal(58), z.literal(80)]),
  showBarcode: z.boolean(),
  showCashier: z.boolean(),
  showCustomerBalance: z.boolean(),
  copies: z.number().int().min(1).max(5),
  headerLines: z.array(z.string()),
  subtitle: LocalizedTextLooseSchema.default({ ar: '' }),
  tagline: LocalizedTextLooseSchema.default({ ar: '' }),
  slogan: LocalizedTextLooseSchema.default({ ar: '' }),
  warrantyNotes: z.array(LocalizedTextLooseSchema).default([]),
  brandLogos: z.array(z.object({ name: z.string().trim().min(1), color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/) })).default([]),
});
export const BarcodeSettingsSchema = z.object({
  internalPrefix: z.string(),
  length: z.number().int().min(4).max(13),
  labelWidth: z.number().positive(),
  labelHeight: z.number().positive(),
  showPrice: z.boolean(),
  showName: z.boolean(),
});
export const PosSettingsSchema = z.object({
  defaultPaymentMethod: PaymentMethodSchema,
  autoPrint: z.boolean(),
  requireCustomerForCredit: z.boolean(),
  maxDiscountPercent: z.number().min(0).max(100),
  soundOnScan: z.boolean(),
  openDrawerOnSale: z.boolean(),
  defaultPriceTier: PriceTierSchema,
  gridColumns: z.number().int().min(1).max(12),
  gridPageSize: z.number().int().min(1).max(200),
  showTierChooserOnScan: z.boolean(),
  idleLockMinutes: z.coerce.number().int().min(0).max(240).default(10),
});
export const PricingSettingsSchema = z.object({
  tierLabels: z.object({ retail1: LocalizedTextRequiredSchema, retail2: LocalizedTextRequiredSchema, wholesale: LocalizedTextRequiredSchema }),
});
export const ReportSettingsSchema = z.object({ annualCarryingRate: z.number().min(0).max(1), deadStockDefaultIdleDays: z.number().int().min(1) });
export const NotificationSettingsSchema = z.object({ lowStock: z.boolean(), overdueDebts: z.boolean(), transfers: z.boolean(), registerClose: z.boolean(), dailySummary: z.boolean() });
export const AlertSettingsSchema = z.object({
  enabled: z.record(AlertTypeSchema, z.boolean()),
  countVarianceThresholdPct: z.number().min(0).max(100),
  largeReturnAmount: z.number().min(0),
  maxReturnsPerCashierPerDay: z.number().int().min(0),
  registerVarianceAmount: z.number().min(0),
  unusualDiscountPercent: z.number().min(0).max(100).default(25),
  maxVoidsPerCashierPerDay: z.number().int().min(0).default(3),
  whatsappManagerPhone: z.string(),
  whatsappOnCritical: z.boolean(),
  roleRouting: z.record(AlertTypeSchema, z.array(RoleKeySchema)),
});
export const SETTINGS_SECTION_SCHEMAS = {
  company: CompanySettingsSchema,
  currency: CurrencySettingsSchema,
  invoice: InvoiceSettingsSchema,
  receipt: ReceiptSettingsSchema,
  barcode: BarcodeSettingsSchema,
  pos: PosSettingsSchema,
  pricing: PricingSettingsSchema,
  reports: ReportSettingsSchema,
  notifications: NotificationSettingsSchema,
  alerts: AlertSettingsSchema,
} as const;

// ---------- print profiles ----------
export const PrintProfileSaveSchema = z.object({
  id: IdSchema.optional(),
  name: z.string().trim().min(1),
  branchId: IdSchema.nullable().default(null),
  paper: PaperKindSchema,
  detail: PrintDetailSchema,
  showLogo: z.boolean().default(true),
  showQr: z.boolean().default(true),
  showCompatibility: z.boolean().default(false),
  showPartNumber: z.boolean().default(true),
  showCashier: z.boolean().default(true),
  showCustomerBalance: z.boolean().default(false),
  showStamp: z.boolean().default(true),
  showReviewStamp: z.boolean().default(false),
  copies: z.coerce.number().int().min(1).max(5).default(1),
  footer: LocalizedTextLooseSchema.default({ ar: '' }),
  printerName: z.string().optional(),
  isDefault: z.boolean().default(false),
});

// ---------- labels ----------
export const LabelElementSchema = z.object({
  id: IdSchema,
  type: LabelElementTypeSchema,
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  fontSize: z.number().positive(),
  fontWeight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)]),
  align: z.enum(['start', 'center', 'end']),
  text: z.string().optional(),
  priceTier: PriceTierSchema.optional(),
  visible: z.boolean(),
});
export const LabelTemplateSaveSchema = z.object({
  id: IdSchema.optional(),
  name: z.string().trim().min(1),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  dpi: z.number().int().min(72).max(600).default(203),
  elements: z.array(LabelElementSchema),
  isDefault: z.boolean().default(false),
  branchId: IdSchema.nullable().default(null),
});

// ---------- quick products ----------
export const QuickCategorySaveSchema = z.object({
  id: IdSchema.optional(),
  name: LocalizedTextSchema,
  order: z.coerce.number().int().min(0).default(0),
  color: z.string().optional(),
  branchId: IdSchema.nullable().default(null),
  sourceCategoryId: IdSchema.nullable().default(null),
  sourceModelId: IdSchema.nullable().default(null),
});
export const QuickCategoryFillSchema = z.object({ limit: z.coerce.number().int().min(1).max(60).default(24), replace: z.boolean().default(false) });
export const QuickProductSaveSchema = z.object({
  id: IdSchema.optional(),
  productId: IdSchema,
  categoryId: IdSchema.nullable().default(null),
  branchId: IdSchema.nullable().default(null),
  order: z.coerce.number().int().min(0).default(0),
  color: z.string().optional(),
  label: LocalizedTextLooseSchema.optional(),
});
export const ReorderSchema = z.object({ ids: z.array(IdSchema).min(1) });

// ---------- alerts ----------
export const AlertQuerySchema = ListQuerySchema.extend({
  unread: BoolQuerySchema.optional(),
  severity: AlertSeveritySchema.optional(),
  type: AlertTypeSchema.optional(),
  resolved: BoolQuerySchema.optional(),
});

// ---------- whatsapp ----------
export const WhatsAppSendSchema = z.object({
  customerId: IdSchema,
  phone: z.string().trim().min(5),
  templateKey: z.enum(['invoice', 'statement', 'debt_reminder', 'payment_confirmation', 'promotion']),
  body: z.string().min(1),
  referenceId: IdSchema.optional(),
});
export const WhatsAppTemplateUpdateSchema = z.object({ name: LocalizedTextSchema.optional(), body: LocalizedTextSchema.optional(), isActive: z.boolean().optional() });

// ---------- sync ----------
export const SyncOpTypeSchema = z.enum(['sale', 'sale_return', 'customer_payment', 'register_open', 'register_close', 'cash_movement', 'customer_create']);
export const SyncOpSchema = z.object({
  opId: z.string().uuid(),
  type: SyncOpTypeSchema,
  clientCreatedAt: z.string(),
  payload: z.unknown(),
});
export const SyncPushSchema = z.object({ terminalId: IdSchema, ops: z.array(SyncOpSchema).min(1).max(200) });
export const SyncPullQuerySchema = z.object({ since: z.string().optional(), branchId: IdSchema });
export const TerminalRegisterSchema = z.object({
  name: z.string().trim().min(1),
  branchId: IdSchema,
  registerId: IdSchema.nullable().default(null),
  appVersion: z.string().optional(),
});

// ---------- reports ----------
export const RangeQuerySchema = z.object({ from: z.string(), to: z.string(), branchId: IdSchema.optional() }).passthrough();
export const DeadStockQuerySchema = z.object({
  branchId: IdSchema.optional(),
  warehouseId: IdSchema.optional(),
  idleDays: z.coerce.number().int().min(1).max(3650).default(90),
  categoryId: IdSchema.optional(),
  minValue: z.coerce.number().min(0).optional(),
});
export const AlternativesQuerySchema = z.object({ branchId: IdSchema, inStockOnly: BoolQuerySchema.default(true) });

export type LoginInput = z.infer<typeof LoginSchema>;
export type CategoryUpdateInput = z.infer<typeof CategoryUpdateSchema>;
export type ProductCreateInput = z.infer<typeof ProductCreateSchema>;
export type ProductUpdateInput = z.infer<typeof ProductUpdateSchema>;
export type ProductPlacementInput = z.infer<typeof ProductPlacementSchema>;
export type CategoryCreateInput = z.infer<typeof CategoryCreateSchema>;
export type BrandCreateInput = z.infer<typeof BrandCreateSchema>;
export type SaleCreateInput = z.infer<typeof SaleCreateSchema>;
export type SaleItemInput = z.infer<typeof SaleItemInputSchema>;
export type SaleReturnCreateInput = z.infer<typeof SaleReturnCreateSchema>;
export type CustomerSaveInput = z.infer<typeof CustomerSaveSchema>;
export type CustomerPaymentCreateInput = z.infer<typeof CustomerPaymentCreateSchema>;
export type SupplierSaveInput = z.infer<typeof SupplierSaveSchema>;
export type AdjustmentCreateInput = z.infer<typeof AdjustmentCreateSchema>;
export type TransferCreateInput = z.infer<typeof TransferCreateSchema>;
export type PurchaseCreateInput = z.infer<typeof PurchaseCreateSchema>;
export type SupplierPaymentCreateInput = z.infer<typeof SupplierPaymentCreateSchema>;
export type PurchaseReturnCreateInput = z.infer<typeof PurchaseReturnCreateSchema>;
export type ExpenseCreateInput = z.infer<typeof ExpenseCreateSchema>;
export type UserSaveInput = z.infer<typeof UserSaveSchema>;
export type BranchSaveInput = z.infer<typeof BranchSaveSchema>;
export type WarehouseSaveInput = z.infer<typeof WarehouseSaveSchema>;
export type PrintProfileSaveInput = z.infer<typeof PrintProfileSaveSchema>;
export type LabelTemplateSaveInput = z.infer<typeof LabelTemplateSaveSchema>;
export type QuickProductSaveInput = z.infer<typeof QuickProductSaveSchema>;
export type QuickCategorySaveInput = z.infer<typeof QuickCategorySaveSchema>;
export type QuickCategoryFillInput = z.infer<typeof QuickCategoryFillSchema>;
export type SyncPushInput = z.infer<typeof SyncPushSchema>;
export type TerminalRegisterInput = z.infer<typeof TerminalRegisterSchema>;
export type DeadStockQuery = z.infer<typeof DeadStockQuerySchema>;
export type WhatsAppSendInput = z.infer<typeof WhatsAppSendSchema>;
