import { createMockState, handleMockRequest, type MockState } from '@@/mock-server/handlers.mjs';
import { StaticAuthProvider } from '@/legiit/auth';
import { HttpLegiitClient } from '@/legiit/http-client';

/** A fetch that answers from the mock Legiit handlers, exactly as the mock server would. */
export function mockLegiitFetch(state: MockState) {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const result = handleMockRequest(state, {
      method: init.method ?? 'GET',
      path: u.pathname + u.search,
      headers,
      body: typeof init.body === 'string' ? init.body : null,
    });
    return new Response(result.status === 204 ? null : result.body, { status: result.status, headers: result.headers });
  };
}

export function httpClient(token: string | null = 'demo-token'): { client: HttpLegiitClient; state: MockState; calls: { url: string; init: RequestInit }[] } {
  const state = createMockState();
  const calls: { url: string; init: RequestInit }[] = [];
  const inner = mockLegiitFetch(state);
  const client = new HttpLegiitClient({
    baseUrl: 'https://api.legiit.com/',
    auth: new StaticAuthProvider(token),
    fetch: (url, init = {}) => {
      calls.push({ url, init });
      return inner(url, init);
    },
    clientVersion: '9.9.9',
  });
  return { client, state, calls };
}
