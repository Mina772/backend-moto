import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { ensureBootstrap } from './bootstrap.js';
import { connectDb, disconnectDb } from './connect.js';
// Side effect: registers every model on the connection so the wipe can enumerate them.
import { SettingsModel } from './models.js';

/**
 * Wipes every business document and leaves a clean install: roles, settings,
 * print profiles, the label template and the root category tree survive. Run `init-admin` afterwards.
 *
 *   npm run db:reset -- --confirm      (PowerShell eats a bare `--`: use "--" --confirm)
 *   NODE_ENV=production CONFIRM_RESET=<dbName> node dist/db/reset-data.js --confirm
 */
const KEEP = new Set(['Role', 'Settings', 'PrintProfile', 'LabelTemplate']);

async function main() {
  await connectDb();
  const dbName = mongoose.connection.name;
  const models = Object.keys(mongoose.models).filter((name) => !KEEP.has(name)).sort();

  const counts: Array<[string, number]> = [];
  for (const name of models) {
    const n = await mongoose.models[name].estimatedDocumentCount();
    if (n > 0) counts.push([name, n]);
  }
  const total = counts.reduce((sum, [, n]) => sum + n, 0);

  console.log(`database: ${dbName}`);
  for (const [name, n] of counts) console.log(`  ${name.padEnd(22)} ${n}`);
  console.log(`  ${'TOTAL'.padEnd(22)} ${total}`);

  // Not `--yes`: npm consumes that one as its own config before the script ever sees it.
  if (!process.argv.includes('--confirm') && process.env.RESET_CONFIRM !== 'true') {
    console.error('\nDry run — nothing deleted. Re-run with --confirm to delete the rows listed above.');
    await disconnectDb();
    process.exit(1);
  }
  if (env.NODE_ENV === 'production' && process.env.CONFIRM_RESET !== dbName) {
    console.error(`\nRefusing: in production set CONFIRM_RESET=${dbName} to confirm.`);
    await disconnectDb();
    process.exit(1);
  }

  for (const name of models) await mongoose.models[name].deleteMany({});
  await SettingsModel.updateOne({ _id: 'app' }, { $set: { 'value.invoice.nextNumber': 1 } });
  // Recreates the root departments and any other bootstrap-owned rows the wipe removed.
  await ensureBootstrap();

  console.log(`\ndeleted ${total} documents — run \`npm run init-admin\` to create the first admin.`);
  await disconnectDb();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
