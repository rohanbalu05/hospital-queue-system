import { defineConfig, devices } from '@playwright/test';

// The end-to-end flow runs against the REAL stack that e2e/stack.ts starts: a freshly seeded PostgreSQL database,
// the built API (apps/api/dist) and the Vite dev server of apps/web proxying /api to it. Nothing is mocked.
// Set PW_CHROMIUM_PATH to use a specific Chromium binary; by default Playwright's own browser (PLAYWRIGHT_BROWSERS_PATH) is used.
const executablePath = process.env['PW_CHROMIUM_PATH'] || undefined;
const webPort = Number(process.env['E2E_WEB_PORT'] ?? 5188);

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/stack.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? `http://127.0.0.1:${webPort}`,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
