import pino from 'pino';
import { env, isProd, isTest } from '../config/env.js';

/** Credentials and tokens must never reach the log store, whichever shape they arrive in. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'token',
  'refreshToken',
  'accessToken',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
];

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  base: { service: 'moto-api', env: env.NODE_ENV },
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  // Aggregators (Loki/Datadog/CloudWatch) index a string level far better than pino's numeric default.
  formatters: isProd ? { level: (label) => ({ level: label }) } : undefined,
  transport: isProd || isTest ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});
