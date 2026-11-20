/**
 * Runs the conformance check against a real Legiit API.
 *
 *   npm run api:check -- https://your-staging-host your-test-token
 *
 * Options: --read-only (no save is sent), --business=<id> (save into this
 * business; default: the first one the API lists), --other-business=<id> (a
 * business of ANOTHER user, to check that this token cannot reach it).
 *
 * scripts/api-check.mjs checks the arguments and turns them into the
 * environment variables read below, so the command is the same in every
 * shell. See docs/legiit-api/README.md, "How to test".
 */
import { describe, it } from 'vitest';
import { defineConformanceSuite } from './suite';

const baseUrl = process.env['LEGIIT_API_BASE_URL'];
const token = process.env['LEGIIT_API_TOKEN'];
const write = (process.env['LEGIIT_API_WRITE'] ?? '').trim().toLowerCase();
/** The same words as in scripts/api-check.mjs. */
const READ_ONLY = ['0', 'false', 'no', 'off'];
const FULL = ['', '1', 'true', 'yes', 'on'];

if (!baseUrl || !token || ![...READ_ONLY, ...FULL].includes(write)) {
  describe('Legiit API conformance', () => {
    it('needs the base URL of the API and a token', () => {
      // The values are not printed: one of them may be the token.
      throw new Error(
        !baseUrl || !token
          ? 'Run: npm run api:check -- https://your-staging-host your-test-token'
          : 'LEGIIT_API_WRITE must be 0, false, no or off (a read-only run), or 1, true, yes or on (a full run).',
      );
    });
  });
} else {
  defineConformanceSuite({
    baseUrl: () => baseUrl,
    token: () => token,
    businessId: () => process.env['LEGIIT_API_BUSINESS_ID'] || undefined,
    otherBusinessId: () => process.env['LEGIIT_API_OTHER_BUSINESS_ID'] || undefined,
    writes: !READ_ONLY.includes(write),
  });
}
