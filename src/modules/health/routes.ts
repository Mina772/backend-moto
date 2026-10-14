import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { isShuttingDown } from '../../lib/lifecycle.js';

export const healthRouter = Router();

const startedAt = Date.now();
const version = env.APP_VERSION || process.env.npm_package_version || 'unknown';

const meta = () => ({
  time: new Date().toISOString(),
  version,
  uptimeSec: Math.round((Date.now() - startedAt) / 1000),
});

/** Liveness: answers as long as the event loop runs. Never touches the database. */
const live = (_req: Request, res: Response) => {
  res.json({ ok: true, ...meta() });
};
healthRouter.get('/', live);
healthRouter.get('/live', live);

async function pingDb(timeoutMs: number) {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !db) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.admin().ping(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('db ping timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Readiness: fails while draining or when MongoDB is unreachable, so traffic is routed elsewhere. */
healthRouter.get('/ready', async (_req, res) => {
  if (isShuttingDown()) return res.status(503).json({ ok: false, status: 'draining', ...meta() });
  if (!(await pingDb(2_000))) return res.status(503).json({ ok: false, status: 'db_unreachable', ...meta() });
  res.json({ ok: true, status: 'ready', ...meta() });
});
