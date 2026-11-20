import { defineConfig } from '@playwright/test';

/**
 * Generates the Chrome Web Store screenshots (store/screenshots/*.png) from
 * fixture states, using the built extension. Run with `npm run screenshots`.
 */
export default defineConfig({
  testDir: './e2e/store',
  testMatch: /.*\.shots\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: 'test-results/store',
  use: { trace: 'off' },
});
