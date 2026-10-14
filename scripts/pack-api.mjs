#!/usr/bin/env node
/**
 * Builds the backend and packs a deployable zip into release/.
 *
 * The bundle in dist/ already contains @moto/shared, so the artifact is
 * workspace-free: unzip it anywhere, `npm install --omit=dev`, `npm start`.
 * The workspace-only "@moto/shared" dependency is stripped from the shipped
 * package.json because the public registry cannot resolve it.
 *
 * Usage: node scripts/pack-api.mjs [--skip-build]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = ROOT;
const DIST_DIR = path.join(API_DIR, 'dist');
const OUT_DIR = path.join(ROOT, 'release');
const SKIP_BUILD = process.argv.includes('--skip-build');

if (!SKIP_BUILD) {
  console.log('> npm run build');
  const res = spawnSync('npm', ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

if (!existsSync(DIST_DIR)) {
  console.error(`dist not found at ${DIST_DIR} — run without --skip-build.`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(API_DIR, 'package.json'), 'utf8'));
const deps = Object.fromEntries(Object.entries(pkg.dependencies ?? {}).filter(([n]) => !n.startsWith('@moto/')));

const deployPkg = {
  name: pkg.name.replace('@moto/', 'moto-'),
  version: pkg.version,
  private: true,
  type: 'module',
  main: 'dist/server.js',
  engines: { node: '>=22' },
  scripts: {
    start: 'node --env-file-if-exists=.env dist/server.js',
    'init-admin': 'node --env-file-if-exists=.env dist/db/init-admin.js',
    'db:reset': 'node --env-file-if-exists=.env dist/db/reset-data.js',
  },
  dependencies: deps,
};

function walk(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push({ name: rel, data: readFileSync(abs) });
  }
  return out;
}

const entries = [
  ...walk(DIST_DIR, 'dist'),
  { name: 'package.json', data: Buffer.from(`${JSON.stringify(deployPkg, null, 2)}\n`) },
  { name: '.env.example', data: readFileSync(path.join(API_DIR, '.env.example')) },
  { name: 'uploads/.gitkeep', data: Buffer.alloc(0) },
];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Minimal deflate zip writer (no third-party dependency, matches the web exporter's approach). */
function zip(files, mtime = new Date()) {
  const dosTime = ((mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((mtime.getFullYear() - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const deflated = deflateRawSync(file.data, { level: 9 });
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0o644 << 16, 38); // unix mode, so Linux hosts get readable files
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `moto-api-${pkg.version}.zip`);
rmSync(outFile, { force: true });
const archive = zip(entries);
writeFileSync(outFile, archive);

console.log(`\n${path.relative(ROOT, outFile)}  (${(archive.length / 1024 / 1024).toFixed(2)} MB, ${entries.length} files)`);
console.log('On the host: npm install --omit=dev  →  node dist/db/init-admin.js (first time)  →  npm start');
