import type { Permission, RoleKey, User } from '@moto/shared';
import { ROLE_PERMISSIONS, resolvePermissions } from '@moto/shared';
import { RoleModel } from '../../db/models.js';

let cache: { map: Partial<Record<RoleKey, Permission[]>>; at: number } | null = null;
const TTL = 10_000;

export async function rolePermissionMap(): Promise<Partial<Record<RoleKey, Permission[]>>> {
  if (cache && Date.now() - cache.at < TTL) return cache.map;
  const roles = await RoleModel.find().lean();
  const map: Partial<Record<RoleKey, Permission[]>> = {};
  for (const r of roles) map[r._id] = r.permissions;
  cache = { map, at: Date.now() };
  return map;
}

export function invalidateRoleCache() {
  cache = null;
}

export async function resolveUserPermissions(user: Pick<User, 'role' | 'extraPermissions'>): Promise<Permission[]> {
  const map = await rolePermissionMap();
  return resolvePermissions(user.role, user.extraPermissions ?? [], { ...ROLE_PERMISSIONS, ...map });
}
