// @vitest-environment node
/**
 * Runs the conformance suite (tests/api/suite.ts, the one the Legiit backend
 * team runs against their API) against the bundled mock server over real
 * HTTP. This keeps three things honest at once: the suite, the mock server
 * and the example files.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect } from 'vitest';
import { createMockState, handleMockRequest, MOCK_TOKENS } from '@@/mock-server/handlers.mjs';
import { defineConformanceSuite } from '../api/suite';

let server: Server;
let baseUrl = '';
/** Requests the server received, counted on the wire. */
let received = 0;
/** What one full run sends. docs/legiit-api/README.md says "about 60 requests": change both together. */
const GUIDE_NUMBERS = { reads: 21, posts: 34, preflights: 2 };

beforeAll(async () => {
  const state = createMockState();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received += 1;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) headers[key] = Array.isArray(value) ? value.join(',') : (value ?? '');
      const result = handleMockRequest(state, { method: req.method ?? 'GET', path: req.url ?? '/', headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

defineConformanceSuite({
  baseUrl: () => baseUrl,
  token: () => MOCK_TOKENS.valid,
  writes: true,
  onFinish: ({ warnings, requests, summary }) => {
    // The reference implementation follows every recommendation of the guide: the check has nothing to warn about.
    expect(warnings).toEqual([]);
    // The summary counts every request the server received: the check's own and the ones the extension's client made.
    expect(requests).toHaveLength(received);
    expect(summary).toContain(`Requests sent:         ${received} (`);
    // The guide quotes these numbers ("How to test" and the advice on rate limits).
    expect({ reads: requests.filter((r) => r.startsWith('GET ')).length, posts: requests.filter((r) => r.startsWith('POST ')).length, preflights: requests.filter((r) => r.startsWith('OPTIONS ')).length }).toEqual(GUIDE_NUMBERS);
  },
});
