import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const config = fileURLToPath(new URL('./env.ts', import.meta.url));
function run(overrides: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', config], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development', SEED_ON_START: 'false', ALLOW_DEMO_SEED: 'false', WHATSAPP_MODE: 'web', ...overrides },
    timeout: 15_000,
  });
}

it('rejects fabricated WhatsApp receipts in every runtime environment', () => {
  for (const NODE_ENV of ['development', 'test', 'production']) {
    const result = run({ NODE_ENV, WHATSAPP_MODE: 'mock' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('WHATSAPP_MODE');
  }
});

it('rejects obsolete flags that request insertion of demo records', () => {
  for (const flag of ['SEED_ON_START', 'ALLOW_DEMO_SEED']) {
    const result = run({ [flag]: 'true' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Demo seeding is unavailable');
  }
});

it('requires real credentials for Cloud API mode', () => {
  const result = run({ WHATSAPP_MODE: 'cloud', WHATSAPP_TOKEN: '', WHATSAPP_PHONE_ID: '' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('requires WHATSAPP_TOKEN');
});

it('accepts manual preparation without cloud credentials', () => {
  expect(run({ WHATSAPP_MODE: 'web' }).status).toBe(0);
});
