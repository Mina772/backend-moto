import type { NextFunction, Request, Response } from 'express';
import type { Permission } from '@moto/shared';
import { hasPermission } from '@moto/shared';
import { forbidden, unauthorized } from '../lib/errors.js';

/** Requires any of the given permissions. */
export function authorize(...required: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    if (required.length && !hasPermission(req.auth.permissions, required)) return next(forbidden(`Missing permission: ${required.join(' | ')}`, 'PERMISSION_DENIED'));
    next();
  };
}

/** Returns the branch filter to apply for the current user: undefined = all branches. */
export function branchScope(req: Request, requested?: string | null): string | undefined {
  const auth = req.auth;
  if (!auth) return requested ?? undefined;
  if (hasPermission(auth.permissions, 'branches.all')) return requested || undefined;
  return auth.branchId;
}

export function assertBranchAccess(req: Request, branchId: string) {
  const auth = req.auth;
  if (!auth) throw unauthorized();
  if (hasPermission(auth.permissions, 'branches.all')) return;
  if (auth.branchId !== branchId) throw forbidden('Branch access denied', 'BRANCH_DENIED');
}

/** Guards every branch a request touches; use for transfers, which span two. */
export function assertBranchesAccess(req: Request, ...branchIds: (string | null | undefined)[]) {
  for (const b of branchIds) if (b) assertBranchAccess(req, b);
}

/**
 * Resolves the warehouse a write targets and rejects warehouses outside the caller's branch.
 * Loading the warehouse is what stops a forged `branchId` from pointing at another branch's stock.
 */
export async function assertWarehouseAccess(req: Request, warehouseId: string): Promise<string> {
  const { WarehouseModel } = await import('../db/models.js');
  const wh = await WarehouseModel.findById(warehouseId).select('branchId').lean();
  if (!wh) throw forbidden('Warehouse not found', 'BRANCH_DENIED');
  assertBranchAccess(req, wh.branchId);
  return wh.branchId;
}
