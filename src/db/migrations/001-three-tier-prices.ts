import { MongoClient } from 'mongodb';
import { planThreeTierPrices } from './price-plan.js';

// Deliberately read-only. Historical writes require an approved backup and a reviewed plan.
if (process.argv.includes('--apply')) throw new Error('Migration apply is disabled: review the read-only plan and authorize a backed-up migration first');
const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI required');
const client = new MongoClient(uri, { appName: 'moto-price-migration-plan', retryWrites: false, serverSelectionTimeoutMS: 10000 });
try {
  await client.connect();
  const totals = { planned: 0, unchanged: 0, blocked: 0 };
  const cursor = client.db().collection('products').find({}, { projection: { prices: 1, retailPrice: 1, wholesalePrice: 1 } });
  for await (const product of cursor) totals[planThreeTierPrices(product).status]++;
  console.log(JSON.stringify({ mode: 'read-only-plan', totals, rule: 'retailPrice -> retail1 and retail2; wholesalePrice -> wholesale; existing prices preserved; legacy fields retained' }, null, 2));
  if (totals.blocked) process.exitCode = 2;
} finally { await client.close(); }
