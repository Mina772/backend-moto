import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { MongoClient } = require('mongodb');
const file = new URL('../../.env', import.meta.url);
const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
const uri = process.env.MONGODB_URI ?? raw.match(/^MONGODB_URI\s*=\s*["']?([^\r\n"']+)/m)?.[1];
const output = new URL('../evidence/pass2/historical-readonly.json', import.meta.url);
mkdirSync(new URL('../evidence/pass2/', import.meta.url), { recursive: true });
if (!uri) { writeFileSync(output, JSON.stringify({ status: 'unavailable', reason: 'No configured database URI' }, null, 2)); process.exit(0); }
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: 'moto-audit-readonly', retryWrites: false });
try {
  await client.connect(); const db = client.db();
  const products = db.collection('products'); const purchases = db.collection('purchases');
  const duplicateGroups = await purchases.aggregate([
    { $match: { supplierInvoiceNumber: { $type: 'string', $ne: '' } } },
    { $group: { _id: { supplier: '$supplierId', number: { $trim: { input: '$supplierInvoiceNumber' } } }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $group: { _id: null, groups: { $sum: 1 }, documents: { $sum: '$count' } } },
  ], { maxTimeMS: 10000 }).toArray();
  const priceShapes = await products.aggregate([{ $group: { _id: { prices: { $type: '$prices' }, retail1: { $type: '$prices.retail1' }, retail2: { $type: '$prices.retail2' }, wholesale: { $type: '$prices.wholesale' }, salePrice: { $type: '$salePrice' }, retailPrice: { $type: '$retailPrice' } }, count: { $sum: 1 } } }], { maxTimeMS: 10000 }).toArray();
  const indexes = (await purchases.listIndexes().toArray()).map(i => ({ key: i.key, unique: Boolean(i.unique), partialFilterExpression: i.partialFilterExpression }));
  writeFileSync(output, JSON.stringify({ status: 'read-only-completed', at: new Date().toISOString(), operations: ['countDocuments', 'aggregate', 'listIndexes'], productCount: await products.countDocuments(), purchaseCount: await purchases.countDocuments(), duplicateSupplierInvoices: duplicateGroups[0] ?? { groups: 0, documents: 0 }, priceShapes, purchaseIndexes: indexes }, null, 2));
} catch (e) { writeFileSync(output, JSON.stringify({ status: 'unavailable', errorType: e.name, reason: 'Configured database connection or read query failed; URI and document contents omitted' }, null, 2)); process.exitCode = 1; }
finally { await client.close(); }
