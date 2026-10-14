import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '../..');
const file = path.join(root, 'src/modules/purchases/routes.ts');
const saved = fs.readFileSync(file);
const current = "await SupplierPaymentModel.create(allocations.map((allocation, i) => ({ ...pay, _id: i === 0 ? pay.id : newId('spay'), id: undefined, purchaseId: allocation.purchaseId, amount: allocation.amount })), { session, ordered: true });";
const old = 'await SupplierPaymentModel.create([{ ...pay, _id: pay.id, id: undefined }], { session });';
try {
  if (!saved.toString().includes(current)) throw new Error('Expected allocation implementation missing');
  fs.writeFileSync(file, saved.toString().replace(current, old));
  const result = spawnSync('npx', ['vitest', 'run', 'src/test/financial-followup.test.ts', '-t', 'automatically allocated supplier'], { cwd: root, encoding: 'utf8', shell: true, windowsHide: true });
  const log = result.stdout + result.stderr;
  fs.writeFileSync(path.join(root, 'audit/evidence/pass2/reproduced-supplier-auto-statement.log'), log);
  if (result.status !== 1 || !log.includes('expected false to be true')) throw new Error('Supplier statement defect was not reproduced');
  console.log('Missing branch supplier receipt reproduced against isolated supplier; source restored');
} finally { fs.writeFileSync(file, saved); }
