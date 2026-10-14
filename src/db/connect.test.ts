import { expect, it, vi } from 'vitest';
vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'production', DNS_SERVERS: '' } }));
vi.mock('../lib/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('./models.js', () => ({ IdempotencyModel: {} }));
vi.mock('mongoose', () => ({ default: { set: vi.fn(), connection: { db: { admin: () => ({ command: async () => ({}) }) } } } }));
import { withTransaction } from './connect.js';

it('refuses every production write without transaction support, including retries', async () => {
  const write = vi.fn(async () => 'non-atomic-write');
  for (let attempt = 0; attempt < 3; attempt++) await expect(withTransaction(write)).rejects.toThrow('transactions unsupported');
  expect(write).not.toHaveBeenCalled();
});
