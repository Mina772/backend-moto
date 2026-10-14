import type { Permission, PermissionCategory, RoleKey } from './types';

export const PERMISSION_CATEGORIES: { key: PermissionCategory; permissions: Permission[] }[] = [
  { key: 'sales', permissions: ['sales.view', 'sales.create', 'sales.cancel', 'sales.print', 'cash.open', 'cash.close'] },
  { key: 'discounts', permissions: ['discounts.item', 'discounts.invoice', 'discounts.unlimited'] },
  { key: 'prices', permissions: ['prices.view_cost', 'prices.edit', 'prices.wholesale'] },
  { key: 'returns', permissions: ['returns.create', 'returns.approve'] },
  { key: 'inventory', permissions: ['inventory.view', 'inventory.adjust', 'inventory.count', 'inventory.transfer', 'inventory.transfer_approve'] },
  { key: 'purchases', permissions: ['purchases.view', 'purchases.create', 'purchases.receive', 'purchases.pay'] },
  { key: 'customers', permissions: ['customers.view', 'customers.edit', 'customers.credit', 'whatsapp.send', 'whatsapp.promote'] },
  { key: 'suppliers', permissions: ['suppliers.view', 'suppliers.edit'] },
  { key: 'reports', permissions: ['reports.view', 'reports.financial', 'audit.view'] },
  { key: 'expenses', permissions: ['expenses.view', 'expenses.create', 'expenses.approve'] },
  { key: 'users', permissions: ['users.view', 'users.edit', 'users.roles'] },
  { key: 'branches', permissions: ['branches.view', 'branches.edit', 'branches.all'] },
  { key: 'settings', permissions: ['settings.view', 'settings.edit', 'settings.quick_grid'] },
];

export const ALL_PERMISSIONS: Permission[] = PERMISSION_CATEGORIES.flatMap((c) => c.permissions);

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  admin: ALL_PERMISSIONS,
  branch_manager: [
    'sales.view', 'sales.create', 'sales.cancel', 'sales.print', 'cash.open', 'cash.close',
    'discounts.item', 'discounts.invoice',
    'prices.view_cost', 'prices.edit', 'prices.wholesale',
    'returns.create', 'returns.approve',
    'inventory.view', 'inventory.adjust', 'inventory.count', 'inventory.transfer', 'inventory.transfer_approve',
    'purchases.view', 'purchases.create', 'purchases.receive',
    'customers.view', 'customers.edit', 'customers.credit', 'whatsapp.send', 'whatsapp.promote',
    'suppliers.view',
    'reports.view', 'reports.financial',
    'expenses.view', 'expenses.create', 'expenses.approve',
    'users.view',
    'branches.view',
    'settings.view', 'settings.quick_grid',
  ],
  accountant: [
    'sales.view', 'sales.print',
    'prices.view_cost',
    'purchases.view', 'purchases.pay',
    'customers.view', 'customers.credit', 'whatsapp.send',
    'suppliers.view', 'suppliers.edit',
    'reports.view', 'reports.financial', 'audit.view',
    'expenses.view', 'expenses.create', 'expenses.approve',
    'branches.view', 'branches.all',
    'cash.close',
  ],
  cashier: ['sales.view', 'sales.create', 'sales.print', 'cash.open', 'cash.close', 'discounts.item', 'returns.create', 'customers.view', 'inventory.view'],
  sales: ['sales.view', 'sales.create', 'sales.print', 'discounts.item', 'discounts.invoice', 'prices.wholesale', 'customers.view', 'customers.edit', 'whatsapp.send', 'inventory.view', 'reports.view'],
  warehouse: ['inventory.view', 'inventory.adjust', 'inventory.count', 'inventory.transfer', 'purchases.view', 'purchases.receive', 'suppliers.view'],
};

export function resolvePermissions(role: RoleKey, extra: Permission[] = [], overrides?: Partial<Record<RoleKey, Permission[]>>): Permission[] {
  const base = overrides?.[role] ?? ROLE_PERMISSIONS[role] ?? [];
  return Array.from(new Set([...base, ...extra]));
}

export function hasPermission(granted: readonly Permission[], required: Permission | Permission[]): boolean {
  const list = Array.isArray(required) ? required : [required];
  return list.some((p) => granted.includes(p));
}
