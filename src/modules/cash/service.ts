import type { ClientSession } from 'mongoose';
import type { CashMovement, RegisterSession } from '@moto/shared';
import { applyCashMovement, round2 } from '@moto/shared';
import { CashRegisterModel, RegisterSessionModel } from '../../db/models.js';
import { audit } from '../../lib/audit.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { newId, nowISO } from '../../lib/ids.js';
import { toPublic } from '../../lib/pagination.js';
import { recomputeExpectedCash } from '../sales/service.js';
import { evaluateEventAlerts } from '../alerts/engine.js';
import { afterCommit } from '../../db/connect.js';

export async function openSession(input: { registerId: string; openingBalance: number; userId: string; date?: string; clientId?: string }, session?: ClientSession): Promise<RegisterSession> {
  const reg = await CashRegisterModel.findById(input.registerId).session(session ?? null);
  if (!reg) throw notFound('Register not found');
  if (reg.currentSessionId) {
    const open = await RegisterSessionModel.findById(reg.currentSessionId).session(session ?? null).lean();
    if (open && open.status === 'open') throw new HttpError(422, 'SESSION_ALREADY_OPEN', 'Register already has an open session', { sessionId: open._id });
  }
  const now = input.date ?? nowISO();
  const id = input.clientId ?? newId('sess');
  const mv: CashMovement = { id: newId('cm'), sessionId: id, type: 'deposit', amount: input.openingBalance, method: 'cash', date: now, reference: 'OPEN', userId: input.userId };
  const doc = await RegisterSessionModel.create(
    [{ _id: id, registerId: reg._id, branchId: reg.branchId, userId: input.userId, openedAt: now, closedAt: null, openingBalance: input.openingBalance, cashSales: 0, cardSales: 0, transferSales: 0, paymentsIn: 0, paymentsOut: 0, expenses: 0, refunds: 0, expectedCash: input.openingBalance, actualCash: null, difference: null, status: 'open', movements: [mv] }],
    { session },
  );
  reg.currentSessionId = id;
  await reg.save({ session });
  return toPublic(doc[0]!.toObject()) as unknown as RegisterSession;
}

export async function addMovement(sessionId: string, input: { type: CashMovement['type']; amount: number; notes?: string; userId: string; date?: string }, session?: ClientSession): Promise<CashMovement> {
  const s = await RegisterSessionModel.findById(sessionId).session(session ?? null);
  if (!s) throw notFound('Session not found');
  if (s.status !== 'open') throw new HttpError(422, 'SESSION_CLOSED', 'Session is closed');
  const now = input.date ?? nowISO();
  const mv: CashMovement = { id: newId('cm'), sessionId, type: input.type, amount: input.amount, method: 'cash', date: now, reference: input.type.toUpperCase(), userId: input.userId, notes: input.notes };
  Object.assign(s, applyCashMovement(s, input.type, input.amount));
  s.movements = [...(s.movements ?? []), mv];
  s.expectedCash = recomputeExpectedCash(s);
  s.markModified('movements');
  await s.save({ session });
  return mv;
}

export async function closeSession(sessionId: string, input: { actualCash: number; notes?: string; userId: string; ip?: string; date?: string }, session?: ClientSession): Promise<RegisterSession> {
  const s = await RegisterSessionModel.findById(sessionId).session(session ?? null);
  if (!s) throw notFound('Session not found');
  if (s.status === 'closed') return toPublic(s.toObject()) as unknown as RegisterSession;
  s.actualCash = input.actualCash;
  s.difference = round2(input.actualCash - s.expectedCash);
  s.closedAt = input.date ?? nowISO();
  s.status = 'closed';
  if (input.notes) s.notes = input.notes;
  await s.save({ session });
  await CashRegisterModel.updateOne({ _id: s.registerId, currentSessionId: sessionId }, { $set: { currentSessionId: null } }, { session });
  await audit({ userId: input.userId, action: 'register_close', entity: 'register_session', entityId: sessionId, branchId: s.branchId, before: { expected: s.expectedCash }, after: { actual: s.actualCash, difference: s.difference }, ip: input.ip }, session);
  const out = toPublic(s.toObject()) as unknown as RegisterSession;
  afterCommit(() => { void evaluateEventAlerts({ kind: 'register_close', session: out }); });
  return out;
}
