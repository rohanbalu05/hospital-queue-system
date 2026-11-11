import { defineConfig } from '@playwright/test';

// The sandbox ships Chromium under /opt/pw-browsers. Set PW_CHROMIUM_PATH to point at a specific binary
// when the version Playwright 1.63.0 expects is not installed.
const executablePath = process.env.PW_CHROMIUM_PATH;
const PORT = 4175;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
