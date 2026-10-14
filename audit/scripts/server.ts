import { fileURLToPath } from 'node:url';
// Isolated browser-test server. Never loads .env or connects to the configured application database.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'audit-test-secret-abcdefghijklmnopqrstuvwxyz';
process.env.JWT_REFRESH_SECRET = 'audit-test-refresh-secret-abcdefghijklmnopqrstuvwxyz';
process.env.LOG_LEVEL = 'silent';
process.env.BCRYPT_COST = '4';
process.env.CORS_ORIGINS = 'http://127.0.0.1:5373';
process.env.UPLOAD_DIR = fileURLToPath(new URL('../tmp/uploads', import.meta.url));
const { startTestDb, stopTestDb } = await import('../../src/test/harness.ts');
const app = await startTestDb({ seed: true });
const server = app.listen(5410, '127.0.0.1', () => process.stdout.write('AUDIT_SERVER_READY\n'));
async function stop() {
  server.close();
  await stopTestDb();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
