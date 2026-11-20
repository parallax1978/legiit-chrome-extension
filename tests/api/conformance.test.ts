/**
 * Runs the conformance suite against a real Legiit API.
 *
 *   LEGIIT_API_BASE_URL=https://staging-api.legiit.com LEGIIT_API_TOKEN=<token> npm run api:check
 *
 * Optional:
 *   LEGIIT_API_BUSINESS_ID=<id>   save into this business (default: the first one the API lists)
 *   LEGIIT_API_WRITE=0            read-only run, nothing is created
 *
 * See docs/legiit-api/README.md, "How to test".
 */
import { describe, it } from 'vitest';
import { defineConformanceSuite } from './suite';

const baseUrl = process.env['LEGIIT_API_BASE_URL'];
const token = process.env['LEGIIT_API_TOKEN'];

if (!baseUrl || !token) {
  describe('Legiit API conformance', () => {
    it('needs LEGIIT_API_BASE_URL and LEGIIT_API_TOKEN', () => {
      throw new Error(
        'Set LEGIIT_API_BASE_URL (for example https://staging-api.legiit.com) and LEGIIT_API_TOKEN (a token of a test account), then run "npm run api:check" again.',
      );
    });
  });
} else {
  defineConformanceSuite({
    baseUrl: () => baseUrl,
    token: () => token,
    businessId: () => process.env['LEGIIT_API_BUSINESS_ID'] || undefined,
    writes: process.env['LEGIIT_API_WRITE'] !== '0',
  });
}
