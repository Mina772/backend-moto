#!/usr/bin/env node
/**
 * Runs a local single-node MongoDB replica set (rs0) for development.
 * Transactions require a replica set, so a plain `mongod` is not enough.
 * Data lives in ~/.mongodb/moto-rs0/data (override with MONGO_DBPATH).
 *
 * Foreground by default (Ctrl+C stops it); `--detached` leaves mongod running
 * after this process exits, `--stop` kills a detached instance.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';

const DETACHED = process.argv.includes('--detached');
const STOP = process.argv.includes('--stop');
const PORT = Number(process.env.MONGO_PORT ?? 27017);
const HOST = '127.0.0.1';
const REPL_SET = 'rs0';
const DB_PATH = process.env.MONGO_DBPATH ?? path.join(homedir(), '.mongodb', 'moto-rs0', 'data');
const ADMIN_URI = `mongodb://${HOST}:${PORT}/?directConnection=true`;

function findMongod() {
  if (process.env.MONGOD_PATH) return process.env.MONGOD_PATH;
  const roots = [
    'C:\\Program Files\\MongoDB\\Server',
    '/usr/local/opt/mongodb-community/bin',
    '/usr/bin',
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (root.includes('Server')) {
      const versions = readdirSync(root).sort().reverse();
      for (const v of versions) {
        const exe = path.join(root, v, 'bin', 'mongod.exe');
        if (existsSync(exe)) return exe;
      }
    } else if (existsSync(path.join(root, 'mongod'))) {
      return path.join(root, 'mongod');
    }
  }
  return 'mongod';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isUp() {
  const client = new MongoClient(ADMIN_URI, { serverSelectionTimeoutMS: 1000 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp()) return;
    await sleep(500);
  }
  throw new Error(`mongod did not answer on ${HOST}:${PORT} in time`);
}

const FOREIGN_MONGOD = [
  `another mongod is already listening on ${HOST}:${PORT} without --replSet, so it cannot host ${REPL_SET}.`,
  'On Windows this is normally the "MongoDB" service. Either free the port (Administrator PowerShell):',
  '    Stop-Service MongoDB ; Set-Service MongoDB -StartupType Manual',
  'or run this replica set on a free port by setting both in erp-backend/.env:',
  '    MONGO_PORT=27018',
  '    MONGODB_URI=mongodb://localhost:27018/moto?replicaSet=rs0&directConnection=true',
].join('\n           ');

// The stored config pins a host:port; moving the node to another port needs a forced reconfig.
async function ensureMemberHost(admin) {
  const me = `${HOST}:${PORT}`;
  const { config } = await admin.command({ replSetGetConfig: 1 });
  if (config.members?.some((m) => m.host === me)) return;
  await admin.command({
    replSetReconfig: { ...config, version: (config.version ?? 1) + 1, members: [{ _id: 0, host: me }] },
    force: true,
  });
  console.log(`[local-mongo] reconfigured ${REPL_SET} onto ${me}`);
}

async function ensureReplicaSet() {
  const client = new MongoClient(ADMIN_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const admin = client.db('admin');
  try {
    let initialised = true;
    try {
      await admin.command({ replSetGetStatus: 1 });
    } catch (err) {
      if (err?.codeName === 'NoReplicationEnabled') throw new Error(FOREIGN_MONGOD);
      // InvalidReplicaSetConfig: the stored config names a host:port this node no longer has.
      if (err?.codeName === 'InvalidReplicaSetConfig') initialised = true;
      else if (err?.codeName === 'NotYetInitialized') initialised = false;
      else throw err;
    }
    if (initialised) {
      console.log(`[local-mongo] replica set ${REPL_SET} already initialised`);
      await ensureMemberHost(admin);
    } else {
      await admin.command({
        replSetInitiate: { _id: REPL_SET, members: [{ _id: 0, host: `${HOST}:${PORT}` }] },
      });
      console.log(`[local-mongo] initiated replica set ${REPL_SET}`);
    }
    // A freshly initiated node needs a moment before it elects itself primary.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const status = await admin.command({ replSetGetStatus: 1 });
      if (status.members?.some((m) => m.stateStr === 'PRIMARY')) break;
      await sleep(500);
    }
  } finally {
    await client.close();
  }
}

const PID_FILE = path.join(DB_PATH, '..', 'mongod.pid');

if (STOP) {
  if (!existsSync(PID_FILE)) {
    console.log('[local-mongo] no detached instance recorded');
    process.exit(0);
  }
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  try {
    process.kill(pid);
    console.log(`[local-mongo] stopped mongod (pid ${pid})`);
  } catch {
    console.log(`[local-mongo] pid ${pid} was not running`);
  }
  rmSync(PID_FILE, { force: true });
  process.exit(0);
}

if (await isUp()) {
  console.log(`[local-mongo] mongod already listening on ${HOST}:${PORT}`);
  try {
    await ensureReplicaSet();
  } catch (err) {
    console.error(`[local-mongo] ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

mkdirSync(DB_PATH, { recursive: true });
const mongod = findMongod();
console.log(`[local-mongo] ${mongod}\n[local-mongo] dbpath ${DB_PATH}`);

const child = spawn(
  mongod,
  ['--replSet', REPL_SET, '--dbpath', DB_PATH, '--port', String(PORT), '--bind_ip', HOST, '--quiet'],
  DETACHED
    ? { detached: true, stdio: 'ignore', windowsHide: true }
    : { stdio: ['ignore', 'ignore', 'inherit'] },
);
child.on('error', (err) => {
  console.error('[local-mongo] failed to start mongod:', err.message);
  process.exit(1);
});

if (DETACHED) {
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
} else {
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      child.kill();
      process.exit(0);
    });
  }
}

await waitForServer();
try {
  await ensureReplicaSet();
} catch (err) {
  console.error(`[local-mongo] ${err.message}`);
  process.exit(1);
}
console.log(`[local-mongo] ready → mongodb://${HOST}:${PORT}/moto?replicaSet=${REPL_SET}&directConnection=true`);
if (DETACHED) {
  console.log(`[local-mongo] running detached (pid ${child.pid}) — stop with \`npm run db:stop\``);
  process.exit(0);
}
