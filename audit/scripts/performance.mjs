import { mkdirSync, writeFileSync } from 'node:fs';
const output = new URL('../evidence/performance.json', import.meta.url);
mkdirSync(new URL('../evidence/', import.meta.url), { recursive: true });
import os from 'node:os';
const base = 'http://127.0.0.1:5410/api';
const login = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': 'pos-desktop' }, body: JSON.stringify({ username: 'admin', password: '123456' }) });
if (!login.ok) throw new Error('Isolated fixture login failed');
const { token } = await login.json();
const catalogResponse = await fetch(base + '/products/prod-1', { headers: { Authorization: `Bearer ${token}` } });
if (!catalogResponse.ok) throw new Error('Fixture product unavailable');
const product = await catalogResponse.json();
const endpoints = [`/products/lookup?term=${encodeURIComponent(product.sku)}&branchId=br-1`,`/products/lookup?term=${encodeURIComponent(product.internalBarcode)}&branchId=br-1`,'/reports/accounting?branchId=br-1&from=2020-01-01&to=2030-12-31','/products?pageSize=100&branchId=br-1'];
const results = [];
for (const endpoint of endpoints) {
  const times = [];
  let failures = 0;
  const concurrency = 5;
  const started = performance.now();
  for (let batch = 0; batch < 20; batch++) await Promise.all(Array.from({ length: concurrency }, async () => {
    const start = performance.now();
    try {
      const response = await fetch(base + endpoint, { headers: { Authorization: `Bearer ${token}` } });
      await response.arrayBuffer();
      if (!response.ok) failures++;
    } catch { failures++; }
    times.push(performance.now() - start);
  }));
  const duration = performance.now() - started;
  times.sort((a, b) => a - b);
  const percentile = p => Number(times[Math.ceil(times.length * p) - 1].toFixed(2));
  results.push({ endpoint, samples: times.length, concurrency, failures, errorRate: failures / times.length, p50ms: percentile(.5), p95ms: percentile(.95), p99ms: percentile(.99), throughputPerSecond: Number((times.length * 1000 / duration).toFixed(2)) });
}
writeFileSync(output, JSON.stringify({ environment: { node: process.version, platform: os.platform(), cpu: os.cpus()[0].model, memoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)), database: 'disposable MongoMemoryReplSet, existing synthetic seed', limitations: 'Loopback development measurements, small seeded catalog, no production acceptance thresholds. Includes auth/database overhead; rate limiting disabled in test mode.' }, results }, null, 2));
console.log(JSON.stringify(results, null, 2));
if (results.some(r => r.failures)) process.exitCode = 1;
