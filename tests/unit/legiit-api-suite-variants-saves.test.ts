// @vitest-environment node
/**
 * Does the conformance check catch a wrong server? Part 2: what a server does
 * with the body of a save, with the business in the path, with the
 * Idempotency-Key, with large bodies and with time. Each test runs the whole
 * check against the mock server with one defect and asserts exactly which
 * checks fail and which warnings appear (tests/api/wrong-servers.ts).
 * Part 1 is legiit-api-suite-variants-replies.test.ts.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { createMockState, handleMockRequest, MOCK_OTHER_BUSINESS_ID, MOCK_TOKENS, type MockRequest, type MockResponse, type MockState } from '@@/mock-server/handlers.mjs';
import { loadContract, runConformance } from '../api/suite';
import { defineVariantTests, error, hasValidToken, html, isAi, isBusinessDetails, isSave, json, later, mock, parsed, pathOf, succeeded, texts, withBody, withIds, type Serve } from '../api/wrong-servers';

type Json = Record<string, unknown>;
const SAVE_SCHEMAS: [RegExp, string][] = [
  [/\/visibility-snapshots$/, 'VisibilitySnapshot'],
  [/\/gap-lists$/, 'GapList'],
  [/\/competitors$/, 'Competitor'],
  [/\/content-editor\/documents$/, 'ContentEditorDocument'],
  [/\/workspaces\/from-brief$/, 'WorkspaceFromBrief'],
  [/\/ai\/completions$/, 'AiCompletionRequest'],
];

/** The contract with every list of "values in this version" turned into a closed list: what a validator does that copies the list. */
const closedLists = (() => {
  const closed = structuredClone(loadContract()) as { components: { schemas: Record<string, Json> } };
  const close = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(close);
    if (node === null || typeof node !== 'object') return;
    const schema = node as Json;
    if (Array.isArray(schema['x-values']) && schema['type'] === 'string') schema['enum'] = schema['x-values'];
    Object.values(schema).forEach(close);
  };
  close(closed.components.schemas);
  delete closed.components.schemas['Capability']!['enum'];
  const ajv = new Ajv2020({ allErrors: false, strict: false, validateSchema: false });
  addFormats(ajv);
  ajv.addSchema({ ...closed, $id: 'https://legiit.invalid/closed' });
  return (request: MockRequest): string | null => {
    const schema = SAVE_SCHEMAS.find(([path]) => path.test(pathOf(request)))?.[1];
    const validate = schema ? ajv.getSchema(`https://legiit.invalid/closed#/components/schemas/${schema}`) : undefined;
    if (!validate || validate(parsed(request.body))) return null;
    const first = validate.errors?.[0];
    return first?.keyword === 'enum' ? `${first.instancePath.slice(1).replace(/\//g, '.')} is not one of the allowed values` : null;
  };
})();

let junk = 0;
/** What a server answers that stored something it had to refuse. */
const storedAnyway = (): MockResponse => json(201, { id: `junk_${++junk}`, url: null });
/** A check that the server makes after the token, before anything else: `refuse` returns the reply, or null to go on. */
const refusing =
  (refuse: (request: MockRequest, body: Json | undefined) => MockResponse | null): Serve =>
  (request, state) =>
    (hasValidToken(request) && request.method === 'POST' ? refuse(request, parsed(request.body)) : null) ?? mock(request, state);

describe('what a server does with the body of a save', () => {
  defineVariantTests([
    {
      wrong: 'a save stores every JSON object',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isSave(request) && reply.status === 422 ? storedAnyway() : reply;
      },
      fails: {
        C6: /^POST \/v1\/businesses\/biz_brightpath\/visibility-snapshots with an empty object: expected HTTP 400 or 422, got 201\. The server stored a body that it must refuse: check that the body has the required keys in the right types\.[\s\S]*… and 5 more of this check$/,
        C16: /with an empty object: expected HTTP 400 or 422, got 201 \(see C6\)\. So this check cannot say whether an error is remembered/,
      },
      also: (result) => {
        // The summary lists what the server stored by mistake, so that it can be removed.
        const wrong = result.created.filter((item) => item.note === 'STORED ALTHOUGH THE BODY IS NOT VALID');
        expect(wrong).toHaveLength(11);
        expect(result.summary).toMatch(/competitor junk_\d+ STORED ALTHOUGH THE BODY IS NOT VALID/);
      },
    },
    {
      wrong: 'only the first save checks its body',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isSave(request) && reply.status === 422 && !pathOf(request).endsWith('/visibility-snapshots') ? storedAnyway() : reply;
      },
      fails: { C6: /^POST \/v1\/businesses\/biz_brightpath\/gap-lists with an empty object: expected HTTP 400 or 422, got 201[\s\S]*\/competitors with an empty object[\s\S]*… and 3 more of this check$/ },
    },
    {
      wrong: 'a save checks only that the required keys are there, not their types',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isSave(request) && reply.status === 422 && Object.keys(parsed(request.body) ?? {}).length > 1 ? storedAnyway() : reply;
      },
      fails: { C6: /^POST \/v1\/businesses\/biz_brightpath\/visibility-snapshots with examples\/saveVisibilitySnapshot\.request\.json with a text in "firstScreenShares", which must be a list: expected HTTP 400 or 422, got 201[\s\S]*with a text in "rows", which must be a list[\s\S]*with a text in "domains", which must be a list/ },
    },
    {
      wrong: 'a body that is not JSON causes a 500',
      serve: (request, state) => {
        const reply = mock(request, state);
        return reply.status === 400 ? html(500, 'Server Error') : reply;
      },
      fails: { C7: /^POST \/v1\/businesses\/biz_brightpath\/visibility-snapshots with a body that is not JSON: expected HTTP 400 or 422, got 500\./ },
    },
    {
      wrong: 'values that are empty ("" and []) are refused as missing',
      // What the rule "required" of Laravel does, on the fields that no example file has empty.
      serve: refusing((request, body) => {
        const empty = (value: unknown): boolean => value === '' || (Array.isArray(value) && value.length === 0);
        const path = pathOf(request);
        const missing = !body
          ? null
          : path.endsWith('/visibility-snapshots') && 'tracked' in body && (empty(body['tracked']) || empty(body['firstScreenShares']))
            ? 'tracked'
            : path.endsWith('/gap-lists') && Array.isArray(body['rows']) && (body['rows'] as Json[]).some((row) => row['title'] === '')
              ? 'rows.0.title'
              : path.endsWith('/content-editor/documents') && 'onlyHere' in body && empty(body['onlyHere'])
                ? 'onlyHere'
                : path.endsWith('/from-brief') && 'nextSteps' in body && empty(body['nextSteps'])
                  ? 'nextSteps'
                  : null;
        return missing ? error(422, 'invalid', `The ${missing} field is required.`) : null;
      }),
      fails: {
        C1: /with examples\/saveVisibilitySnapshot\.request\.json and these empty values: tracked = \[\], firstScreenShares = \[\], [^\n]*: expected HTTP 200 or 201, got 422\. The extension sends these values\. They are valid: do not refuse them as "missing"\. Body: \{"error":\{"code":"invalid","message":"The tracked field is required\."\}\}$/,
        C2: /and these empty values: subject = "", title = "" in one row, url = null and domain = null in one row: expected HTTP 200 or 201, got 422/,
        C4: /and these empty values: targetKeyword = "", pageTitle = "", onlyHere = \[\], missingPoints = \[\]: expected HTTP 200 or 201, got 422/,
        C5: /and these empty values: nextSteps = \[\], issues = \[\], [^\n]*competitors\[0\]\.domains = \[\]: expected HTTP 200 or 201, got 422/,
      },
    },
    {
      wrong: 'a list of "values in this version" is treated as a closed list',
      serve: refusing((request) => {
        const problem = closedLists(request);
        return problem ? error(422, 'invalid', problem) : null;
      }),
      fails: {
        C15: /^POST \/v1\/businesses\/biz_brightpath\/visibility-snapshots with examples\/saveVisibilitySnapshot\.request\.json and values that no example has: expected HTTP 200 or 201, got 422\. Sent alone, this part was refused with HTTP 422: values of a later extension version \(mode = "a-mode-added-later", firstScreenShares\[0\]\.type = "a_block_added_later"\)\. Accept a value you do not know where the reference says "Values in this version": store it as text\. Body: \{"error":\{"code":"invalid","message":"mode is not one of the allowed values"\}\}\n[\s\S]*issues\[0\]\.code = "a-finding-added-later"/,
        D4: /^POST \/v1\/ai\/completions with task = "a-task-added-later": expected HTTP 200, got 422\. "task" is for your metering and logs\. Accept a value you do not know/,
      },
      also: (result) => {
        // Only the group of values that was refused is named: the URL and the emoji were accepted.
        const message = result.checks.find((check) => check.id === 'C15')!.message;
        expect(message).not.toContain('a URL with the characters');
        expect(message).not.toContain('an emoji');
        expect(message.split('\n')).toHaveLength(4);
      },
    },
    {
      wrong: 'a URL with | [ ] is refused by a strict validator',
      serve: refusing((_request, body) => (texts(body).some((text) => /^https?:\/\/\S*[|[\]]/.test(text)) ? error(422, 'invalid', 'The url field must be a valid URL.') : null)),
      fails: { C15: /^POST [^\n]* and values that no example has: expected HTTP 200 or 201, got 422\. Sent alone, this part was refused with HTTP 422: a URL with the characters \| \[ \] \(organic\[0\]\.url = "https:\/\/example\.com\/a\|b\?x=\[1\]"\)\. Check that a URL starts with http:\/\/ or https:\/\/ and has at most 2,048 characters, and nothing more\./ },
      also: (result) => expect(result.checks.find((check) => check.id === 'C15')!.message).not.toContain('values of a later extension version'),
    },
    {
      // The emoji that the check adds itself. Some example files have another one (a tooth): a server that fails on
      // every character of 4 bytes fails C1 and C2 as well, and every check that sends such an example.
      wrong: 'a text with the emoji 😀 (4 bytes in UTF-8) causes a 500',
      serve: refusing((_request, body) => (texts(body).some((text) => text.includes('😀')) ? html(500, 'Incorrect string value') : null)),
      fails: {
        C10: /expected HTTP 200 or 201, got 500\. The name has an emoji, which is 4 bytes in UTF-8: a MySQL database needs utf8mb4 for it\./,
        C15: /Sent alone, this part was refused with HTTP 500: an emoji in a page title \(organic\[0\]\.title ends with 😀\)\. All text is valid Unicode and can contain emoji\. An emoji is 4 bytes in UTF-8: a MySQL database needs utf8mb4 for it\./,
      },
    },
    {
      wrong: 'a text with an emoji comes back damaged',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isBusinessDetails(request) && succeeded(reply) ? { ...reply, body: reply.body.replace(/[\u{10000}-\u{10FFFF}]/gu, '?') } : reply;
      },
      fails: { C10: /^GET \/v1\/businesses\/biz_brightpath lists the competitor as "Conformance Check: Zahnärzte München – “Lächeln” 東京 \?", but it was sent as "Conformance Check: Zahnärzte München – “Lächeln” 東京 😀": the text was damaged\. Store and return text as UTF-8\. An emoji is 4 bytes in UTF-8: a MySQL database needs utf8mb4 for it\. If the competitor is left from an earlier run, remove it and run the check again\.$/ },
    },
    {
      wrong: 'a competitor that was added is not listed in Business Details',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isBusinessDetails(request) && succeeded(reply) ? withBody(reply, (body) => ({ ...body, competitors: (body['competitors'] as { name: string }[]).filter((c) => !c.name.startsWith('Conformance Check')) })) : reply;
      },
      fails: { C10: /was saved \(HTTP 201\), but GET \/v1\/businesses\/biz_brightpath does not list it \(it lists: [^)]*Zilker Family Dentistry\)\. A competitor that was added must appear in Business Details at once\./ },
    },
    {
      wrong: 'nothing that breaks a rule: the names of competitors come back in lower case',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isBusinessDetails(request) && succeeded(reply) ? withBody(reply, (body) => ({ ...body, competitors: (body['competitors'] as { name: string }[]).map((c) => ({ ...c, name: c.name.toLowerCase() })) })) : reply;
      },
      warns: [['C10', /is listed as "conformance check: zahnärzte münchen – “lächeln” 東京 😀": the letter case or the spaces were changed/]],
    },
    {
      wrong: 'nothing that breaks a rule: the business has more than 200 competitors, and a new one comes last',
      prepare: (state) => {
        for (let i = 0; i < 202; i += 1) {
          state.details['biz_brightpath']!.competitors.push({ name: `Competitor ${i}`, domains: [`competitor-${i}.example`] });
          state.competitorIds['biz_brightpath']!.push(`com_many_${i}`);
        }
      },
      serve: mock,
      // The extension reads the first 200 competitors, so it never sees the new one. The check cannot tell whether
      // that matters for this business: it recommends a smaller test business.
      warns: [['C10', /the business has 20\d competitors and the new one is not among the first 200, which is all the extension reads\. Use a test business with fewer competitors, or list new ones first\./]],
    },
    {
      wrong: 'the header Idempotency-Key is required',
      serve: refusing((request) => (isSave(request) && !request.headers['idempotency-key'] ? error(400, 'bad_request', 'The Idempotency-Key header is required.') : null)),
      // C6 and C7 send no key either. They expect a refusal, and get one.
      fails: { C8: /the extension would tell the user: "Legiit rejected the request \(400\): The Idempotency-Key header is required\."\. The same body with an Idempotency-Key header was accepted: do not require that header\./ },
    },
    {
      wrong: 'a field that the API does not know is refused',
      serve: refusing((request, body) => (isSave(request) && body && 'addedByALaterExtensionVersion' in body ? error(422, 'invalid', 'addedByALaterExtensionVersion is not allowed.') : null)),
      fails: { C8: /The same body with an Idempotency-Key header was refused too \(HTTP 422\), so the unknown field is the cause: ignore fields you do not know, a later extension version may add fields\./ },
    },
  ]);
});

/** For the time of one request, the business of the second user is a business that everybody can reach. */
const withoutOwnerCheck = (request: MockRequest, state: MockState): MockResponse => {
  state.details[MOCK_OTHER_BUSINESS_ID] = state.ownDetails['usr_demo_2']![MOCK_OTHER_BUSINESS_ID]!;
  try {
    return mock(request, state);
  } finally {
    delete state.details[MOCK_OTHER_BUSINESS_ID];
  }
};

const INTEGER_IDS = { biz_brightpath: 101, biz_oakline: 102 };
const integerForm = (id: string): boolean => /^\d{1,18}$/.test(id);

describe('what a server does with the business in the path', () => {
  defineVariantTests([
    {
      wrong: 'a business of another user can be read and saved into',
      run: { otherBusiness: MOCK_OTHER_BUSINESS_ID },
      serve: (request, state) => (pathOf(request).includes(MOCK_OTHER_BUSINESS_ID) ? withoutOwnerCheck(request, state) : mock(request, state)),
      fails: {
        B5: /^GET \/v1\/businesses\/biz_harborview \(a business of another user\): expected HTTP 404, got 200\. The token reached a business that is not its user's\. If this business belongs to the user of the token, the option --other-business is wrong: give the id of a business of ANOTHER user\.[\s\S]*POST \/v1\/businesses\/biz_harborview\/content-editor\/documents \(a save into a business of another user\): expected HTTP 404, got 201/,
      },
      also: (result) => {
        const wrong = result.created.filter((item) => item.note === `STORED IN THE OTHER USER'S BUSINESS ${MOCK_OTHER_BUSINESS_ID}`);
        expect(wrong.map((item) => item.kind)).toEqual(['visibility snapshot', 'gap list', 'competitor', 'content analysis']);
        expect(result.summary).toMatch(/gap list gap_\d+ STORED IN THE OTHER USER'S BUSINESS biz_harborview/);
      },
    },
    {
      wrong: 'a business of another user answers 403, which reveals that it exists',
      run: { otherBusiness: MOCK_OTHER_BUSINESS_ID },
      serve: (request, state) => (pathOf(request).includes(MOCK_OTHER_BUSINESS_ID) && hasValidToken(request) ? error(403, 'forbidden', 'This business belongs to another account') : mock(request, state)),
      fails: { B5: /^GET \/v1\/businesses\/biz_harborview \(a business of another user\): expected HTTP 404, got 403\. Body: / },
    },
    {
      wrong: 'a save into a business that does not exist is stored',
      serve: (request, state) => {
        const reply = mock(request, state);
        return isSave(request) && reply.status === 404 ? storedAnyway() : reply;
      },
      fails: { C9: /^POST \/v1\/businesses\/biz_[a-z]{10}\/visibility-snapshots \(a business that does not exist\): expected HTTP 404, got 201\./ },
      also: (result) => {
        const wrong = result.created.filter((item) => item.note?.startsWith('STORED FOR A BUSINESS THAT DOES NOT EXIST (biz_'));
        expect(wrong.map((item) => item.kind)).toEqual(['visibility snapshot', 'gap list', 'competitor', 'content analysis']);
      },
    },
    {
      wrong: 'nothing: the ids are integers, and an id of any other form is simply not found',
      serve: withIds(INTEGER_IDS, integerForm, () => error(404, 'not_found', 'No such business')),
      also: (result, _state, received) => {
        expect(result.summary).toContain('Business used:         101');
        // An unknown id with as many digits, then three ids of another form.
        const probes = received.filter((request) => request.method === 'GET' && /^\/v1\/businesses\/[^/]+$/.test(request.path) && !/\/10[12]$/.test(request.path)).map((request) => request.path.split('/').at(-1));
        expect(probes.slice(-4)).toEqual([expect.stringMatching(/^[1-9]\d\d$/), 'conformance-check-no-such-business', '101abc', '99999999999999999999']);
      },
    },
    {
      wrong: 'nothing that breaks a rule: the ids are integers, and an id of another form gets the 404 of the framework',
      serve: withIds(INTEGER_IDS, integerForm, () => json(404, { message: 'The route could not be found.' })),
      warns: [
        ['B3', /an id of another form than yours \("conformance-check-no-such-business"\) answered HTTP 404 instead of 404 "not_found"\. [^\n]* it would then take the feature for "not built" and hide it instead of saying that the business is gone/],
        ['B3', /an id of yours followed by letters \("101abc"\) answered HTTP 404 instead of 404 "not_found"/],
        ['B3', /a number that is too large for an id \("99999999999999999999"\) answered HTTP 404 instead of 404 "not_found"/],
      ],
    },
    {
      wrong: 'the ids are integers, and "101abc" is read as 101 (MySQL compares a text with a number that way)',
      serve: (request, state) => withIds(INTEGER_IDS, integerForm, () => error(404, 'not_found', 'No such business'))({ ...request, path: request.path.replace(/^(\/v1\/businesses\/\d+)[a-z]+/, '$1') }, state),
      fails: { B3: /^GET \/v1\/businesses\/101abc \(an id of yours followed by letters\): answered HTTP 200\. It must be a 4xx other than 401 \(best: 404 with the code "not_found"\), never a server error and never a success\./ },
    },
    {
      wrong: 'the ids are integers, and a number that is too large causes a 500',
      serve: withIds(INTEGER_IDS, integerForm, (id) => (/^\d+$/.test(id) ? html(500, 'value out of range for type integer') : error(404, 'not_found', 'No such business'))),
      fails: { B3: /^GET \/v1\/businesses\/99999999999999999999 \(a number that is too large for an id\): answered HTTP 500\. It must be a 4xx other than 401/ },
    },
    {
      wrong: 'nothing that breaks a rule: the ids are ULIDs, and an id of another form answers 400',
      serve: withIds({ biz_brightpath: '01J3DF75DDA33214231DCF72E2', biz_oakline: '01J3DF75DDB6XKQ0W9N4T8P5ZV' }, (id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id), () => error(400, 'invalid_id', 'The business id is not valid')),
      // The unknown id of the check is a ULID too, so it is "not found" and not "another form".
      warns: [['B3', /an id of another form than yours \("conformance-check-no-such-business"\) answered HTTP 400 "invalid_id" instead of 404 "not_found"\. [^\n]*show "Legiit rejected the request"/]],
      also: (_result, _state, received) => {
        const unknown = received.map((request) => /^\/v1\/businesses\/([^/]+)\/gap-lists$/.exec(request.path)?.[1]).filter((id) => id && !id.startsWith('01J3DF75DDA3'));
        expect(unknown).toEqual([expect.stringMatching(/^01J3DF75[0-9A-HJKMNP-TV-Z]{18}$/)]);
      },
    },
    {
      wrong: 'nothing: the ids are UUIDs or the hexadecimal ids of MongoDB, and an id of another form answers 404 "not_found"',
      serve: (request, state) =>
        withIds({ biz_brightpath: '507f1f77bcf86cd799439011', biz_oakline: '0b6e4d6c-58f4-4a5e-9d6f-3c2a1b7e9f10' }, (id) => /^[0-9a-f]{24}$/.test(id) || /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id), () => error(404, 'not_found', 'No such business'))(request, state),
      also: (_result, _state, received) => {
        const unknown = received.map((request) => /^\/v1\/businesses\/([^/]+)\/gap-lists$/.exec(request.path)?.[1]).filter((id) => id && id !== '507f1f77bcf86cd799439011');
        expect(unknown).toEqual([expect.stringMatching(/^507f1f77[0-9a-f]{16}$/)]);
      },
    },
    {
      wrong: 'nothing: the account has only "workspaces" and "ai", and a business of another user is given',
      run: { otherBusiness: MOCK_OTHER_BUSINESS_ID },
      prepare: (state) => {
        state.session.capabilities = ['workspaces', 'ai'];
      },
      serve: mock,
      // B5 has nothing to try. C12 cannot tell the key from the de-duplication of workspaces by their briefId.
      skips: ['B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3', 'C4', 'C9', 'C10', 'C11', 'C12'],
      also: (result, _state, received) => {
        expect(result.checks.find((check) => check.id === 'B5')!.message).toBe('neither "businesses" nor a save into a business is enabled for this account');
        expect(result.checks.find((check) => check.id === 'C12')!.message).toMatch(/^only saves that are de-duplicated by their content are enabled \(competitors, workspaces\)/);
        expect(received.some((request) => request.path.includes(MOCK_OTHER_BUSINESS_ID))).toBe(false);
      },
    },
    {
      wrong: 'nothing that breaks a rule: the account saves snapshots without "businesses"; the business comes from --business',
      run: { business: 'biz_brightpath', otherBusiness: MOCK_OTHER_BUSINESS_ID },
      prepare: (state) => {
        state.session.capabilities = ['visibilitySnapshots'];
      },
      serve: mock,
      warns: [['A2', /visibilitySnapshots listed without "businesses"/]],
      skips: ['B1', 'B2', 'B3', 'B4', 'C2', 'C3', 'C4', 'C5', 'C10', 'C11', 'C13', 'C14', 'D1', 'D2', 'D3', 'D4'],
      also: (_result, _state, received) => {
        // B5 tries the one save that the account has, and does not read the business: that needs "businesses".
        expect(received.filter((request) => request.path.includes(MOCK_OTHER_BUSINESS_ID)).map((request) => `${request.method} ${request.path}`)).toEqual([`POST /v1/businesses/${MOCK_OTHER_BUSINESS_ID}/visibility-snapshots`]);
      },
    },
  ]);
});

/** The reply of the first save with each Idempotency-Key, by path and key. */
const firstReplies = new WeakMap<MockState, Map<string, MockResponse>>();

describe('what a server does with the Idempotency-Key, and with the same content again', () => {
  defineVariantTests([
    {
      wrong: 'nothing that breaks a rule: the Idempotency-Key is ignored',
      serve: (request, state) => mock({ ...request, headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== 'idempotency-key')) }, state),
      warns: [['C12', /the same visibility snapshot sent twice with the same Idempotency-Key returned two different ids, so the user's second click after a timeout creates a duplicate\. Recommended: return the first reply again\./]],
    },
    {
      wrong: 'nothing that the check can see: the Idempotency-Key is ignored, and only competitors and workspaces are enabled',
      prepare: (state) => {
        state.session.capabilities = ['businesses', 'competitors', 'workspaces'];
      },
      serve: (request, state) => mock({ ...request, headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== 'idempotency-key')) }, state),
      skips: ['B4', 'B5', 'C1', 'C2', 'C4', 'C12', 'D1', 'D2', 'D3', 'D4'],
      also: (result) => expect(result.checks.find((check) => check.id === 'C12')!.message).toBe('only saves that are de-duplicated by their content are enabled (competitors, workspaces): for them a repeated Idempotency-Key cannot be told apart from that de-duplication'),
    },
    {
      wrong: 'nothing that breaks a rule: an error is remembered under its Idempotency-Key',
      serve: (request, state) => {
        const key = request.headers['idempotency-key'];
        if (!isSave(request) || !key || !hasValidToken(request)) return mock(request, state);
        const replies = firstReplies.get(state) ?? firstReplies.set(state, new Map()).get(state)!;
        const known = replies.get(`${request.path} ${key}`);
        if (known) return known;
        const reply = mock(request, state);
        replies.set(`${request.path} ${key}`, reply);
        return reply;
      },
      warns: [['C16', /a valid visibility snapshot was answered with the same error again \(HTTP 422\), because its Idempotency-Key came with a request before that was refused \(HTTP 422\)\. Remember only the reply of a successful save, and do not compare bodies\. A user who gets a 429 or a 5xx can otherwise never send again from the same dialog\./]],
    },
    {
      wrong: 'nothing that breaks a rule: a key that came with another body before is refused with 409',
      serve: (request, state) => {
        const key = request.headers['idempotency-key'];
        if (!isSave(request) || !key || !hasValidToken(request)) return mock(request, state);
        const bodies = firstReplies.get(state) ?? firstReplies.set(state, new Map()).get(state)!;
        const before = bodies.get(`${request.path} ${key}`);
        if (before && before.body !== request.body) return error(409, 'key_reused', 'This Idempotency-Key was used with another body.');
        bodies.set(`${request.path} ${key}`, { status: 0, headers: {}, body: request.body ?? '' });
        return mock(request, state);
      },
      warns: [['C16', /a valid visibility snapshot was refused with HTTP 409, because its Idempotency-Key came with a request before that was refused \(HTTP 422\)/]],
    },
    {
      wrong: 'a snapshot, a gap list or a content analysis with the same content is stored only once',
      serve: (request, state) => {
        if (!isSave(request) || !hasValidToken(request) || /\/(competitors|from-brief)$/.test(pathOf(request))) return mock(request, state);
        // What a server does that looks for an item with the same content before it stores one.
        const { addedByALaterExtensionVersion: _unknown, ...content } = parsed(request.body) ?? {};
        const known = firstReplies.get(state) ?? firstReplies.set(state, new Map()).get(state)!;
        const before = known.get(`${request.path} ${JSON.stringify(content)}`);
        if (before) return { ...before, status: 200 };
        const reply = mock(request, state);
        if (reply.status === 201) known.set(`${request.path} ${JSON.stringify(content)}`, reply);
        return reply;
      },
      fails: {
        C8: /^POST \/v1\/businesses\/biz_brightpath\/visibility-snapshots with [^\n]*: the reply has the id "vis_1", which an earlier save of this run returned already\. A visibility snapshot is never de-duplicated by its content: the same content under a new Idempotency-Key is a new item, with an id of its own\.\n[^\n]*gap-lists[^\n]*A gap list is never de-duplicated[^\n]*\n[^\n]*A content analysis is never de-duplicated/,
        C12: /with examples\/saveVisibilitySnapshot\.request\.json and a new Idempotency-Key: the reply has the id "vis_1", which an earlier save of this run returned already/,
        C16: /with a valid body and the Idempotency-Key of a request that was refused before: the reply has the id "vis_1", which an earlier save of this run returned already/,
      },
    },
    {
      wrong: 'nothing that breaks a rule: a competitor is stored twice, and a brief that is sent again becomes a second workspace',
      serve: (request, state) => {
        const reply = mock(request, state);
        // 200 means "this item was there already". This server makes a new item of it.
        return isSave(request) && reply.status === 200 ? withBody({ ...reply, status: 201 }, (body) => ({ ...body, id: `again_${++junk}` })) : reply;
      },
      warns: [
        ['C11', /adding the same competitor twice \(the name in another letter case\) returned two different ids\. Recommended: return the id of the existing competitor/],
        ['C14', /the same briefId sent twice created two workspaces\. Recommended: update the first one and return its id/],
      ],
    },
  ]);
});

const bytes = (request: MockRequest): number => Buffer.byteLength(request.body ?? '', 'utf8');

describe('a server that ends the connection', () => {
  it('when a body is larger than 100 KB: the check says what probably happened, not "check the base URL"', async () => {
    // Not a variant of the mock's HTTP server: this one stops reading in the middle of a body and answers nothing.
    const state = createMockState();
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 100_000) req.destroy();
        else chunks.push(chunk);
      });
      req.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(',') : (value ?? '');
        const reply = handleMockRequest(state, { method: req.method ?? 'GET', path: req.url ?? '/', headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(reply.status, reply.headers);
        res.end(reply.body);
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const result = await runConformance({ baseUrl: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: () => MOCK_TOKENS.valid, writes: true });
      const failed = result.checks.filter((check) => check.outcome === 'failed');
      expect(failed.map((check) => check.id)).toEqual(['C13']);
      expect(failed[0]!.message).toMatch(
        /^POST \/v1\/businesses\/biz_brightpath\/gap-lists: no reply \([A-Z_]+\)\. The connection ended while a body of 1,02\d KB was sent\. Something in front of your API \(a proxy, the web server, the framework\) probably refuses a body of this size without a reply: accept request bodies of up to 1 MB \(1,048,576 bytes\)\.\n {5}POST \/v1\/workspaces\/from-brief: no reply/,
      );
      expect(result.warnings).toEqual([]);
      expect(result.summary).toMatch(/the slowest took \d+ ms; 2 got no reply/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('large bodies, and time', () => {
  defineVariantTests([
    {
      wrong: 'a body of more than 100 KB is refused with 413',
      serve: refusing((request) => (bytes(request) > 100_000 ? error(413, 'too_large', 'request entity too large') : null)),
      fails: {
        C13: /^POST \/v1\/businesses\/biz_brightpath\/gap-lists with a gap list of 1,02\d KB: refused as too large \(413\)\. Accept request bodies of up to 1 MB \(1,048,576 bytes\): raise the limit of your framework or proxy\.[^\n]*\n {5}POST \/v1\/workspaces\/from-brief with a brief of 5\d\d KB: refused as too large \(413\)/,
      },
    },
    {
      wrong: 'the Markdown of a brief goes into a column that ends at 64 KB',
      serve: refusing((_request, body) => (Buffer.byteLength(String(body?.['markdown'] ?? ''), 'utf8') > 65_535 ? html(500, 'Data too long for column markdown') : null)),
      fails: { C13: /^POST \/v1\/workspaces\/from-brief with a brief of 5\d\d KB: expected HTTP 200 or 201, got 500\. Check the size of the column that stores "markdown": a MySQL TEXT column ends at 64 KB\./ },
    },
    // The four variants below depend on time. Their limits are far from what a request to a local server takes
    // (a few milliseconds; 1 MB takes some tens), so that a busy machine does not change the result.
    {
      wrong: 'nothing that breaks a rule: the two largest saves are slow',
      run: { limits: { slowMs: 300 } },
      serve: (request, state) => (bytes(request) > 400_000 && hasValidToken(request) ? later(450, mock(request, state)) : mock(request, state)),
      // The two saves have their own warning and their own line in the summary. They are not counted again as "slow requests".
      warns: [
        ['C13', /the gap list of 1,02\d KB took \d\.\d seconds\. The extension stops waiting after 20 seconds, and real bodies arrive over slower connections\. Look at how the body is validated and stored\./],
        ['C13', /the brief of 5\d\d KB took \d\.\d seconds/],
      ],
      also: (result) => expect(result.summary).toMatch(/Largest saves: {9}gap list of 1,02\d KB in [\d,]{3,} ms, brief of 5\d\d KB in [\d,]{3,} ms/),
    },
    {
      wrong: 'nothing that breaks a rule: two saves of a competitor are slow',
      run: { limits: { slowMs: 300 } },
      serve: (request, state) => (/conformance check: twice/i.test(request.body ?? '') && hasValidToken(request) ? later(450, mock(request, state)) : mock(request, state)),
      // One line for all slow requests, not one line for each of them.
      warns: [['Speed', /^Speed: 2 requests took more than 0\.3 seconds\. The slowest was POST \/v1\/businesses\/biz_brightpath\/competitors with \d\.\d seconds\. The extension stops waiting after 20 seconds, and the user looks at "Sending…" all that time\.$/]],
    },
    {
      wrong: 'the AI endpoint does not answer one request in time',
      run: { limits: { aiMs: 1000 } },
      serve: (request, state) => (isAi(request) && hasValidToken(request) && (request.body ?? '').includes('responseSchema') ? later(5_000, mock(request, state)) : mock(request, state)),
      // The check names the request and the limit. The time limit of the test runner plays no part.
      fails: { D2: /^POST \/v1\/ai\/completions did not answer within 1 second\. The extension stops waiting after 1 second and tells the user that Legiit did not answer\.$/ },
      also: (result) => {
        // A request that got no reply is counted like every other request.
        expect(result.requests.filter((request) => request === 'POST /v1/ai/completions')).toHaveLength(6);
        expect(result.summary).toMatch(/Requests sent: {9}100 \(29 reads, 63 saves, 6 to the AI endpoint, 2 preflight\), the slowest took [\d,]+ ms; 1 got no reply/);
      },
    },
    {
      wrong: 'a save does not answer two requests in time',
      run: { limits: { requestMs: 1000 } },
      // The two requests of C8 and C15 to this endpoint: one comes from the extension's client, one from the check.
      serve: (request, state) =>
        pathOf(request).endsWith('/content-editor/documents') && hasValidToken(request) && /addedByALaterExtensionVersion|an-engine-added-later/.test(request.body ?? '') ? later(5_000, mock(request, state)) : mock(request, state),
      fails: {
        C8: /^POST \/v1\/businesses\/biz_brightpath\/content-editor\/documents with [^\n]*, sent by the extension's own client: the extension would tell the user: "Legiit did not answer in time"\.$/,
        C15: /^POST \/v1\/businesses\/biz_brightpath\/content-editor\/documents did not answer within 1 second\. The extension stops waiting after 1 second and tells the user that Legiit did not answer\.$/,
      },
    },
  ]);
});
