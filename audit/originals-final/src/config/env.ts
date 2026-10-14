import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_VERSION: z.string().default(''),
  // directConnection=true: the compose replica set advertises `mongo:27017`, which is unreachable from the host.
  MONGODB_URI: z.string().min(1).default('mongodb://localhost:27017/moto?replicaSet=rs0&directConnection=true'),
  MONGO_POOL_SIZE: z.coerce.number().int().positive().max(500).default(20),
  /** Comma-separated resolvers used instead of the system ones; needed when a router mangles SRV answers. */
  DNS_SERVERS: z.string().default(''),
  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me-please-32chars'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-only-refresh-secret-change-me-32chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173'),
  PUBLIC_URL: z.string().default('http://localhost:5173'),
  UPLOAD_DIR: z.string().default('uploads'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Hops of reverse proxy to trust for client IP / protocol. Set to the real depth behind your LB. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
  JSON_BODY_LIMIT: z.string().default('2mb'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  /** How long in-flight requests get to finish after SIGTERM before the process is killed. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** Delay between failing readiness and closing the listener, so a load balancer can drain us first. */
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).default(5_000),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  /** `none` is required when the web app is served from a different origin than the API. */
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  WHATSAPP_MODE: z.enum(['cloud', 'web']).default('web'),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_ID: z.string().optional(),
  /** Dialling code applied to local numbers before building a wa.me link. */
  WHATSAPP_COUNTRY_CODE: z.string().regex(/^\d{1,4}$/).default('20'),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env: Env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
// Browsers drop a SameSite=None cookie that is not also Secure, which would silently break refresh.
export const cookieSecure = isProd || env.COOKIE_SECURE || env.COOKIE_SAMESITE === 'none';

// Fail explicitly for obsolete flags so an old deployment cannot silently expect demo records.
if (process.env.SEED_ON_START === 'true' || process.env.ALLOW_DEMO_SEED === 'true') {
  console.error('Demo seeding is unavailable. Remove SEED_ON_START / ALLOW_DEMO_SEED and use init-admin with real business details.');
  process.exit(1);
}

if (env.WHATSAPP_MODE === 'cloud' && (!env.WHATSAPP_TOKEN?.trim() || !env.WHATSAPP_PHONE_ID?.trim())) {
  console.error('WHATSAPP_MODE=cloud requires WHATSAPP_TOKEN and WHATSAPP_PHONE_ID.');
  process.exit(1);
}

if (isProd) {
  const problems: string[] = [];
  const explicitlySet = (key: string) => typeof process.env[key] === 'string' && process.env[key] !== '';

  if (env.JWT_SECRET.startsWith('dev-only') || env.JWT_REFRESH_SECRET.startsWith('dev-only')) {
    problems.push('JWT_SECRET / JWT_REFRESH_SECRET still hold their development defaults.');
  }
  if (env.JWT_SECRET.length < 32 || env.JWT_REFRESH_SECRET.length < 32) {
    problems.push('JWT_SECRET and JWT_REFRESH_SECRET must be at least 32 characters.');
  }
  if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    problems.push('JWT_SECRET and JWT_REFRESH_SECRET must differ.');
  }
  if (!explicitlySet('MONGODB_URI')) {
    problems.push('MONGODB_URI must be set explicitly (the localhost default is development-only).');
  }
  if (!explicitlySet('CORS_ORIGINS')) {
    problems.push('CORS_ORIGINS must list the real web origins (the localhost default is development-only).');
  }
  if (corsOrigins.includes('*')) {
    problems.push('CORS_ORIGINS must not be "*" when cookies are used for authentication.');
  }
  if (!explicitlySet('PUBLIC_URL') || env.PUBLIC_URL.startsWith('http://localhost')) {
    problems.push('PUBLIC_URL must be the public https origin (invoice QR links point at it).');
  }
  for (const origin of [...corsOrigins, env.PUBLIC_URL]) {
    if (origin.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(origin)) {
      problems.push(`Refusing plaintext origin "${origin}" — auth cookies require https.`);
    }
  }
  if (problems.length) {
    console.error(`Refusing to start in production:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
}
