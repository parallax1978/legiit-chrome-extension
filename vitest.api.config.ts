import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Configuration for "npm run api:check": the conformance suite that the
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
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
