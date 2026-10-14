import { Router } from 'express';
import type { FilterQuery } from 'mongoose';
import type { WhatsAppMessage, WhatsAppTemplate } from '@moto/shared';
import { ListQuerySchema, WhatsAppSendSchema, WhatsAppTemplateUpdateSchema, hasPermission } from '@moto/shared';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { WhatsAppMessageModel, WhatsAppTemplateModel } from '../../db/models.js';
import { audit, clientIp } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { paginate } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/authorize.js';
import { q, validate } from '../../middleware/validate.js';
import { provider, sendWhatsApp } from './provider.js';

export const whatsappRouter = Router();
whatsappRouter.use(authenticate());

const toTemplate = (d: { _id: string; name: WhatsAppTemplate['name']; body: WhatsAppTemplate['body']; variables: string[]; isActive: boolean }): WhatsAppTemplate => ({ key: d._id as WhatsAppTemplate['key'], name: d.name, body: d.body, variables: d.variables, isActive: d.isActive });

whatsappRouter.get('/templates', authorize('whatsapp.send', 'settings.view'), async (_req, res, next) => {
  try {
    res.json((await WhatsAppTemplateModel.find().lean()).map(toTemplate));
  } catch (e) {
    next(e);
  }
});
whatsappRouter.put('/templates/:key', authorize('settings.edit'), validate(WhatsAppTemplateUpdateSchema), async (req, res, next) => {
  try {
    const doc = await WhatsAppTemplateModel.findByIdAndUpdate(req.params.key as string, { $set: req.body as z.infer<typeof WhatsAppTemplateUpdateSchema> }, { new: true }).lean();
    if (!doc) throw notFound('Template not found');
    res.json(toTemplate(doc));
  } catch (e) {
    next(e);
  }
});

const MsgQuerySchema = ListQuerySchema.extend({ customerId: z.string().optional(), status: z.string().optional(), templateKey: z.string().optional() });
whatsappRouter.get('/messages', authorize('whatsapp.send', 'customers.view'), async (req, res, next) => {
  try {
    const query = q(req, MsgQuerySchema);
    const filter: FilterQuery<WhatsAppMessage> = {};
    if (query.customerId) filter.customerId = query.customerId;
    if (query.status) filter.status = query.status;
    if (query.templateKey) filter.templateKey = query.templateKey;
    res.json(await paginate(WhatsAppMessageModel, { filter, query, defaultSort: { sentAt: -1 } }));
  } catch (e) {
    next(e);
  }
});
whatsappRouter.get('/stats', authorize('whatsapp.send', 'settings.view', 'settings.edit'), async (_req, res, next) => {
  try {
    const docs = await WhatsAppMessageModel.find().lean();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const delivered = docs.filter((m) => m.status === 'delivered' || m.status === 'read').length;
    const terminal = docs.filter((m) => ['sent', 'delivered', 'read', 'failed'].includes(m.status)).length;
    // Deep-link mode leaves from the shop's own phone, so the server never sees a receipt: unknown, not 0%.
    const deliveryRate = env.WHATSAPP_MODE !== 'web' && delivered > 0 ? (delivered / terminal) * 100 : null;
    res.json({ total: docs.length, sentToday: docs.filter((m) => m.sentAt >= todayStart.toISOString() && ['sent', 'delivered', 'read'].includes(m.status)).length, deliveryRate, failed: docs.filter((m) => m.status === 'failed').length, queued: docs.filter((m) => m.status === 'queued').length, mode: env.WHATSAPP_MODE });
  } catch (e) {
    next(e);
  }
});
whatsappRouter.post('/send', authorize('whatsapp.send'), validate(WhatsAppSendSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof WhatsAppSendSchema>;
    // Marketing needs its own grant; transactional messages ride on whatsapp.send.
    if (input.templateKey === 'promotion' && !hasPermission(req.auth!.permissions, 'whatsapp.promote')) {
      throw forbidden('Sending promotions requires whatsapp.promote', 'FORBIDDEN');
    }
    const message = await sendWhatsApp({ ...input, userId: req.auth!.id });
    await audit({
      userId: req.auth!.id,
      action: 'whatsapp_send',
      entity: 'customer',
      entityId: input.customerId,
      branchId: req.auth!.branchId,
      after: { templateKey: input.templateKey, phone: message.phone, status: message.status, referenceId: input.referenceId },
      ip: clientIp(req),
    });
    res.status(201).json(message);
  } catch (e) {
    next(e);
  }
});
whatsappRouter.post('/messages/:id/retry', authorize('whatsapp.send'), async (req, res, next) => {
  try {
    const doc = await WhatsAppMessageModel.findById(req.params.id as string);
    if (!doc) throw notFound('Message not found');
    if (doc.templateKey === 'promotion' && !hasPermission(req.auth!.permissions, 'whatsapp.promote')) throw forbidden('Sending promotions requires whatsapp.promote', 'FORBIDDEN');
    if (doc.status !== 'failed') throw conflict('Only failed messages can be retried', 'MESSAGE_NOT_FAILED');
    if (/\{[a-zA-Z_]+\}/.test(doc.body)) throw badRequest('Complete all message variables before sending', 'UNRESOLVED_TEMPLATE');
    doc.status = 'queued';
    doc.error = undefined;
    doc.link = undefined;
    await doc.save();
    try {
      const r = await provider.send({ customerId: doc.customerId, phone: doc.phone, templateKey: doc.templateKey, body: doc.body, userId: req.auth!.id, referenceId: doc.referenceId }, doc._id);
      doc.status = r.status;
      if (r.error) doc.error = r.error;
      if (r.link) doc.link = r.link;
    } catch {
      doc.status = 'failed';
      doc.error = 'WhatsApp provider request failed';
    }
    await doc.save();
    const { _id, ...rest } = doc.toObject();
    res.json({ ...rest, id: _id });
  } catch (e) {
    next(e);
  }
});
