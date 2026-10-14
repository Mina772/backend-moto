import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { api, loginAs, startTestDb, stopTestDb } from '../../test/harness.js';
import { env } from '../../config/env.js';
import { CustomerModel, UserModel } from '../../db/models.js';

let app: Express;
const auth = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });

beforeAll(async () => {
  app = await startTestDb({ seed: true });
});
afterAll(stopTestDb);

describe('auth hardening', () => {
  it('expired refresh token → 401, not 500', async () => {
    const expired = jwt.sign({ sub: 'usr-1', typ: 'refresh' }, env.JWT_REFRESH_SECRET, { expiresIn: -10 });
    const res = await api(app).post('/api/auth/refresh').set('X-Client', 'pos-desktop').send({ refreshToken: expired });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_INVALID');
  });

  it('web and desktop refresh tokens coexist; logout revokes only its own device', async () => {
    const desktop = await loginAs(app, 'cashier1');
    const web = await api(app).post('/api/auth/login').send({ username: 'cashier1', password: '123456' });
    expect(web.status).toBe(200);
    const pick = (h: unknown) => (h as string[]).find((c) => c.startsWith('moto_rt='))!.split(';')[0]!;
    const cookie = pick(web.headers['set-cookie']);

    // Desktop refresh still works after the web login.
    const r1 = await api(app).post('/api/auth/refresh').set('X-Client', 'pos-desktop').send({ refreshToken: desktop.refreshToken });
    expect(r1.status).toBe(200);
    // Web refresh still works after the desktop rotation.
    const r2 = await api(app).post('/api/auth/refresh').set('Cookie', cookie).send({});
    expect(r2.status).toBe(200);

    // Logging out the desktop session leaves the web cookie valid.
    const out = await api(app).post('/api/auth/logout').set(auth(r1.body)).send({ refreshToken: r1.body.refreshToken });
    expect(out.status).toBe(200);
    const dead = await api(app).post('/api/auth/refresh').set('X-Client', 'pos-desktop').send({ refreshToken: r1.body.refreshToken });
    expect(dead.status).toBe(401);
    const webCookie2 = pick(r2.headers['set-cookie']);
    const alive = await api(app).post('/api/auth/refresh').set('Cookie', webCookie2).send({});
    expect(alive.status).toBe(200);
    const doc = await UserModel.findOne({ username: 'cashier1' }).lean();
    expect(doc!.refreshTokens.length).toBeGreaterThanOrEqual(1);
  });

  it('users.edit cannot grant admin or change own status; status is not reset on edit', async () => {
    const manager = await loginAs(app, 'khaled.m');
    const admin = await loginAs(app, 'admin');
    const target = await UserModel.findOne({ username: 'cashier1' }).lean();
    const base = { username: target!.username, fullName: target!.fullName, email: target!.email, phone: target!.phone, branchId: target!.branchId };

    // Manager has users.view only in the default matrix → grant users.edit for this test via admin.
    await UserModel.updateOne({ _id: manager.user.id }, { $set: { extraPermissions: ['users.edit'] } });
    const manager2 = await loginAs(app, 'khaled.m');

    const escalate = await api(app).put(`/api/users/${target!._id}`).set(auth(manager2)).send({ ...base, role: 'admin' });
    expect(escalate.status).toBe(403);

    const suspend = await api(app).put(`/api/users/${target!._id}`).set(auth(admin)).send({ ...base, role: 'cashier', status: 'suspended' });
    expect(suspend.status).toBe(200);
    const edit = await api(app).put(`/api/users/${target!._id}`).set(auth(admin)).send({ ...base, role: 'cashier', phone: '01000000099' });
    expect(edit.status).toBe(200);
    expect(edit.body.status).toBe('suspended');

    const self = await api(app).put(`/api/users/${admin.user.id}`).set(auth(admin)).send({ username: 'admin', fullName: { ar: 'x' }, role: 'admin', branchId: 'br-1', status: 'inactive' });
    expect(self.status).toBe(403);
    await UserModel.updateOne({ _id: target!._id }, { $set: { status: 'active' } });
  });

  it('?hasDebt=false / ?isActive=false are honoured (no coerce-to-true)', async () => {
    const admin = await loginAs(app, 'admin');
    await CustomerModel.updateOne({ _id: 'cust-1' }, { $set: { isActive: false } });
    const inactive = await api(app).get('/api/customers').query({ isActive: 'false', pageSize: 500 }).set(auth(admin));
    expect(inactive.status).toBe(200);
    expect(inactive.body.data.every((c: { isActive: boolean }) => c.isActive === false)).toBe(true);
    expect(inactive.body.data.some((c: { id: string }) => c.id === 'cust-1')).toBe(true);
    const noDebt = await api(app).get('/api/customers').query({ hasDebt: 'false', pageSize: 500 }).set(auth(admin));
    expect(noDebt.body.data.some((c: { balance: number }) => c.balance <= 0)).toBe(true);
    await CustomerModel.updateOne({ _id: 'cust-1' }, { $set: { isActive: true } });
  });
});
