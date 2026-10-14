import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import type { AuditAction } from '@moto/shared';
import { AuditLogModel } from '../db/models.js';
import { newId, nowISO } from './ids.js';

export interface AuditInput {
  userId: string;
  action: AuditAction;
  entity: string;
  entityId: string;
  branchId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string;
  date?: string;
}

export async function audit(input: AuditInput, session?: ClientSession) {
  await AuditLogModel.create(
    [
      {
        _id: newId('aud'),
        userId: input.userId,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        branchId: input.branchId,
        date: input.date ?? nowISO(),
        before: input.before ?? null,
        after: input.after ?? null,
        ip: input.ip ?? '',
      },
    ],
    { session },
  );
}

export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0]!.trim();
  return req.ip ?? '';
}
