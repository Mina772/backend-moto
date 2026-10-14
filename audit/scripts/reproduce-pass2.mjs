// Temporarily use only preserved pre-pass source files against new regressions; always restore.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '../..');
const files = ['src/modules/customers/routes.ts', 'src/modules/purchases/routes.ts', 'src/modules/sync/routes.ts'];
const saved = new Map(files.map(file => [file, fs.readFileSync(path.join(root, file))]));
try {
  for (const file of files) fs.copyFileSync(path.join(root, 'audit/originals-pass2', file), path.join(root, file));
  const r = spawnSync('npx', ['vitest', 'run', 'src/test/branch-projection.test.ts'], { cwd: root, encoding: 'utf8', shell: true, windowsHide: true });
  fs.writeFileSync(path.join(root, 'audit/evidence/pass2/reproduced-branch-projection.log'), r.stdout + r.stderr);
  console.log(`Original branch-projection regression exit: ${r.status}`);
  if (r.status !== 1 || !/5 failed/.test(r.stdout + r.stderr)) process.exitCode = 1;
} finally {
  for (const [file, bytes] of saved) fs.writeFileSync(path.join(root, file), bytes);
}
