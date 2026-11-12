# @hqms/tests

Black-box tests that exercise the system through HTTP and a real PostgreSQL. Owned by the test-engineer from Wave 1.

| Folder         | Runner     | Command                                           | Notes                                                                                                                                                                          |
| -------------- | ---------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `integration/` | Vitest     | `pnpm test` (via the root, runs in `pnpm verify`) | Uses `TEST_DATABASE_URL`                                                                                                                                                       |
| `concurrency/` | Vitest     | `pnpm test:concurrency`                           | T1/T2 race tests, real parallel connections, never mocked (`t1-*`, `t2-golden-http`, `t2-doctor-guard`)                                                                        |
| `e2e/`         | Playwright | `pnpm e2e`                                        | Real stack: `e2e/stack.ts` seeds `hqms_e2e_test`, builds and starts the API (port 3188) and the Vite dev server (port 5188); set `PW_CHROMIUM_PATH` to use a specific Chromium |
| `helpers/`     | n/a        | n/a                                               | Shared fixtures (pool, login, seed lookups)                                                                                                                                    |

Defaults: black-box suites use `hqms_test_blackbox`, the end-to-end flow `hqms_e2e_test` (both recreated every run, admin URL `TEST_ADMIN_DATABASE_URL`); `integration/t3-sse-freshness.test.ts` is the 50-client SSE freshness check.
Folders are created by the test-engineer together with the first test file; commands pass when a folder is absent
(`--passWithNoTests`).
