import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { badRequest } from '../lib/errors.js';

type Source = 'body' | 'query' | 'params';

export function validate<T extends ZodTypeAny>(schema: T, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(badRequest('Validation failed', 'VALIDATION', result.error.flatten()));
    }
    if (source === 'query') {
      // Express 5 exposes `query` as a getter; stash the parsed value separately.
      (req as Request & { validatedQuery: unknown }).validatedQuery = result.data;
    } else {
      (req as Request & Record<Source, unknown>)[source] = result.data;
    }
    next();
  };
}

export function parsed<T extends ZodTypeAny>(req: Request, _schema: T, source: Source = 'body'): z.infer<T> {
  if (source === 'query') return (req as Request & { validatedQuery?: unknown }).validatedQuery as z.infer<T>;
  return req[source] as z.infer<T>;
}

export function q<T extends ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const r = (req as Request & { validatedQuery?: unknown }).validatedQuery;
  if (r !== undefined) return r as z.infer<T>;
  const result = schema.safeParse(req.query);
  if (!result.success) throw badRequest('Validation failed', 'VALIDATION', result.error.flatten());
  return result.data;
}
