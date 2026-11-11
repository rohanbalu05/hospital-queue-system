import { defineConfig, devices } from '@playwright/test';

// Specs in e2e-real run against the REAL stack that tests/e2e/stack.ts starts (fresh seeded PostgreSQL, built API,
// Vite dev server proxying /api). Nothing is mocked. Run with `pnpm e2e:real`; set PW_CHROMIUM_PATH for a specific browser.
const executablePath = process.env['PW_CHROMIUM_PATH'] || undefined;
const webPort = Number(process.env['E2E_WEB_PORT'] ?? 5188);

export default defineConfig({
  testDir: './e2e-real',
  testMatch: '**/*.spec.ts',
  globalSetup: '../../tests/e2e/stack.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
