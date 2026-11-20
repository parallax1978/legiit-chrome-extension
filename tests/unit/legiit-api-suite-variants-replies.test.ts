// @vitest-environment node
/**
 * Does the conformance check catch a wrong server? Part 1: replies and errors
 * in a wrong shape, the token, CORS, redirects, and a server that cannot be
 * reached. Each test runs the whole check against the mock server with one
 * defect and asserts exactly which checks fail and which warnings appear
 * (tests/api/wrong-servers.ts). Part 2 is legiit-api-suite-variants-saves.test.ts.
 */
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MOCK_TOKENS } from '@@/mock-server/handlers.mjs';
import { runConformance } from '../api/suite';
import { closedPort, defineVariantTests, error, hasValidToken, html, isAi, isBusinessDetails, isSave, json, mock, pathOf, runAgainst, succeeded, withBody, withoutHeaders } from '../api/wrong-servers';

/** Every check that reads the id of a saved item from the reply of a save. C8 reads it with the extension's client. */
const READS_A_SAVE_REPLY = ['C1', 'C2', 'C3', 'C4', 'C5', 'C8', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'];
const failsAll = (ids: readonly string[], message: RegExp): Record<string, RegExp> => Object.fromEntries(ids.map((id) => [id, message]));
/** Every check after group A. They are skipped when the session cannot be read. */
const AFTER_A = ['B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'D1', 'D2', 'D3', 'D4'];

/** The same integer for the same text id, for a server whose ids are numbers. */
const integerIds = new Map<string, number>();
const asInteger = (id: unknown): number => integerIds.get(String(id)) ?? integerIds.set(String(id), 5000 + integerIds.size).get(String(id))!;

describe('the server that is right', () => {
  defineVariantTests([
    { wrong: 'nothing: the unchanged mock passes, with no warning', serve: mock },
    {
      wrong: 'nothing: the replies are compressed with gzip',
      serve: (request, state) => {
        const reply = mock(request, state);
        // The HTTP server of the mock sends the bytes as they are.
        return reply.body ? { ...reply, headers: { ...reply.headers, 'content-encoding': 'gzip' }, body: gzipSync(Buffer.from(reply.body, 'utf8')) as unknown as string } : reply;
      },
    },
    {
      wrong: 'nothing: the id of the user and the ids of saved items are integers, and every save answers 200',
      serve: (request, state) => {
        const reply = mock(request, state);
        if (!succeeded(reply) || !reply.body) return reply;
        if (pathOf(request) === '/v1/session') return withBody(reply, (body) => ({ ...body, user: { ...(body['user'] as object), id: 42 } }));
        return isSave(request) ? withBody({ ...reply, status: 200 }, (body) => ({ ...body, id: asInteger(body['id']) })) : reply;
      },
      also: (result) => expect(result.created.every((item) => /^\d+$/.test(item.id ?? ''))).toBe(true),
    },
  ]);
});

describe('replies in a wrong shape', () => {
  defineVariantTests([
    {
      wrong: 'every reply is wrapped in {"data": …}',
      serve: (request, state) => {
        const reply = mock(request, state);
        return succeeded(reply) && reply.body ? withBody(reply, (body) => ({ data: body })) : reply;
      },
      fails: { A1: /does not match the contract schema "Session": \(body\) has no key "user", which is required/, A2: /the extension cannot use the reply\. It would tell the user: "Legiit sent a reply in an unexpected shape"/ },
      // Without a session nothing else can be checked. The checks that need a token that is known to be valid are skipped too.
      skips: ['A5', 'A6', 'A7', 'A9', ...AFTER_A],
      also: (result) => {
        expect(result.summary).toContain('Account:               NOT CONNECTED: the session could not be read (see A1 and A2)');
        expect(result.summary).toContain('Capabilities:          unknown, because the session could not be read');
        expect(result.summary).not.toContain('Capabilities off');
        expect(result.checks.find((check) => check.id === 'C1')!.message).toBe('the session could not be read: fix A1 and A2 first');
      },
    },
    {
      wrong: 'the reply of every save is wrapped in {"data": …}',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isSave(request) && succeeded(reply) ? withBody(reply, (body) => ({ data: body })) : reply;
      },
      fails: { ...failsAll(READS_A_SAVE_REPLY, /does not match the contract schema "SaveResult": \(body\) has no key "id", which is required/), C8: /the extension would tell the user: "Legiit sent a reply in an unexpected shape"\. The reply must be a JSON object with the "id" of the stored item at the top level/ },
      also: (result) => {
        // The items were stored: the summary says so, although no reply gave an id.
        expect(result.created.length).toBeGreaterThan(20);
        expect(result.created.every((item) => item.id === null)).toBe(true);
        expect(result.summary).toMatch(/Created in this run: {3}\d+ items \(/);
        expect(result.summary).toContain('visibility snapshot (the reply gave no id)');
      },
    },
    {
      wrong: 'a save answers 204 without a body',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isSave(request) && succeeded(reply) ? { ...reply, status: 204, body: '' } : reply;
      },
      fails: { ...failsAll(READS_A_SAVE_REPLY, /answered HTTP 204 without a body\. A save must return a JSON body with the "id" of the stored item/), C8: /the extension would tell the user: "Legiit sent a reply that could not be read"/ },
      also: (result) => expect(result.summary).toContain('gap list (the reply gave no id)'),
    },
    {
      wrong: 'a save answers 200 with an empty body',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isSave(request) && succeeded(reply) ? { ...reply, status: 200, body: '' } : reply;
      },
      fails: { ...failsAll(READS_A_SAVE_REPLY, /answered HTTP 200 without a body\. A save must return a JSON body/), C8: /the extension would tell the user: "Legiit sent a reply that could not be read"/ },
    },
    {
      wrong: 'a save answers 202',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isSave(request) && reply.status === 201 ? { ...reply, status: 202 } : reply;
      },
      // The extension takes every 2xx with an id for a success, so its own client (C8) completes the save.
      fails: failsAll(READS_A_SAVE_REPLY.filter((id) => id !== 'C8'), /expected HTTP 200 or 201, got 202/),
    },
    {
      wrong: 'the reply of a save has no id',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isSave(request) && succeeded(reply) ? withBody(reply, (body) => ({ url: body['url'], saved: true })) : reply;
      },
      fails: { ...failsAll(READS_A_SAVE_REPLY, /\(body\) has no key "id", which is required/), C8: /Legiit sent a reply in an unexpected shape/ },
    },
    {
      wrong: 'the reply of a save is an HTML page',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isSave(request) && succeeded(reply) ? html(200, 'Saved') : reply;
      },
      fails: { ...failsAll(READS_A_SAVE_REPLY, /the reply must be sent with "Content-Type: application\/json"\. It came with "text\/html; charset=utf-8"/), C8: /Legiit sent a reply that could not be read/ },
    },
    {
      wrong: 'the url in the reply of a save is a relative path',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isSave(request) && succeeded(reply) ? withBody(reply, (body) => ({ ...body, url: String(body['url']).replace('https://app.legiit.example', '') })) : reply;
      },
      // The extension shows "Saved" without a link for such a url, so its own client (C8) completes the save.
      fails: failsAll(READS_A_SAVE_REPLY.filter((id) => id !== 'C8'), /"url" must be null, or an absolute URL without spaces that the user can open\. It starts with https:\/\/ \(http:\/\/ on a local test system\)\. Got "\/command-center\//),
    },
    {
      wrong: 'the url in the reply of a save is null (the pages do not exist yet)',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isSave(request) && succeeded(reply) ? withBody(reply, (body) => ({ ...body, url: null })) : reply;
      },
      warns: [
        ['C1', /no "url" in the reply to 3 of 3 saves, so the extension shows "Saved" without an "Open in Command Center" link/],
        ['C2', /no "url" in the reply to 3 of 3 saves/],
        ['C3', /no "url" in the reply to 2 of 2 saves/],
        ['C4', /no "url" in the reply to 3 of 3 saves/],
        ['C5', /no "url" in the reply to 3 of 3 saves/],
      ],
      also: (result) => expect(result.summary).toContain('Links returned:        none in 14 saves'),
    },
    {
      wrong: 'the url in the reply of a save is http, not https',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isSave(request) && succeeded(reply) ? withBody(reply, (body) => ({ ...body, url: String(body['url']).replace('https://', 'http://') })) : reply;
      },
      warns: ['C1', 'C2', 'C3', 'C4', 'C5'].map((id): [string, RegExp] => [id, /"url" is not an https URL \(http:\/\/app\.legiit\.example/]),
    },
    {
      wrong: 'two businesses of the list have the same id',
      serve: (request, state) => {
        const reply = mock(request, state);
        return pathOf(request) === '/v1/businesses' && succeeded(reply) ? withBody(reply, (body) => ({ businesses: [...(body['businesses'] as object[]), (body['businesses'] as object[])[0]] })) : reply;
      },
      fails: { B1: /^GET \/v1\/businesses: two businesses have the same id\. Business ids must be unique\.$/ },
    },
    {
      wrong: 'nothing, but the test account has no business',
      serve: (request, state) => {
        const reply = mock(request, state);
        return pathOf(request) === '/v1/businesses' && succeeded(reply) ? json(200, { businesses: [] }) : reply;
      },
      fails: {
        B1: /^GET \/v1\/businesses: the list is empty\. The test account needs at least one business for the remaining checks\.$/,
        B2: /^There is no business to read: the test account needs at least one\.$/,
      },
      // Without a business, only the workspace can be saved. C9 saves into a business that does not exist.
      skips: ['B5', 'C1', 'C2', 'C3', 'C4', 'C10', 'C11', 'C12'],
      also: (result) => expect(result.checks.find((check) => check.id === 'C1')!.message).toBe('no business to work with: list the "businesses" capability with at least one business, or pass --business=<id>'),
    },
    {
      wrong: 'Business Details carries another id than the list',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isBusinessDetails(request) && succeeded(reply) ? withBody(reply, (body) => ({ ...body, id: 'biz_another_id' })) : reply;
      },
      fails: { B2: /^GET \/v1\/businesses\/biz_brightpath: the reply carries the id "biz_another_id"\. Business Details must carry the same id as the list\.$/ },
    },
    {
      wrong: 'Business Details has snake_case keys (brand_names, focus_keywords)',
      serve: (request, state) => {
        const reply = mock(request, state);
        if (!isBusinessDetails(request) || !succeeded(reply)) return reply;
        return withBody(reply, ({ brandNames, focusKeywords, ...rest }) => ({ ...rest, brand_names: brandNames, focus_keywords: focusKeywords }));
      },
      fails: { B2: /keys are camelCase and case-sensitive\. "brand_names" is not read: the extension expects "brandNames"; "focus_keywords" is not read: the extension expects "focusKeywords"/ },
    },
    {
      wrong: 'nothing: every object has extra fields, also a contract key in a second spelling (updatedAt and updated_at)',
      serve: (request, state) => {
        const reply = mock(request, state);
        if (!reply.body) return reply;
        const extra = { created_at: '2026-11-20 12:00:00', updated_at: '2026-11-20 12:00:00', meta: { page: 1 }, links: { self: 'https://api.legiit.example/self' } };
        return withBody(reply, (body) => (succeeded(reply) ? { ...body, ...extra, brand_names: body['brandNames'] } : { ...body, error: { ...(body['error'] as object), details: [{ field: 'x' }], trace_id: 'abc' }, status: reply.status }));
      },
    },
    {
      wrong: 'a list is sent as an object with numbers as keys (a filtered PHP array)',
      serve: (request, state) => {
        const reply = mock(request, state);
        if (!isBusinessDetails(request) || !succeeded(reply)) return reply;
        return withBody(reply, (body) => ({ ...body, competitors: Object.fromEntries((body['competitors'] as unknown[]).map((competitor, index) => [String(index * 2), competitor])) }));
      },
      fails: { B2: /does not match the contract schema "BusinessDetails": \/competitors must be array or null/ },
    },
    {
      wrong: 'a capability name is misspelt (visibilitySnapshot)',
      prepare: (state) => {
        state.session.capabilities = state.session.capabilities.map((name) => (name === 'visibilitySnapshots' ? 'visibilitySnapshot' : name));
      },
      // The mock goes by the same list: its endpoint is off too, as on a server that reads the name from one place.
      serve: mock,
      warns: [['A1', /the session lists capability names the extension does not know and ignores: visibilitySnapshot\. Check the spelling \(names are case-sensitive\)/]],
      skips: ['B5', 'C1'],
      also: (result) => {
        expect(result.checks.find((check) => check.id === 'C1')!.message).toBe('capability "visibilitySnapshots" is not enabled for this account');
        expect(result.summary).toContain('Capabilities off:      visibilitySnapshots  (their checks were skipped, so this run does not prove them)');
      },
    },
    {
      wrong: 'the session lists no capability, and the replies have no Cache-Control header',
      prepare: (state) => {
        state.session.capabilities = [];
      },
      serve: (request, state) => withoutHeaders(mock(request, state), (name) => name === 'cache-control'),
      warns: [
        ['A1', /the reply has no "Cache-Control: no-store" header/],
        ['A2', /the session lists no capabilities, so the extension shows no Legiit feature at all/],
      ],
      skips: AFTER_A,
    },
    {
      wrong: 'saves into a business are listed without the capability "businesses"',
      prepare: (state) => {
        state.session.capabilities = ['gapLists', 'competitors', 'ai'];
      },
      serve: mock,
      warns: [['A2', /gapLists, competitors listed without "businesses": the user cannot choose a business, so these saves stay disabled/]],
      // No business can be found, so nothing can be saved.
      skips: ['B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'],
    },
    {
      wrong: 'nothing: updatedAt of Industry Pulse is a date and time without a time zone, which the contract allows',
      serve: (request, state) => {
        const reply = mock(request, state);
        return pathOf(request) === '/v1/industry-pulse' && succeeded(reply) ? withBody(reply, (body) => ({ ...body, updatedAt: '2026-11-18T09:00:00.123456' })) : reply;
      },
    },
    {
      wrong: 'an event of Industry Pulse has a date that is no real day',
      serve: (request, state) => {
        const reply = mock(request, state);
        if (pathOf(request) !== '/v1/industry-pulse' || !succeeded(reply)) return reply;
        return withBody(reply, (body) => ({ ...body, events: (body['events'] as object[]).map((event, index) => (index === 1 ? { ...event, date: '2026-02-30' } : event)) }));
      },
      fails: { B4: /\/events\/1\/date must be a calendar day written as YYYY-MM-DD/ },
    },
    {
      wrong: 'the AI endpoint returns the JSON document as an object, and one line for a summary',
      serve: (request, state) => {
        const reply = mock(request, state);
        if (!isAi(request) || !succeeded(reply)) return reply;
        return withBody(reply, (body) => ({ ...body, text: String(body['text']).startsWith('{') ? (JSON.parse(String(body['text'])) as unknown) : 'One line only.' }));
      },
      fails: { D2: /does not match the contract schema "AiCompletionResponse": \/text must be string/ },
      warns: [['D1', /the reply has 1 line; the prompt asks for 3 to 6 bullet points/]],
    },
  ]);
});

describe('errors in a wrong shape', () => {
  defineVariantTests([
    {
      wrong: 'a 401 has no error body ({"message": "Unauthenticated."})',
      serve: (request, state) => {
        const reply = mock(request, state);
        return reply.status === 401 ? json(401, { message: 'Unauthenticated.' }) : reply;
      },
      fails: {
        A3: /^GET \/v1\/session without a token: the error body does not match the contract schema "Error": \(body\) has no key "error", which is required\. Body: \{"message":"Unauthenticated\."\}\n[\s\S]*POST \/v1\/ai\/completions without a token: the error body does not match/,
        A4: /GET \/v1\/session with an unknown token: the error body does not match the contract schema "Error"/,
      },
    },
    {
      wrong: 'a request without a valid token is redirected to a login page',
      serve: (request, state) => {
        const reply = mock(request, state);
        return reply.status === 401 ? { status: 302, headers: { location: '/login' }, body: '' } : reply;
      },
      fails: {
        A3: /GET \/v1\/session without a token: answered with a redirect \(HTTP 302 to \/login\)\. Answer on the URL that was called: the extension never follows a redirect/,
        A4: /POST \/v1\/workspaces\/from-brief with an unknown token: answered with a redirect \(HTTP 302 to \/login\)/,
      },
    },
    {
      wrong: 'every error is an HTML page of the framework',
      serve: (request, state) => {
        const reply = mock(request, state);
        return reply.status >= 400 ? html(reply.status, `Error ${reply.status}`) : reply;
      },
      // A5 passes: an unknown path may answer 404 with any body.
      fails: failsAll(['A3', 'A4', 'B3', 'C6', 'C7', 'C9', 'D3'], /an error must be sent with "Content-Type: application\/json", also when your framework produces the error by itself\. It came with "text\/html; charset=utf-8"\. Body: <!doctype html>/),
    },
    {
      wrong: 'errors are sent as application/problem+json',
      serve: (request, state) => {
        const reply = mock(request, state);
        return reply.status >= 400 ? { ...reply, headers: { ...reply.headers, 'content-type': 'application/problem+json' } } : reply;
      },
      fails: failsAll(['A3', 'A4', 'B3', 'C6', 'C7', 'C9', 'D3'], /an error must be sent with "Content-Type: application\/json"[^\n]*It came with "application\/problem\+json"/),
    },
    {
      wrong: 'every error has its error body, but the status 200',
      serve: (request, state) => {
        const reply = mock(request, state);
        return reply.status >= 400 ? { ...reply, status: 200 } : reply;
      },
      fails: {
        A3: /^GET \/v1\/session without a token: expected HTTP 401, got 200\. The body is an error, but the status is 200: send every error with its HTTP status\. Body: \{"error":/,
        A4: /with an unknown token: expected HTTP 401, got 200\. The body is an error, but the status is 200/,
        A5: /^GET of an unknown path: expected HTTP 404 or 405 or 501, got 200\./,
        B3: /expected HTTP 404, got 200\./,
        C6: /with an empty object: expected HTTP 400 or 422, got 200\. The body is an error, but the status is 200: send every error with its HTTP status\./,
        C7: /with a body that is not JSON: expected HTTP 400 or 422, got 200\./,
        C9: /\(a business that does not exist\): expected HTTP 404, got 200\./,
        C16: /with an empty object: expected HTTP 400 or 422, got 200 \(see C6\)/,
        D3: /without system and prompt: expected HTTP 400 or 422, got 200\./,
      },
      // Nothing was stored by these replies, so the summary does not list them as items.
      also: (result) => expect(result.created.filter((item) => item.note !== null || item.id === null)).toEqual([]),
    },
    {
      wrong: 'an endpoint is in the session, but it is not built',
      serve: (request, state) => (pathOf(request) === '/v1/workspaces/from-brief' && hasValidToken(request) ? error(404, 'not_available', 'No route') : mock(request, state)),
      fails: {
        C5: /^POST \/v1\/workspaces\/from-brief with examples\/createWorkspaceFromBrief\.request\.json: expected HTTP 200 or 201, got 404\. Body: /,
        C6: /^POST \/v1\/workspaces\/from-brief with an empty object: expected HTTP 400 or 422, got 404\./,
        C7: /^POST \/v1\/workspaces\/from-brief with a body that is not JSON: expected HTTP 400 or 422, got 404\./,
        C8: /the extension would tell the user: "This Legiit feature is not available"\. The endpoint answered HTTP 404, which means "not built", although its capability is in the session\. The extension then hides the button\.$/,
        C13: /^POST \/v1\/workspaces\/from-brief with a brief of 5\d\d KB: expected HTTP 200 or 201, got 404\. Body: /,
        C14: /expected HTTP 200 or 201, got 404\./,
        C15: /^POST \/v1\/workspaces\/from-brief with examples\/createWorkspaceFromBrief\.request\.json and values that no example has: expected HTTP 200 or 201, got 404\. Body: /,
      },
      also: (result) => {
        // A 404 says nothing about the body: no check guesses at a value or a column that could be the cause.
        const messages = result.checks.map((check) => check.message).join('\n');
        expect(messages).not.toMatch(/MySQL|Sent alone|do not refuse them as "missing"|Idempotency-Key header was/);
      },
    },
    {
      wrong: 'a missing business answers 404 without the code "not_found"',
      serve: (request, state) => {
        const reply = mock(request, state);
        return reply.status === 404 ? withBody(reply, (body) => ({ error: { ...(body['error'] as object), code: 'route_not_found' } })) : reply;
      },
      fails: {
        B3: /\(an id that no business of this account has\): error\.code is "route_not_found", expected "not_found"\. Without that code the extension takes a missing business for an endpoint that is not built/,
        C9: /visibility-snapshots \(a business that does not exist\): error\.code is "route_not_found", expected "not_found"[\s\S]*content-editor\/documents \(a business that does not exist\)/,
      },
    },
    {
      wrong: 'an unknown path answers with the code "not_found"',
      serve: (request, state) => {
        const reply = mock(request, state);
        return reply.status === 404 ? withBody(reply, (body) => ({ error: { ...(body['error'] as object), code: 'not_found' } })) : reply;
      },
      fails: { A5: /the code "not_found" is reserved for a missing business\. An unknown path must use another code, or no error body/ },
    },
    {
      wrong: 'a valid token gets 401 for a business that does not exist',
      serve: (request, state) => {
        const reply = mock(request, state);
        return reply.status === 404 && pathOf(request).startsWith('/v1/businesses/') ? error(401, 'unauthorised', 'Not your business') : reply;
      },
      fails: {
        A6: /with a valid token: answered 401\. Use 401 only for a bad token/,
        B3: /expected HTTP 404, got 401/,
        C9: /expected HTTP 404, got 401/,
      },
    },
    {
      wrong: 'a missing business answers 400, and the error message repeats the token of the request',
      run: { token: 'lgt_secret_token_0123456789abcdef' },
      serve: (request, state) => {
        // This server knows one more token, and names it in an error.
        const token = /^Bearer (.+)$/i.exec(request.headers['authorization'] ?? '')?.[1] ?? '';
        const reply = mock(token === 'lgt_secret_token_0123456789abcdef' ? { ...request, headers: { ...request.headers, authorization: `Bearer ${MOCK_TOKENS.valid}` } } : request, state);
        return reply.status === 404 && pathOf(request).startsWith('/v1/businesses/') ? error(400, 'bad_request', `The token ${token} has no such business`) : reply;
      },
      // The check shows the body of the reply, with the token taken out.
      fails: {
        B3: /expected HTTP 404, got 400\. Body: \{"error":\{"code":"bad_request","message":"The token <token> has no such business"\}\}/,
        C9: /expected HTTP 404, got 400\. Body: \{"error":\{"code":"bad_request","message":"The token <token> has no such business"\}\}/,
      },
      also: (result) => {
        expect(result.summary).not.toContain('lgt_secret');
        expect(result.summary).toContain('FAILED: 2 checks of 34 failed (B3, C9). 31 passed, 1 skipped.');
      },
    },
  ]);
});

/** What a run with the second user of the mock skips: that user has "businesses", "visibilitySnapshots" and "industryPulse". */
const SMALLER_PLAN_SKIPS = ['B5', 'C2', 'C3', 'C4', 'C5', 'C10', 'C11', 'C13', 'C14', 'D1', 'D2', 'D3', 'D4'];
const OFF_ENDPOINTS = ['/v1/businesses/biz_brightpath/gap-lists', '/v1/businesses/biz_brightpath/competitors', '/v1/businesses/biz_brightpath/content-editor/documents', '/v1/workspaces/from-brief', '/v1/ai/completions'];

describe('an account on a smaller plan: endpoints whose capability is not in the session', () => {
  defineVariantTests([
    {
      wrong: 'nothing: the endpoints that the plan does not include answer 404 with another code than "not_found"',
      run: { token: MOCK_TOKENS.limited },
      serve: mock,
      skips: SMALLER_PLAN_SKIPS,
      also: (result, _state, received) => {
        // A5 sends an empty object to each of the five endpoints that are off, with the token of the run.
        const probes = received.filter((request) => request.method === 'POST' && request.body === '{}' && request.headers['authorization'] === `Bearer ${MOCK_TOKENS.limited}` && !('idempotency-key' in request.headers));
        expect(probes.map((request) => request.path).filter((path) => OFF_ENDPOINTS.includes(path))).toEqual(expect.arrayContaining(OFF_ENDPOINTS));
        expect(result.created.every((item) => item.kind === 'visibility snapshot' && item.note === null)).toBe(true);
      },
    },
    {
      wrong: 'an endpoint whose capability is off answers with the code "not_found"',
      run: { token: MOCK_TOKENS.limited },
      serve: (request, state) => {
        const reply = mock(request, state);
        return reply.status === 404 && reply.body.includes('is not enabled for this account') ? withBody(reply, (body) => ({ error: { ...(body['error'] as object), code: 'not_found' } })) : reply;
      },
      fails: {
        A5: /^POST \/v1\/businesses\/biz_brightpath\/gap-lists \(the capability "gapLists" is not in the session\): the code "not_found" is reserved for a missing business\. An endpoint whose capability is off must use another code, or no error body\.\n[\s\S]*POST \/v1\/ai\/completions \(the capability "ai" is not in the session\): the code "not_found" is reserved/,
      },
      skips: SMALLER_PLAN_SKIPS,
    },
    {
      wrong: 'an endpoint whose capability is off answers 403',
      run: { token: MOCK_TOKENS.limited },
      serve: (request, state) => {
        const reply = mock(request, state);
        return reply.status === 404 && reply.body.includes('is not enabled for this account') ? error(403, 'forbidden', 'Your plan does not include this feature') : reply;
      },
      fails: { A5: /^POST \/v1\/businesses\/biz_brightpath\/gap-lists \(the capability "gapLists" is not in the session\): expected HTTP 404 or 405 or 501 or 400 or 422, got 403\. Use 403 only for a feature that the user has\. A feature that the user does not have answers 404, like an endpoint that does not exist\./ },
      skips: SMALLER_PLAN_SKIPS,
    },
    {
      wrong: 'nothing that breaks a rule: endpoints answer although their capability is not in the session',
      // The session of this account lists three capabilities, but the server goes by the list of the first user.
      run: { token: MOCK_TOKENS.limited },
      prepare: (state) => {
        state.limitedSession.capabilities = ['visibilitySnapshots', 'ai'];
      },
      serve: (request, state) => {
        const reply = mock(request, state);
        const asFirstUser = (): typeof reply => mock({ ...request, headers: { ...request.headers, authorization: `Bearer ${MOCK_TOKENS.valid}` } }, state);
        return reply.status === 404 && reply.body.includes('is not enabled for this account') && hasValidToken(request) ? asFirstUser() : reply;
      },
      // A read that works is a recommendation to list the capability. An empty object is refused for its fields: fine.
      warns: [
        ['A2', /visibilitySnapshots listed without "businesses"/],
        ['A5', /^A5: GET \/v1\/businesses \(the capability "businesses" is not in the session\) answered HTTP 200\. The extension never calls an endpoint whose capability is not listed\. List the capability when the endpoint is ready, or answer 404 when the plan of the user does not include it\.$/],
        ['A5', /GET \/v1\/industry-pulse \(the capability "industryPulse" is not in the session\) answered HTTP 200/],
      ],
      // No business is known, so nothing can be saved. C9 needs none: it saves into a business that does not exist.
      skips: ['B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'],
    },
  ]);
});

describe('the token and the headers of a request', () => {
  defineVariantTests([
    {
      wrong: 'only GET /v1/session checks the token',
      serve: (request, state) => mock(pathOf(request) === '/v1/session' || request.method === 'OPTIONS' ? request : { ...request, headers: { ...request.headers, authorization: `Bearer ${MOCK_TOKENS.valid}` } }, state),
      fails: {
        A3: /GET \/v1\/businesses without a token: expected HTTP 401, got 200\. The server answered a request that it must refuse: check the token on every endpoint\.[\s\S]*POST \/v1\/ai\/completions without a token: expected HTTP 401, got 200\. [^\n]*Without that check, anyone can use your AI model/,
        A4: /POST \/v1\/businesses\/biz_brightpath\/competitors with an unknown token: expected HTTP 401, got 20[01]/,
      },
      also: (result) => {
        // What the server stored for requests without a valid token is in the summary, so that it can be removed.
        const wrong = result.created.filter((item) => item.note === 'STORED ALTHOUGH THE REQUEST HAD NO VALID TOKEN');
        expect(wrong.map((item) => item.kind).sort()).toEqual(['competitor', 'content analysis', 'content analysis', 'gap list', 'gap list', 'visibility snapshot', 'visibility snapshot', 'workspace']);
        expect(result.summary).toMatch(/visibility snapshot vis_\d+ STORED ALTHOUGH THE REQUEST HAD NO VALID TOKEN/);
      },
    },
    {
      wrong: 'every token is accepted, known or not',
      serve: (request, state) => mock(request.headers['authorization'] ? { ...request, headers: { ...request.headers, authorization: `Bearer ${MOCK_TOKENS.valid}` } } : request, state),
      fails: { A4: /^GET \/v1\/session with an unknown token: expected HTTP 401, got 200\. The server answered a request that it must refuse: check the token on every endpoint\.[\s\S]*POST \/v1\/ai\/completions with an unknown token: expected HTTP 401, got 200/ },
    },
    {
      wrong: 'the word "Bearer" is matched with its letter case',
      serve: (request, state) => (/^bearer /.test(request.headers['authorization'] ?? '') ? error(401, 'unauthorised', 'Missing bearer token') : mock(request, state)),
      warns: [['A7', /"Authorization: bearer <token>", with the word in lower case, was answered with 401\. Chrome sends "Bearer", so the extension works, but HTTP says that the word is case-insensitive/]],
    },
    {
      wrong: 'the header X-Legiit-Client is required',
      serve: (request, state) => (request.method !== 'OPTIONS' && !request.headers['x-legiit-client'] ? error(400, 'bad_request', 'X-Legiit-Client is required') : mock(request, state)),
      // Only this check fails. A7 and A8 send that header, so they do not blame the letter case of "Bearer" or the Origin.
      fails: { A9: /GET \/v1\/session without the X-Legiit-Client header: expected HTTP 200, got 400\. The header is for your logs: do not require it\./ },
    },
    {
      wrong: 'requests with an Origin header are refused',
      serve: (request, state) => (request.headers['origin'] && request.method !== 'OPTIONS' ? error(403, 'forbidden', 'Origin not allowed') : mock(request, state)),
      // Chrome adds Origin to every POST of the extension: no save and no AI call works.
      fails: failsAll(['A3', 'A4', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'D1', 'D2', 'D3', 'D4'], /got 403|Legiit rejected the request \(403\): Origin not allowed/),
      also: (result) => {
        // A check names five problems at most, and says how many more there are.
        const c6 = result.checks.find((check) => check.id === 'C6')!.message.split('\n');
        expect(c6).toHaveLength(6);
        expect(c6.at(-1)).toBe('     … and 5 more of this check');
      },
      warns: [['A8', /GET \/v1\/session with an Origin header was answered 403: do not allow or block requests by Origin/]],
    },
    {
      wrong: 'no reply has CORS headers, and OPTIONS is not answered',
      serve: (request, state) => withoutHeaders(request.method === 'OPTIONS' ? error(405, 'method_not_allowed', 'No such method') : mock(request, state), (name) => name.startsWith('access-control-')),
      warns: [['A8', /the CORS safety net is not in place\. [^\n]*OPTIONS \/v1\/session \(before a GET\): status 405 instead of 204; no Access-Control-Allow-Origin for the extension; Access-Control-Allow-Headers does not name authorization, x-legiit-client[^\n]*GET \/v1\/session with an Origin header: the reply has no Access-Control-Allow-Origin/]],
    },
    {
      wrong: 'Access-Control-Allow-Headers is "*", which does not stand for Authorization',
      serve: (request, state) => ({ ...mock(request, state), headers: { ...mock({ ...request, method: 'OPTIONS' }, state).headers, ...mock(request, state).headers, 'access-control-allow-headers': '*' } }),
      warns: [['A8', /OPTIONS \/v1\/session \(before a GET\): Access-Control-Allow-Headers does not name authorization\. OPTIONS \/v1\/ai\/completions \(before a POST\): Access-Control-Allow-Headers does not name authorization\./]],
    },
  ]);
});

describe('a server that does not answer where it was called', () => {
  defineVariantTests([
    {
      wrong: 'every path is redirected to the same path with a slash at the end',
      serve: (request, state) => (request.method !== 'OPTIONS' && !pathOf(request).endsWith('/') ? { status: 301, headers: { location: `${pathOf(request)}/` }, body: '' } : mock(request, state)),
      fails: { A1: /GET \/v1\/session: answered with a redirect \(HTTP 301 to \/v1\/session\/\)\. Answer on the URL that was called: the extension never follows a redirect/ },
      skips: ['A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', ...AFTER_A],
      also: (result, _state, received) => {
        // The check did not follow the redirect either: no request with a slash at the end arrived.
        expect(received.filter((request) => pathOf(request).endsWith('/'))).toEqual([]);
        expect(result.checks.find((check) => check.id === 'B1')!.message).toBe('GET /v1/session got no reply: fix A1 first');
      },
    },
    {
      wrong: 'a POST is redirected',
      serve: (request, state) => (isSave(request) ? { status: 307, headers: { location: `https://www.legiit.example${pathOf(request)}` }, body: '' } : mock(request, state)),
      fails: {
        ...failsAll(['A3', 'A4', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C9', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15'], /answered with a redirect \(HTTP 307 to https:\/\/www\.legiit\.example\/v1\//),
        C8: /the extension would tell the user: "Could not reach Legiit: the Legiit API answered with a redirect \(HTTP 307\) instead of a reply"/,
        C16: /expected HTTP 400 or 422, got 307/,
      },
    },
  ]);

  it('a server that cannot be reached: one check fails with the reason, and the others are skipped', async () => {
    const nothingListens = await closedPort();
    const result = await runConformance({ baseUrl: () => nothingListens, token: () => MOCK_TOKENS.valid, writes: true });
    expect(result.checks.filter((check) => check.outcome === 'failed').map((check) => check.id)).toEqual(['A1']);
    expect(result.checks[0]!.message).toMatch(/^GET \/v1\/session: no reply \(ECONNREFUSED\)\. Check the base URL, and that the server runs and can be reached from this computer\.$/);
    expect(result.checks.slice(1).every((check) => check.outcome === 'skipped' && check.message === 'GET /v1/session got no reply: fix A1 first')).toBe(true);
    expect(result.summary).toContain('Capabilities:          unknown, because the session could not be read');
    expect(result.summary).toContain('FAILED: 1 check of 34 failed (A1). 0 passed, 33 skipped.');
    expect(result.summary).toMatch(/Requests sent: {9}2 \(2 reads, 0 saves, 0 to the AI endpoint, 0 preflight\), the slowest took \d+ ms; 2 got no reply/);
  });

  it('a base URL or a token that cannot be used: the run says so and sends nothing', async () => {
    for (const [baseUrl, token, message] of [
      ['127.0.0.1:8787', MOCK_TOKENS.valid, /^The base URL of the API is not a URL that starts with http:\/\/ or https:\/\//],
      ['ftp://example.com', MOCK_TOKENS.valid, /^The base URL of the API is not a URL/],
      ['https://user:secret@example.com', MOCK_TOKENS.valid, /^The base URL of the API must not contain a user name, a password/],
      ['http://127.0.0.1:1', 'a token with spaces', /^The token is not printable ASCII without spaces/],
      ['http://127.0.0.1:1', 'tökén', /^The token is not printable ASCII/],
    ] as const) {
      const result = await runConformance({ baseUrl: () => baseUrl, token: () => token, writes: true });
      expect(result.requests).toEqual([]);
      expect(result.checks.map((check) => check.outcome)).toEqual(['failed', ...Array.from({ length: 33 }, () => 'skipped')]);
      expect(result.checks[0]!.message).toMatch(message);
      expect(result.checks[1]!.message).toBe('the check could not start: see A1');
      expect(result.summary).not.toContain('secret');
      if (token.includes(' ')) expect(JSON.stringify(result)).not.toContain(token);
    }
  });

  defineVariantTests([
    {
      wrong: 'nothing: the API has a path prefix (https://host/api/lens)',
      run: { basePath: '/api/lens/' },
      serve: (request, state) => (request.path.startsWith('/api/lens/v1/') ? mock({ ...request, path: request.path.slice('/api/lens'.length) }, state) : html(404, 'Not Found')),
      also: (result) => expect(result.requests[0]).toBe('GET /api/lens/v1/session'),
    },
    {
      wrong: 'nothing, but the base URL of the run ends with /v1',
      run: { basePath: '/v1' },
      serve: mock,
      // The mock answers /v1/v1/session with 404, so the session cannot be read. Only the token checks can still run.
      fails: { A1: /^GET \/v1\/session: expected HTTP 200, got 404\. The base URL ends with \/v1: give it without \/v1, the check adds it\. Body: /, A2: /It would tell the user: "This Legiit feature is not available"/ },
      skips: ['A5', 'A6', 'A7', 'A9', ...AFTER_A],
    },
    {
      wrong: 'nothing, but the token of the run is not a token of this API',
      run: { token: 'not-a-token-of-this-api' },
      serve: mock,
      // No check claims that "a valid token" was refused: without a session the token is not known to be valid.
      fails: { A1: /^GET \/v1\/session: expected HTTP 200, got 401\. The token of the run was refused\. Is it a token of this API\? If it is, something in front of the API answers 401, for example HTTP Basic auth on a staging site\. Body: /, A2: /It would tell the user: "Legiit did not accept the token"/ },
      skips: ['A5', 'A6', 'A7', 'A9', ...AFTER_A],
    },
  ]);
});

describe('the checks answer for what the summary says', () => {
  it('a failed AI check names the limit of the API when the reply is 429', async () => {
    const { result } = await runAgainst({ serve: (request, state) => (isAi(request) && hasValidToken(request) ? error(429, 'ai_allowance_used', 'You have used the AI allowance of today. It starts again at 00:00 UTC.') : mock(request, state)) });
    expect(result.checks.filter((check) => check.outcome === 'failed').map((check) => check.id)).toEqual(['D1', 'D2', 'D3', 'D4']);
    expect(result.checks.find((check) => check.id === 'D1')!.message).toBe(
      'POST /v1/ai/completions: expected HTTP 200, got 429. The API limits the requests of the test account. The check sends all its requests within a few seconds (the summary counts them): exempt the test account from the rate limits, or allow for the check. Body: {"error":{"code":"ai_allowance_used","message":"You have used the AI allowance of today. It starts again at 00:00 UTC."}}',
    );
  });
});
