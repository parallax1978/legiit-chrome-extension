/**
 * The HTTP server around the request handlers of the mock (handlers.mjs).
 * Shared by the local mock server (server.mjs) and by the tests that need a
 * real server: they start it on a free port.
 */
import { createServer } from 'node:http';
import { MAX_REQUEST_BYTES } from './contract.mjs';
import { handleMockRequest } from './handlers.mjs';

/**
 * @param {object} options
 * @param {import('./handlers.mjs').MockState} options.state
 * @param {typeof handleMockRequest} [options.handle] What answers a request. Default: the handlers of the mock.
 * @param {(line: string) => void} [options.log] Called with one line per request.
 * @returns {import('node:http').Server} A server that is not listening yet.
 */
export function createMockServer({ state, handle = handleMockRequest, log = () => {} }) {
  return createServer((req, res) => {
    const chunks = [];
    let kept = 0;
    req.on('data', (chunk) => {
      // A body over 1 MB is answered with 413. One byte over the limit is enough for the handlers to see that it
      // is too large. The rest is read and thrown away, so that the client can finish sending and read the reply.
      if (kept > MAX_REQUEST_BYTES) return;
      chunks.push(chunk);
      kept += chunk.length;
    });
    req.on('end', async () => {
      let result;
      try {
        // "handle" may return a promise: a test server can answer late.
        result = await handle(state, {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')])),
          body: Buffer.concat(chunks).subarray(0, MAX_REQUEST_BYTES + 1).toString('utf8'),
        });
      } catch (error) {
        // Nothing a request contains may stop the mock: it answers 500 and carries on.
        console.error(error);
        result = { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: { code: 'server_error', message: 'The mock failed on this request.' } }) };
      }
      if (res.destroyed) return;
      // The CORS headers of the guide (section 3) are part of every reply the handlers give.
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      log(`${req.method} ${req.url} → ${result.status}`);
    });
  });
}
