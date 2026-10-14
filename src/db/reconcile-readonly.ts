import { MongoClient } from 'mongodb';
import { reconciliationPlan } from './reconciliation-plan.js';
if (process.argv.includes('--apply')) throw new Error('Historical mutations are disabled');
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
const client = new MongoClient(process.env.MONGODB_URI, { retryWrites: false, appName: 'moto-readonly-reconciliation', serverSelectionTimeoutMS: 10000 });
try { await client.connect(); console.log(JSON.stringify(await reconciliationPlan(client.db()), null, 2)); } finally { await client.close(); }
