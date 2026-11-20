/**
 * Runs the conformance suite against a real Legiit API.
 *
 *   npm run api:check -- https://your-staging-host your-test-token
 *
 * Options: --read-only (nothing is created), --business=<id> (save into this
 * business; default: the first one the API lists), --other-business=<id> (a
 * business of ANOTHER user, to check that this token cannot reach it).
 *
 * scripts/api-check.mjs turns these into the environment variables read
 * below, so the command is the same in every shell.
 * See docs/legiit-api/README.md, "How to test".
 */
import { describe, it } from 'vitest';
import { defineConformanceSuite } from './suite';

const baseUrl = process.env['LEGIIT_API_BASE_URL'];
const token = process.env['LEGIIT_API_TOKEN'];

if (!baseUrl || !token) {
  describe('Legiit API conformance', () => {
    it('needs the address of the API and a token', () => {
      throw new Error('Run: npm run api:check -- https://your-staging-host your-test-token');
    });
  });
} else {
  defineConformanceSuite({
    baseUrl: () => baseUrl,
    token: () => token,
    businessId: () => process.env['LEGIIT_API_BUSINESS_ID'] || undefined,
    otherBusinessId: () => process.env['LEGIIT_API_OTHER_BUSINESS_ID'] || undefined,
    writes: process.env['LEGIIT_API_WRITE'] !== '0',
  });
}
