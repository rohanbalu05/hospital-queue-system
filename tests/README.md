# @hqms/tests

Black-box tests that exercise the system through HTTP and a real PostgreSQL. Owned by the test-engineer from Wave 1.

| Folder | Runner | Command | Notes |
| --- | --- | --- | --- |
| `integration/` | Vitest | `pnpm test` (via the root, runs in `pnpm verify`) | Uses `TEST_DATABASE_URL` |
| `concurrency/` | Vitest | `pnpm test:concurrency` | T1/T2 race tests, real parallel connections, never mocked |
| `e2e/` | Playwright | `pnpm e2e` | Needs api + web running; set `PW_CHROMIUM_PATH` to use a pre-installed Chromium |
| `helpers/` | n/a | n/a | Shared fixtures (pool, login, seed lookups) |

Defaults: `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/hqms_test`, `E2E_BASE_URL=http://localhost:5173`.
Folders are created by the test-engineer together with the first test file; commands pass when a folder is absent
(`--passWithNoTests`).
