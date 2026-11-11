import { defineConfig } from 'vitest/config';

// Pure, DB-free tests of the seeded queue simulation. Kept apart from the integration/concurrency
// config, which needs PostgreSQL.
export default defineConfig({
  test: {
    include: ['simulation/**/*.test.ts'],
    root: new URL('..', import.meta.url).pathname,
    testTimeout: 60_000,
  },
});
