import { Router } from 'express';
import type { FilterQuery } from 'mongoose';
import type { Alert } from '@moto/shared';
import { AlertQuerySchema } from '@moto/shared';
import { AlertModel, NotificationModel } from '../../db/models.js';
import { notFound } from '../../lib/errors.js';
import { nowISO } from '../../lib/ids.js';
import { paginate, toPublic, toPublicList } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { branchScope } from '../../middleware/authorize.js';
import { q } from '../../middleware/validate.js';
import { getSettings } from '../settings/service.js';

export const alertsRouter = Router();
export const notificationsRouter = Router();
alertsRouter.use(authenticate());
notificationsRouter.use(authenticate());

async function alertFilterFor(req: Parameters<typeof branchScope>[0], extra: FilterQuery<Alert> = {}): Promise<FilterQuery<Alert>> {
  const settings = await getSettings();
  const role = req.auth!.role;
  const allowedTypes = Object.entries(settings.alerts.roleRouting)
    .filter(([, roles]) => !roles || roles.length === 0 || roles.includes(role))
    .map(([t]) => t);
  const branchId = branchScope(req, undefined);
  const f: FilterQuery<Alert> = { ...extra };
  if (allowedTypes.length) f.type = { $in: allowedTypes };
  if (branchId) f.$or = [{ branchId }, { branchId: null }];
  return f;
}

alertsRouter.get('/', async (req, res, next) => {
  try {
    const query = q(req, AlertQuerySchema);
    const extra: FilterQuery<Alert> = {};
    if (query.unread) extra.readBy = { $ne: req.auth!.id };
    if (query.severity) extra.severity = query.severity;
    if (query.type) extra.type = query.type;
    extra.resolvedAt = query.resolved ? { $ne: null } : null;
    const filter = await alertFilterFor(req, extra);
    // Keep the role-routing restriction: a requested type outside the allowed set yields nothing.
    if (query.type) {
      const allowed = (filter.type as { $in?: string[] } | undefined)?.$in;
      filter.type = allowed && !allowed.includes(query.type) ? { $in: [] } : query.type;
    }
    res.json(await paginate(AlertModel, { filter, query, defaultSort: { createdAt: -1 } }));
  } catch (e) {
    next(e);
  }
});

alertsRouter.get('/summary', async (req, res, next) => {
  try {
    const filter = await alertFilterFor(req, { resolvedAt: null });
    const [unread, critical, latest] = await Promise.all([
      AlertModel.countDocuments({ ...filter, readBy: { $ne: req.auth!.id } }),
      AlertModel.countDocuments({ ...filter, severity: 'critical' }),
      AlertModel.find(filter).sort({ createdAt: -1 }).limit(3).lean(),
    ]);
    res.json({ unread, critical, latest: toPublicList(latest) });
  } catch (e) {
    next(e);
  }
});

alertsRouter.patch('/:id/read', async (req, res, next) => {
  try {
    const doc = await AlertModel.findByIdAndUpdate(req.params.id as string, { $addToSet: { readBy: req.auth!.id } }, { new: true }).lean();
    if (!doc) throw notFound('Alert not found');
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});
alertsRouter.patch('/:id/resolve', async (req, res, next) => {
  try {
    const doc = await AlertModel.findByIdAndUpdate(req.params.id as string, { $set: { resolvedAt: nowISO() }, $addToSet: { readBy: req.auth!.id } }, { new: true }).lean();
    if (!doc) throw notFound('Alert not found');
    res.json(toPublic(doc));
  } catch (e) {
    next(e);
  }
});
alertsRouter.post('/read-all', async (req, res, next) => {
  try {
    const filter = await alertFilterFor(req, { resolvedAt: null });
    await AlertModel.updateMany(filter, { $addToSet: { readBy: req.auth!.id } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------- legacy notifications (header bell) → derived from alerts + system notifications ----------
notificationsRouter.get('/', async (req, res, next) => {
  try {
    const filter = await alertFilterFor(req, { resolvedAt: null });
    const [alerts, sys] = await Promise.all([AlertModel.find(filter).sort({ createdAt: -1 }).limit(20).lean(), NotificationModel.find().sort({ date: -1 }).limit(10).lean()]);
    const typeMap: Record<string, string> = { low_stock: 'low_stock', out_of_stock: 'low_stock', debt_overdue_customer: 'debt_overdue', debt_overdue_supplier: 'debt_overdue', register_variance: 'register', count_variance: 'system', large_return: 'system', unusual_operation: 'system', sync_rejected: 'system', system: 'system' };
    const fromAlerts = alerts.map((a) => ({ id: a._id, type: typeMap[a.type] ?? 'system', title: a.title, body: a.body, date: a.createdAt, read: a.readBy.includes(req.auth!.id), link: a.link }));
    const fromSys = sys.map(toPublic);
    res.json([...fromAlerts, ...fromSys].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 25));
  } catch (e) {
    next(e);
  }
});
notificationsRouter.patch('/:id/read', async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const a = await AlertModel.updateOne({ _id: id }, { $addToSet: { readBy: req.auth!.id } });
    if (!a.matchedCount) await NotificationModel.updateOne({ _id: id }, { $set: { read: true } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
notificationsRouter.post('/read-all', async (req, res, next) => {
  try {
    const filter = await alertFilterFor(req, { resolvedAt: null });
    await Promise.all([AlertModel.updateMany(filter, { $addToSet: { readBy: req.auth!.id } }), NotificationModel.updateMany({ read: false }, { $set: { read: true } })]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
