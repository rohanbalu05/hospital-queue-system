import { defineConfig } from 'vitest/config';

// Integration and concurrency tests run against a real PostgreSQL (TEST_DATABASE_URL); never mocked.
export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts', 'concurrency/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Concurrency tests open their own parallel connections; files run one at a time to keep DB state predictable.
    fileParallelism: false,
    env: {
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/hqms_test',
    },
  },
});
