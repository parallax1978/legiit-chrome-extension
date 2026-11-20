import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { DEFAULT_LEGIIT_API_BASE_URL } from './src/config/constants.ts';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve('src'),
      '@@': resolve('.'),
    },
  },
  define: {
    __LEGIIT_API_BASE_URL__: JSON.stringify(DEFAULT_LEGIIT_API_BASE_URL),
    'import.meta.env.DEV': 'false',
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 15_000,
  },
});
