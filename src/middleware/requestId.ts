import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// Only accept ids that are safe to echo back in a header and to index in a log store.
const VALID_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Correlates access logs, error responses and upstream proxy logs through one id per request. */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get('x-request-id');
  const id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export function getRequestId(res: Response): string | undefined {
  return typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;
}
