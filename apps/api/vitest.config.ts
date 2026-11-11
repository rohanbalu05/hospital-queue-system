import { defineConfig } from 'vitest/config';

/** Own scratch database, so parallel builders never collide on hqms_test. Created and seeded in global setup. */
export const TEST_DB_NAME = 'hqms_test_api';
const adminUrl = process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${TEST_DB_NAME}`;

// globalSetup runs in this process and workers inherit it, so set the variables here as well as in `env`.
process.env['DATABASE_URL'] = testUrl.toString();
process.env['TEST_ADMIN_DATABASE_URL'] = adminUrl;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    env: {
      DATABASE_URL: testUrl.toString(),
      TEST_ADMIN_DATABASE_URL: adminUrl,
      NODE_ENV: 'test',
      // Tests log in many times from one address.
      LOGIN_RATE_LIMIT_MAX: '1000',
    },
    // All files share one scratch database; run them one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
