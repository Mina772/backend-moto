import { defineConfig } from 'vitest/config';
import config from './vitest.config';

// These acceptance scenarios exercise the API together with the real desktop implementation.
// Keep them separate from the backend-only suite used by standalone builds and installs.
export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ['integration/**/*.test.ts'],
  },
});
