import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import type { Session, User } from '@moto/shared';
import { ChangePasswordSchema, LoginSchema, RefreshSchema } from '@moto/shared';
import { cookieSecure, env } from '../../config/env.js';
import { UserModel } from '../../db/models.js';
import { audit, clientIp } from '../../lib/audit.js';
import { badRequest, forbidden, unauthorized } from '../../lib/errors.js';
import { nowISO } from '../../lib/ids.js';
import { toPublic } from '../../lib/pagination.js';
import { accessTokenExpiry, authenticate, loadAuthUser, signAccessToken, signRefreshToken, verifyRefreshToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { resolveUserPermissions } from './permissions.js';

export const authRouter = Router();

const REFRESH_COOKIE = 'moto_rt';
const MAX_REFRESH_TOKENS = 5;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** Replace `oldHash` (if any) with a new entry, keeping at most MAX_REFRESH_TOKENS devices. */
function rotateRefreshToken(user: InstanceType<typeof UserModel>, oldHash: string | null, nextToken: string, client: string) {
  const kept = (user.refreshTokens ?? []).filter((t) => t.hash !== oldHash);
  user.refreshTokens = [...kept, { hash: hashToken(nextToken), client, createdAt: nowISO() }].slice(-MAX_REFRESH_TOKENS);
}

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, skip: () => env.NODE_ENV === 'test' });

function isDesktopClient(req: { header(name: string): string | undefined }) {
  return req.header('X-Client') === 'pos-desktop';
}

async function buildSession(userDoc: InstanceType<typeof UserModel>, includeRefresh: string | null): Promise<Session> {
  const user = toPublic(userDoc.toObject()) as unknown as User;
  const permissions = await resolveUserPermissions(user);
  return { user, permissions, token: signAccessToken({ ...user, authVersion: userDoc.authVersion ?? 0 }), refreshToken: includeRefresh ?? undefined, expiresAt: accessTokenExpiry() };
}

const REFRESH_COOKIE_OPTS = { httpOnly: true, sameSite: env.COOKIE_SAMESITE, secure: cookieSecure, path: '/api/auth' } as const;

function setRefreshCookie(res: { cookie: (name: string, value: string, opts: object) => void }, token: string) {
  res.cookie(REFRESH_COOKIE, token, { ...REFRESH_COOKIE_OPTS, maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000 });
}

authRouter.post('/login', loginLimiter, validate(LoginSchema), async (req, res, next) => {
  try {
    const { username, password } = req.body as { username: string; password: string };
    const user = await UserModel.findOne({ username: username.toLowerCase() });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
    if (user.status !== 'active') throw forbidden('Account is not active', 'USER_INACTIVE');
    const refresh = signRefreshToken(user._id);
    const desktop = isDesktopClient(req);
    user.lastLogin = nowISO();
    rotateRefreshToken(user, null, refresh, desktop ? 'pos-desktop' : 'web');
    await user.save();
    await audit({ userId: user._id, action: 'login', entity: 'session', entityId: user._id, branchId: user.branchId, after: { device: req.header('user-agent') ?? '' }, ip: clientIp(req) });
    if (!desktop) setRefreshCookie(res, refresh);
    res.json(await buildSession(user, desktop ? refresh : null));
  } catch (e) {
    next(e);
  }
});

authRouter.post('/refresh', validate(RefreshSchema), async (req, res, next) => {
  try {
    const bodyToken = (req.body as { refreshToken?: string }).refreshToken;
    const cookieToken = (req as unknown as { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE];
    const token = bodyToken ?? cookieToken;
    if (!token) throw unauthorized('Missing refresh token', 'NO_REFRESH');
    const { sub } = verifyRefreshToken(token);
    const user = await UserModel.findById(sub);
    const currentHash = hashToken(token);
    if (!user || user.status !== 'active' || !user.refreshTokens?.some((t) => t.hash === currentHash)) throw unauthorized('Refresh token revoked', 'REFRESH_REVOKED');
    const next_ = signRefreshToken(user._id);
    const desktop = isDesktopClient(req) || Boolean(bodyToken);
    rotateRefreshToken(user, currentHash, next_, desktop ? 'pos-desktop' : 'web');
    const updated = await UserModel.findOneAndUpdate({ _id: user._id, status: 'active', 'refreshTokens.hash': currentHash, passwordHash: user.passwordHash }, [{ $set: { refreshTokens: { $slice: [{ $concatArrays: [{ $filter: { input: '$refreshTokens', as: 'device', cond: { $ne: ['$$device.hash', currentHash] } } }, [{ hash: hashToken(next_), client: desktop ? 'pos-desktop' : 'web', createdAt: nowISO() }]] }, -MAX_REFRESH_TOKENS] } } }], { new: true });
    if (!updated) throw unauthorized('Refresh token already consumed or revoked', 'REFRESH_REVOKED');
    if (!desktop) setRefreshCookie(res, next_);
    res.json(await buildSession(updated, desktop ? next_ : null));
  } catch (e) {
    next(e instanceof jwt.JsonWebTokenError ? unauthorized(e instanceof jwt.TokenExpiredError ? 'Refresh token expired' : 'Invalid refresh token', 'REFRESH_INVALID') : e);
  }
});

authRouter.post('/logout', authenticate(false), async (req, res, next) => {
  try {
    const bodyToken = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    const cookieToken = (req as unknown as { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE];
    const token = bodyToken ?? cookieToken;
    if (token) {
      try {
        const { sub } = verifyRefreshToken(token);
        await UserModel.updateOne({ _id: sub }, { $pull: { refreshTokens: { hash: hashToken(token) } } });
      } catch (error) { if (!(error instanceof jwt.JsonWebTokenError)) throw error; }
    }
    if (req.auth) {
      const bodyToken = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
      const cookieToken = (req as unknown as { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE];
      const token = bodyToken ?? cookieToken;
      // Revoke only this device's token; other sessions stay signed in.
      if (token) await UserModel.updateOne({ _id: req.auth.id }, { $pull: { refreshTokens: { hash: hashToken(token) } } });
      await audit({ userId: req.auth.id, action: 'logout', entity: 'session', entityId: req.auth.id, branchId: req.auth.branchId, ip: clientIp(req) });
    }
    // Attributes must match the Set-Cookie or the browser keeps the old cookie.
    res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTS);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

authRouter.get('/me', authenticate(), async (req, res, next) => {
  try {
    const auth = await loadAuthUser(req.auth!.id);
    if (!auth) throw unauthorized();
    const session: Session = { user: auth.user, permissions: auth.permissions, token: signAccessToken({ ...auth.user, authVersion: auth.authVersion }), expiresAt: accessTokenExpiry() };
    res.json(session);
  } catch (e) {
    next(e);
  }
});

authRouter.post('/change-password', authenticate(), validate(ChangePasswordSchema), async (req, res, next) => {
  try {
    const { current, next: nextPw } = req.body as { current: string; next: string };
    const user = await UserModel.findById(req.auth!.id);
    if (!user) throw unauthorized();
    if (!(await bcrypt.compare(current, user.passwordHash))) throw badRequest('Current password is incorrect', 'WRONG_PASSWORD');
    user.passwordHash = await bcrypt.hash(nextPw, env.BCRYPT_COST);
    user.refreshTokens = [];
    user.authVersion = (user.authVersion ?? 0) + 1;
    await user.save();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
