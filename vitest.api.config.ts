import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Configuration for "npm run api:check": the conformance check that the
 * Legiit backend team runs against their API (tests/api/). It needs no
 * browser and no extension build, only Node.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve('src'),
      '@@': resolve('.'),
    },
  },
  define: {
    'import.meta.env.DEV': 'false',
  },
  test: {
    environment: 'node',
    include: ['tests/api/conformance.test.ts'],
    // No time limit per check: every request of the check has its own limit (the limits of the extension: 20
    // seconds, 60 seconds for the AI endpoint), and a request that got no reply in time fails with a sentence
    // that says so. A limit here would end a check in the middle and report nothing useful.
    testTimeout: 0,
    hookTimeout: 0,
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
