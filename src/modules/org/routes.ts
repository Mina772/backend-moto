import { Router } from 'express';
import bcrypt from 'bcryptjs';
import type { FilterQuery } from 'mongoose';
import type { Branch, Role, RoleKey, User } from '@moto/shared';
import { BranchSaveSchema, ListQuerySchema, RolePermissionsSchema, UserSaveSchema, hasPermission } from '@moto/shared';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { BranchModel, ExpenseModel, ProductModel, RoleModel, SaleModel, StockLevelModel, UserModel, WarehouseModel } from '../../db/models.js';
import { audit, clientIp } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { newId, nowISO } from '../../lib/ids.js';
import { paginate, searchRegex, toPublic, toPublicList } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/authorize.js';
import { q, validate } from '../../middleware/validate.js';
import { invalidateRoleCache } from '../auth/permissions.js';

export const branchesRouter = Router();
export const usersRouter = Router();
export const rolesRouter = Router();
branchesRouter.use(authenticate());
usersRouter.use(authenticate());
rolesRouter.use(authenticate());

// ---------- branches ----------
branchesRouter.get('/', authorize('branches.view', 'sales.create', 'inventory.view'), async (_req, res, next) => {
  try {
    res.json(toPublicList(await BranchModel.find().sort({ code: 1 }).lean()));
  } catch (e) {
    next(e);
  }
});
branchesRouter.get('/performance', authorize('branches.view', 'reports.view'), async (_req, res, next) => {
  try {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const from = monthStart.toISOString();
    const [branches, sales, expenses, levels, products, users, warehouses] = await Promise.all([
      BranchModel.find().lean(),
      SaleModel.find({ date: { $gte: from }, status: { $nin: ['held', 'cancelled'] } }).lean(),
      ExpenseModel.find({ date: { $gte: from }, status: 'approved' }).lean(),
      StockLevelModel.find().lean(),
      ProductModel.find().lean(),
      UserModel.find({ status: 'active' }).lean(),
      WarehouseModel.find().lean(),
    ]);
    const cost = new Map(products.map((p) => [p._id, p.lastPurchaseCost]));
    res.json(
      branches.map((b) => {
        const bs = sales.filter((s) => s.branchId === b._id);
        const revenue = bs.reduce((a, s) => a + s.total, 0);
        const profit = bs.reduce((a, s) => a + s.items.reduce((x, i) => x + (i.unitPrice - i.unitCost) * i.quantity - i.discount, 0) - s.invoiceDiscount, 0);
        const exp = expenses.filter((e) => e.branchId === b._id).reduce((a, e) => a + e.amount, 0);
        const inventory = levels.filter((l) => l.branchId === b._id).reduce((a, l) => a + l.quantity * (cost.get(l.productId) ?? 0), 0);
        return { branch: toPublic(b), revenue, profit, expenses: exp, net: profit - exp, invoices: bs.length, inventory, employees: users.filter((u) => u.branchId === b._id).length, warehouses: warehouses.filter((w) => w.branchId === b._id).length };
      }),
    );
  } catch (e) {
    next(e);
  }
});
branchesRouter.post('/', authorize('branches.edit'), validate(BranchSaveSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof BranchSaveSchema>;
    const doc = await BranchModel.create({ _id: newId('br'), ...input, city: input.city ?? { ar: '' }, address: input.address ?? { ar: '' }, managerId: input.managerId ?? '', openedAt: nowISO() });
    res.status(201).json(toPublic(doc.toObject()));
  } catch (e) {
    next(e);
  }
});
branchesRouter.put('/:id', authorize('branches.edit'), validate(BranchSaveSchema), async (req, res, next) => {
  try {
    const { id: _ignored, ...rest } = req.body as z.infer<typeof BranchSaveSchema>;
    void _ignored;
    const doc = await BranchModel.findByIdAndUpdate(req.params.id as string, { $set: rest }, { new: true }).lean();
    if (!doc) throw notFound('Branch not found');
    res.json(toPublic(doc) as unknown as Branch);
  } catch (e) {
    next(e);
  }
});
branchesRouter.get('/:id', authorize('branches.view'), async (req, res, next) => {
  try {
    const doc = await BranchModel.findById(req.params.id as string).lean();
    if (!doc) throw notFound('Branch not found');
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});

// ---------- users ----------
const UserQuerySchema = ListQuerySchema.extend({ role: z.string().optional(), status: z.string().optional() });
usersRouter.get('/', authorize('users.view'), async (req, res, next) => {
  try {
    const query = q(req, UserQuerySchema);
    const filter: FilterQuery<User> = {};
    if (query.branchId) filter.branchId = query.branchId;
    if (query.role) filter.role = query.role;
    if (query.status) filter.status = query.status;
    const re = searchRegex(query.search);
    if (re) filter.$or = [{ username: re }, { 'fullName.ar': re }, { 'fullName.en': re }, { email: re }, { phone: re }];
    res.json(await paginate(UserModel, { filter, query, defaultSort: { username: 1 } }));
  } catch (e) {
    next(e);
  }
});
usersRouter.get('/all', authorize('users.view', 'sales.view', 'inventory.view', 'reports.view'), async (_req, res, next) => {
  try {
    res.json(toPublicList(await UserModel.find().sort({ username: 1 }).lean()));
  } catch (e) {
    next(e);
  }
});
usersRouter.post('/', authorize('users.edit'), validate(UserSaveSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof UserSaveSchema>;
    const username = input.username.toLowerCase();
    if (await UserModel.exists({ username })) throw conflict('Username already taken', 'USERNAME_TAKEN');
    if (!input.password) throw badRequest('Password required for new users', 'PASSWORD_REQUIRED');
    if ((input.role === 'admin' || input.extraPermissions?.length) && !hasPermission(req.auth!.permissions, 'users.roles')) throw forbidden('users.roles required to assign admin role or extra permissions', 'PERMISSION_DENIED');
    const { password, id: _ignored, ...rest } = input;
    void _ignored;
    const colors = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#be185d', '#4f46e5'];
    const doc = await UserModel.create({ _id: newId('usr'), ...rest, status: input.status ?? 'active', username, passwordHash: await bcrypt.hash(password, env.BCRYPT_COST), avatarColor: colors[Math.floor(Math.random() * colors.length)], lastLogin: null, createdAt: nowISO() });
    await audit({ userId: req.auth!.id, action: 'user_create', entity: 'user', entityId: doc._id, branchId: req.auth!.branchId, after: { username, role: input.role }, ip: clientIp(req) });
    res.status(201).json(toPublic(doc.toObject()));
  } catch (e) {
    next(e);
  }
});
usersRouter.put('/:id', authorize('users.edit'), validate(UserSaveSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof UserSaveSchema>;
    const doc = await UserModel.findById(req.params.id as string);
    if (!doc) throw notFound('User not found');
    const username = input.username.toLowerCase();
    if (username !== doc.username && (await UserModel.exists({ username }))) throw conflict('Username already taken', 'USERNAME_TAKEN');
    const before = { role: doc.role, status: doc.status, branchId: doc.branchId };
    const { password, id: _ignored, ...rest } = input;
    void _ignored;
    const roleChanged = rest.role !== doc.role || (rest.extraPermissions !== undefined && JSON.stringify(rest.extraPermissions) !== JSON.stringify(doc.extraPermissions ?? []));
    const statusChanged = rest.status !== undefined && rest.status !== doc.status;
    if (roleChanged && !hasPermission(req.auth!.permissions, 'users.roles')) throw forbidden('users.roles required to change role or extra permissions', 'PERMISSION_DENIED');
    if (doc._id === req.auth!.id && (roleChanged || statusChanged)) throw forbidden('Cannot change your own role or status', 'SELF_EDIT_DENIED');
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) doc.set(k, v);
    doc.username = username;
    if (password) {
      doc.passwordHash = await bcrypt.hash(password, env.BCRYPT_COST);
      doc.refreshTokens = [];
      doc.authVersion = (doc.authVersion ?? 0) + 1;
    }
    await doc.save();
    await audit({ userId: req.auth!.id, action: 'user_update', entity: 'user', entityId: doc._id, branchId: req.auth!.branchId, before, after: { role: doc.role, status: doc.status, branchId: doc.branchId }, ip: clientIp(req) });
    res.json(toPublic(doc.toObject()));
  } catch (e) {
    next(e);
  }
});
usersRouter.get('/:id', authorize('users.view'), async (req, res, next) => {
  try {
    const doc = await UserModel.findById(req.params.id as string).lean();
    if (!doc) throw notFound('User not found');
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});

// ---------- roles ----------
rolesRouter.get('/', authorize('users.view', 'users.roles'), async (_req, res, next) => {
  try {
    const [roles, counts] = await Promise.all([RoleModel.find().lean(), UserModel.aggregate<{ _id: RoleKey; n: number }>([{ $group: { _id: '$role', n: { $sum: 1 } } }])]);
    const cmap = new Map(counts.map((c) => [c._id, c.n]));
    const out: Role[] = roles.map((r) => ({ key: r._id, name: r.name, description: r.description, permissions: r.permissions, usersCount: cmap.get(r._id) ?? 0, isSystem: true }));
    res.json(out);
  } catch (e) {
    next(e);
  }
});
rolesRouter.put('/:key', authorize('users.roles'), validate(RolePermissionsSchema), async (req, res, next) => {
  try {
    const key = req.params.key as RoleKey;
    if (key === 'admin') throw badRequest('Admin permissions are fixed', 'ADMIN_FIXED');
    const role = await RoleModel.findById(key);
    if (!role) throw notFound('Role not found');
    const before = role.permissions;
    role.permissions = (req.body as z.infer<typeof RolePermissionsSchema>).permissions;
    await role.save();
    invalidateRoleCache();
    await audit({ userId: req.auth!.id, action: 'permission_change', entity: 'role', entityId: key, branchId: req.auth!.branchId, before: { permissions: before }, after: { permissions: role.permissions }, ip: clientIp(req) });
    const usersCount = await UserModel.countDocuments({ role: key });
    res.json({ key, name: role.name, description: role.description, permissions: role.permissions, usersCount, isSystem: true } satisfies Role);
  } catch (e) {
    next(e);
  }
});
