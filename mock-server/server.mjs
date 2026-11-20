#!/usr/bin/env node
/**
 * Local mock of the Legiit Command Center API, for development.
 *
 *   npm run mock                       → http://localhost:8787
 *   LEGIIT_API_BASE_URL=http://localhost:8787 npm run dev
 *
 * Then connect in the extension with the token "demo-token"
 * ("limited-token" simulates an account with fewer features, "invalid" is rejected).
 * It implements docs/legiit-api-contract.yaml with fixtures from fixtures/legiit.
 */
import { createServer } from 'node:http';
import { createMockState, handleMockRequest, MOCK_TOKENS } from './handlers.mjs';

const port = Number(process.env.PORT ?? 8787);
const state = createMockState();

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => {
    chunks.push(chunk);
    if (chunks.reduce((n, c) => n + c.length, 0) > 5_000_000) req.destroy();
  });
  req.on('end', () => {
    const result = handleMockRequest(state, {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')])),
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(result.status, {
      ...result.headers,
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, accept, x-legiit-client',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    });
    res.end(result.body);
    console.log(`${new Date().toISOString()}  ${req.method} ${req.url} → ${result.status}`);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Legiit mock API listening on http://localhost:${port}`);
  console.log(`Tokens: "${MOCK_TOKENS.valid}" (full access), "${MOCK_TOKENS.limited}" (some features), "${MOCK_TOKENS.invalid}" (rejected)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
