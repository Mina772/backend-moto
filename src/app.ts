import express from 'express';
import path from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { corsOrigins, env, isProd, isTest } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { getRequestId, requestId } from './middleware/requestId.js';
import { healthRouter } from './modules/health/routes.js';
import { authRouter } from './modules/auth/routes.js';
import { catalogRouter, productsRouter } from './modules/products/routes.js';
import { publicRouter, salesRouter } from './modules/sales/routes.js';
import { customersRouter, debtsRouter } from './modules/customers/routes.js';
import { inventoryRouter, transfersRouter, warehousesRouter } from './modules/inventory/routes.js';
import { purchasesRouter, suppliersRouter } from './modules/purchases/routes.js';
import { branchesRouter, rolesRouter, usersRouter } from './modules/org/routes.js';
import { cashRouter, expensesRouter } from './modules/cash/routes.js';
import { auditRouter, reportsRouter, searchRouter } from './modules/reports/routes.js';
import { alertsRouter, notificationsRouter } from './modules/alerts/routes.js';
import { labelsRouter, printProfilesRouter, settingsRouter } from './modules/settings/routes.js';
import { quickRouter } from './modules/quick/routes.js';
import { whatsappRouter } from './modules/whatsapp/routes.js';
import { syncRouter, terminalsRouter } from './modules/sync/routes.js';

const isHealthPath = (url = '') => url.startsWith('/api/health') || url === '/health';

export function createApp() {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('etag', 'strong');
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // The API serves JSON and uploaded images only; a locked-down CSP costs nothing here.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], imgSrc: ["'self'", 'data:'], frameAncestors: ["'none'"] } },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => {
        // Electron (file://) and same-origin requests have no Origin header.
        if (!origin || corsOrigins.includes(origin) || corsOrigins.includes('*')) return cb(null, true);
        cb(new Error(`CORS: origin ${origin} not allowed`));
      },
      credentials: true,
      exposedHeaders: ['X-Legacy-Barcode', 'Idempotent-Replay'],
    }),
  );
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
  app.use(cookieParser());
  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (_req, res) => getRequestId(res as unknown as express.Response) ?? '',
        autoLogging: { ignore: (req) => isHealthPath(req.url) },
      }),
    );
  }
  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: isProd ? env.RATE_LIMIT_MAX : 5000,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => isTest || isHealthPath(req.originalUrl),
    }),
  );

  const api = express.Router();
  api.use('/health', healthRouter);
  api.use('/auth', authRouter);
  api.use('/products', productsRouter);
  api.use('/catalog', catalogRouter);
  api.use('/sales', salesRouter);
  api.use('/public', publicRouter);
  api.use('/customers', customersRouter);
  api.use('/debts', debtsRouter);
  api.use('/inventory', inventoryRouter);
  api.use('/warehouses', warehousesRouter);
  api.use('/transfers', transfersRouter);
  api.use('/purchases', purchasesRouter);
  api.use('/suppliers', suppliersRouter);
  api.use('/branches', branchesRouter);
  api.use('/users', usersRouter);
  api.use('/roles', rolesRouter);
  api.use('/cash', cashRouter);
  api.use('/expenses', expensesRouter);
  api.use('/reports', reportsRouter);
  api.use('/audit', auditRouter);
  api.use('/search', searchRouter);
  api.use('/alerts', alertsRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/settings', settingsRouter);
  api.use('/print-profiles', printProfilesRouter);
  api.use('/labels', labelsRouter);
  api.use('/quick-products', quickRouter);
  api.use('/whatsapp', whatsappRouter);
  api.use('/sync', syncRouter);
  api.use('/terminals', terminalsRouter);

  app.use('/api', api);
  app.use('/uploads', express.static(path.resolve(env.UPLOAD_DIR), { maxAge: '7d', immutable: true, index: false, dotfiles: 'ignore' }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
