// @vitest-environment node
/**
 * Runs the conformance check (tests/api/suite.ts, the one the Legiit backend
 * team runs against their API) against the bundled mock server over real
 * HTTP, in the three modes of the guide: a full run, a read-only run, and a
 * full run with a business of another user. This keeps three things honest at
 * once: the check, the mock server and the example files.
 *
 * The mock is the reference implementation: the check finds no failure in it
 * and has nothing to warn about. That the check FAILS when a server is wrong
 * is proved in tests/unit/legiit-api-suite-variants.test.ts.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockState, handleMockRequest, MOCK_OTHER_BUSINESS_ID, MOCK_TOKENS, type MockRequest } from '@@/mock-server/handlers.mjs';
import { createMockServer } from '@@/mock-server/http.mjs';
import { defineConformanceSuite, requestExamples, runConformance, type ConformanceResult } from '../api/suite';

/**
 * The numbers that docs/legiit-api/README.md quotes ("Two levels of done", "Rate limits", "Check your API"):
 * change the guide together with this constant. They move when a check changes, and when an example request of a
 * save is added: one more example is one more save and one more item in a full run.
 */
const GUIDE_NUMBERS = {
  /** The example requests of the five saves that the numbers below were counted with. */
  saveExamples: 10,
  checks: 34,
  /** Requests of one run against the mock, by kind. "saves" and "ai" are POST requests, "reads" are GET requests. */
  full: { reads: 29, saves: 63, ai: 6, preflights: 2 },
  readOnly: { reads: 28, saves: 0, ai: 6, preflights: 2 },
  otherBusiness: { reads: 30, saves: 67, ai: 6, preflights: 2 },
  /** Of these, the reads, saves and AI calls that carry no valid token (A3, A4): a rate limit per user does not count them. */
  withoutValidToken: { full: 20, readOnly: 10, otherBusiness: 20 },
  /** What a full run creates in the account. */
  created: { 'visibility snapshot': 7, 'gap list': 6, competitor: 4, 'content analysis': 5, workspace: 6 },
};

const SAVE_OPERATIONS = ['saveVisibilitySnapshot', 'saveGapList', 'addCompetitor', 'sendToContentEditor', 'createWorkspaceFromBrief'];

interface Received extends MockRequest {
  validToken: boolean;
}

/** A mock server on a free port that keeps what it received. */
async function startMock(): Promise<{ baseUrl: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server: Server = createMockServer({
    state: createMockState(),
    handle: (state, request) => {
      // The word Bearer is case-insensitive (A7 sends it in lower case).
      received.push({ ...request, validToken: (request.headers['authorization'] ?? '').toLowerCase() === `bearer ${MOCK_TOKENS.valid}` });
      return handleMockRequest(state, request);
    },
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, close: () => new Promise<void>((done) => server.close(() => done())) };
}

/** The requests by kind, as the summary of the check counts them. */
function kinds(requests: readonly string[]): { reads: number; saves: number; ai: number; preflights: number } {
  const count = (test: (request: string) => boolean): number => requests.filter(test).length;
  return {
    reads: count((r) => r.startsWith('GET ')),
    saves: count((r) => r.startsWith('POST ') && !r.includes('/v1/ai/')),
    ai: count((r) => r.startsWith('POST ') && r.includes('/v1/ai/')),
    preflights: count((r) => r.startsWith('OPTIONS ')),
  };
}

const outcomes = (result: ConformanceResult, outcome: string): string[] => result.checks.filter((check) => check.outcome === outcome).map((check) => check.id);

/** The summary counts every request the server received: the check's own and the ones the extension's client made. */
function expectEveryRequestCounted(result: ConformanceResult, received: readonly Received[]): void {
  expect(result.requests).toHaveLength(received.length);
  expect(result.summary).toContain(`Requests sent:         ${received.length} (`);
  expect(result.requests).toEqual(received.map((request) => `${request.method} ${request.path}`));
}

let mock: Awaited<ReturnType<typeof startMock>>;

beforeAll(async () => {
  mock = await startMock();
});

afterAll(async () => {
  await mock.close();
});

// --- A full run, with every check as a test of its own.
defineConformanceSuite({
  baseUrl: () => mock.baseUrl,
  token: () => MOCK_TOKENS.valid,
  writes: true,
  onFinish: (result) => {
    // The reference implementation follows every rule and every recommendation of the guide.
    expect(result.warnings).toEqual([]);
    expect(outcomes(result, 'failed')).toEqual([]);
    // Without a business of another user exactly one check is skipped.
    expect(outcomes(result, 'skipped')).toEqual(['B5']);
    expect(result.checks).toHaveLength(GUIDE_NUMBERS.checks);
    expect(result.summary).toContain(`Result:                no check failed: ${GUIDE_NUMBERS.checks - 1} of ${GUIDE_NUMBERS.checks} passed, 1 skipped.`);
    expectEveryRequestCounted(result, mock.received);

    // The guide quotes these numbers. They were counted with a fixed number of example requests.
    const saveExamples = SAVE_OPERATIONS.flatMap(requestExamples).length;
    expect(saveExamples, `GUIDE_NUMBERS was counted with ${GUIDE_NUMBERS.saveExamples} example requests of saves. Each one more adds one save and one item: update GUIDE_NUMBERS and tell the owner of docs/legiit-api/README.md.`).toBe(GUIDE_NUMBERS.saveExamples);
    expect(kinds(result.requests)).toEqual(GUIDE_NUMBERS.full);
    expect(mock.received.filter((request) => request.method !== 'OPTIONS' && !request.validToken)).toHaveLength(GUIDE_NUMBERS.withoutValidToken.full);
    expect(result.summary).toContain(`(${GUIDE_NUMBERS.withoutValidToken.full} of the reads, saves and AI calls carried no valid token`);

    // What the run created: every item has an id, nothing is listed twice, nothing was stored by mistake.
    const created: Record<string, number> = {};
    for (const item of result.created) created[item.kind] = (created[item.kind] ?? 0) + 1;
    expect(created).toEqual(GUIDE_NUMBERS.created);
    expect(result.created.every((item) => item.id !== null && item.note === null)).toBe(true);
    expect(new Set(result.created.map((item) => `${item.kind} ${item.id}`)).size).toBe(result.created.length);
    const total = Object.values(GUIDE_NUMBERS.created).reduce((a, b) => a + b, 0);
    expect(result.summary).toContain(`Created in this run:   ${total} items (7 visibility snapshots, 6 gap lists, 4 competitors, 5 content analyses, 6 workspaces)`);

    // The two largest saves have a line of their own, with their size and their time.
    expect(result.summary).toMatch(/Largest saves: {9}gap list of 1,02\d KB in [\d,]+ ms, brief of 5\d\d KB in [\d,]+ ms\n/);
    // The summary starts with the mode and ends with the result, and never shows the token.
    expect(result.summary.split('\n').slice(1, 3)).toEqual(['Legiit API conformance summary', '  Mode:                  full run: test data was created in the account']);
    expect(result.summary.trimEnd().split('\n').at(-2)).toMatch(/^ {2}Result: /);
    expect(result.summary).not.toContain(MOCK_TOKENS.valid);

    // A request that the check writes itself carries the same headers as one that the extension's client sends:
    // B2 reads the business both ways, C8 saves through the client, and C1 saves with a request of the check.
    const withToken = mock.received.filter((request) => request.validToken);
    const without = (headers: Record<string, string>, ...names: string[]): Record<string, string> => Object.fromEntries(Object.entries(headers).filter(([name]) => !names.includes(name)));
    const reads = withToken.filter((request) => request.method === 'GET' && request.path === '/v1/businesses/biz_brightpath');
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const read of reads) expect(read.headers).toEqual(reads[0]!.headers);
    const saves = withToken.filter((request) => request.method === 'POST' && request.path === '/v1/businesses/biz_brightpath/visibility-snapshots');
    expect(saves.some((request) => (request.body ?? '').includes('addedByALaterExtensionVersion') && !('idempotency-key' in request.headers))).toBe(true);
    for (const save of saves) expect(without(save.headers, 'idempotency-key', 'content-length')).toEqual(without(saves[0]!.headers, 'idempotency-key', 'content-length'));
    // What Chrome sends for the extension, as far as the server can see it (guide, section 3).
    expect(saves[0]!.headers).toMatchObject({ accept: 'application/json', 'content-type': 'application/json', 'x-legiit-client': 'legiit-lens/conformance', origin: expect.stringMatching(/^chrome-extension:\/\/[a-p]{32}$/), 'cache-control': 'no-cache', pragma: 'no-cache' });
    expect(reads[0]!.headers).not.toHaveProperty('origin');
  },
});

describe('the other two modes of the check, against the mock', () => {
  it('a read-only run sends no save at all and creates nothing', async () => {
    const server = await startMock();
    try {
      const result = await runConformance({ baseUrl: () => server.baseUrl, token: () => MOCK_TOKENS.valid, writes: false });
      expect(result.warnings).toEqual([]);
      expect(outcomes(result, 'failed')).toEqual([]);
      expect(kinds(result.requests)).toEqual(GUIDE_NUMBERS.readOnly);
      expect(server.received.filter((request) => request.method !== 'OPTIONS' && !request.validToken)).toHaveLength(GUIDE_NUMBERS.withoutValidToken.readOnly);
      // Every POST of the run went to the AI endpoint.
      expect(server.received.filter((request) => request.method === 'POST').every((request) => request.path === '/v1/ai/completions')).toBe(true);
      expect(result.created).toEqual([]);
      expect(result.summary).toContain('Mode:                  read-only: no save was sent');
      expect(result.summary).toContain('Created in this run:   nothing');
      // Every check of group C is skipped, and B5 because no business of another user was given.
      expect(outcomes(result, 'skipped')).toEqual(['B5', ...result.checks.filter((check) => check.id.startsWith('C')).map((check) => check.id)]);
      expect(result.checks.filter((check) => check.id.startsWith('C')).every((check) => check.message === 'read-only run: no save is sent')).toBe(true);
      expectEveryRequestCounted(result, server.received);
    } finally {
      await server.close();
    }
  });

  it('with a business of another user no check is skipped: the run that proves "API done"', async () => {
    const server = await startMock();
    try {
      const result = await runConformance({ baseUrl: () => server.baseUrl, token: () => MOCK_TOKENS.valid, otherBusinessId: () => MOCK_OTHER_BUSINESS_ID, writes: true });
      expect(result.warnings).toEqual([]);
      expect(outcomes(result, 'failed')).toEqual([]);
      expect(outcomes(result, 'skipped')).toEqual([]);
      expect(outcomes(result, 'passed')).toHaveLength(GUIDE_NUMBERS.checks);
      expect(result.summary).toContain(`Result:                PASSED: all ${GUIDE_NUMBERS.checks} checks passed, and no check was skipped.`);
      expect(kinds(result.requests)).toEqual(GUIDE_NUMBERS.otherBusiness);
      expect(server.received.filter((request) => request.method !== 'OPTIONS' && !request.validToken)).toHaveLength(GUIDE_NUMBERS.withoutValidToken.otherBusiness);
      // One read of the other user's business, and one save into it for each of the four saves into a business.
      expect(server.received.filter((request) => request.path.includes(MOCK_OTHER_BUSINESS_ID)).map((request) => request.method)).toEqual(['GET', 'POST', 'POST', 'POST', 'POST']);
      expect(result.created.every((item) => item.note === null)).toBe(true);
      expectEveryRequestCounted(result, server.received);
    } finally {
      await server.close();
    }
  });

  it('the second user of the mock can reach the business that the first user cannot', () => {
    const state = createMockState();
    const get = (token: string, path: string) => handleMockRequest(state, { method: 'GET', path, headers: { authorization: `Bearer ${token}` } });
    expect(get(MOCK_TOKENS.valid, `/v1/businesses/${MOCK_OTHER_BUSINESS_ID}`).status).toBe(404);
    expect(JSON.parse(get(MOCK_TOKENS.valid, `/v1/businesses/${MOCK_OTHER_BUSINESS_ID}`).body)).toEqual(JSON.parse(get(MOCK_TOKENS.valid, '/v1/businesses/no-such-business').body));
    expect(get(MOCK_TOKENS.limited, `/v1/businesses/${MOCK_OTHER_BUSINESS_ID}`).status).toBe(200);
    const ids = (token: string): string[] => (JSON.parse(get(token, '/v1/businesses').body) as { businesses: { id: string }[] }).businesses.map((b) => b.id);
    expect(ids(MOCK_TOKENS.valid)).not.toContain(MOCK_OTHER_BUSINESS_ID);
    // The businesses that both users share come first, so the first business of the list is the same for both.
    expect(ids(MOCK_TOKENS.limited)).toEqual([...ids(MOCK_TOKENS.valid), MOCK_OTHER_BUSINESS_ID]);
  });
});
