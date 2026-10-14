import type { Customer } from './types';

/** Shared non-retail contacts can be selected for cash sales; their financial account stays private. */
export function customerVisibleInBranch(customer: Customer, branchId: string): boolean {
  return customer.branchId === branchId || customer.type !== 'retail';
}
export function projectCustomer(customer: Customer, branchId?: string): Customer {
  if (!branchId || customer.branchId === branchId) return customer;
  return {
    id: customer.id, code: customer.code, name: customer.name, phone: customer.phone,
    whatsapp: customer.whatsapp, address: { ar: '' }, type: customer.type,
    balance: 0, creditLimit: 0, financialRestricted: true, branchId: customer.branchId,
    isActive: customer.isActive, createdAt: customer.createdAt, updatedAt: customer.updatedAt,
  };
}
