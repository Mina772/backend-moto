import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { NextFunction, Request, Response } from 'express';
import { IdempotencyModel } from '../db/models.js';
import { conflict } from '../lib/errors.js';
import { writeContext } from '../lib/write-context.js';

/**
 * Reserves `Idempotency-Key` per user. The domain transaction saves the response
 * together with its writes; concurrent retries wait for that committed response.
 */
export function idempotency(status = 201) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') return next();
    const key = req.header('Idempotency-Key');
    if (!key) return next();
    const userId = req.auth?.id ?? 'anon';
    const id = `${userId}:${key}`;
    const owner = randomUUID();
    const requestHash = createHash('sha256').update(req.originalUrl + JSON.stringify(req.body ?? {})).digest('hex');

    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          await IdempotencyModel.create({ _id: id, userId, requestHash, status, state: 'processing', owner, startedAt: new Date() });
          break;
        } catch (e) {
          if (!(typeof e === 'object' && e !== null && 'code' in e && e.code === 11000)) throw e;
        }
        const existing = await IdempotencyModel.findById(id).lean();
        if (!existing) continue;
        if (existing.requestHash !== requestHash) return next(conflict('Idempotency key reused with a different payload', 'IDEMPOTENCY_MISMATCH'));
        if (existing.state !== 'processing') {
          res.setHeader('Idempotent-Replay', 'true');
          return res.status(existing.status).json(existing.response);
        }
        // Take over crashed reservations after the maximum transaction lifetime. The old writer
        // must still own this row inside its transaction to commit.
        if (existing.startedAt && existing.startedAt.getTime() < Date.now() - 120_000) {
          const claim = await IdempotencyModel.updateOne({ _id: id, owner: existing.owner, state: 'processing', startedAt: existing.startedAt }, { $set: { owner, startedAt: new Date() } });
          if (claim.modifiedCount === 1) break;
        }
        if (Date.now() >= deadline) {
          res.setHeader('Retry-After', '2');
          return next(conflict('Request is still processing; retry with the same key', 'IDEMPOTENCY_IN_PROGRESS'));
        }
        await delay(25);
      }
      res.once('finish', () => {
        if (res.statusCode >= 400) void IdempotencyModel.deleteOne({ _id: id, owner, state: 'processing' }).catch(() => undefined);
      });
      writeContext.run({ id, owner, status }, next);
    } catch (e) {
      next(e);
    }
  };
}
