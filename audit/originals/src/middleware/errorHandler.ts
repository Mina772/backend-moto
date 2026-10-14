import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isProd } from '../config/env.js';
import { getRequestId } from './requestId.js';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = getRequestId(res);
  if (err instanceof HttpError) {
    if (err.status >= 500) logger.error({ err, path: req.path, requestId }, err.message);
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'Validation failed', details: err.flatten() } });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: err.message } });
  }
  if (typeof err === 'object' && err && 'code' in err && (err as { code: number }).code === 11000) {
    const key = Object.keys((err as { keyPattern?: Record<string, number> }).keyPattern ?? {})[0] ?? 'field';
    return res.status(409).json({ error: { code: 'DUPLICATE', message: `Duplicate value for ${key}`, details: { field: key } } });
  }
  if (typeof err === 'object' && err && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' } });
  }
  // A dead database is transient: say so, or clients cannot tell a retry apart from a bad request.
  if (err instanceof mongoose.mongo.MongoServerSelectionError || err instanceof mongoose.mongo.MongoNetworkError || err instanceof mongoose.mongo.MongoNotConnectedError) {
    logger.error({ err, path: req.path, requestId }, 'database unreachable');
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: { code: 'DB_UNAVAILABLE', message: 'Database temporarily unavailable, please retry', requestId } });
  }
  logger.error({ err, path: req.path, requestId }, 'Unhandled error');
  // In production the id is the only safe handle a user can quote back to support.
  res.status(500).json({ error: { code: 'INTERNAL', message: isProd ? 'Internal server error' : err instanceof Error ? err.message : String(err), requestId } });
}
