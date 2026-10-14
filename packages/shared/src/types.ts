// ---------- Shared primitives ----------
export type ID = string;
export type ISODate = string;
export type Locale = 'ar' | 'en';
export type Money = number;

/** Arabic is mandatory; English is optional and falls back to Arabic in the UI. */
export interface LocalizedText {
  ar: string;
  en?: string;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  branchId?: ID;
  from?: ISODate;
  to?: ISODate;
  [key: string]: unknown;
}

// ---------- Auth / Users / Permissions ----------
export type RoleKey = 'admin' | 'branch_manager' | 'accountant' | 'cashier' | 'sales' | 'warehouse';

export type PermissionCategory =
  | 'sales'
  | 'discounts'
  | 'prices'
  | 'returns'
  | 'inventory'
  | 'purchases'
  | 'customers'
  | 'suppliers'
  | 'reports'
  | 'expenses'
  | 'users'
  | 'branches'
  | 'settings';

export type Permission =
  | 'sales.view'
  | 'sales.create'
  | 'sales.cancel'
  | 'sales.print'
  | 'discounts.item'
  | 'discounts.invoice'
  | 'discounts.unlimited'
  | 'prices.view_cost'
  | 'prices.edit'
  | 'prices.wholesale'
  | 'returns.create'
  | 'returns.approve'
  | 'inventory.view'
  | 'inventory.adjust'
  | 'inventory.count'
  | 'inventory.transfer'
  | 'inventory.transfer_approve'
  | 'purchases.view'
  | 'purchases.create'
  | 'purchases.receive'
  | 'purchases.pay'
  | 'customers.view'
  | 'customers.edit'
  | 'customers.credit'
  | 'suppliers.view'
  | 'suppliers.edit'
  | 'reports.view'
  | 'reports.financial'
  | 'expenses.view'
  | 'expenses.create'
  | 'expenses.approve'
  | 'users.view'
  | 'users.edit'
  | 'users.roles'
  | 'branches.view'
  | 'branches.edit'
  | 'branches.all'
  | 'settings.view'
  | 'settings.edit'
  | 'settings.quick_grid'
  | 'cash.open'
  | 'cash.close'
  | 'audit.view'
  | 'whatsapp.send'
  /** Marketing messages are gated separately from transactional ones. */
  | 'whatsapp.promote';

export interface Role {
  key: RoleKey;
  name: LocalizedText;
  description: LocalizedText;
  permissions: Permission[];
  usersCount: number;
  isSystem: boolean;
}

export type UserStatus = 'active' | 'inactive' | 'suspended';

export interface User {
  id: ID;
  username: string;
  fullName: LocalizedText;
  email: string;
  phone: string;
  role: RoleKey;
  branchId: ID;
  status: UserStatus;
  avatarColor: string;
  lastLogin: ISODate | null;
  createdAt: ISODate;
  extraPermissions?: Permission[];
}

export interface Session {
  user: User;
  permissions: Permission[];
  token: string;
  refreshToken?: string;
  expiresAt: ISODate;
}

// ---------- Branches / Warehouses ----------
export interface Branch {
  id: ID;
  code: string;
  name: LocalizedText;
  city: LocalizedText;
  address: LocalizedText;
  phone: string;
  managerId: ID;
  isActive: boolean;
  posTerminals: number;
  openedAt: ISODate;
}

export interface WarehouseBin {
  id: ID;
  code: string;
  shelfId: ID;
}
export interface WarehouseShelf {
  id: ID;
  code: string;
  locationId: ID;
  bins: WarehouseBin[];
}
export interface WarehouseLocation {
  id: ID;
  code: string;
  name: LocalizedText;
  shelves: WarehouseShelf[];
}

export interface Warehouse {
  id: ID;
  code: string;
  name: LocalizedText;
  branchId: ID;
  isActive: boolean;
  isMain: boolean;
  locations: WarehouseLocation[];
  capacity: number;
}

// ---------- Catalog ----------
export interface Brand {
  id: ID;
  name: LocalizedText;
  country: LocalizedText;
}
export interface Category {
  id: ID;
  name: LocalizedText;
  parentId: ID | null;
  /** Ancestor ids ordered root → direct parent; empty for a root department. */
  ancestors: ID[];
  sortOrder: number;
  isActive: boolean;
}

export interface CategoryNode extends Category {
  depth: number;
  /** Products filed directly on this node. */
  productCount: number;
  /** Products on this node and every descendant. */
  totalProductCount: number;
  children: CategoryNode[];
}
export interface MotorcycleModel {
  id: ID;
  code: string;
  name: LocalizedText;
  manufacturer: string;
  engineCc: number;
  years: string;
}

export type PriceTier = 'retail1' | 'retail2' | 'wholesale';
export type SalePriceTier = PriceTier | 'special' | 'manual';

export interface ProductPrices {
  retail1: Money;
  retail2: Money;
  wholesale: Money;
}

export interface Product {
  id: ID;
  name: LocalizedText;
  /** System-generated, unique; the only barcode used operationally. */
  internalBarcode: string;
  /** Manufacturer barcode kept read-only for migration lookups. */
  legacyBarcode?: string;
  sku: string;
  partNumber: string;
  brandId: ID;
  categoryId: ID;
  supplierId: ID;
  /** Free-form size/spec, e.g. "90/90-17", "1L", "M". */
  size?: string;
  image?: string;
  purchasePrice: Money;
  lastPurchaseCost: Money;
  prices: ProductPrices;
  minStock: number;
  unit: LocalizedText;
  compatibleModelIds: ID[];
  alternativeProductIds: ID[];
  isActive: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
  deletedAt?: ISODate | null;
}

export interface StockLevel {
  productId: ID;
  branchId: ID;
  warehouseId: ID;
  quantity: number;
  reserved: number;
  locationCode: string;
  shelf: string;
  bin: string;
  updatedAt?: ISODate;
}

export type StockMovementType =
  | 'sale'
  | 'sale_return'
  | 'purchase'
  | 'purchase_return'
  | 'transfer_in'
  | 'transfer_out'
  | 'adjustment_in'
  | 'adjustment_out'
  | 'damaged'
  | 'count';

export interface StockMovement {
  id: ID;
  date: ISODate;
  productId: ID;
  type: StockMovementType;
  quantity: number;
  previousStock: number;
  newStock: number;
  userId: ID;
  branchId: ID;
  warehouseId: ID;
  reference: string;
  notes?: string;
}

export type AdjustmentReason = 'damaged' | 'expired' | 'lost' | 'found' | 'count_correction' | 'other';

export interface StockAdjustment {
  id: ID;
  date: ISODate;
  branchId: ID;
  warehouseId: ID;
  productId: ID;
  direction: 'increase' | 'decrease';
  quantity: number;
  reason: AdjustmentReason;
  notes: string;
  userId: ID;
  status: 'pending' | 'approved' | 'rejected';
}

export interface StockCountItem {
  productId: ID;
  expected: number;
  counted: number | null;
}
export interface StockCount {
  id: ID;
  code: string;
  date: ISODate;
  branchId: ID;
  warehouseId: ID;
  userId: ID;
  status: 'draft' | 'in_progress' | 'completed';
  items: StockCountItem[];
}

export type PriceField = PriceTier | 'purchasePrice';

export interface PriceHistoryEntry {
  id: ID;
  productId: ID;
  field: PriceField;
  oldValue: Money;
  newValue: Money;
  userId: ID;
  branchId: ID;
  /** How the change was made, for auditing bulk/import runs. */
  source: 'single' | 'bulk' | 'import' | 'purchase';
  date: ISODate;
  reason?: string;
}

export interface SpecialPrice {
  id: ID;
  customerId: ID;
  productId: ID;
  price: Money;
  validFrom: ISODate;
  validTo: ISODate | null;
}

// ---------- Customers / Suppliers ----------
export type CustomerType = 'retail' | 'wholesale' | 'workshop';

export interface Customer {
  /** Contact-only cross-branch projection; credit and account payments are unavailable. */
  financialRestricted?: boolean;
  id: ID;
  code: string;
  name: LocalizedText;
  phone: string;
  whatsapp: string;
  address: LocalizedText;
  type: CustomerType;
  creditLimit: Money;
  balance: Money;
  branchId: ID;
  isActive: boolean;
  createdAt: ISODate;
  updatedAt?: ISODate;
  notes?: string;
}

export interface Supplier {
  id: ID;
  code: string;
  name: LocalizedText;
  contactPerson: LocalizedText;
  phone: string;
  email: string;
  address: LocalizedText;
  balance: Money;
  paymentTermsDays: number;
  isActive: boolean;
  createdAt: ISODate;
}

// ---------- Sales ----------
export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'credit';
export type SaleStatus = 'completed' | 'held' | 'cancelled' | 'returned' | 'partially_returned';
export type SaleType = 'cash' | 'credit';

export interface SaleItem {
  id: ID;
  productId: ID;
  name: LocalizedText;
  barcode: string;
  sku: string;
  partNumber?: string;
  quantity: number;
  /** Tier price before item discount. */
  listPrice: Money;
  unitPrice: Money;
  unitCost: Money;
  priceTier: SalePriceTier;
  discount: Money;
  discountPercent: number;
  subtotal: Money;
  returnedQty: number;
}

export interface PaymentSplit {
  method: PaymentMethod;
  amount: Money;
  reference?: string;
}

export type SyncState = 'synced' | 'pending' | 'failed';

export interface Sale {
  id: ID;
  invoiceNumber: string;
  /** Server-assigned monotonic sequence used for ordering offline-created invoices. */
  serverSequence?: number;
  date: ISODate;
  branchId: ID;
  cashierId: ID;
  customerId: ID | null;
  registerSessionId: ID | null;
  terminalId?: ID | null;
  items: SaleItem[];
  subtotal: Money;
  itemDiscounts: Money;
  invoiceDiscount: Money;
  tax: Money;
  total: Money;
  paid: Money;
  remaining: Money;
  change: Money;
  payments: PaymentSplit[];
  type: SaleType;
  status: SaleStatus;
  notes?: string;
  dueDate?: ISODate;
  qrPayload?: string;
  syncStatus?: SyncState;
}

export type ReturnReason = 'defective' | 'wrong_item' | 'customer_changed_mind' | 'duplicate' | 'other';

export interface SaleReturnItem {
  saleItemId: ID;
  productId: ID;
  quantity: number;
  unitPrice: Money;
  refund: Money;
  reason: ReturnReason;
}

export interface SaleReturn {
  id: ID;
  returnNumber: string;
  saleId: ID;
  invoiceNumber: string;
  date: ISODate;
  branchId: ID;
  userId: ID;
  customerId: ID | null;
  items: SaleReturnItem[];
  refundAmount: Money;
  refundMethod: PaymentMethod;
  /** Explicit debt-first settlement; absent on legacy return records. */
  debtReduction?: Money;
  payoutAmount?: Money;
  reversal?: 'cancellation';
  notes?: string;
}

// ---------- Purchases ----------
export type PurchaseStatus = 'draft' | 'ordered' | 'partially_received' | 'received' | 'cancelled';

export interface PurchaseItem {
  id: ID;
  productId: ID;
  quantity: number;
  receivedQty: number;
  unitCost: Money;
  subtotal: Money;
}

export interface Purchase {
  id: ID;
  invoiceNumber: string;
  supplierInvoiceNumber: string;
  supplierId: ID;
  branchId: ID;
  warehouseId: ID;
  date: ISODate;
  expectedDate: ISODate;
  items: PurchaseItem[];
  subtotal: Money;
  discount: Money;
  total: Money;
  paid: Money;
  remaining: Money;
  status: PurchaseStatus;
  userId: ID;
  notes?: string;
}

export interface PurchaseReturn {
  id: ID;
  returnNumber: string;
  purchaseId: ID;
  supplierId: ID;
  date: ISODate;
  items: { productId: ID; purchaseItemId?: ID; quantity: number; unitCost: Money }[];
  total: Money;
  userId: ID;
  reason: string;
  debtReduction?: Money;
  payoutAmount?: Money;
  refundMethod?: Exclude<PaymentMethod, 'credit'>;
  reversal?: 'cancellation';
}

export interface SupplierPayment {
  id: ID;
  supplierId: ID;
  purchaseId: ID | null;
  date: ISODate;
  amount: Money;
  method: PaymentMethod;
  reference: string;
  userId: ID;
  notes?: string;
}

export interface SupplierReimbursement {
  id: ID; returnId: ID; purchaseId: ID; supplierId: ID; branchId: ID; amount: Money;
  method: Exclude<PaymentMethod, 'credit'>; status: 'pending' | 'received'; createdAt: ISODate;
  userId: ID; receivedAt?: ISODate; receivedBy?: ID; reference?: string; registerSessionId?: ID;
}

// ---------- Transfers ----------
export type TransferStatus = 'draft' | 'requested' | 'approved' | 'sent' | 'received' | 'completed' | 'rejected';

export interface TransferItem {
  productId: ID;
  requestedQty: number;
  sentQty: number;
  receivedQty: number;
}

export interface Transfer {
  id: ID;
  code: string;
  sourceBranchId: ID;
  destinationBranchId: ID;
  sourceWarehouseId: ID;
  destinationWarehouseId: ID;
  items: TransferItem[];
  status: TransferStatus;
  requestedAt: ISODate;
  requestedBy: ID;
  approvedAt?: ISODate;
  approvedBy?: ID;
  sentAt?: ISODate;
  sentBy?: ID;
  receivedAt?: ISODate;
  receivedBy?: ID;
  completedAt?: ISODate;
  notes?: string;
  timeline: { status: TransferStatus; at: ISODate; by: ID; note?: string }[];
}

// ---------- Debts / Payments ----------
export type DebtStatus = 'open' | 'partial' | 'paid' | 'overdue';

export interface CustomerDebt {
  id: ID;
  customerId: ID;
  saleId: ID;
  invoiceNumber: string;
  invoiceDate: ISODate;
  dueDate: ISODate;
  originalAmount: Money;
  paidAmount: Money;
  remaining: Money;
  branchId: ID;
}

export interface CustomerPayment {
  id: ID;
  customerId: ID;
  debtId: ID | null;
  saleId: ID | null;
  date: ISODate;
  amount: Money;
  method: PaymentMethod;
  reference: string;
  userId: ID;
  branchId: ID;
  notes?: string;
}

export interface StatementLine {
  date: ISODate;
  type: 'invoice' | 'payment' | 'return' | 'opening';
  reference: string;
  debit: Money;
  credit: Money;
  balance: Money;
}

// ---------- Cash Registers ----------
export type RegisterSessionStatus = 'open' | 'closed';
export type CashMovementType = 'sale' | 'payment_in' | 'payment_out' | 'expense' | 'deposit' | 'withdrawal' | 'refund';

export interface CashRegister {
  id: ID;
  code: string;
  name: LocalizedText;
  branchId: ID;
  isActive: boolean;
  currentSessionId: ID | null;
}

export interface CashMovement {
  id: ID;
  sessionId: ID;
  type: CashMovementType;
  amount: Money;
  method: PaymentMethod;
  date: ISODate;
  reference: string;
  userId: ID;
  notes?: string;
}

export interface RegisterSession {
  id: ID;
  registerId: ID;
  branchId: ID;
  userId: ID;
  openedAt: ISODate;
  closedAt: ISODate | null;
  openingBalance: Money;
  cashSales: Money;
  cardSales: Money;
  transferSales: Money;
  paymentsIn: Money;
  paymentsOut: Money;
  expenses: Money;
  refunds: Money;
  expectedCash: Money;
  actualCash: Money | null;
  difference: Money | null;
  status: RegisterSessionStatus;
  movements: CashMovement[];
  notes?: string;
}

// ---------- Expenses ----------
export interface ExpenseCategory {
  id: ID;
  name: LocalizedText;
  color: string;
}

export interface Expense {
  id: ID;
  code: string;
  categoryId: ID;
  amount: Money;
  branchId: ID;
  registerId: ID | null;
  date: ISODate;
  description: LocalizedText;
  userId: ID;
  status: 'pending' | 'approved' | 'rejected';
  receiptRef?: string;
}

// ---------- WhatsApp ----------
export type WhatsAppTemplateKey = 'invoice' | 'statement' | 'debt_reminder' | 'payment_confirmation' | 'promotion';
export type MessageStatus = 'prepared' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

export interface WhatsAppTemplate {
  key: WhatsAppTemplateKey;
  name: LocalizedText;
  body: LocalizedText;
  variables: string[];
  isActive: boolean;
}

export interface WhatsAppMessage {
  id: ID;
  customerId: ID;
  phone: string;
  templateKey: WhatsAppTemplateKey;
  body: string;
  status: MessageStatus;
  sentAt: ISODate;
  deliveredAt?: ISODate;
  readAt?: ISODate;
  error?: string;
  /** `wa.me` URL to open in WhatsApp Web (deep-link mode only). */
  link?: string;
  userId: ID;
  referenceId?: ID;
}

// ---------- Audit ----------
export type AuditAction =
  | 'login'
  | 'logout'
  | 'price_change'
  | 'invoice_cancel'
  | 'sale_return'
  | 'purchase_return'
  | 'stock_adjustment'
  | 'purchase_create'
  | 'payment'
  | 'user_create'
  | 'user_update'
  | 'permission_change'
  | 'transfer_approve'
  | 'register_close'
  | 'settings_change'
  | 'barcode_regenerate'
  | 'terminal_register'
  | 'product_create'
  | 'product_update'
  | 'product_delete'
  | 'category_change'
  | 'sale_create'
  | 'transfer_create'
  | 'customer_update'
  | 'supplier_update'
  | 'whatsapp_send';

export interface AuditLog {
  id: ID;
  userId: ID;
  action: AuditAction;
  entity: string;
  entityId: ID;
  branchId: ID;
  date: ISODate;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string;
}

// ---------- Notifications / Alerts ----------
export type NotificationType = 'low_stock' | 'debt_overdue' | 'transfer' | 'register' | 'system';

export interface AppNotification {
  id: ID;
  type: NotificationType;
  title: LocalizedText;
  body: LocalizedText;
  date: ISODate;
  read: boolean;
  link?: string;
}

export type AlertType =
  | 'unusual_operation'
  | 'low_stock'
  | 'out_of_stock'
  | 'debt_overdue_customer'
  | 'debt_overdue_supplier'
  | 'count_variance'
  | 'large_return'
  | 'register_variance'
  | 'sync_rejected'
  | 'system';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: ID;
  type: AlertType;
  severity: AlertSeverity;
  title: LocalizedText;
  body: LocalizedText;
  entity: string;
  entityId: ID;
  branchId: ID | null;
  createdAt: ISODate;
  readBy: ID[];
  resolvedAt?: ISODate | null;
  dedupeKey: string;
  link?: string;
}

// ---------- Settings ----------
export interface CompanySettings {
  name: LocalizedText;
  taxNumber: string;
  commercialRegister: string;
  phone: string;
  email: string;
  address: LocalizedText;
  logoUrl?: string;
  vatRegistered: boolean;
  invoiceLegalText: LocalizedText;
}

export interface CurrencySettings {
  code: string;
  symbol: LocalizedText;
  decimals: number;
  symbolPosition: 'before' | 'after';
}

export interface InvoiceSettings {
  prefix: string;
  nextNumber: number;
  footerText: LocalizedText;
  showLogo: boolean;
  showTax: boolean;
  taxRate: number;
  allowNegativeStock: boolean;
}

export interface ReceiptSettings {
  paperWidth: 58 | 80;
  showBarcode: boolean;
  showCashier: boolean;
  showCustomerBalance: boolean;
  copies: number;
  headerLines: string[];
  /** Branding printed on every invoice and receipt. */
  subtitle: LocalizedText;
  tagline: LocalizedText;
  slogan: LocalizedText;
  warrantyNotes: LocalizedText[];
  brandLogos: { name: string; color: string }[];
}

export interface BarcodeSettings {
  internalPrefix: string;
  length: number;
  labelWidth: number;
  labelHeight: number;
  showPrice: boolean;
  showName: boolean;
}

export interface PosSettings {
  defaultPaymentMethod: PaymentMethod;
  autoPrint: boolean;
  requireCustomerForCredit: boolean;
  maxDiscountPercent: number;
  soundOnScan: boolean;
  openDrawerOnSale: boolean;
  defaultPriceTier: PriceTier;
  gridColumns: number;
  gridPageSize: number;
  showTierChooserOnScan: boolean;
  /** Minutes of inactivity before the terminal locks itself; 0 disables the lock. */
  idleLockMinutes: number;
}

export interface PricingSettings {
  tierLabels: Record<PriceTier, LocalizedText>;
}

export interface ReportSettings {
  /** Annual carrying-cost rate as a fraction (0.2 = 20%). */
  annualCarryingRate: number;
  deadStockDefaultIdleDays: number;
}

export interface NotificationSettings {
  lowStock: boolean;
  overdueDebts: boolean;
  transfers: boolean;
  registerClose: boolean;
  dailySummary: boolean;
}

export interface AlertSettings {
  enabled: Record<AlertType, boolean>;
  countVarianceThresholdPct: number;
  largeReturnAmount: number;
  maxReturnsPerCashierPerDay: number;
  registerVarianceAmount: number;
  /** Invoice-level discount above this percentage is flagged for review. */
  unusualDiscountPercent: number;
  maxVoidsPerCashierPerDay: number;
  whatsappManagerPhone: string;
  whatsappOnCritical: boolean;
  roleRouting: Partial<Record<AlertType, RoleKey[]>>;
}

export interface AppSettings {
  company: CompanySettings;
  currency: CurrencySettings;
  invoice: InvoiceSettings;
  receipt: ReceiptSettings;
  barcode: BarcodeSettings;
  pos: PosSettings;
  pricing: PricingSettings;
  reports: ReportSettings;
  notifications: NotificationSettings;
  alerts: AlertSettings;
}

// ---------- Printing ----------
export type PaperKind = 'thermal80' | 'thermal58' | 'a4' | 'a5';
export type PrintDetail = 'detailed' | 'compact';

export interface PrintProfile {
  id: ID;
  name: string;
  branchId: ID | null;
  paper: PaperKind;
  detail: PrintDetail;
  showLogo: boolean;
  showQr: boolean;
  showCompatibility: boolean;
  showPartNumber: boolean;
  showCashier: boolean;
  showCustomerBalance: boolean;
  /** Round company stamp next to the signature boxes. */
  showStamp: boolean;
  /** "Reviewed" mark inside the reviewer signature box. */
  showReviewStamp: boolean;
  copies: number;
  footer: LocalizedText;
  printerName?: string;
  isDefault: boolean;
}

export interface PrintOutcome {
  status: 'printed' | 'saved' | 'cancelled';
}

// ---------- Barcode labels ----------
export type LabelElementType = 'companyName' | 'logo' | 'productName' | 'price' | 'barcode' | 'customText' | 'sku' | 'partNumber' | 'location';

export interface LabelElement {
  id: ID;
  type: LabelElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  fontWeight: 400 | 500 | 600 | 700;
  align: 'start' | 'center' | 'end';
  text?: string;
  priceTier?: PriceTier;
  visible: boolean;
}

export interface LabelTemplate {
  id: ID;
  name: string;
  widthMm: number;
  heightMm: number;
  dpi: number;
  elements: LabelElement[];
  isDefault: boolean;
  branchId: ID | null;
}

export interface LabelJob {
  productId: ID;
  quantity: number;
}

// ---------- Quick products ----------
export interface QuickCategory {
  id: ID;
  name: LocalizedText;
  order: number;
  color?: string;
  branchId: ID | null;
  /** Optional link to a catalog department, so the group can be filled from it. */
  sourceCategoryId?: ID | null;
  /** Optional link to a motorcycle model, so the group can be filled with its compatible parts. */
  sourceModelId?: ID | null;
}

export interface QuickProduct {
  id: ID;
  productId: ID;
  categoryId: ID | null;
  branchId: ID | null;
  order: number;
  color?: string;
  label?: LocalizedText;
}

// ---------- Reports ----------
export interface DashboardKpis {
  todaySales: Money;
  todayProfit: Money;
  purchases: Money;
  expenses: Money;
  customerDebts: Money;
  supplierDebts: Money;
  inventoryValue: Money;
  lowStockCount: number;
  outOfStockCount: number;
  activeBranches: number;
  activePosTerminals: number;
  salesChange: number;
  profitChange: number;
  invoicesCount: number;
}

export interface TimeSeriesPoint {
  date: string;
  sales: Money;
  profit: Money;
  purchases?: Money;
  expenses?: Money;
}

export interface NamedValue {
  name: LocalizedText;
  value: number;
  color?: string;
}

export interface DashboardData {
  kpis: DashboardKpis;
  salesSeries: TimeSeriesPoint[];
  salesByBranch: NamedValue[];
  salesByCategory: NamedValue[];
  salesByTier: NamedValue[];
  topProducts: { product: Product; qty: number; revenue: Money }[];
  paymentMethods: NamedValue[];
  debtAging: NamedValue[];
}

export interface AccountingSummary {
  /** Invoice totals include tax; profit is calculated from netSales. */
  totalSales: Money;
  /** Refunds in the report period; netSales and cogs include their reversals. */
  returns?: Money;
  netSales: Money;
  tax: Money;
  cogs: Money;
  grossProfit: Money;
  expenses: Money;
  netProfit: Money;
  inventoryValue: Money;
  receivables: Money;
  payables: Money;
  series: TimeSeriesPoint[];
  expenseBreakdown: NamedValue[];
}

export type DeadStockAction = 'discount' | 'transfer' | 'liquidate' | 'return_to_supplier';

export interface DeadStockRow {
  product: Product;
  branchId: ID;
  qtyOnHand: number;
  lastSaleDate: ISODate | null;
  lastMovementDate: ISODate | null;
  idleDays: number;
  unitCost: Money;
  frozenCapital: Money;
  carryingCost: Money;
  suggestedAction: DeadStockAction;
}

export interface DeadStockReport {
  rows: DeadStockRow[];
  totals: { frozenCapital: Money; carryingCost: Money; itemCount: number; qty: number };
  idleDays: number;
  annualCarryingRate: number;
}

export interface DeadStockSnapshot {
  id: ID;
  date: ISODate;
  branchId: ID | null;
  idleDays: number;
  frozenCapital: Money;
  carryingCost: Money;
  itemCount: number;
}

// ---------- Alternatives ----------
export type AlternativeMatchReason = 'explicit' | 'compat_same_model' | 'part_family';

export interface AlternativeSuggestion {
  product: Product;
  qtyAvailable: number;
  matchReason: AlternativeMatchReason;
  sharedModels: MotorcycleModel[];
  prices: ProductPrices;
  otherBranches: { branchId: ID; qty: number }[];
  /** "rack · shelf · bin" in the requesting branch. */
  location?: string;
}

// ---------- Offline / Sync ----------
export type SyncStatus = 'idle' | 'syncing' | 'error';

export type SyncOpType =
  | 'sale'
  | 'sale_return'
  | 'customer_payment'
  | 'register_open'
  | 'register_close'
  | 'cash_movement'
  | 'customer_create';

export interface SyncOp<TPayload = unknown> {
  opId: string;
  type: SyncOpType;
  clientCreatedAt: ISODate;
  payload: TPayload;
}

export type SyncOpResultStatus = 'applied' | 'duplicate' | 'rejected';

export interface SyncOpResult {
  opId: string;
  status: SyncOpResultStatus;
  serverId?: ID;
  error?: { code: string; message: string };
}

export interface SyncPushRequest {
  terminalId: ID;
  ops: SyncOp[];
}

export interface SyncPushResponse {
  results: SyncOpResult[];
  serverTime: ISODate;
}

export interface SyncPullResponse {
  /** Branch-scoped durable refund documents and their source invoices for reconciliation. */
  refundHistory?: SaleReturn[];
  returnSales?: Sale[];
  /** Terminal operations already included in this stock/customer snapshot. */
  acknowledgedOps?: SyncOpResult[];
  /** Checkout warehouse selected by the server; null means the branch has none. */
  salesWarehouseId?: ID | null;
  products: Product[];
  stockLevels: StockLevel[];
  customers: Customer[];
  specialPrices: SpecialPrice[];
  quickProducts: QuickProduct[];
  quickCategories: QuickCategory[];
  printProfiles: PrintProfile[];
  motorcycleModels: MotorcycleModel[];
  categories: Category[];
  brands: Brand[];
  /** Named so the terminal never shows a raw branch id (stock in other branches, transfers). */
  branches: Branch[];
  /** Shift currently open on this terminal's register, including one opened from the ERP. */
  openSession: RegisterSession | null;
  settings: AppSettings | null;
  deleted: { products: ID[]; customers: ID[]; quickProducts: ID[]; quickCategories: ID[] };
  serverTime: ISODate;
}

export interface Terminal {
  id: ID;
  code: string;
  name: string;
  branchId: ID;
  registerId: ID | null;
  lastSeenAt: ISODate | null;
  appVersion?: string;
  createdAt: ISODate;
}

/** Legacy in-browser queue entry (kept for the web sync panel). */
export interface QueuedTransaction {
  id: ID;
  type: 'sale' | 'return' | 'payment' | 'register';
  createdAt: ISODate;
  payload: unknown;
  attempts: number;
  status: 'pending' | 'failed' | 'synced';
  error?: string;
}

// ---------- Public e-invoice verification ----------
export interface InvoiceVerification {
  invoiceNumber: string;
  date: ISODate;
  sellerName: LocalizedText;
  taxNumber: string;
  total: Money;
  tax: Money;
  status: SaleStatus;
  itemsCount: number;
}
