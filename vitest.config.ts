import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
