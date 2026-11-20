import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests load the built extension (dist/) in Chromium and serve
 * fixtures by intercepting the real URLs, so no test ever touches live
 * Google, an AI site, the Wayback Machine or Legiit.
 *
 * Run with `npm run e2e` (builds first) or `npm run e2e:only`.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  // Each test launches its own browser profile with the extension installed.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: { trace: 'off' },
});
