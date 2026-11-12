import { defineConfig } from 'vitest/config';

// Integration and concurrency tests are black-box: real HTTP against the built API (apps/api/dist) and a real
// PostgreSQL scratch database `hqms_test_blackbox` (see support/global-setup.ts). Nothing is mocked.
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', 'simulation/**'],
    globalSetup: ['support/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // All files share one database and one API process; run them one after another.
    fileParallelism: false,
  },
});
