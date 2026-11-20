/**
 * The self-test of the conformance check: "does the check catch a wrong server?".
 *
 * A "variant" is the bundled mock server with one deliberate defect. The tests
 * in tests/unit/legiit-api-suite-variants-*.test.ts run the whole check against
 * each variant over real HTTP (a server on a free port) and assert exactly
 * which checks fail, with which message, and which warnings appear. Every
 * other check must pass or be skipped. So a check that stops catching its
 * defect, or that starts to fail for a server that is right, breaks "npm test".
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { CORS_HEADERS, createMockState, handleMockRequest, MOCK_TOKENS, type MockRequest, type MockResponse, type MockState } from '@@/mock-server/handlers.mjs';
import { createMockServer } from '@@/mock-server/http.mjs';
import { runConformance, type ConformanceOptions, type ConformanceResult } from './suite';

/** Answers one request. `state` is the state of the mock behind the variant. */
export type Serve = (request: MockRequest, state: MockState) => MockResponse | Promise<MockResponse>;

export interface Variant {
  /** What the server does wrong, in a few words. It is the name of the test. */
  wrong: string;
  serve: Serve;
  /** Changes the state of the mock before the run (the capabilities of the account, for example). */
  prepare?: (state: MockState) => void;
  /** `basePath` is added to the base URL that the check gets ("/v1", "/api/lens"). */
  run?: { token?: string; business?: string; otherBusiness?: string; readOnly?: boolean; limits?: ConformanceOptions['limits']; basePath?: string };
  /** The checks that fail, each with a part of its message. Every other check passes or is skipped. */
  fails?: Record<string, RegExp>;
  /** The warnings, in their order, as [id of the check, a part of the text]. No other warning appears. */
  warns?: [string, RegExp][];
  /** The checks that are skipped. Default: B5, or none when a business of another user is given. */
  skips?: string[];
  /** More to assert about the run. */
  also?: (result: ConformanceResult, state: MockState, received: MockRequest[]) => void;
}

/** The mock itself: the server that is right. */
export const mock = (request: MockRequest, state: MockState): MockResponse => handleMockRequest(state, request);

export const pathOf = (request: MockRequest): string => request.path.split('?')[0]!;
export const isSave = (request: MockRequest): boolean =>
  request.method === 'POST' && (/^\/v1\/businesses\/[^/]+\/(visibility-snapshots|gap-lists|competitors|content-editor\/documents)$/.test(pathOf(request)) || pathOf(request) === '/v1/workspaces/from-brief');
export const isAi = (request: MockRequest): boolean => request.method === 'POST' && pathOf(request) === '/v1/ai/completions';
export const isBusinessDetails = (request: MockRequest): boolean => request.method === 'GET' && /^\/v1\/businesses\/[^/]+$/.test(pathOf(request));
export const succeeded = (reply: MockResponse): boolean => reply.status >= 200 && reply.status < 300;
export const hasValidToken = (request: MockRequest): boolean => /^bearer (demo-token|limited-token)$/i.test(request.headers['authorization'] ?? '');

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): MockResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS_HEADERS, ...headers },
  body: JSON.stringify(body),
});
export const error = (status: number, code: string, message: string): MockResponse => json(status, { error: { code, message } });
export const html = (status: number, title: string): MockResponse => ({ status, headers: { 'content-type': 'text/html; charset=utf-8', ...CORS_HEADERS }, body: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>` });

type Json = Record<string, unknown>;
/** The body of a request or of a reply as JSON, or undefined when it is none. */
export function parsed(text: string | null | undefined): Json | undefined {
  try {
    const value = JSON.parse(text || 'null') as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}
/** The reply with another JSON body. */
export const withBody = (reply: MockResponse, change: (body: Json) => unknown): MockResponse => ({ ...reply, body: JSON.stringify(change(parsed(reply.body) ?? {})) });
/** The reply without some headers. */
export const withoutHeaders = (reply: MockResponse, drop: (name: string) => boolean): MockResponse => ({ ...reply, headers: Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !drop(name))) });
/** Every text in a JSON value. */
export function texts(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value);
  else if (value !== null && typeof value === 'object') for (const child of Object.values(value)) texts(child, found);
  return found;
}
/** A reply that comes after a delay. The timer does not keep the test process alive. */
export const later = (ms: number, reply: MockResponse): Promise<MockResponse> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(reply), ms).unref();
  });

/**
 * A server whose business ids have another form than the ids of the mock: integers, UUIDs, ULIDs. The ids in
 * the paths and in the replies are translated. `otherForm` answers a path whose id has not the form of the scheme.
 */
export function withIds(ids: Record<string, string | number>, wellFormed: (id: string) => boolean, otherForm: (id: string) => MockResponse | null, inner: Serve = mock): Serve {
  const internal = new Map(Object.entries(ids).map(([inside, outside]) => [String(outside), inside]));
  return async (request, state) => {
    const match = /^\/v1\/businesses\/([^/]+)(\/.*)?$/.exec(pathOf(request));
    let translated = request;
    if (match && request.method !== 'OPTIONS') {
      const outside = decodeURIComponent(match[1]!);
      if (!wellFormed(outside)) {
        // Only after the token was checked, as a framework does.
        const answer = hasValidToken(request) ? otherForm(outside) : null;
        if (answer) return answer;
      }
      translated = { ...request, path: `/v1/businesses/${encodeURIComponent(internal.get(outside) ?? 'no-business-has-this-id')}${match[2] ?? ''}` };
    }
    const reply = await inner(translated, state);
    if (!succeeded(reply) || request.method !== 'GET') return reply;
    return withBody(reply, (body) => {
      if (Array.isArray(body['businesses'])) return { ...body, businesses: (body['businesses'] as Json[]).map((business) => ({ ...business, id: ids[String(business['id'])] ?? business['id'] })) };
      return typeof body['id'] === 'string' && body['id'] in ids && 'competitors' in body ? { ...body, id: ids[body['id']] } : body;
    });
  };
}

export interface VariantRun {
  result: ConformanceResult;
  state: MockState;
  received: MockRequest[];
}

/** Runs the whole check against one variant, over HTTP, on a free port. */
export async function runAgainst(variant: Pick<Variant, 'serve' | 'prepare' | 'run'>): Promise<VariantRun> {
  const state = createMockState();
  variant.prepare?.(state);
  const received: MockRequest[] = [];
  const server: Server = createMockServer({
    state,
    handle: (mockState, request) => {
      received.push(request);
      return variant.serve(request, mockState);
    },
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const result = await runConformance({
      baseUrl: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}${variant.run?.basePath ?? ''}`,
      token: () => variant.run?.token ?? MOCK_TOKENS.valid,
      businessId: () => variant.run?.business,
      otherBusinessId: () => variant.run?.otherBusiness,
      writes: !variant.run?.readOnly,
      limits: variant.run?.limits,
    });
    return { result, state, received };
  } finally {
    // A request that the check gave up on can still be open.
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

/** The base URL of a port on which nothing listens. */
export async function closedPort(): Promise<string> {
  const server = createMockServer({ state: createMockState() });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return `http://127.0.0.1:${port}`;
}

/** Registers one test per variant. */
export function defineVariantTests(variants: readonly Variant[]): void {
  for (const variant of variants) {
    it(variant.wrong, async () => {
      const { result, state, received } = await runAgainst(variant);
      const failed = result.checks.filter((check) => check.outcome === 'failed');
      const report = failed.map((check) => `${check.id}: ${check.message}`).join('\n');
      // A failure is always a sentence about the server, never a crash of the check.
      expect(report).not.toContain('The check itself stopped');
      expect(report).not.toMatch(/TypeError|Cannot read properties|undefined \(reading/);
      // Exactly these checks fail, each with its message; no other check fails.
      const inOrder = (ids: string[]): string[] => result.checks.map((check) => check.id).filter((id) => ids.includes(id));
      expect(failed.map((check) => check.id), report.slice(0, 3000)).toEqual(inOrder(Object.keys(variant.fails ?? {})));
      expect(Object.keys(variant.fails ?? {}).filter((id) => !result.checks.some((check) => check.id === id))).toEqual([]);
      for (const check of failed) expect(check.message, check.id).toMatch(variant.fails![check.id]!);
      // Exactly these warnings appear.
      const warnings = result.warnings.join('\n');
      expect(result.warnings.map((warning) => warning.slice(0, warning.indexOf(':'))), warnings).toEqual((variant.warns ?? []).map(([id]) => id));
      (variant.warns ?? []).forEach(([, text], index) => expect(result.warnings[index]).toMatch(text));
      const skipped = result.checks.filter((check) => check.outcome === 'skipped').map((check) => check.id);
      expect(skipped).toEqual(inOrder(variant.skips ?? (variant.run?.otherBusiness ? [] : ['B5'])));
      // The last line of the summary says the same, and the exit code of the runner follows from it.
      const last = result.summary.trimEnd().split('\n').findLast((line) => line.startsWith('  Result:'))!;
      if (failed.length > 0) expect(last).toContain(`FAILED: ${failed.length} ${failed.length === 1 ? 'check' : 'checks'} of ${result.checks.length} failed (${failed.map((check) => check.id).join(', ')})`);
      else expect(last).toMatch(skipped.length > 0 ? /no check failed: \d+ of \d+ passed, \d+ skipped/ : /PASSED: all \d+ checks passed/);
      // The token is never printed.
      expect(JSON.stringify(result)).not.toContain(variant.run?.token ?? MOCK_TOKENS.valid);
      variant.also?.(result, state, received);
    });
  }
}
