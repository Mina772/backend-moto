import dns from 'node:dns';
import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { writeContext } from '../lib/write-context.js';
import { IdempotencyModel } from './models.js';

mongoose.set('strictQuery', true);

// Some resolvers randomise the letter case of SRV answers (DNS 0x20); the driver's parent-domain
// check is case-sensitive and rejects them with "Server record does not share hostname with parent URI".
const dnsServers = env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean);
if (dnsServers.length) dns.setServers(dnsServers);

let listenersAttached = false;

export async function connectDb(uri = env.MONGODB_URI) {
  txSupported = null;
  if (!listenersAttached) {
    listenersAttached = true;
    mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
    mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
    mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));
  }
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    maxPoolSize: env.MONGO_POOL_SIZE,
    // Azure Cosmos DB hands out URIs with retrywrites=false; an option here would override it.
    ...(/[?&]retrywrites=/i.test(uri) ? {} : { retryWrites: true }),
  });
  if (env.NODE_ENV === 'production' && !(await supportsTransactions())) {
    await mongoose.disconnect();
    throw new Error('MongoDB must run as a replica set in production (transactions unsupported)');
  }
  logger.info({ uri: uri.replace(/\/\/[^@]+@/, '//***@') }, 'MongoDB connected');
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

/** True when the server supports multi-document transactions (replica set / mongos). */
export async function supportsTransactions(): Promise<boolean> {
  try {
    const admin = mongoose.connection.db?.admin();
    if (!admin) return false;
    const info = (await admin.command({ hello: 1 })) as { setName?: string; msg?: string };
    return Boolean(info.setName) || info.msg === 'isdbgrid';
  } catch {
    return false;
  }
}

let txSupported: boolean | null = null;
const transactionContext = new AsyncLocalStorage<{ session: mongoose.ClientSession; committed: (() => void)[] }>();

export function afterCommit(fn: () => void) {
  const active = transactionContext.getStore();
  if (active) active.committed.push(fn);
  else writeContext.exit(fn);
}

/**
 * Runs `fn` inside a transaction when the deployment supports it; otherwise runs without a session.
 * Callers must pass `session` to every query for atomicity.
 */
export async function withTransaction<T>(fn: (session: mongoose.ClientSession | undefined) => Promise<T>): Promise<T> {
  const active = transactionContext.getStore();
  if (active) return fn(active.session);
  if (txSupported === null) {
    txSupported = await supportsTransactions();
    if (!txSupported) {
      logger.warn('MongoDB transactions unsupported (standalone server) — multi-document writes are not atomic');
    }
  }
  const receipt = writeContext.getStore();
  if (!txSupported) {
    if (env.NODE_ENV === 'production' || receipt) throw new Error('MongoDB must run as a replica set (transactions unsupported)');
    return fn(undefined);
  }
  const session = await mongoose.startSession();
  try {
    let result!: T;
    let committed: (() => void)[] = [];
    await session.withTransaction(async () => {
      committed = [];
      await transactionContext.run({ session, committed }, async () => {
        if (receipt && !(await IdempotencyModel.exists({ _id: receipt.id, owner: receipt.owner, state: 'processing' }).session(session))) throw new Error('Idempotency reservation no longer owned');
        result = await fn(session);
        if (receipt) {
          const updated = await IdempotencyModel.updateOne({ _id: receipt.id, owner: receipt.owner, state: 'processing' }, { $set: { state: 'completed', status: receipt.status, response: result } }, { session });
          if (updated.modifiedCount !== 1) throw new Error('Idempotency reservation no longer owned');
        }
      });
    });
    for (const notify of committed) writeContext.exit(notify);
    return result;
  } finally {
    await session.endSession();
  }
}
