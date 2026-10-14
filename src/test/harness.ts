import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { connectDb } from '../db/connect.js';
import { seedDatabase } from './fixtures/seed.js';
import { ensureBootstrap } from '../db/bootstrap.js';

let replset: MongoMemoryReplSet | null = null;
let app: Express | null = null;

export async function startTestDb(opts: { seed?: boolean } = {}) {
  if (!replset) {
    replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await connectDb(replset.getUri('moto-test'));
  }
  await mongoose.connection.dropDatabase();
  await ensureBootstrap();
  if (opts.seed) await seedDatabase();
  app ??= createApp();
  return app;
}

export async function stopTestDb() {
  await mongoose.disconnect();
  await replset?.stop();
  replset = null;
  app = null;
}

export async function loginAs(appInstance: Express, username: string, password = '123456') {
  const res = await request(appInstance).post('/api/auth/login').set('X-Client', 'pos-desktop').send({ username, password });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { token: string; refreshToken: string; user: { id: string; branchId: string } };
}

export const api = (appInstance: Express) => request(appInstance);
