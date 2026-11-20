#!/usr/bin/env node
/**
 * Local mock of the Legiit Command Center API, for development.
 *
 *   npm run mock                       → http://localhost:8787
 *   PORT=8788 npm run mock             → another port (PORT=0: any free port; the first line of output names it)
 *   LEGIIT_API_BASE_URL=http://localhost:8787 npm run dev
 *
 * Then connect in the extension with the token "demo-token"
 * ("limited-token" is a second user with fewer features; any other token is refused with 401).
 * The business "biz_harborview" belongs to the second user alone, for the option --other-business of the check:
 *   npm run api:check -- http://localhost:8787 demo-token --other-business=biz_harborview
 * It implements docs/legiit-api/openapi.yaml with fixtures from fixtures/legiit.
 * A request body of more than 1 MB is answered with 413, however large it is.
 */
import { createMockState, MOCK_OTHER_BUSINESS_ID, MOCK_TOKENS } from './handlers.mjs';
import { createMockServer } from './http.mjs';

const DEFAULT_PORT = 8787;
// An empty PORT counts as "not set": Number('') would be 0, which means "any free port".
const wanted = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535) {
  console.error('PORT must be a whole number from 0 to 65535 (0 means: any free port). Example: PORT=8788 npm run mock');
  process.exit(1);
}

const server = createMockServer({ state: createMockState(), log: (line) => console.log(`${new Date().toISOString()}  ${line}`) });

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${wanted} is in use: another program, or a second mock server, listens there.`);
    console.error(`Try another port: PORT=${wanted === 65535 ? wanted - 1 : wanted + 1} npm run mock   (in PowerShell: $env:PORT=${wanted === 65535 ? wanted - 1 : wanted + 1}; npm run mock)`);
  } else {
    console.error(`The mock server could not start: ${error.message}`);
  }
  process.exit(1);
});

server.listen(wanted, '127.0.0.1', () => {
  console.log(`Legiit mock API listening on http://localhost:${server.address().port}`);
  console.log(`Tokens: "${MOCK_TOKENS.valid}" (a user with every feature), "${MOCK_TOKENS.limited}" (a second user with three features). Any other token is refused with 401.`);
  console.log(`The business "${MOCK_OTHER_BUSINESS_ID}" belongs to the second user alone: the first user's token gets 404 "not_found" for it.`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Connections that a client keeps open would keep the server alive.
    server.closeAllConnections();
  });
}
