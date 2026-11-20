import type { Server } from 'node:http';
import type { MockRequest, MockResponse, MockState } from './handlers.mjs';

export interface MockServerOptions {
  state: MockState;
  /** What answers a request. Default: the handlers of the mock. A test server can return a promise, to answer late. */
  handle?: (state: MockState, request: MockRequest) => MockResponse | Promise<MockResponse>;
  /** Called with one line per request ("GET /v1/session → 200"). */
  log?: (line: string) => void;
}

/** An HTTP server around the request handlers of the mock. It is not listening yet. */
export function createMockServer(options: MockServerOptions): Server;
