import { defineConfig } from '@playwright/test';

/**
 * Generates the screenshots of the API kit's developer guide (docs/legiit-api/images/*.png) from the built
 * extension, the mock API and a fixture page. Run with `npm run screenshots:kit`.
 *
 * It does not build the extension: it uses dist/ as it is, and the spec stops when dist/ is missing or older
 * than src/. Run `npm run build` first in that case.
 */
export default defineConfig({
  testDir: './e2e/kit',
  testMatch: /.*\.shots\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: 'test-results/kit',
  use: { trace: 'off' },
});
