// @vitest-environment node
/**
 * Runs the conformance suite (tests/api/suite.ts, the one the Legiit backend
 * team runs against their API) against the bundled mock server over real
 * HTTP. This keeps three things honest at once: the suite, the mock server
 * and the example files.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll } from 'vitest';
import { createMockState, handleMockRequest, MOCK_TOKENS } from '@@/mock-server/handlers.mjs';
import { defineConformanceSuite } from '../api/suite';

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const state = createMockState();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) headers[key] = Array.isArray(value) ? value.join(',') : (value ?? '');
      const result = handleMockRequest(state, { method: req.method ?? 'GET', path: req.url ?? '/', headers, body: Buffer.concat(chunks).toString('utf8') });
      // No CORS headers on purpose: the extension does not need them (its host permission covers the API host).
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

defineConformanceSuite({ baseUrl: () => baseUrl, token: () => MOCK_TOKENS.valid, writes: true });
