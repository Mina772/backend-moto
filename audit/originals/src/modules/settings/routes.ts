import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import type { AppSettings, LabelTemplate, PrintProfile } from '@moto/shared';
import { LabelTemplateSaveSchema, PrintProfileSaveSchema, SETTINGS_SECTION_SCHEMAS, SettingsSectionSchema, SettingsUpdateSchema, SOCKET_EVENTS } from '@moto/shared';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { LabelTemplateModel, PrintProfileModel } from '../../db/models.js';
import { audit, clientIp } from '../../lib/audit.js';
import { ensureCounterAtLeast } from '../../lib/counters.js';
import { HttpError, badRequest, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { toPublic, toPublicList } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize, branchScope } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { emitGlobal } from '../../realtime/socket.js';
import { getSettings, updateSettingsSection } from './service.js';

export const settingsRouter = Router();
export const printProfilesRouter = Router();
export const labelsRouter = Router();
settingsRouter.use(authenticate());
printProfilesRouter.use(authenticate());
labelsRouter.use(authenticate());

const uploadDir = path.resolve(env.UPLOAD_DIR);
mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => cb(null, `logo-${Date.now()}${path.extname(file.originalname).toLowerCase() || '.png'}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.mimetype)) return cb(badRequest('Unsupported image type', 'BAD_MIME'));
    cb(null, true);
  },
});

settingsRouter.get('/', authorize('settings.view', 'sales.create', 'inventory.view'), async (_req, res, next) => {
  try {
    res.json(await getSettings());
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/:section', authorize('settings.edit'), validate(SettingsUpdateSchema), async (req, res, next) => {
  try {
    const section = SettingsSectionSchema.parse(req.params.section) as keyof AppSettings;
    const before = (await getSettings())[section] as unknown as Record<string, unknown>;
    const { value } = req.body as z.infer<typeof SettingsUpdateSchema>;
    // Partial updates are allowed; the merged section must still satisfy its schema.
    const parsed = SETTINGS_SECTION_SCHEMAS[section].safeParse({ ...before, ...value });
    if (!parsed.success) throw new HttpError(400, 'VALIDATION', 'Invalid settings', parsed.error.flatten());
    const next_ = await updateSettingsSection(section, parsed.data as unknown as AppSettings[typeof section]);
    if (section === 'invoice') await ensureCounterAtLeast('invoice', next_.invoice.nextNumber - 1);
    await audit({ userId: req.auth!.id, action: 'settings_change', entity: 'settings', entityId: section, branchId: req.auth!.branchId, before, after: next_[section] as unknown as Record<string, unknown>, ip: clientIp(req) });
    res.json(next_);
  } catch (e) {
    next(e);
  }
});

settingsRouter.post('/logo', authorize('settings.edit'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw badRequest('No file uploaded', 'NO_FILE');
    const url = `/uploads/${req.file.filename}`;
    const current = await getSettings();
    await updateSettingsSection('company', { ...current.company, logoUrl: url });
    res.json({ url });
  } catch (e) {
    next(e);
  }
});

// ---------- print profiles ----------
printProfilesRouter.get('/', authorize('sales.print', 'settings.view', 'sales.create'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    const docs = await PrintProfileModel.find(branchId ? { $or: [{ branchId }, { branchId: null }] } : {}).sort({ isDefault: -1, name: 1 }).lean();
    res.json(toPublicList(docs));
  } catch (e) {
    next(e);
  }
});
async function savePrintProfile(input: z.infer<typeof PrintProfileSaveSchema>, id?: string): Promise<PrintProfile> {
  if (input.isDefault) await PrintProfileModel.updateMany({ branchId: input.branchId, ...(id ? { _id: { $ne: id } } : {}) }, { $set: { isDefault: false } });
  const { id: _ignored, ...rest } = input;
  void _ignored;
  const doc = id ? await PrintProfileModel.findByIdAndUpdate(id, { $set: rest }, { new: true }).lean() : (await PrintProfileModel.create({ _id: newId('pp'), ...rest })).toObject();
  if (!doc) throw notFound('Print profile not found');
  emitGlobal(SOCKET_EVENTS.settingsChanged, { section: 'printProfiles' });
  return toPublic(doc) as unknown as PrintProfile;
}
printProfilesRouter.post('/', authorize('settings.edit'), validate(PrintProfileSaveSchema), async (req, res, next) => {
  try {
    res.status(201).json(await savePrintProfile(req.body));
  } catch (e) {
    next(e);
  }
});
printProfilesRouter.put('/:id', authorize('settings.edit'), validate(PrintProfileSaveSchema), async (req, res, next) => {
  try {
    res.json(await savePrintProfile(req.body, req.params.id as string));
  } catch (e) {
    next(e);
  }
});
printProfilesRouter.delete('/:id', authorize('settings.edit'), async (req, res, next) => {
  try {
    await PrintProfileModel.deleteOne({ _id: req.params.id as string });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------- label templates ----------
labelsRouter.get('/templates', authorize('inventory.view', 'settings.view'), async (req, res, next) => {
  try {
    const branchId = branchScope(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    const docs = await LabelTemplateModel.find(branchId ? { $or: [{ branchId }, { branchId: null }] } : {}).sort({ isDefault: -1, name: 1 }).lean();
    res.json(toPublicList(docs));
  } catch (e) {
    next(e);
  }
});
async function saveLabelTemplate(input: z.infer<typeof LabelTemplateSaveSchema>, id?: string): Promise<LabelTemplate> {
  if (input.isDefault) await LabelTemplateModel.updateMany({ branchId: input.branchId, ...(id ? { _id: { $ne: id } } : {}) }, { $set: { isDefault: false } });
  const { id: _ignored, ...rest } = input;
  void _ignored;
  const doc = id ? await LabelTemplateModel.findByIdAndUpdate(id, { $set: rest }, { new: true }).lean() : (await LabelTemplateModel.create({ _id: newId('lbl'), ...rest })).toObject();
  if (!doc) throw notFound('Label template not found');
  return toPublic(doc) as unknown as LabelTemplate;
}
labelsRouter.post('/templates', authorize('settings.edit', 'inventory.adjust'), validate(LabelTemplateSaveSchema), async (req, res, next) => {
  try {
    res.status(201).json(await saveLabelTemplate(req.body));
  } catch (e) {
    next(e);
  }
});
labelsRouter.put('/templates/:id', authorize('settings.edit', 'inventory.adjust'), validate(LabelTemplateSaveSchema), async (req, res, next) => {
  try {
    res.json(await saveLabelTemplate(req.body, req.params.id as string));
  } catch (e) {
    next(e);
  }
});
labelsRouter.delete('/templates/:id', authorize('settings.edit'), async (req, res, next) => {
  try {
    await LabelTemplateModel.deleteOne({ _id: req.params.id as string });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
