#!/usr/bin/env node
/**
 * Local mock of the Legiit Command Center API, for development.
 *
 *   npm run mock                       → http://localhost:8787
 *   LEGIIT_API_BASE_URL=http://localhost:8787 npm run dev
 *
 * Then connect in the extension with the token "demo-token"
 * ("limited-token" is a second user with fewer features; any other token is refused with 401).
 * It implements docs/legiit-api/openapi.yaml with fixtures from fixtures/legiit.
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
    let result;
    try {
      result = handleMockRequest(state, {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')])),
        body: Buffer.concat(chunks).toString('utf8'),
      });
    } catch (error) {
      // Nothing a request contains may stop the mock: it answers 500 and carries on.
      console.error(error);
      result = { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: { code: 'server_error', message: 'The mock failed on this request.' } }) };
    }
    // The CORS headers of the guide (section 3) are part of every reply the handlers give.
    res.writeHead(result.status, result.headers);
    res.end(result.body);
    console.log(`${new Date().toISOString()}  ${req.method} ${req.url} → ${result.status}`);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Legiit mock API listening on http://localhost:${port}`);
  console.log(`Tokens: "${MOCK_TOKENS.valid}" (a user with every feature), "${MOCK_TOKENS.limited}" (a second user with three features). Any other token is refused with 401.`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
