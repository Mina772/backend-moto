import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Permission, RoleKey, User } from '@moto/shared';
import { env } from '../config/env.js';
import { unauthorized } from '../lib/errors.js';
import { UserModel } from '../db/models.js';
import { resolveUserPermissions } from '../modules/auth/permissions.js';

export interface AuthUser {
  id: string;
  username: string;
  role: RoleKey;
  branchId: string;
  permissions: Permission[];
  user: User;
  authVersion: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthUser;
    terminalId?: string;
  }
}

export interface AccessTokenPayload {
  sub: string;
  role: RoleKey;
  branchId: string;
  typ: 'access';
  ver?: number;
}

export function signAccessToken(user: Pick<User, 'id' | 'role' | 'branchId'> & { authVersion?: number }): string {
  const payload: AccessTokenPayload = { sub: user.id, role: user.role, branchId: user.branchId, typ: 'access', ver: user.authVersion ?? 0 };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'] });
}

export function signRefreshToken(userId: string): string {
  // jti makes every token unique even when two devices log in within the same second (iat has 1s resolution).
  return jwt.sign({ sub: userId, typ: 'refresh' }, env.JWT_REFRESH_SECRET, { expiresIn: `${env.REFRESH_TOKEN_TTL_DAYS}d`, jwtid: randomUUID() });
}

export function verifyRefreshToken(token: string): { sub: string } {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as { sub: string; typ: string };
  if (payload.typ !== 'refresh') throw unauthorized('Invalid token');
  return { sub: payload.sub };
}

export function accessTokenExpiry(): string {
  const m = /^(\d+)([smhd])$/.exec(env.ACCESS_TOKEN_TTL);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 } as const;
  const secs = m ? Number(m[1]) * mult[m[2] as keyof typeof mult] : 900;
  return new Date(Date.now() + secs * 1000).toISOString();
}

export async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  const doc = await UserModel.findById(userId).lean();
  if (!doc || doc.status !== 'active') return null;
  const user = { ...doc, id: doc._id } as unknown as User & { _id?: string; passwordHash?: string; refreshTokens?: unknown; authVersion?: number };
  delete user._id;
  delete user.passwordHash;
  delete user.refreshTokens;
  delete user.authVersion;
  const permissions = await resolveUserPermissions(user);
  return { id: user.id, username: user.username, role: user.role, branchId: user.branchId, permissions, user, authVersion: doc.authVersion ?? 0 };
}

export function authenticate(required = true) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) {
        if (required) throw unauthorized('Missing token');
        return next();
      }
      let payload: AccessTokenPayload;
      try {
        payload = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
      } catch {
        if (!required) return next();
        throw unauthorized('Invalid or expired token', 'TOKEN_EXPIRED');
      }
      if (payload.typ !== 'access') { if (!required) return next(); throw unauthorized('Invalid token'); }
      const auth = await loadAuthUser(payload.sub);
      if (!auth) { if (!required) return next(); throw unauthorized('User inactive', 'USER_INACTIVE'); }
      if ((payload.ver ?? 0) !== auth.authVersion) { if (!required) return next(); throw unauthorized('Session revoked', 'TOKEN_REVOKED'); }
      req.auth = auth;
      const terminalId = req.headers['x-terminal-id'];
      if (typeof terminalId === 'string') req.terminalId = terminalId;
      next();
    } catch (e) {
      next(e);
    }
  };
}
