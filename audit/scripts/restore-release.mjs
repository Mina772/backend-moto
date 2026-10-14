import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '../..'), backend = root;
const require = createRequire(path.join(backend, 'package.json'));
const { MongoMemoryReplSet } = require('mongodb-memory-server'), { MongoClient, BSON } = require('mongodb');
const run = promisify(execFile), output = path.join(root, 'audit/evidence/release-closure/restore');
await mkdir(output, { recursive: true });
const toolsRoot = path.join(root, 'audit/evidence/release-closure/tools');
const tools = path.join(toolsRoot, (await readdir(toolsRoot)).find(name => name.startsWith('mongodb-database-tools-')), 'bin');
const user = 'isolated_audit_root', password = randomBytes(24).toString('hex');
let repl, client, api;
const result = { passed: false, isolation: 'owned authenticated loopback replica set, synthetic documents, random credentials', docker: 'unavailable', tls: 'not qualified', pitr: 'not qualified' };
const stopApi = async () => { if (!api || api.exitCode !== null) return; api.kill(); await Promise.race([new Promise(resolve => api.once('exit', resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('API stop timeout')), 20000))]); api = null; };
try {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger', auth: { enable: true, customRootName: user, customRootPwd: password } } });
  const base = repl.getUri(), uri = db => {
    const value = new URL(base); value.username = user; value.password = password; value.pathname = `/${db}`; value.searchParams.set('authSource', 'admin'); return value.href;
  };
  client = new MongoClient(uri('release_fixture')); await client.connect();
  const source = client.db('release_fixture');
  const anonymous = new MongoClient(base);
  try { await anonymous.connect(); await assert.rejects(() => anonymous.db('release_fixture').collection('sales').findOne()); } finally { await anonymous.close(); }
  const fixture = {
    sales: [{ _id: 'sale1', total: 100, paid: 50, remaining: 0, status: 'returned' }],
    customerdebts: [{ _id: 'debt1', saleId: 'sale1', remaining: 0, paid: 50, amount: 100 }],
    customerpayments: [{ _id: 'receipt1', saleId: 'sale1', amount: 50 }],
    salereturns: [{ _id: 'return1', saleId: 'sale1', refundAmount: 100, debtReduction: 50, payoutAmount: 50 }],
    purchases: [{ _id: 'purchase1', supplierId: 'supplier1', supplierInvoiceNumber: 'SYN-1', total: 100, paid: 50, remaining: 0 }],
    supplierpayments: [{ _id: 'supplierpay1', purchaseId: 'purchase1', amount: 50 }],
    purchasereturns: [{ _id: 'preturn1', purchaseId: 'purchase1', total: 100, debtReduction: 50, payoutAmount: 50 }],
    supplierreimbursements: [{ _id: 'reimbursement1', returnId: 'preturn1', amount: 50, status: 'received', reference: 'synthetic-bank' }],
    stocklevels: [{ _id: 'stock1', productId: 'product1', quantity: 10, reserved: 0 }],
  };
  for (const [name, docs] of Object.entries(fixture)) { await source.collection(name).insertMany(docs); await source.collection(name).createIndex({ _id: 1, auditMarker: 1 }, { name: 'audit_index' }); }
  const archive = path.join(output, 'synthetic-production-format.archive.gz');
  const dumpConfig = path.join(output, 'dump.config.yml'), restoreConfig = path.join(output, 'restore.config.yml');
  // Disposable credentials are never printed. Config is overwritten after the tools exit.
  await writeFile(dumpConfig, `uri: ${uri('release_fixture')}\n`);
  const dumpAt = performance.now(); const dump = await run(path.join(tools, 'mongodump.exe'), [`--config=${dumpConfig}`, `--archive=${archive}`, '--gzip'], { windowsHide: true, timeout: 60000 });
  result.dumpMs = Math.round(performance.now() - dumpAt); await writeFile(path.join(output, 'dump.log'), dump.stderr);
  await writeFile(restoreConfig, `uri: ${uri('')}\n`);
  const restoreAt = performance.now(); const restoredLog = await run(path.join(tools, 'mongorestore.exe'), [`--config=${restoreConfig}`, `--archive=${archive}`, '--gzip', '--nsFrom=release_fixture.*', '--nsTo=release_restored.*'], { windowsHide: true, timeout: 60000 });
  result.restoreMs = Math.round(performance.now() - restoreAt); await writeFile(path.join(output, 'restore.log'), restoredLog.stderr);
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const restored = client.db('release_restored'), hash = docs => createHash('sha256').update(JSON.stringify(stable(BSON.EJSON.serialize(docs, { relaxed: false })))).digest('hex');
  result.collections = [];
  for (const name of Object.keys(fixture)) {
    const docs = await source.collection(name).find().sort({ _id: 1 }).toArray(), copy = await restored.collection(name).find().sort({ _id: 1 }).toArray();
    assert.equal(hash(copy), hash(docs));
    const indexes = async db => (await db.collection(name).listIndexes().toArray()).map(i => ({ name: i.name, key: i.key, unique: !!i.unique }));
    assert.deepEqual(await indexes(restored), await indexes(source)); result.collections.push({ name, documents: docs.length, sha256: hash(copy), indexesEqual: true });
  }
  assert.equal((await restored.collection('customerpayments').findOne()).amount, (await restored.collection('salereturns').findOne()).payoutAmount);
  assert.equal((await restored.collection('supplierpayments').findOne()).amount, (await restored.collection('supplierreimbursements').findOne()).amount);
  result.archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex'); result.archiveBytes = (await readFile(archive)).length; result.rpo = 'fixture snapshot only; no continuous backup or oplog replay';
  // Real production-mode API process, separate empty fixture DB with authenticated Mongo connection.
  const port = 43000 + Math.floor(Math.random() * 1000), address = `http://127.0.0.1:${port}`;
  const launch = async () => {
    api = spawn(process.execPath, ['dist/server.js'], { cwd: backend, windowsHide: true, env: { ...process.env, NODE_ENV: 'production', PORT: String(port), MONGODB_URI: uri('release_api'), JWT_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'), CORS_ORIGINS: 'https://fixture.example', PUBLIC_URL: 'https://fixture.example', WHATSAPP_MODE: 'web', LOG_LEVEL: 'silent', SHUTDOWN_DRAIN_MS: '0', SHUTDOWN_TIMEOUT_MS: '5000', SEED_ON_START: 'false', ALLOW_DEMO_SEED: 'false', UPLOAD_DIR: path.join(output, 'uploads') } });
    let log = ''; api.stdout.on('data', b => { log += b; }); api.stderr.on('data', b => { log += b; });
    for (let n = 0; n < 100; n++) { if (api.exitCode !== null) throw new Error(`isolated API exited ${api.exitCode}`); try { const response = await fetch(`${address}/api/health`); if (response.ok) return; } catch { /* startup */ } await new Promise(resolve => setTimeout(resolve, 200)); }
    await writeFile(path.join(output, 'api-startup-error.log'), log); throw new Error('isolated API startup timeout');
  };
  await launch();
  assert.equal((await fetch(`${address}/api/products`)).status, 401);
  const health = await fetch(`${address}/api/health`, { headers: { Origin: 'https://fixture.example' } }); assert(health.ok); assert.equal(health.headers.get('access-control-allow-origin'), 'https://fixture.example'); assert(health.headers.get('strict-transport-security'));
  const disallowed = await fetch(`${address}/api/products`, { headers: { Origin: 'https://unapproved.example' } }); assert.notEqual(disallowed.headers.get('access-control-allow-origin'), 'https://unapproved.example');
  await stopApi(); await launch(); assert.equal((await fetch(`${address}/api/products`)).status, 401);
  result.productionApi = { authEnforced: true, allowedCors: true, disallowedCors: true, hstsHeader: true, processRestart: true, dataBase: 'separate synthetic release_api' };
  result.passed = true;
} finally {
  await stopApi(); await client?.close(); await repl?.stop({ doCleanup: false });
  for (const name of ['dump.config.yml', 'restore.config.yml']) await writeFile(path.join(output, name), '# Disposable credentials removed after execution\n');
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
