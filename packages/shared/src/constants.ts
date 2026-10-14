import type { AlertSettings, AlertType, AppSettings, LabelElement, LabelTemplate, PaperKind, PrintProfile } from './types';

export const ALERT_TYPES: AlertType[] = [
  'low_stock', 'out_of_stock', 'debt_overdue_customer', 'debt_overdue_supplier',
  'count_variance', 'large_return', 'register_variance', 'unusual_operation', 'sync_rejected', 'system',
];

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: Object.fromEntries(ALERT_TYPES.map((t) => [t, true])) as Record<AlertType, boolean>,
  countVarianceThresholdPct: 5,
  largeReturnAmount: 2000,
  maxReturnsPerCashierPerDay: 5,
  registerVarianceAmount: 50,
  unusualDiscountPercent: 25,
  maxVoidsPerCashierPerDay: 3,
  whatsappManagerPhone: '',
  whatsappOnCritical: false,
  roleRouting: {
    low_stock: ['admin', 'branch_manager', 'warehouse'],
    out_of_stock: ['admin', 'branch_manager', 'warehouse', 'cashier', 'sales'],
    debt_overdue_customer: ['admin', 'branch_manager', 'accountant'],
    debt_overdue_supplier: ['admin', 'accountant'],
    count_variance: ['admin', 'branch_manager', 'warehouse'],
    large_return: ['admin', 'branch_manager'],
    register_variance: ['admin', 'branch_manager', 'accountant'],
    unusual_operation: ['admin', 'branch_manager'],
    sync_rejected: ['admin', 'branch_manager'],
    system: ['admin'],
  },
};

export const DEFAULT_SETTINGS: AppSettings = {
  company: {
    name: { ar: '', en: '' },
    taxNumber: '',
    commercialRegister: '',
    phone: '',
    email: '',
    address: { ar: '', en: '' },
    vatRegistered: false,
    invoiceLegalText: { ar: '', en: '' },
  },
  currency: { code: 'EGP', symbol: { ar: 'ج.م', en: 'EGP' }, decimals: 2, symbolPosition: 'after' },
  invoice: {
    prefix: 'INV-',
    nextNumber: 1,
    footerText: { ar: '', en: '' },
    showLogo: true,
    showTax: false,
    taxRate: 14,
    allowNegativeStock: false,
  },
  receipt: {
    paperWidth: 80,
    showBarcode: true,
    showCashier: true,
    showCustomerBalance: true,
    copies: 1,
    headerLines: [],
    subtitle: { ar: '', en: '' },
    tagline: { ar: '', en: '' },
    slogan: { ar: '', en: '' },
    warrantyNotes: [],
    brandLogos: [],
  },
  barcode: { internalPrefix: 'MP', length: 8, labelWidth: 50, labelHeight: 25, showPrice: true, showName: true },
  pos: {
    defaultPaymentMethod: 'cash',
    autoPrint: true,
    requireCustomerForCredit: true,
    maxDiscountPercent: 15,
    soundOnScan: true,
    openDrawerOnSale: true,
    defaultPriceTier: 'retail1',
    gridColumns: 6,
    gridPageSize: 24,
    showTierChooserOnScan: true,
    idleLockMinutes: 10,
  },
  pricing: {
    tierLabels: {
      retail1: { ar: 'قطاعي 1', en: 'Retail 1' },
      retail2: { ar: 'قطاعي 2', en: 'Retail 2' },
      wholesale: { ar: 'جملة', en: 'Wholesale' },
    },
  },
  reports: { annualCarryingRate: 0.2, deadStockDefaultIdleDays: 90 },
  notifications: { lowStock: true, overdueDebts: true, transfers: true, registerClose: true, dailySummary: false },
  alerts: DEFAULT_ALERT_SETTINGS,
};

/**
 * Fills in sections and keys a stored settings document predates. A section saved before a field existed
 * would otherwise arrive without it and crash every consumer that reads it (e.g. `receipt.warrantyNotes.map`).
 */
export function mergeAppSettings(value: Partial<AppSettings> | null | undefined): AppSettings {
  const v = value ?? {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    out[key] = { ...(DEFAULT_SETTINGS[key] as object), ...((v[key] as object | undefined) ?? {}) };
  }
  return out as unknown as AppSettings;
}

export const PAPER_SIZES: Record<PaperKind, { widthMm: number; heightMm: number | 'auto'; label: string }> = {
  thermal80: { widthMm: 80, heightMm: 'auto', label: '80mm' },
  thermal58: { widthMm: 58, heightMm: 'auto', label: '58mm' },
  a4: { widthMm: 210, heightMm: 297, label: 'A4' },
  a5: { widthMm: 148, heightMm: 210, label: 'A5' },
};

export const LABEL_PRESETS: { name: string; widthMm: number; heightMm: number }[] = [
  { name: '50 × 25', widthMm: 50, heightMm: 25 },
  { name: '40 × 30', widthMm: 40, heightMm: 30 },
  { name: '58 × 40', widthMm: 58, heightMm: 40 },
];

export function defaultLabelElements(widthMm: number, heightMm: number): LabelElement[] {
  const w = widthMm;
  const h = heightMm;
  return [
    { id: 'el-company', type: 'companyName', x: 1, y: 0.5, w: w - 2, h: h * 0.14, fontSize: 7, fontWeight: 700, align: 'center', visible: true },
    { id: 'el-name', type: 'productName', x: 1, y: h * 0.16, w: w - 2, h: h * 0.22, fontSize: 7, fontWeight: 500, align: 'center', visible: true },
    { id: 'el-barcode', type: 'barcode', x: 2, y: h * 0.4, w: w - 4, h: h * 0.38, fontSize: 6, fontWeight: 400, align: 'center', visible: true },
    { id: 'el-price', type: 'price', x: 1, y: h * 0.8, w: w - 2, h: h * 0.18, fontSize: 9, fontWeight: 700, align: 'center', priceTier: 'retail1', visible: true },
    { id: 'el-sku', type: 'sku', x: 1, y: h * 0.8, w: w * 0.4, h: h * 0.18, fontSize: 5, fontWeight: 400, align: 'start', visible: false },
    { id: 'el-logo', type: 'logo', x: 1, y: 0.5, w: w * 0.18, h: h * 0.14, fontSize: 6, fontWeight: 400, align: 'start', visible: false },
    { id: 'el-text', type: 'customText', x: 1, y: h * 0.8, w: w * 0.4, h: h * 0.18, fontSize: 5, fontWeight: 400, align: 'end', text: '', visible: false },
  ];
}

export function defaultLabelTemplate(id = 'lbl-default'): LabelTemplate {
  return { id, name: '50 × 25 Standard', widthMm: 50, heightMm: 25, dpi: 203, elements: defaultLabelElements(50, 25), isDefault: true, branchId: null };
}

export function defaultPrintProfiles(): PrintProfile[] {
  const base = { branchId: null, showLogo: true, showQr: true, showCashier: true, showCustomerBalance: false, showStamp: true, showReviewStamp: false, copies: 1, footer: { ar: '' }, isDefault: false };
  return [
    { ...base, id: 'pp-thermal80', name: 'Thermal 80mm — compact', paper: 'thermal80', detail: 'compact', showCompatibility: false, showPartNumber: false, isDefault: true },
    { ...base, id: 'pp-thermal80-detailed', name: 'Thermal 80mm — detailed', paper: 'thermal80', detail: 'detailed', showCompatibility: true, showPartNumber: true },
    { ...base, id: 'pp-thermal58', name: 'Thermal 58mm — compact', paper: 'thermal58', detail: 'compact', showCompatibility: false, showPartNumber: false },
    { ...base, id: 'pp-a4', name: 'A4 invoice — detailed', paper: 'a4', detail: 'detailed', showCompatibility: true, showPartNumber: true },
    { ...base, id: 'pp-a5', name: 'A5 invoice — compact', paper: 'a5', detail: 'compact', showCompatibility: false, showPartNumber: true },
  ];
}

export const SYNC_ERROR_CODES = {
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  CUSTOMER_CREDIT_EXCEEDED: 'CUSTOMER_CREDIT_EXCEEDED',
  SESSION_CLOSED: 'SESSION_CLOSED',
  SESSION_ALREADY_OPEN: 'SESSION_ALREADY_OPEN',
  SALE_NOT_FOUND: 'SALE_NOT_FOUND',
  CUSTOMER_NOT_FOUND: 'CUSTOMER_NOT_FOUND',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  VALIDATION: 'VALIDATION',
  UNKNOWN_OP: 'UNKNOWN_OP',
} as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[keyof typeof SYNC_ERROR_CODES];

export const SOCKET_EVENTS = {
  saleCreated: 'sale.created',
  stockChanged: 'stock.changed',
  debtChanged: 'debt.changed',
  notificationNew: 'notification.new',
  quickProductsChanged: 'quickProducts.changed',
  settingsChanged: 'settings.changed',
} as const;
