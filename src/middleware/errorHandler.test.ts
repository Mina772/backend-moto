import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError, z } from 'zod';
import { errorHandler } from './errorHandler.js';
import { HttpError } from '../lib/errors.js';

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    locals: { requestId: 'req-test-1' } as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return this.headers[name.toLowerCase()];
    },
  };
  return res as unknown as Response & typeof res;
}

const req = { path: '/api/sales' } as Request;
const next = (() => undefined) as NextFunction;

describe('errorHandler', () => {
  it('reports an unreachable database as a retryable 503', () => {
    for (const err of [
      Object.create(mongoose.mongo.MongoServerSelectionError.prototype) as Error,
      new mongoose.mongo.MongoNetworkError('connection 1 to 127.0.0.1:27017 closed'),
    ]) {
      const res = fakeRes();
      errorHandler(err, req, res, next);
      expect(res.statusCode).toBe(503);
      expect((res.body as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
      expect(res.getHeader('Retry-After')).toBe('5');
    }
  });

  it('keeps every other failure on its own status', () => {
    const cases: [unknown, number, string][] = [
      [new HttpError(422, 'INSUFFICIENT_STOCK', 'no stock'), 422, 'INSUFFICIENT_STOCK'],
      [new ZodError([]), 400, 'VALIDATION'],
      [{ code: 11000, keyPattern: { internalBarcode: 1 } }, 409, 'DUPLICATE'],
      [{ type: 'entity.too.large' }, 413, 'PAYLOAD_TOO_LARGE'],
      [new Error('something else'), 500, 'INTERNAL'],
    ];
    for (const [err, status, code] of cases) {
      const res = fakeRes();
      errorHandler(err, req, res, next);
      expect(res.statusCode).toBe(status);
      expect((res.body as { error: { code: string } }).error.code).toBe(code);
      expect(res.getHeader('Retry-After')).toBeUndefined();
    }
  });

  it('never leaks validation internals as a 500', () => {
    const res = fakeRes();
    const parsed = z.object({ quantity: z.number() }).safeParse({ quantity: 'two' });
    expect(parsed.success).toBe(false);
    errorHandler(parsed.success ? null : parsed.error, req, res, next);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { details: unknown } }).error.details).toBeTruthy();
  });
});
