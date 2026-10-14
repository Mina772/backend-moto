import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { api, loginAs, startTestDb, stopTestDb } from './harness.js';
import { env } from '../config/env.js';
import { UserModel } from '../db/models.js';
import { authenticateSocketToken } from '../realtime/socket.js';
let app: Express;
beforeAll(async () => { app = await startTestDb({ seed: true }); });
afterAll(stopTestDb);
it('uses current branch and role for socket authorization and rejects revoked accounts and refresh tokens', async () => {
  const s = await loginAs(app, 'khaled.m');
  await UserModel.updateOne({ _id: s.user.id }, { $set: { branchId: 'br-2', role: 'cashier' } });
  expect(await authenticateSocketToken(s.token)).toMatchObject({ branchId: 'br-2', role: 'cashier' });
  await UserModel.updateOne({ _id: s.user.id }, { $inc: { authVersion: 1 } });
  await expect(authenticateSocketToken(s.token)).rejects.toThrow('unauthorized');
  await expect(authenticateSocketToken(jwt.sign({ sub: s.user.id, typ: 'refresh' }, env.JWT_SECRET))).rejects.toThrow('unauthorized');
});
it('allows logout to revoke refresh credentials despite revoked access', async () => {
  const s = await loginAs(app, 'cashier1');
  await UserModel.updateOne({ _id: s.user.id }, { $inc: { authVersion: 1 } });
  expect((await api(app).post('/api/auth/logout').set('Authorization', `Bearer ${s.token}`).send({ refreshToken: s.refreshToken })).status).toBe(200);
  expect((await api(app).post('/api/auth/refresh').send({ refreshToken: s.refreshToken })).status).toBe(401);
});
it('consumes one refresh token atomically across concurrent retries', async () => {
  const s = await loginAs(app, 'admin');
  const results = await Promise.all(Array.from({ length: 6 }, () => api(app).post('/api/auth/refresh').set('X-Client', 'pos-desktop').send({ refreshToken: s.refreshToken })));
  expect(results.filter(r => r.status === 200)).toHaveLength(1);
  expect(results.filter(r => r.status === 401)).toHaveLength(5);
  const live = results.find(r => r.status === 200)!;
  expect((await api(app).post('/api/auth/refresh').send({ refreshToken: live.body.refreshToken })).status).toBe(200);
});
it('revokes logout refresh credentials even when the access token expired', async () => {
  const s = await loginAs(app, 'admin');
  const expired = jwt.sign({ sub: s.user.id, typ: 'access', role: 'admin', branchId: 'br-1' }, env.JWT_SECRET, { expiresIn: -1 });
  expect((await api(app).post('/api/auth/logout').set('Authorization', `Bearer ${expired}`).send({ refreshToken: s.refreshToken })).status).toBe(200);
  expect((await api(app).post('/api/auth/refresh').send({ refreshToken: s.refreshToken })).status).toBe(401);
});
it('invalidates prior access and refresh credentials after a password change', async () => {
  const s = await loginAs(app, 'admin');
  expect((await api(app).post('/api/auth/change-password').set('Authorization', `Bearer ${s.token}`).send({ current: '123456', next: 'synthetic-new-password' })).status).toBe(200);
  expect((await api(app).get('/api/auth/me').set('Authorization', `Bearer ${s.token}`)).status).toBe(401);
  expect((await api(app).post('/api/auth/refresh').send({ refreshToken: s.refreshToken })).status).toBe(401);
  const fresh = await loginAs(app, 'admin', 'synthetic-new-password');
  expect((await api(app).get('/api/auth/me').set('Authorization', `Bearer ${fresh.token}`)).status).toBe(200);
});
