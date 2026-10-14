import { Router } from 'express';
import type { FilterQuery } from 'mongoose';
import type { AuditLog } from '@moto/shared';
import { DeadStockQuerySchema, ListQuerySchema, RangeQuerySchema, hasPermission } from '@moto/shared';
import { z } from 'zod';
import { AuditLogModel, CustomerModel, DeadStockSnapshotModel, ProductModel, SaleModel, SupplierModel } from '../../db/models.js';
import { dateRange, paginate, searchRegex, toPublicList } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize, branchScope } from '../../middleware/authorize.js';
import { q } from '../../middleware/validate.js';
import { visibleCosts } from '../../lib/visibility.js';
import { accounting, dashboard, deadStock, employeePerformance, salesReport } from './service.js';

export const reportsRouter = Router();
export const auditRouter = Router();
export const searchRouter = Router();
reportsRouter.use(authenticate());
reportsRouter.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => json(visibleCosts(body, req.auth!.permissions));
  next();
});
auditRouter.use(authenticate());
searchRouter.use(authenticate());

reportsRouter.get('/dashboard', authorize('reports.view'), async (req, res, next) => {
  try {
    const f = q(req, RangeQuerySchema);
    res.json(await dashboard({ from: f.from, to: f.to, branchId: branchScope(req, f.branchId) }));
  } catch (e) {
    next(e);
  }
});
reportsRouter.get('/accounting', authorize('reports.financial'), async (req, res, next) => {
  try {
    const f = q(req, RangeQuerySchema);
    res.json(await accounting({ from: f.from, to: f.to, branchId: branchScope(req, f.branchId) }));
  } catch (e) {
    next(e);
  }
});
const SalesReportSchema = RangeQuerySchema.extend({ cashierId: z.string().optional(), customerId: z.string().optional(), groupBy: z.enum(['day', 'cashier', 'branch', 'product', 'category', 'tier']).optional() });
reportsRouter.get('/sales', authorize('reports.view'), async (req, res, next) => {
  try {
    const f = q(req, SalesReportSchema);
    res.json(await salesReport({ ...f, branchId: branchScope(req, f.branchId) }));
  } catch (e) {
    next(e);
  }
});
reportsRouter.get('/employees', authorize('reports.view'), async (req, res, next) => {
  try {
    const f = q(req, RangeQuerySchema);
    res.json(await employeePerformance({ from: f.from, to: f.to, branchId: branchScope(req, f.branchId) }));
  } catch (e) {
    next(e);
  }
});
reportsRouter.get('/dead-stock', authorize('reports.view', 'inventory.view'), async (req, res, next) => {
  try {
    const f = q(req, DeadStockQuerySchema);
    res.json(await deadStock({ ...f, branchId: branchScope(req, f.branchId) }));
  } catch (e) {
    next(e);
  }
});
reportsRouter.get('/dead-stock/snapshots', authorize('reports.view', 'inventory.view'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined) ?? null;
    res.json(toPublicList(await DeadStockSnapshotModel.find({ branchId }).sort({ date: -1 }).limit(90).lean()));
  } catch (e) {
    next(e);
  }
});

// ---------- audit ----------
const AuditQuerySchema = ListQuerySchema.extend({ userId: z.string().optional(), action: z.string().optional(), entity: z.string().optional(), entityId: z.string().optional() });
auditRouter.get('/', authorize('audit.view'), async (req, res, next) => {
  try {
    const query = q(req, AuditQuerySchema);
    const filter: FilterQuery<AuditLog> = {};
    const branchId = branchScope(req, query.branchId);
    if (branchId) filter.branchId = branchId;
    if (query.userId) filter.userId = query.userId;
    if (query.action) filter.action = query.action;
    if (query.entity) filter.entity = query.entity;
    if (query.entityId) filter.entityId = query.entityId;
    const range = dateRange(query.from, query.to);
    if (range) filter.date = range;
    const re = searchRegex(query.search);
    if (re) filter.$or = [{ entityId: re }, { entity: re }, { action: re }];
    res.json(await paginate(AuditLogModel, { filter, query, defaultSort: { date: -1 } }));
  } catch (e) {
    next(e);
  }
});

// ---------- global search ----------
searchRouter.get('/', async (req, res, next) => {
  try {
    const term = String(req.query.term ?? '').trim();
    if (!term) return res.json({ products: [], sales: [], customers: [], suppliers: [] });
    const re = searchRegex(term)!;
    const branchId = branchScope(req, undefined);
    const [products, sales, customers, suppliers] = await Promise.all([
      hasPermission(req.auth!.permissions, 'inventory.view') ? ProductModel.find({ deletedAt: null, $or: [{ 'name.ar': re }, { 'name.en': re }, { sku: re }, { internalBarcode: re }, { partNumber: re }] }).limit(5).lean() : Promise.resolve([]),
      hasPermission(req.auth!.permissions, 'sales.view') ? SaleModel.find({ invoiceNumber: re, status: { $ne: 'held' }, ...(branchId ? { branchId } : {}) }).limit(4).lean() : Promise.resolve([]),
      hasPermission(req.auth!.permissions, 'customers.view') ? CustomerModel.find({ $or: [{ 'name.ar': re }, { 'name.en': re }, { phone: re }] }).limit(4).lean() : Promise.resolve([]),
      hasPermission(req.auth!.permissions, 'suppliers.view') ? SupplierModel.find({ $or: [{ 'name.ar': re }, { 'name.en': re }] }).limit(3).lean() : Promise.resolve([]),
    ]);
    res.json(visibleCosts({ products: toPublicList(products), sales: toPublicList(sales), customers: toPublicList(customers), suppliers: toPublicList(suppliers) }, req.auth!.permissions));
  } catch (e) {
    next(e);
  }
});
