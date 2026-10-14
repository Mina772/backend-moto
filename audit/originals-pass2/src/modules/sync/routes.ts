import { Router } from 'express';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ClientSession } from 'mongoose';
import type { Permission, Sale, SyncOp, SyncOpResult, SyncPullResponse, Terminal } from '@moto/shared';
import {
  CashMovementCreateSchema, CustomerPaymentCreateSchema, CustomerSaveSchema, RegisterCloseSchema, RegisterOpenSchema, SaleCreateSchema, SaleReturnCreateSchema, SyncPullQuerySchema, SyncPushSchema, SYNC_ERROR_CODES, TerminalRegisterSchema,
} from '@moto/shared';
import { z } from 'zod';
import { withTransaction } from '../../db/connect.js';
import {
  BranchModel, BrandModel, CashRegisterModel, CategoryModel, CustomerModel, MotorcycleModelModel, PrintProfileModel, ProductModel, QuickCategoryModel, QuickProductModel, RegisterSessionModel, SaleModel, SpecialPriceModel, StockLevelModel, SyncOpModel, TerminalModel, TombstoneModel,
} from '../../db/models.js';
import { audit, clientIp } from '../../lib/audit.js';
import { nextSeq } from '../../lib/counters.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { newId, nowISO } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { toPublic, toPublicList } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { assertBranchAccess, authorize } from '../../middleware/authorize.js';
import { q, validate } from '../../middleware/validate.js';
import { raiseSyncRejected } from '../alerts/engine.js';
import { addMovement, closeSession, openSession } from '../cash/service.js';
import { recordCustomerPayment, saveCustomer } from '../customers/service.js';
import { salesWarehouseFor } from '../inventory/stock.js';
import { hideCost } from '../products/service.js';
import { createReturn, createSale } from '../sales/service.js';
import { getSettings } from '../settings/service.js';

export const syncRouter = Router();
export const terminalsRouter = Router();
syncRouter.use(authenticate());
terminalsRouter.use(authenticate());

const strip = <T extends { _id: string }>(d: T) => {
  const { _id, ...rest } = d;
  void _id;
  return rest;
};

async function buildPull(branchId: string, permissions: readonly Permission[], since?: string, registerId?: string | null, opIds: string[] = [], session?: ClientSession): Promise<SyncPullResponse> {
  const serverTime = nowISO();
  const sinceFilter = since ? { updatedAt: { $gt: since } } : {};
  // Read the changing ledgers sequentially on the same snapshot session.
  const products = await ProductModel.find(since ? sinceFilter : { deletedAt: null }).session(session ?? null).lean();
  const stockLevels = await StockLevelModel.find({ branchId, ...(since ? { updatedAt: { $gt: since } } : {}) }).session(session ?? null).lean();
  const customers = await CustomerModel.find(since ? sinceFilter : { isActive: true }).session(session ?? null).lean();
  const settings = await getSettings(session);
  // Delta pulls include deactivated/soft-deleted rows so terminals can drop them; bootstrap only sends live rows.
  // Reference tables (profiles, categories, …) are small, so a delta re-sends them in full.
  const [specialPrices, quickProducts, quickCategories, printProfiles, models, categories, brands, branches, tombstones] = await Promise.all([
    SpecialPriceModel.find().lean(),
    QuickProductModel.find({ $or: [{ branchId }, { branchId: null }], ...sinceFilter }).lean(),
    QuickCategoryModel.find({ $or: [{ branchId }, { branchId: null }] }).lean(),
    PrintProfileModel.find({ $or: [{ branchId }, { branchId: null }] }).lean(),
    MotorcycleModelModel.find().lean(),
    CategoryModel.find().lean(),
    BrandModel.find().lean(),
    BranchModel.find().lean(),
    since ? TombstoneModel.find({ deletedAt: { $gt: since } }).lean() : Promise.resolve([]),
  ]);
  const openSession = registerId ? await RegisterSessionModel.findOne({ registerId, status: 'open' }).lean() : null;
  const deleted = { products: [] as string[], customers: [] as string[], quickProducts: [] as string[], quickCategories: [] as string[] };
  for (const t of tombstones) {
    if (t.coll in deleted) deleted[t.coll as keyof typeof deleted].push(t.entityId);
  }
  for (const p of products) if (p.deletedAt) deleted.products.push(p._id);
  const liveProducts = products.filter((p) => !p.deletedAt);
  return {
    acknowledgedOps: (await SyncOpModel.find({ _id: { $in: opIds }, status: 'applied', terminalId: { $in: (await TerminalModel.find({ branchId }).select('_id').session(session ?? null).lean()).map(t => t._id) } }).session(session ?? null).lean()).map(o => ({ opId: o._id, status: 'duplicate', serverId: o.serverId })),
    salesWarehouseId: await salesWarehouseFor(branchId, session).catch(() => null),
    products: hideCost(toPublicList(liveProducts) as unknown as SyncPullResponse['products'], permissions),
    stockLevels: stockLevels.map(strip),
    customers: toPublicList(customers) as unknown as SyncPullResponse['customers'],
    specialPrices: toPublicList(specialPrices) as unknown as SyncPullResponse['specialPrices'],
    quickProducts: toPublicList(quickProducts) as unknown as SyncPullResponse['quickProducts'],
    quickCategories: toPublicList(quickCategories) as unknown as SyncPullResponse['quickCategories'],
    printProfiles: toPublicList(printProfiles) as unknown as SyncPullResponse['printProfiles'],
    motorcycleModels: toPublicList(models) as unknown as SyncPullResponse['motorcycleModels'],
    categories: toPublicList(categories) as unknown as SyncPullResponse['categories'],
    brands: toPublicList(brands) as unknown as SyncPullResponse['brands'],
    branches: toPublicList(branches) as unknown as SyncPullResponse['branches'],
    openSession: openSession ? (toPublic(openSession) as unknown as SyncPullResponse['openSession']) : null,
    settings,
    deleted,
    serverTime,
  };
}

/** Register this terminal is wired to, used to ship back the shift that is open on it. */
async function callerRegisterId(req: { terminalId?: string }): Promise<string | null> {
  if (!req.terminalId) return null;
  const t = await TerminalModel.findById(req.terminalId).select('registerId').lean();
  return t?.registerId ?? null;
}

syncRouter.get('/pull', authorize('sales.create'), async (req, res, next) => {
  try {
    const { branchId, since } = q(req, SyncPullQuerySchema);
    assertBranchAccess(req, branchId);
    const opIds = typeof req.query.opIds === 'string' ? req.query.opIds.split(',').filter(Boolean).slice(0, 200) : [];
    const registerId = await callerRegisterId(req);
    res.json(await withTransaction(session => buildPull(branchId, req.auth!.permissions, since, registerId, opIds, session)));
  } catch (e) {
    next(e);
  }
});

syncRouter.get('/bootstrap', authorize('sales.create'), async (req, res, next) => {
  try {
    const branchId = z.string().parse(req.query.branchId);
    assertBranchAccess(req, branchId);
    const opIds = typeof req.query.opIds === 'string' ? req.query.opIds.split(',').filter(Boolean).slice(0, 200) : [];
    const registerId = await callerRegisterId(req);
    res.json(await withTransaction(session => buildPull(branchId, req.auth!.permissions, undefined, registerId, opIds, session)));
  } catch (e) {
    next(e);
  }
});

type ApplyResult = { serverId?: string };

/**
 * Terminals reference sessions by their local id; map that to the open session on the register.
 * With `strict`, only the exact session or one opened by the same user qualifies (used for register_close so a stale
 * close never shuts another cashier's session).
 */
async function resolveSessionId(terminal: Terminal, wanted: string | null | undefined, opts: { strict?: boolean; userId?: string } = {}): Promise<string | null> {
  if (!wanted) return null;
  const exact = await RegisterSessionModel.findById(wanted).lean();
  if (exact && (exact.branchId !== terminal.branchId || terminal.registerId && exact.registerId !== terminal.registerId)) throw new HttpError(403, 'BRANCH_DENIED', 'Session does not belong to this terminal');
  if (exact?.status === 'open' && (!opts.strict || exact.userId === opts.userId)) return exact._id;
  if (exact && opts.strict && exact.userId !== opts.userId) return null;
  const open = await RegisterSessionModel.findOne({
    branchId: terminal.branchId,
    status: 'open',
    ...(terminal.registerId ? { registerId: terminal.registerId } : {}),
    ...(opts.strict && opts.userId ? { userId: opts.userId } : {}),
  }).sort({ openedAt: -1 }).lean();
  return open?._id ?? null;
}

const isDuplicateKey = (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 11000;

/** Locate the server record an op already produced (used when a re-push hits INVOICE_EXISTS / E11000). */
async function findServerIdFor(op: SyncOp): Promise<string | undefined> {
  const p = op.payload as Record<string, unknown>;
  switch (op.type) {
    case 'sale': {
      const inv = typeof p.invoiceNumber === 'string' ? p.invoiceNumber : undefined;
      return inv ? (await SaleModel.findOne({ invoiceNumber: inv }).select('_id').lean())?._id : undefined;
    }
    case 'customer_create':
      return typeof p.id === 'string' ? p.id : undefined;
    case 'register_open':
      return typeof p.sessionId === 'string' ? p.sessionId : undefined;
    default:
      return undefined;
  }
}

async function applyOp(op: SyncOp, terminal: Terminal, userId: string, permissions: readonly Permission[], ip: string): Promise<ApplyResult> {
  const requireAny = (...required: Permission[]) => {
    if (!required.some(p => permissions.includes(p))) throw new HttpError(403, 'PERMISSION_DENIED', `Missing permission: ${required.join(' | ')}`);
  };
  const sameBranch = (branchId: string) => {
    if (branchId !== terminal.branchId) throw new HttpError(403, 'BRANCH_DENIED', 'Operation belongs to another branch');
  };
  switch (op.type) {
    case 'sale': {
      const input = SaleCreateSchema.parse(op.payload);
      const registerSessionId = await resolveSessionId(terminal, input.registerSessionId);
      sameBranch(input.branchId);
      const sale = await createSale({ ...input, registerSessionId, branchId: terminal.branchId, terminalId: terminal.id, cashierId: userId }, { userId, ip, terminalId: terminal.id, permissions });
      return { serverId: sale.id };
    }
    case 'sale_return': {
      requireAny('returns.create');
      const input = SaleReturnCreateSchema.parse(op.payload);
      let sale = await SaleModel.findById(input.saleId).lean();
      if (!sale) {
        const reference = typeof (op.payload as { invoiceNumber?: string }).invoiceNumber === 'string' ? (op.payload as { invoiceNumber: string }).invoiceNumber : undefined;
        const applied = await SyncOpModel.findOne({ terminalId: terminal.id, type: 'sale', localId: input.saleId, status: 'applied' }).lean();
        sale = applied?.serverId ? await SaleModel.findById(applied.serverId).lean() : reference ? await SaleModel.findOne({ invoiceNumber: reference, branchId: terminal.branchId }).lean() : null;
        if (sale) {
          input.saleId = sale._id;
          const lineIndexes = (op.payload as { lineIndexes?: number[] }).lineIndexes;
          for (const [index, item] of input.items.entries()) {
            const lineIndex = lineIndexes?.[index];
            const line = Number.isInteger(lineIndex) ? sale.items[lineIndex!] : undefined;
            if (!line || line.productId !== item.productId) throw new HttpError(422, 'SALE_ITEM_NOT_FOUND', 'Local sale line mapping missing');
            item.saleItemId = line.id;
          }
        }
      }
      if (!sale) throw new HttpError(422, 'SALE_NOT_FOUND', 'Sale not found');
      sameBranch(sale.branchId);
      const ret = await createReturn(input, { userId, ip });
      return { serverId: ret.id };
    }
    case 'customer_payment': {
      requireAny('customers.credit', 'sales.create');
      const input = CustomerPaymentCreateSchema.parse(op.payload);
      sameBranch(input.branchId);
      const customer = await CustomerModel.findById(input.customerId).lean();
      if (!customer) throw new HttpError(422, 'CUSTOMER_NOT_FOUND', 'Customer not found');
      sameBranch(customer.branchId);
      const pay = await recordCustomerPayment({ ...input, branchId: terminal.branchId }, { userId, ip });
      return { serverId: pay.id };
    }
    case 'customer_create': {
      requireAny('customers.edit', 'sales.create');
      const input = CustomerSaveSchema.parse(op.payload);
      sameBranch(input.branchId ?? terminal.branchId);
      const clientId = typeof (op.payload as { id?: string }).id === 'string' ? (op.payload as { id: string }).id : undefined;
      if (clientId) {
        const existing = await CustomerModel.findById(clientId).lean();
        if (existing) {
          sameBranch(existing.branchId);
          return { serverId: existing._id };
        }
      }
      const c = await saveCustomer({ ...input, id: undefined, branchId: input.branchId ?? terminal.branchId }, terminal.branchId, { clientId });
      return { serverId: c.id };
    }
    case 'register_open': {
      requireAny('cash.open');
      const input = RegisterOpenSchema.extend({ sessionId: z.string().optional() }).parse(op.payload);
      // Idempotent: if the register is already open (ERP, another push), adopt that session instead of failing.
      const reg = await CashRegisterModel.findById(input.registerId).lean();
      if (!reg) throw notFound('Register not found');
      sameBranch(reg.branchId);
      if (terminal.registerId && input.registerId !== terminal.registerId) throw new HttpError(403, 'BRANCH_DENIED', 'Register does not belong to this terminal');
      if (reg?.currentSessionId) {
        const open = await RegisterSessionModel.findById(reg.currentSessionId).lean();
        if (open?.status === 'open') return { serverId: open._id };
      }
      const s = await withTransaction((session) => openSession({ registerId: input.registerId, openingBalance: input.openingBalance, userId, date: op.clientCreatedAt, clientId: input.sessionId }, session));
      return { serverId: s.id };
    }
    case 'register_close': {
      requireAny('cash.close');
      const input = RegisterCloseSchema.extend({ sessionId: z.string() }).parse(op.payload);
      const sessionId = await resolveSessionId(terminal, input.sessionId, { strict: true, userId });
      if (!sessionId) throw new HttpError(422, 'SESSION_CLOSED', 'No open register session to close');
      const s = await withTransaction((session) => closeSession(sessionId, { actualCash: input.actualCash, notes: input.notes, userId, ip, date: op.clientCreatedAt }, session));
      return { serverId: s.id };
    }
    case 'cash_movement': {
      requireAny('cash.open', 'cash.close', 'sales.create');
      const input = CashMovementCreateSchema.extend({ sessionId: z.string() }).parse(op.payload);
      const sessionId = await resolveSessionId(terminal, input.sessionId);
      if (!sessionId) throw new HttpError(422, 'SESSION_CLOSED', 'No open session for this terminal');
      const mv = await withTransaction((session) => addMovement(sessionId, { type: input.type, amount: input.amount, notes: input.notes, userId, date: op.clientCreatedAt }, session));
      return { serverId: mv.id };
    }
    default:
      throw new HttpError(422, SYNC_ERROR_CODES.UNKNOWN_OP, `Unknown op type ${(op as SyncOp).type}`);
  }
}

syncRouter.post('/push', authorize('sales.create'), validate(SyncPushSchema), async (req, res, next) => {
  try {
    const { terminalId, ops } = req.body as z.infer<typeof SyncPushSchema>;
    const terminalDoc = await TerminalModel.findById(terminalId).lean();
    if (!terminalDoc) throw notFound('Terminal not registered', 'TERMINAL_NOT_FOUND');
    const terminal = toPublic(terminalDoc) as unknown as Terminal;
    assertBranchAccess(req, terminal.branchId);
    await TerminalModel.updateOne({ _id: terminalId }, { $set: { lastSeenAt: nowISO() } });

    const results: SyncOpResult[] = [];
    const sorted = [...ops].sort((a, b) => a.clientCreatedAt.localeCompare(b.clientCreatedAt));
    for (const op of sorted) {
      const requestHash = createHash('sha256').update(JSON.stringify({ type: op.type, payload: op.payload })).digest('hex');
      const identity = { terminalId, type: op.type, requestHash, userId: req.auth!.id, localId: typeof (op.payload as { localId?: string }).localId === 'string' ? (op.payload as { localId: string }).localId : undefined };
      try {
        let result: SyncOpResult | undefined;
        for (let attempt = 0; !result; attempt++) {
          try {
            result = await withTransaction(async session => {
              const existing = await SyncOpModel.findById(op.opId).session(session ?? null).lean();
              if (existing) {
                if (existing.terminalId !== terminalId || existing.type !== op.type || existing.requestHash && existing.requestHash !== requestHash || existing.userId && existing.userId !== req.auth!.id) throw new HttpError(409, 'SYNC_OP_MISMATCH', 'Operation identity was reused');
                if (existing.status !== 'applying') return { opId: op.opId, status: existing.status === 'rejected' ? 'rejected' as const : 'duplicate' as const, serverId: existing.serverId, error: existing.error };
                if (!existing.requestHash && !['sale', 'register_open', 'customer_create'].includes(op.type)) throw new HttpError(409, 'SYNC_RECOVERY_REQUIRED', 'Legacy operation has an unknown commit state; reconcile it before retrying');
                // Only legacy versions leave committed `applying` rows. Touching the row inside
                // this transaction serializes recovery with any other recovering writer.
                await SyncOpModel.updateOne({ _id: op.opId }, { $set: identity }, { session });
              } else {
                await SyncOpModel.create([{ _id: op.opId, ...identity, status: 'applying' }], { session });
              }
              const applied = await applyOp(op as SyncOp, terminal, req.auth!.id, req.auth!.permissions, clientIp(req));
              await SyncOpModel.updateOne({ _id: op.opId }, { $set: { status: 'applied', serverId: applied.serverId } }, { session });
              return { opId: op.opId, status: 'applied' as const, serverId: applied.serverId };
            });
          } catch (e) {
            if (!isDuplicateKey(e) || attempt >= 8) throw e;
            await delay(25);
          }
        }
        results.push(result);
      } catch (e) {
        const alreadyApplied = e instanceof HttpError && e.code === 'INVOICE_EXISTS';
        if (alreadyApplied) {
          const serverId = await findServerIdFor(op as SyncOp);
          const sale = serverId ? await SaleModel.findById(serverId).lean() : null;
          if (!sale || sale.terminalId !== terminalId || sale.branchId !== terminal.branchId) {
            results.push({ opId: op.opId, status: 'rejected', error: { code: 'SYNC_OP_MISMATCH', message: 'Invoice belongs to another terminal' } });
            continue;
          }
          await SyncOpModel.updateOne({ _id: op.opId }, { $set: { ...identity, status: 'applied', serverId } }, { upsert: true });
          results.push({ opId: op.opId, status: 'duplicate', serverId });
          continue;
        }
        const code = e instanceof HttpError ? e.code : e instanceof z.ZodError ? SYNC_ERROR_CODES.VALIDATION : 'INTERNAL';
        const message = e instanceof Error ? e.message : String(e);
        const transient = !(e instanceof HttpError) && !(e instanceof z.ZodError);
        if (transient) {
          // The domain transaction rolled back together with the claim; the same op is retryable.
          logger.error({ err: e, opId: op.opId }, 'sync op transient failure');
          results.push({ opId: op.opId, status: 'rejected', error: { code: 'TRANSIENT', message } });
          continue;
        }
        if (code !== 'SYNC_OP_MISMATCH' && code !== 'SYNC_RECOVERY_REQUIRED') {
          try {
            await SyncOpModel.updateOne({ _id: op.opId, status: { $ne: 'applied' } }, { $set: { ...identity, status: 'rejected', error: { code, message } } }, { upsert: true });
          } catch (writeError) {
            if (!isDuplicateKey(writeError)) throw writeError;
          }
        }
        results.push({ opId: op.opId, status: 'rejected', error: { code, message } });
        void raiseSyncRejected(terminal.code, terminal.branchId, op.opId, code, message);
      }
    }
    res.json({ results, serverTime: nowISO() });
  } catch (e) {
    next(e);
  }
});

// ---------- terminals ----------
terminalsRouter.get('/', authorize('settings.view', 'branches.view'), async (req, res, next) => {
  try {
    const branchId = typeof req.query.branchId === 'string' ? req.query.branchId : undefined;
    res.json(toPublicList(await TerminalModel.find(branchId ? { branchId } : {}).sort({ code: 1 }).lean()));
  } catch (e) {
    next(e);
  }
});
terminalsRouter.post('/', authorize('settings.edit', 'cash.open'), validate(TerminalRegisterSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof TerminalRegisterSchema>;
    assertBranchAccess(req, input.branchId);
    const branch = await BranchModel.findById(input.branchId).lean();
    if (!branch || !branch.isActive) throw notFound('Branch not found', 'BRANCH_NOT_FOUND');
    const seq = await nextSeq('terminal');
    const code = `T${String(seq).padStart(3, '0')}`;
    const doc = await TerminalModel.create({ _id: newId('term'), code, name: input.name, branchId: input.branchId, registerId: input.registerId, lastSeenAt: nowISO(), appVersion: input.appVersion, createdAt: nowISO() });
    await audit({ userId: req.auth!.id, action: 'terminal_register', entity: 'terminal', entityId: doc._id, branchId: input.branchId, after: { code, name: input.name }, ip: clientIp(req) });
    res.status(201).json(toPublic(doc.toObject()) as unknown as Terminal);
  } catch (e) {
    next(e);
  }
});
terminalsRouter.post('/:id/heartbeat', authorize('sales.create'), async (req, res, next) => {
  try {
    const appVersion = typeof (req.body as { appVersion?: string })?.appVersion === 'string' ? (req.body as { appVersion: string }).appVersion : undefined;
    await TerminalModel.updateOne({ _id: req.params.id as string }, { $set: { lastSeenAt: nowISO(), ...(appVersion ? { appVersion } : {}) } });
    res.json({ serverTime: nowISO() });
  } catch (e) {
    next(e);
  }
});

export type { Sale };
