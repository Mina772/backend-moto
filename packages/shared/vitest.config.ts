import { defineConfig } from 'vitest/config';

// Own config so vitest does not inherit the host project's setupFiles/aliases.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
