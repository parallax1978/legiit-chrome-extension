/**
 * The developer handoff kit in docs/legiit-api: the examples are what the
 * extension really sends, they match the contract, the mock server and the
 * real client agree with them, and the generated files (the reference, the
 * contract with examples, the JSON Schema files) are current.
 *
 * To refresh the example files after a deliberate change to a payload:
 *   npm run api:examples
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { problemWith } from '@@/mock-server/contract.mjs';
import { CORS_HEADERS, createMockState, handleMockRequest, MOCK_TOKENS } from '@@/mock-server/handlers.mjs';
import { StaticAuthProvider } from '@/legiit/auth';
import { LegiitError, METHOD_CAPABILITY, type LegiitMethod } from '@/legiit/client';
import { HttpLegiitClient } from '@/legiit/http-client';
import { LIMITS, MAX_REQUEST_BYTES } from '@/legiit/limits';
import { ALL_CAPABILITIES } from '@/legiit/types';
import { parseBriefRewrite } from '@/ai/brief-rewrite';
import { toLines } from '@/ai/provider';
import { EMBEDDING_SAME_THRESHOLD, LEXICAL_SAME_THRESHOLD } from '@/similarity/engine';
import { contractValidators, EXAMPLES_DIR, KIT_DIR, loadContract, requestExamples } from '../api/suite';
import { buildExampleReplies, buildExampleRequests, EXAMPLE_BUSINESS_ID, toExampleJson, WEB_TITLES } from '../helpers/api-examples';
import { httpClient } from '../helpers/legiit';

const ROOT = resolve(__dirname, '../..');
const file = (name: string) => join(EXAMPLES_DIR, name);
const read = <T = unknown>(name: string) => JSON.parse(readFileSync(file(name), 'utf8')) as T;

interface Operation {
  operationId: LegiitMethod;
  method: 'GET' | 'POST';
  path: string;
  requestSchema: string | null;
  responseSchema: string;
  successStatus: number;
}

const contract = loadContract() as {
  info: { version: string };
  paths: Record<string, Record<string, { operationId: LegiitMethod; requestBody?: { content: { 'application/json': { schema: { $ref: string } } } }; responses: Record<string, { $ref?: string; content?: { 'application/json': { schema: { $ref: string } } } }> }>>;
  components: { responses: Record<string, { content: { 'application/json': { schema: { $ref: string } } } }>; schemas: Record<string, unknown> };
};
const nameOf = (ref: string) => ref.split('/').at(-1)!;

const operations: Operation[] = Object.entries(contract.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, op]) => {
    // A save declares 201 (stored) and 200 (it already existed): a first save answers 201.
    const [status, success] = Object.entries(op.responses).find(([code]) => code === '201') ?? Object.entries(op.responses).find(([code]) => code.startsWith('2'))!;
    const response = success.$ref ? contract.components.responses[nameOf(success.$ref)]! : (success as { content: { 'application/json': { schema: { $ref: string } } } });
    return {
      operationId: op.operationId,
      method: method.toUpperCase() as 'GET' | 'POST',
      path,
      requestSchema: op.requestBody ? nameOf(op.requestBody.content['application/json'].schema.$ref) : null,
      responseSchema: nameOf(response.content['application/json'].schema.$ref),
      successStatus: Number(status),
    };
  }),
);
const validators = contractValidators(contract as unknown as Record<string, unknown>);
if (!existsSync(EXAMPLES_DIR)) mkdirSync(EXAMPLES_DIR, { recursive: true });
// Built by the extension's own code. The files are compared with it below, and written when missing.
const built = await buildExampleRequests();
/** Replies for cases that the mock server does not have: file name → status, schema and body. */
const replies = buildExampleReplies();
/** One more reply of the mock server: the session of its second user, who is on a smaller plan. */
const SMALL_PLAN_SESSION = 'getSession.small-plan.response.json';
/** The error replies that are answers of the mock server (the other error examples are in "replies"). */
const MOCK_ERRORS = ['error.401-bad-token.json', 'error.404-business-not-found.json', 'error.404-feature-not-available.json', 'error.422-invalid-body.json'];
const exampleFiles = () => readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json')).sort();
const requestFilesOf = (op: Operation) => Object.keys(built).filter((f) => f.startsWith(`${op.operationId}.`)).sort((a, b) => a.length - b.length || a.localeCompare(b));
const responseFileFor = (requestFile: string) => requestFile.replace(/\.request\.json$/, '.response.json');
const concretePath = (op: Operation) => op.path.replace('{businessId}', EXAMPLE_BUSINESS_ID);
const auth = { authorization: `Bearer ${MOCK_TOKENS.valid}` };

describe('example requests are what the extension really sends', () => {
  for (const [name, payload] of Object.entries(built)) {
    it(name, async () => {
      // Plain JSON only: nothing undefined, no class instances.
      expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
      await expect(toExampleJson(payload)).toMatchFileSnapshot(file(name));
    });
  }

  it('covers every endpoint that takes a body', () => {
    for (const op of operations.filter((o) => o.requestSchema)) {
      expect(requestFilesOf(op).length, op.operationId).toBeGreaterThan(0);
      expect(requestExamples(op.operationId)).toEqual(requestFilesOf(op));
    }
  });

  it('carry an emoji (4 bytes in UTF-8) and a title in a non-Latin script, unchanged', () => {
    const titles = (name: string, list: 'organic' | 'rows'): string[] => (read<Record<string, { title: string }[]>>(name)[list] ?? []).map((entry) => entry.title);
    // Both were put into the results page that the extension read; its payload code did not touch them.
    expect(titles('saveVisibilitySnapshot.request.json', 'organic')).toContain(WEB_TITLES.emoji.to);
    expect(titles('saveGapList.request.json', 'rows')).toContain(WEB_TITLES.emoji.to);
    expect(titles('saveGapList.request.json', 'rows')).toContain(WEB_TITLES.nonLatin.to);
    expect([...WEB_TITLES.emoji.to].some((character) => character.codePointAt(0)! > 0xffff)).toBe(true);
    expect(WEB_TITLES.nonLatin.to).toMatch(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u);
    // In the file the emoji is 4 bytes, not an escape: a database that stores 3 bytes per character fails on it.
    for (const name of ['saveVisibilitySnapshot.request.json', 'saveGapList.request.json']) expect(readFileSync(file(name)).includes(Buffer.from([0xf0, 0x9f, 0xa6, 0xb7])), name).toBe(true);
  });

  it('show both engines of a content analysis, each with its threshold', () => {
    const method = (name: string) => read<{ method: { engine: string; threshold: number; pagesCompared: number } }>(name).method;
    // The normal case, with the sentence model that is bundled in the extension; and the fallback when it cannot run.
    expect(method('sendToContentEditor.request.json')).toEqual({ engine: 'embedding', threshold: EMBEDDING_SAME_THRESHOLD, pagesCompared: 5 });
    expect(method('sendToContentEditor.pasted-text.request.json')).toEqual({ engine: 'lexical', threshold: LEXICAL_SAME_THRESHOLD, pagesCompared: 1 });
    // The contract quotes the two thresholds.
    const threshold = (contract.components.schemas['ContentEditorDocument'] as { properties: { method: { properties: { threshold: { description: string } } } } }).properties.method.properties.threshold;
    expect(threshold.description).toContain(`${EMBEDDING_SAME_THRESHOLD} for embedding and ${LEXICAL_SAME_THRESHOLD} for lexical`);
    // The model's answers behind the first example were recorded with the settings of the extension's worker
    // (tests/helpers/api-examples.ts): the same model, the same batches, the same pooling.
    const worker = readFileSync(resolve(ROOT, 'src/similarity/embed.worker.ts'), 'utf8');
    const recorder = readFileSync(resolve(ROOT, 'tests/helpers/embed-texts.mjs'), 'utf8');
    for (const setting of ["MODEL_ID = 'Xenova/all-MiniLM-L6-v2'", 'BATCH_SIZE = 16', "dtype: 'q8'", "pooling: 'mean', normalize: true"]) {
      expect(worker, `src/similarity/embed.worker.ts: ${setting}`).toContain(setting);
      expect(recorder, `tests/helpers/embed-texts.mjs: ${setting}`).toContain(setting);
    }
  });

  it('write every date and time as UTC with milliseconds, as the reference says', () => {
    // The fields with "format: date-time" of the request schemas, found by walking schema and example together.
    type Node = { properties?: Record<string, Node>; items?: Node; format?: string };
    const found: string[] = [];
    const walk = (schema: Node | undefined, value: unknown, path: string): void => {
      if (!schema) return;
      if (schema.format === 'date-time') {
        found.push(path);
        expect(value, path).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
      if (Array.isArray(value)) value.forEach((item, index) => walk(schema.items, item, `${path}[${index}]`));
      else if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) walk(schema.properties?.[key], child, `${path}.${key}`);
    };
    for (const op of operations.filter((o) => o.requestSchema)) {
      for (const requestFile of requestFilesOf(op)) walk(contract.components.schemas[op.requestSchema!] as Node, read(requestFile), requestFile);
    }
    expect(found.length).toBeGreaterThanOrEqual(8);
    // No reply has a date and time that must have a certain form: the extension reads none.
    const replySchemas = JSON.stringify(Object.fromEntries(Object.entries(contract.components.schemas).filter(([name]) => !operations.some((op) => op.requestSchema === name) && name !== 'Competitor')));
    expect(replySchemas).not.toContain('date-time');
  });

  it('no example comes near the size limit, and the mock refuses a body over it', () => {
    for (const [name, payload] of Object.entries(built)) expect(new TextEncoder().encode(JSON.stringify(payload)).length, name).toBeLessThan(64_000);
    const reply = handleMockRequest(createMockState(), { method: 'POST', path: '/v1/workspaces/from-brief', headers: auth, body: JSON.stringify({ markdown: 'x'.repeat(MAX_REQUEST_BYTES) }) });
    expect(reply.status).toBe(413);
  });
});

describe('example responses are what the mock server answers', () => {
  it('for every request example', async () => {
    const state = createMockState();
    for (const op of operations.filter((o) => o.requestSchema)) {
      for (const requestFile of requestFilesOf(op)) {
        const reply = handleMockRequest(state, { method: op.method, path: concretePath(op), headers: auth, body: readFileSync(file(requestFile), 'utf8') });
        expect(reply.status, `${op.operationId} with ${requestFile}`).toBe(op.successStatus);
        await expect(toExampleJson(JSON.parse(reply.body))).toMatchFileSnapshot(file(responseFileFor(requestFile)));
      }
    }
  });

  it('for every read endpoint', async () => {
    const state = createMockState();
    for (const op of operations.filter((o) => !o.requestSchema)) {
      const reply = handleMockRequest(state, { method: op.method, path: concretePath(op), headers: auth });
      expect(reply.status, op.operationId).toBe(op.successStatus);
      await expect(toExampleJson(JSON.parse(reply.body))).toMatchFileSnapshot(file(`${op.operationId}.response.json`));
    }
    // The same endpoint for a user whose plan has fewer features: the session lists only those.
    const smallPlan = handleMockRequest(state, { method: 'GET', path: '/v1/session', headers: { authorization: `Bearer ${MOCK_TOKENS.limited}` } });
    await expect(toExampleJson(JSON.parse(smallPlan.body))).toMatchFileSnapshot(file(SMALL_PLAN_SESSION));
  });

  it('for the error cases the guide describes', async () => {
    const state = createMockState();
    const cases: [string, Parameters<typeof handleMockRequest>[1], number][] = [
      ['error.401-bad-token.json', { method: 'GET', path: '/v1/session', headers: { authorization: `Bearer ${MOCK_TOKENS.invalid}` } }, 401],
      ['error.404-business-not-found.json', { method: 'GET', path: '/v1/businesses/no-such-business', headers: auth }, 404],
      ['error.404-feature-not-available.json', { method: 'POST', path: '/v1/ai/completions', headers: { authorization: `Bearer ${MOCK_TOKENS.limited}` }, body: readFileSync(file('completeAI.request.json'), 'utf8') }, 404],
      ['error.422-invalid-body.json', { method: 'POST', path: `/v1/businesses/${EXAMPLE_BUSINESS_ID}/visibility-snapshots`, headers: auth, body: '{}' }, 422],
    ];
    expect(cases.map(([name]) => name)).toEqual(MOCK_ERRORS);
    for (const [name, request, status] of cases) {
      const reply = handleMockRequest(state, request);
      expect(reply.status, name).toBe(status);
      await expect(toExampleJson(JSON.parse(reply.body))).toMatchFileSnapshot(file(name));
    }
  });
});

describe('every example matches the contract', () => {
  it('requests match their request schema', () => {
    for (const op of operations.filter((o) => o.requestSchema)) {
      for (const requestFile of requestFilesOf(op)) {
        const validate = validators(op.requestSchema!);
        expect(validate(read(requestFile)), `${requestFile}: ${JSON.stringify(validate.errors)}`).toBe(true);
      }
    }
  });

  it('responses match their response schema', () => {
    for (const op of operations) {
      const files = op.requestSchema ? requestFilesOf(op).map(responseFileFor) : [`${op.operationId}.response.json`];
      for (const name of files) {
        const validate = validators(op.responseSchema);
        expect(validate(read(name)), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
      }
    }
  });

  it('error bodies match the Error schema', () => {
    const errors = exampleFiles().filter((f) => f.startsWith('error.'));
    expect(errors).toEqual([...MOCK_ERRORS, ...Object.keys(replies).filter((f) => f.startsWith('error.'))].sort());
    for (const name of errors) {
      const validate = validators('Error');
      expect(validate(read(name)), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('the contract rejects what it should (the validator is not vacuous)', () => {
    const snapshot = read<Record<string, unknown>>('saveVisibilitySnapshot.request.json');
    expect(validators('VisibilitySnapshot')({ ...snapshot, keyword: 42 })).toBe(false);
    // A closed list refuses a value outside it; a list that later versions may extend does not.
    expect(validators('VisibilitySnapshot')({ ...snapshot, firstOrganicFold: 'middle' })).toBe(false);
    expect(validators('VisibilitySnapshot')({ ...snapshot, mode: 'images' })).toBe(true);
    const { keyword: _omitted, ...withoutKeyword } = snapshot;
    expect(validators('VisibilitySnapshot')(withoutKeyword)).toBe(false);
    expect(validators('SaveResult')({})).toBe(false);
    expect(validators('SaveResult')({ id: 17 })).toBe(true);
    expect(validators('SaveResult')({ id: 'x', url: 'javascript:alert(1)' })).toBe(false);
    expect(validators('Session')({ user: { name: 'No id' }, capabilities: [] })).toBe(false);
    expect(validators('Session')({ user: { id: 1 }, capabilities: ['ai'] })).toBe(true);
    expect(validators('Session')({ user: { id: 1 }, capabilities: ['a-capability-added-later'] })).toBe(true);
    expect(validators('Session')({ user: { id: 1 }, capabilities: { 0: 'ai' } })).toBe(false);
    expect(validators('SaveResult')({ id: 9007199254740993 })).toBe(false);
    // A reply may be longer than what the extension uses: that is not a contract violation.
    expect(validators('BusinessList')({ businesses: [{ id: 1, name: 'n'.repeat(500) }] })).toBe(true);
    expect(validators('Error')({ error: { code: 'invalid', message: 'm'.repeat(900) } })).toBe(true);
    // URLs that a strict URI validator refuses are valid: browsers write them this way.
    const withOddUrl = { ...snapshot, organic: [{ position: 1, url: 'https://example.com/a|b?x=[1]', domain: 'example.com', title: 'T', topPx: 1, fold: 'above' }] };
    expect(validators('VisibilitySnapshot')(withOddUrl)).toBe(true);
    // The mock names the first problem in words.
    expect(problemWith('VisibilitySnapshot', {})).toBe('keyword is required');
    expect(problemWith('VisibilitySnapshot', { ...snapshot, firstOrganicFold: 'middle' })).toBe('firstOrganicFold must be one of: above, partly, below, null');
    expect(problemWith('VisibilitySnapshot', { ...snapshot, mode: 'a-mode-added-later' })).toBeNull();
    expect(problemWith('Competitor', { name: 'x'.repeat(161), domains: [] })).toBe('name is longer than 160 characters');
    expect(problemWith('GapList', { ...read<Record<string, unknown>>('saveGapList.request.json'), rows: [] })).toBe('rows needs at least 1 item');
    expect(problemWith('VisibilitySnapshot', snapshot)).toBeNull();
  });

  it('there are no stray example files', () => {
    const expected = new Set<string>([SMALL_PLAN_SESSION, ...MOCK_ERRORS, ...Object.keys(replies)]);
    for (const op of operations) {
      if (op.requestSchema) for (const f of requestFilesOf(op)) expected.add(f).add(responseFileFor(f));
      else expected.add(`${op.operationId}.response.json`);
    }
    expect(exampleFiles().filter((f) => !expected.has(f))).toEqual([]);
    expect([...expected].filter((f) => !exampleFiles().includes(f))).toEqual([]);
  });
});

/**
 * Replies that the mock server does not give: integer ids, a session without capabilities, a save without a page
 * to link to, and errors with a message that a user can act on. Nothing produces them, so they are checked twice:
 * against the contract, and against the parsing of the extension's own client (src/legiit/http-client.ts).
 */
describe('example replies that the mock server does not give', () => {
  /** The extension's client, answered with one fixed reply: what it returns or throws is what its parsers make of that reply. */
  const answeredWith = (status: number, body: unknown) => {
    const urls: string[] = [];
    const client = new HttpLegiitClient({
      baseUrl: 'https://api.legiit.com',
      auth: new StaticAuthProvider(MOCK_TOKENS.valid),
      fetch: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      },
    });
    return { client, urls };
  };
  const answeredWithExample = (name: string) => answeredWith(replies[name]!.status, replies[name]!.body);
  const messageOf = (name: string): string => read<{ error: { message: string } }>(name).error.message;

  for (const [name, reply] of Object.entries(replies)) {
    it(`${name} is written from its source and matches the contract`, async () => {
      await expect(toExampleJson(reply.body)).toMatchFileSnapshot(file(name));
      const validate = validators(reply.schema);
      expect(validate(reply.body), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    });
  }

  it('the session of a user on a smaller plan matches the contract, and the extension shows only the features it lists', async () => {
    const example = read<{ user: { id: string }; plan: string; capabilities: string[] }>(SMALL_PLAN_SESSION);
    expect(validators('Session')(example)).toBe(true);
    const session = await httpClient(MOCK_TOKENS.limited).client.getSession();
    expect(session).toMatchObject(example);
    expect(session.capabilities.length).toBeGreaterThan(0);
    expect(session.capabilities.length).toBeLessThan(ALL_CAPABILITIES.length);
    expect(session.user.id).not.toBe(read<{ user: { id: string } }>('getSession.response.json').user.id);
  });

  it('a session without capabilities connects the user, with no feature', async () => {
    const session = await answeredWithExample('getSession.no-capabilities.response.json').client.getSession();
    expect(session.capabilities).toEqual([]);
    expect(session.user.id).toBe(read<{ user: { id: string } }>('getSession.response.json').user.id);
  });

  it('integer ids are read as text and sent back as their digits', async () => {
    const session = await answeredWithExample('getSession.integer-ids.response.json').client.getSession();
    expect(session.user.id).toBe('4127');
    expect(session.capabilities).toEqual([...ALL_CAPABILITIES]);
    const businesses = await answeredWithExample('listBusinesses.integer-ids.response.json').client.listBusinesses();
    expect(businesses.map((b) => b.id)).toEqual(['31', '58']);
    expect(businesses.map((b) => b.name)).toEqual(read<{ businesses: { name: string }[] }>('listBusinesses.response.json').businesses.map((b) => b.name));
    // The id the list gave is the id in the path of the next request, and the id of the details.
    const one = answeredWithExample('getBusinessDetails.integer-ids.response.json');
    const details = await one.client.getBusinessDetails(businesses[0]!.id);
    expect(one.urls).toEqual(['https://api.legiit.com/v1/businesses/31']);
    expect(details).toEqual({ ...read<Record<string, unknown>>('getBusinessDetails.response.json'), id: '31' });
    const save = answeredWithExample('anySave.integer-id.response.json');
    expect(await save.client.addCompetitor(businesses[0]!.id, read('addCompetitor.request.json'))).toEqual({ id: '9041', url: 'https://app.legiit.example/command-center/competitors/9041' });
    expect(save.urls).toEqual(['https://api.legiit.com/v1/businesses/31/competitors']);
  });

  it('a save reply with "url": null is a complete save, for each of the five saves', async () => {
    const { client } = answeredWithExample('anySave.url-null.response.json');
    const saved = { id: (replies['anySave.url-null.response.json']!.body as { id: string }).id, url: null };
    expect(await client.saveVisibilitySnapshot(EXAMPLE_BUSINESS_ID, read('saveVisibilitySnapshot.request.json'))).toEqual(saved);
    expect(await client.saveGapList(EXAMPLE_BUSINESS_ID, read('saveGapList.request.json'))).toEqual(saved);
    expect(await client.addCompetitor(EXAMPLE_BUSINESS_ID, read('addCompetitor.request.json'))).toEqual(saved);
    expect(await client.sendToContentEditor(EXAMPLE_BUSINESS_ID, read('sendToContentEditor.request.json'))).toEqual(saved);
    expect(await client.createWorkspaceFromBrief(read('createWorkspaceFromBrief.request.json'))).toEqual(saved);
  });

  it('the extension treats every error example as the reference says', async () => {
    type Call = (client: HttpLegiitClient) => Promise<unknown>;
    const save: Call = (client) => client.addCompetitor(EXAMPLE_BUSINESS_ID, read('addCompetitor.request.json'));
    const session: Call = (client) => client.getSession();
    const ai: Call = (client) => client.completeAI(read('completeAI.request.json'));
    const shown = (status: number, name: string): string => `Legiit rejected the request (${status}): ${messageOf(name)}`;
    /** File → the call that gets this reply, the kind of failure the extension sees, and the text it shows. */
    const expected: Record<string, [Call, LegiitError['code'], string]> = {
      'error.400-unreadable-body.json': [save, 'rejected', shown(400, 'error.400-unreadable-body.json')],
      // On the session check this reply makes the extension delete the token; its message is not shown.
      'error.401-bad-token.json': [session, 'unauthorised', 'Legiit did not accept the token'],
      'error.403-role-may-not-save.json': [save, 'rejected', shown(403, 'error.403-role-may-not-save.json')],
      'error.404-business-not-found.json': [save, 'rejected', `Legiit could not find it (404): ${messageOf('error.404-business-not-found.json')}`],
      // No message: the extension says that Legiit cannot receive this yet, and hides the button.
      'error.404-feature-not-available.json': [save, 'unavailable', 'This Legiit feature is not available'],
      'error.409-save-still-running.json': [save, 'rejected', shown(409, 'error.409-save-still-running.json')],
      'error.413-body-too-large.json': [save, 'rejected', shown(413, 'error.413-body-too-large.json')],
      'error.422-invalid-body.json': [save, 'rejected', shown(422, 'error.422-invalid-body.json')],
      'error.429-allowance-used-up.json': [ai, 'rejected', shown(429, 'error.429-allowance-used-up.json')],
      'error.429-too-many-requests.json': [save, 'rejected', shown(429, 'error.429-too-many-requests.json')],
    };
    expect(Object.keys(expected)).toEqual(exampleFiles().filter((f) => f.startsWith('error.')));
    for (const [name, [call, code, message]] of Object.entries(expected)) {
      const status = Number(name.slice(6, 9));
      const failure = await call(answeredWith(status, read(name)).client).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure, name).toBeInstanceOf(LegiitError);
      expect([(failure as LegiitError).code, (failure as LegiitError).status, (failure as LegiitError).message], name).toEqual([code, status, message]);
      // An error with the agreed body is the API's own verdict: for a 401 on the session check that deletes the token.
      expect((failure as LegiitError).definite, name).toBe(true);
    }
  });

  it('every error message is one plain sentence that fits on the screen, and says what the user can do', () => {
    for (const name of exampleFiles().filter((f) => f.startsWith('error.'))) {
      expect(messageOf(name).length, name).toBeLessThanOrEqual(200);
      expect(messageOf(name), name).not.toMatch(/[<>\n]/);
    }
    // The hand-written ones: what is wrong and, where the user can do something about it, a colon and what to do.
    // A body that is not JSON or is too large is not the user's to repair, so those two say only what is wrong.
    for (const name of Object.keys(replies).filter((f) => f.startsWith('error.'))) expect(messageOf(name), name).toMatch(/^[A-Z][^.:]+(: [a-z][^.:]+)?\.$/);
    for (const name of Object.keys(replies).filter((f) => /^error\.(403|409|429)-/.test(f))) expect(messageOf(name), name).toMatch(/: [a-z]/);
    // An allowance that is used up says when to try again; a refusal names its reason.
    for (const name of exampleFiles().filter((f) => f.startsWith('error.429-'))) expect(messageOf(name), name).toMatch(/try again in \d/);
    expect(messageOf('error.403-role-may-not-save.json')).toMatch(/^Your role /);
  });
});

describe('the real client accepts every example response', () => {
  it('through the same parsing the extension uses', async () => {
    const { client } = httpClient();
    const session = await client.getSession();
    expect(session).toMatchObject(read<Record<string, unknown>>('getSession.response.json'));
    expect(await client.listBusinesses()).toEqual(read<{ businesses: unknown[] }>('listBusinesses.response.json').businesses);
    expect(await client.getBusinessDetails(EXAMPLE_BUSINESS_ID)).toEqual(read('getBusinessDetails.response.json'));
    expect(await client.getIndustryPulse()).toEqual(read('getIndustryPulse.response.json'));
    expect(await client.saveVisibilitySnapshot(EXAMPLE_BUSINESS_ID, read('saveVisibilitySnapshot.request.json'))).toMatchObject({ id: expect.any(String) });
    expect(await client.saveGapList(EXAMPLE_BUSINESS_ID, read('saveGapList.request.json'))).toMatchObject({ id: expect.any(String) });
    expect(await client.addCompetitor(EXAMPLE_BUSINESS_ID, read('addCompetitor.request.json'))).toMatchObject({ id: expect.any(String) });
    expect(await client.addCompetitor(EXAMPLE_BUSINESS_ID, read('addCompetitor.name-only.request.json'))).toMatchObject({ id: expect.any(String) });
    expect(await client.sendToContentEditor(EXAMPLE_BUSINESS_ID, read('sendToContentEditor.request.json'))).toMatchObject({ id: expect.any(String) });
    expect(await client.sendToContentEditor(EXAMPLE_BUSINESS_ID, read('sendToContentEditor.pasted-text.request.json'))).toMatchObject({ id: expect.any(String) });
    expect(await client.createWorkspaceFromBrief(read('createWorkspaceFromBrief.request.json'))).toMatchObject({ id: expect.any(String) });
    expect((await client.completeAI(read('completeAI.request.json'))).text.length).toBeGreaterThan(0);
    expect((await client.completeAI(read('completeAI.brief.request.json'))).text).toContain('"avatars"');
  });
});

describe('the mock server behaves as the guide asks of the real one', () => {
  const post = (state: ReturnType<typeof createMockState>, path: string, body: unknown, headers: Record<string, string> = {}) =>
    handleMockRequest(state, { method: 'POST', path, headers: { ...auth, ...headers }, body: JSON.stringify(body) });
  const competitors = `/v1/businesses/${EXAMPLE_BUSINESS_ID}/competitors`;

  it('answers a repeated Idempotency-Key with the first reply and stores nothing new', () => {
    const state = createMockState();
    const snapshot = read('saveVisibilitySnapshot.request.json');
    const path = `/v1/businesses/${EXAMPLE_BUSINESS_ID}/visibility-snapshots`;
    const first = post(state, path, snapshot, { 'Idempotency-Key': 'key-1' });
    const again = post(state, path, snapshot, { 'idempotency-key': 'key-1' });
    const other = post(state, path, snapshot, { 'Idempotency-Key': 'key-2' });
    expect(again).toEqual(first);
    expect(JSON.parse(other.body).id).not.toBe(JSON.parse(first.body).id);
    expect(state.saved.visibilitySnapshots).toHaveLength(2);
    // Without a key every request is a new item.
    post(state, path, snapshot);
    post(state, path, snapshot);
    expect(state.saved.visibilitySnapshots).toHaveLength(4);
  });

  it('adds a competitor once, and lists it in Business Details afterwards', () => {
    const state = createMockState();
    const first = post(state, competitors, { name: 'Riverbend Dental', domains: ['riverbenddental.example'] });
    const sameName = post(state, competitors, { name: ' riverbend dental ', domains: ['riverbend.example'] });
    const sameDomain = post(state, competitors, { name: 'Riverbend', domains: ['https://www.RiverbendDental.example/about'] });
    expect([first.status, sameName.status, sameDomain.status]).toEqual([201, 200, 200]);
    expect(JSON.parse(sameName.body)).toEqual(JSON.parse(first.body));
    expect(JSON.parse(sameDomain.body)).toEqual(JSON.parse(first.body));
    expect(state.saved.competitors).toHaveLength(1);
    const read = () => JSON.parse(handleMockRequest(state, { method: 'GET', path: `/v1/businesses/${EXAMPLE_BUSINESS_ID}`, headers: auth }).body) as { competitors: { name: string; domains: string[] }[] };
    // It keeps its name and gains the domain it did not have.
    expect(read().competitors.at(-1)).toEqual({ name: 'Riverbend Dental', domains: ['riverbenddental.example', 'riverbend.example'] });
    expect(read().competitors.filter((c) => c.name === 'Riverbend Dental')).toHaveLength(1);
    // A competitor the business already had is returned with its own id, not added again.
    const known = post(state, competitors, { name: 'LAKESIDE SMILES', domains: [] });
    expect(known.status).toBe(200);
    expect(JSON.parse(known.body).id).toBe('com_seed_1');
    expect(read().competitors.filter((c) => c.name === 'Lakeside Smiles')).toHaveLength(1);
    // A name match wins over a domain match; a subdomain is another domain.
    const both = post(state, competitors, { name: 'Capitol Dental Care', domains: ['lakesidesmiles.example', 'capitol-second.example'] });
    expect(JSON.parse(both.body).id).toBe('com_seed_2');
    // The competitor gains the domain nobody had; the one that belongs to another competitor stays where it is.
    expect(read().competitors.find((c) => c.name === 'Capitol Dental Care')!.domains).toEqual(['capitoldentalcare.example', 'capitol-second.example']);
    expect(read().competitors.filter((c) => (c.domains ?? []).includes('lakesidesmiles.example')).map((c) => c.name)).toEqual(['Lakeside Smiles']);
    expect(post(state, competitors, { name: 'Lakeside Blog', domains: ['blog.lakesidesmiles.example'] }).status).toBe(201);
    // No name matches and the domains belong to two competitors: the first domain of the request decides.
    const matched = (domains: string[]): [number, string] => {
      const reply = post(state, competitors, { name: 'A name nobody has', domains });
      return [reply.status, JSON.parse(reply.body).id as string];
    };
    expect(matched(['capitoldentalcare.example', 'lakesidesmiles.example'])).toEqual([200, 'com_seed_2']);
    expect(matched(['lakesidesmiles.example', 'capitoldentalcare.example'])).toEqual([200, 'com_seed_1']);
    expect(matched(['not-known-yet.example', 'capitoldentalcare.example'])).toEqual([200, 'com_seed_2']);
  });

  it('gives a remembered reply before it looks at the fields, and after the business was checked', () => {
    const state = createMockState();
    const headers = { ...auth, 'idempotency-key': 'key-1' };
    const send = (path: string, body: unknown) => handleMockRequest(state, { method: 'POST', path, headers, body: JSON.stringify(body) });
    const first = send(competitors, { name: 'Northside Dental', domains: [] });
    expect(first.status).toBe(201);
    // The same key with a body that would be refused: the first reply again, nothing is validated or stored.
    const again = send(competitors, { name: 'Only a name' });
    expect([again.status, JSON.parse(again.body)]).toEqual([201, JSON.parse(first.body)]);
    // The business is checked first: a remembered reply is never given for another path or a missing business.
    expect(send('/v1/businesses/nope/competitors', { name: 'Northside Dental', domains: [] }).status).toBe(404);
    expect(state.saved.competitors).toHaveLength(1);
  });

  it('looks up remembered replies per user, and gives the second token a user of its own', () => {
    const state = createMockState();
    const path = '/v1/businesses/biz_brightpath/visibility-snapshots';
    const body = JSON.stringify(read('saveVisibilitySnapshot.request.json'));
    const send = (token: string) => handleMockRequest(state, { method: 'POST', path, headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'one-key' }, body });
    const first = send(MOCK_TOKENS.valid);
    // The same key from the same user: the first reply again. The same key from another user: another save.
    expect(JSON.parse(send(MOCK_TOKENS.valid).body)).toEqual(JSON.parse(first.body));
    expect(JSON.parse(send(MOCK_TOKENS.limited).body).id).not.toBe(JSON.parse(first.body).id);
    expect(state.saved.visibilitySnapshots).toHaveLength(2);
    const who = (token: string) => (JSON.parse(handleMockRequest(state, { method: 'GET', path: '/v1/session', headers: { authorization: `Bearer ${token}` } }).body) as { user: { id: string } }).user.id;
    expect(who(MOCK_TOKENS.valid)).not.toBe(who(MOCK_TOKENS.limited));
  });

  it('answers a preflight on any path without a token, and sends the CORS headers with every reply', () => {
    const state = createMockState();
    const preflight = handleMockRequest(state, { method: 'OPTIONS', path: '/v1/anything', headers: {} });
    expect(preflight.status).toBe(204);
    for (const reply of [preflight, handleMockRequest(state, { method: 'GET', path: '/v1/session', headers: {} }), handleMockRequest(state, { method: 'GET', path: '/v1/session', headers: auth })]) {
      expect(reply.headers).toMatchObject(CORS_HEADERS);
    }
    // The guide prints the same four headers.
    const guide = readFileSync(resolve(KIT_DIR, 'README.md'), 'utf8');
    expect(guide).toContain(`Access-Control-Allow-Headers: ${CORS_HEADERS['access-control-allow-headers']}`);
    expect(guide).toContain(`Access-Control-Allow-Methods: ${CORS_HEADERS['access-control-allow-methods']}`);
    expect(guide).toContain(`Access-Control-Max-Age: ${CORS_HEADERS['access-control-max-age']}`);
  });

  it('keeps one workspace per brief and per account', () => {
    const state = createMockState();
    const brief = read<Record<string, unknown>>('createWorkspaceFromBrief.request.json');
    const first = post(state, '/v1/workspaces/from-brief', brief);
    const again = post(state, '/v1/workspaces/from-brief', { ...brief, competitors: [] });
    const other = post(state, '/v1/workspaces/from-brief', { ...brief, briefId: 'another-brief' });
    expect([first.status, again.status, other.status]).toEqual([201, 200, 201]);
    expect(JSON.parse(again.body)).toEqual(JSON.parse(first.body));
    expect(state.saved.workspaces).toHaveLength(2);
    // The second send replaced the stored brief.
    expect(state.saved.workspaces[0]!.payload['competitors']).toEqual([]);
  });

  it('uses 401 only for the token, 404 "not_found" only for a missing business, and refuses bodies the contract does not allow', () => {
    const state = createMockState();
    expect(handleMockRequest(state, { method: 'GET', path: '/v1/session', headers: {} }).status).toBe(401);
    expect(handleMockRequest(state, { method: 'GET', path: '/v1/session', headers: { Authorization: 'bearer demo-token' } }).status).toBe(200);
    expect(JSON.parse(post(state, '/v1/businesses/nope/gap-lists', read('saveGapList.request.json')).body)).toEqual({ error: { code: 'not_found', message: 'No such business' } });
    expect(JSON.parse(handleMockRequest(state, { method: 'GET', path: '/v1/nope', headers: auth }).body).error.code).toBe('not_available');
    expect(post(state, competitors, { name: 'Only a name' }).status).toBe(422);
    expect(post(state, competitors, { name: 'N', domains: [], somethingNew: true }).status).toBe(201);
    expect(handleMockRequest(state, { method: 'POST', path: competitors, headers: auth, body: '{not json' }).status).toBe(400);
    expect(post(state, competitors, []).status).toBe(400);
    expect(post(state, '/v1/ai/completions', { task: 'rewind' }).status).toBe(422);
    // An id that is the name of something built into JavaScript, or that cannot be decoded, is simply not found.
    for (const id of ['constructor', '__proto__', 'toString', '%E0%A4%A', '..%2F..']) {
      const reply = handleMockRequest(state, { method: 'GET', path: `/v1/businesses/${id}`, headers: auth });
      expect([reply.status, JSON.parse(reply.body).error.code], id).toEqual([404, 'not_found']);
      expect(post(state, `/v1/businesses/${id}/competitors`, { name: 'N', domains: [] }).status, id).toBe(404);
    }
  });

  it('answers every failure with the agreed error body and a message of at most 200 characters', () => {
    const state = createMockState();
    const snapshot = read<Record<string, unknown>>('saveVisibilitySnapshot.request.json');
    const brief = read<Record<string, unknown>>('createWorkspaceFromBrief.request.json');
    const replies = [
      handleMockRequest(state, { method: 'GET', path: '/v1/session', headers: {} }),
      handleMockRequest(state, { method: 'GET', path: `/v1/${'very-long-path/'.repeat(40)}`, headers: auth }),
      handleMockRequest(state, { method: 'DELETE', path: '/v1/session', headers: auth }),
      post(state, `/v1/businesses/${EXAMPLE_BUSINESS_ID}/visibility-snapshots`, { ...snapshot, grade: { letter: 'Z', score: 1, estimate: true } }),
      post(state, '/v1/workspaces/from-brief', { ...brief, issues: [{ code: 'x', severity: 'catastrophic', title: 't', detail: 'd', pages: ['https://a.example/'] }] }),
      post(state, '/v1/workspaces/from-brief', { ...brief, markdown: 'x'.repeat(MAX_REQUEST_BYTES) }),
      post(state, '/v1/ai/completions', {}),
    ];
    expect(replies.map((r) => r.status)).toEqual([401, 404, 404, 422, 422, 413, 422]);
    for (const reply of replies) {
      const body = JSON.parse(reply.body) as { error: { code: string; message: string } };
      expect(validators('Error')(body), reply.body).toBe(true);
      expect(body.error.message.length).toBeLessThanOrEqual(200);
      expect(reply.headers['content-type']).toContain('application/json');
    }
  });

  it('answers the AI endpoint the way the guide asks a real model to', () => {
    const state = createMockState();
    const summary = JSON.parse(post(state, '/v1/ai/completions', read('completeAI.request.json')).body) as { text: string };
    const points = summary.text.split('\n');
    expect(points.length).toBeGreaterThanOrEqual(3);
    expect(points.length).toBeLessThanOrEqual(6);
    expect(points.every((line) => line.startsWith('- ') && line.length < 600)).toBe(true);
    expect(toLines(summary.text)).toHaveLength(points.length);
    const brief = JSON.parse(post(state, '/v1/ai/completions', read('completeAI.brief.request.json')).body) as { text: unknown };
    expect(typeof brief.text).toBe('string');
    expect(parseBriefRewrite(brief.text as string)?.avatars).toHaveLength(3);
  });
});

describe('values that a later version may extend', () => {
  type Node = { properties?: Record<string, Node>; items?: Node; $ref?: string; oneOf?: Node[]; 'x-values'?: string[]; enum?: unknown[] };
  const schemas = contract.components.schemas as Record<string, Node>;
  const resolveRef = (node: Node): Node => {
    const ref = node.$ref ?? node.oneOf?.find((n) => n.$ref)?.$ref;
    return ref ? { ...schemas[nameOf(ref)]!, ...node } : node;
  };

  it('every example uses only the values the contract lists for this version', () => {
    const seen: string[] = [];
    const walk = (schemaNode: Node, value: unknown, path: string): void => {
      const schema = resolveRef(schemaNode);
      if (Array.isArray(value)) return value.forEach((item, i) => schema.items && walk(schema.items, item, `${path}[${i}]`));
      if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) if (schema.properties?.[key]) walk(schema.properties[key], child, `${path}.${key}`);
        return;
      }
      if (schema['x-values']) {
        seen.push(path);
        expect(schema['x-values'], `${path} = ${String(value)}`).toContain(value);
      }
    };
    for (const op of operations.filter((o) => o.requestSchema)) {
      for (const file of requestFilesOf(op)) walk(schemas[op.requestSchema!]!, read(file), file);
    }
    walk(schemas['Session']!, read('getSession.response.json'), 'getSession.response.json');
    expect(seen.length).toBeGreaterThan(40);
  });

  it('the server is told to accept other values: the mock stores a body with a value it has never seen', () => {
    const state = createMockState();
    const gaps = read<{ rows: Record<string, unknown>[] }>('saveGapList.request.json');
    const later = { ...gaps, rows: [{ ...gaps.rows[0], surfaceId: 'a_surface_added_later', pageType: 'a-type-added-later' }] };
    expect(handleMockRequest(state, { method: 'POST', path: `/v1/businesses/${EXAMPLE_BUSINESS_ID}/gap-lists`, headers: auth, body: JSON.stringify(later) }).status).toBe(201);
    const brief = read<{ issues: Record<string, unknown>[] }>('createWorkspaceFromBrief.request.json');
    const newCode = { ...brief, issues: [{ ...brief.issues[0], code: 'a-finding-added-later' }] };
    expect(handleMockRequest(state, { method: 'POST', path: '/v1/workspaces/from-brief', headers: auth, body: JSON.stringify(newCode) }).status).toBe(201);
  });
});

describe('limits: what the code enforces is what the contract promises', () => {
  type Schema = { properties?: Record<string, Schema>; items?: Schema; maxLength?: number; maxItems?: number; maximum?: number; $ref?: string; oneOf?: Schema[] };
  const schemas = contract.components.schemas as Record<string, Schema>;
  const resolveRef = (schema: Schema): Schema => {
    const viaOneOf = schema.oneOf?.find((s) => s.$ref);
    const ref = schema.$ref ?? viaOneOf?.$ref;
    return ref ? { ...schemas[nameOf(ref)]!, ...schema } : schema;
  };
  /** "GapList.rows[].contacts[].label" → the schema of that field. */
  const at = (path: string): Schema => {
    const [root, ...parts] = path.split('.');
    let schema = resolveRef(schemas[root!]!);
    for (const part of parts) {
      const list = part.endsWith('[]');
      schema = resolveRef(schema.properties![list ? part.slice(0, -2) : part]!);
      if (list) schema = resolveRef(schema.items!);
    }
    return schema;
  };
  const arrayAt = (path: string): Schema => {
    const parent = path.split('.');
    const last = parent.pop()!;
    return resolveRef((parent.length > 1 ? at(parent.join('.')) : resolveRef(schemas[parent[0]!]!)).properties![last]!);
  };

  it('text limits', () => {
    const text: [string, number][] = [
      ['HttpUrl', LIMITS.url],
      ['VisibilitySnapshot.keyword', LIMITS.snapshot.keyword],
      ['VisibilitySnapshot.location', LIMITS.snapshot.location],
      ['VisibilitySnapshot.organic[].title', LIMITS.snapshot.title],
      ['VisibilitySnapshot.organic[].url', LIMITS.url],
      ['VisibilitySnapshot.organic[].domain', LIMITS.domain],
      ['VisibilitySnapshot.tracked[].name', LIMITS.brandName],
      ['GapList.source', LIMITS.gapList.source],
      ['GapList.subject', LIMITS.gapList.subject],
      ['GapList.rows[].surface', LIMITS.gapList.surface],
      ['GapList.rows[].title', LIMITS.gapList.title],
      ['GapList.rows[].url', LIMITS.url],
      ['GapList.rows[].domain', LIMITS.domain],
      ['GapList.rows[].evidence', LIMITS.gapList.evidence],
      ['GapList.rows[].competitors[]', LIMITS.brandName],
      ['GapList.rows[].contacts[].label', LIMITS.gapList.contactLabel],
      ['GapList.rows[].contacts[].url', LIMITS.url],
      ['Competitor.name', LIMITS.brandName],
      ['Competitor.domains[]', LIMITS.domain],
      ['ContentEditorDocument.targetKeyword', LIMITS.contentEditor.keyword],
      ['ContentEditorDocument.pageUrl', LIMITS.url],
      ['ContentEditorDocument.pageTitle', LIMITS.contentEditor.title],
      ['ContentEditorDocument.onlyHere[]', LIMITS.contentEditor.sentence],
      ['ContentEditorDocument.missingPoints[].text', LIMITS.contentEditor.sentence],
      ['ContentEditorDocument.missingPoints[].urls[]', LIMITS.url],
      ['ContentEditorDocument.comparedUrls[]', LIMITS.url],
      ['WorkspaceFromBrief.businessName', LIMITS.workspace.businessName],
      ['WorkspaceFromBrief.siteUrl', LIMITS.url],
      ['WorkspaceFromBrief.contact.phones[]', LIMITS.workspace.phone],
      ['WorkspaceFromBrief.contact.emails[]', LIMITS.workspace.email],
      ['WorkspaceFromBrief.contact.addresses[]', LIMITS.workspace.address],
      ['WorkspaceFromBrief.serviceAreas[]', LIMITS.workspace.serviceArea],
      ['WorkspaceFromBrief.services[]', LIMITS.workspace.service],
      ['WorkspaceFromBrief.competitors[].name', LIMITS.brandName],
      ['WorkspaceFromBrief.focusKeywords[]', LIMITS.workspace.focusKeyword],
      ['WorkspaceFromBrief.avatars[].name', LIMITS.workspace.avatarName],
      ['WorkspaceFromBrief.avatars[].description', LIMITS.workspace.avatarDescription],
      ['WorkspaceFromBrief.issues[].title', LIMITS.workspace.issueTitle],
      ['WorkspaceFromBrief.issues[].pages[]', LIMITS.url],
      ['WorkspaceFromBrief.nextSteps[]', LIMITS.workspace.nextStep],
      ['WorkspaceFromBrief.markdown', LIMITS.workspace.markdown],
      ['AiCompletionRequest.system', LIMITS.ai.system],
      ['AiCompletionRequest.prompt', LIMITS.ai.prompt],
    ];
    for (const [path, limit] of text) expect(at(path).maxLength, path).toBe(limit);
  });

  it('list limits', () => {
    const lists: [string, number][] = [
      ['VisibilitySnapshot.firstScreenShares', LIMITS.snapshot.firstScreenShares],
      ['VisibilitySnapshot.organic', LIMITS.snapshot.organic],
      ['VisibilitySnapshot.tracked', LIMITS.snapshot.tracked],
      ['GapList.rows', LIMITS.gapList.rows],
      ['GapList.rows[].competitors', LIMITS.gapList.competitors],
      ['GapList.rows[].contacts', LIMITS.gapList.contacts],
      ['Competitor.domains', LIMITS.brandDomains],
      ['ContentEditorDocument.onlyHere', LIMITS.contentEditor.onlyHere],
      ['ContentEditorDocument.missingPoints', LIMITS.contentEditor.missingPoints],
      ['ContentEditorDocument.missingPoints[].urls', LIMITS.contentEditor.urls],
      ['ContentEditorDocument.comparedUrls', LIMITS.contentEditor.urls],
      ['WorkspaceFromBrief.contact.phones', LIMITS.workspace.phones],
      ['WorkspaceFromBrief.contact.emails', LIMITS.workspace.emails],
      ['WorkspaceFromBrief.contact.addresses', LIMITS.workspace.addresses],
      ['WorkspaceFromBrief.serviceAreas', LIMITS.workspace.serviceAreas],
      ['WorkspaceFromBrief.services', LIMITS.workspace.services],
      ['WorkspaceFromBrief.competitors', LIMITS.workspace.competitors],
      ['WorkspaceFromBrief.focusKeywords', LIMITS.workspace.focusKeywords],
      ['WorkspaceFromBrief.avatars', LIMITS.workspace.avatars],
      ['WorkspaceFromBrief.issues', LIMITS.workspace.issues],
      ['WorkspaceFromBrief.issues[].pages', LIMITS.workspace.issuePages],
      ['WorkspaceFromBrief.nextSteps', LIMITS.workspace.nextSteps],
    ];
    for (const [path, limit] of lists) expect(arrayAt(path).maxItems, path).toBe(limit);
    expect(at('VisibilitySnapshot.organic[].position').maximum).toBe(LIMITS.snapshot.organic);
    for (const path of ['VisibilitySnapshot.firstOrganicTopPx', 'VisibilitySnapshot.organic[].topPx', 'VisibilitySnapshot.tracked[].topPx']) expect(at(path).maximum, path).toBe(LIMITS.px);
    for (const path of ['VisibilitySnapshot.viewport.width', 'VisibilitySnapshot.viewport.height']) expect(at(path).maximum, path).toBe(LIMITS.viewport);
    expect(at('GapList.rows[].position').maximum).toBe(LIMITS.gapList.position);
    expect(at('WorkspaceFromBrief.briefId').maxLength).toBe(LIMITS.workspace.briefId);
    expect(at('WorkspaceFromBrief.issues[].detail').maxLength).toBe(LIMITS.workspace.issueDetail);
    expect(LIMITS.ai.maxOutputTokensJson).toBeLessThanOrEqual(at('AiCompletionRequest.maxOutputTokens').maximum!);
    expect(at('ContentEditorDocument.method.pagesCompared').maximum).toBe(LIMITS.contentEditor.urls);
    expect(LIMITS.ai.maxOutputTokens).toBeLessThanOrEqual(at('AiCompletionRequest.maxOutputTokens').maximum!);
  });

  it('every text and list in a request schema has a limit', () => {
    const unbounded: string[] = [];
    const walk = (schema: Schema & { type?: string | string[]; enum?: unknown[]; const?: unknown; format?: string; pattern?: string }, path: string, depth = 0): void => {
      const resolved = resolveRef(schema) as typeof schema;
      const types = Array.isArray(resolved.type) ? resolved.type : resolved.type ? [resolved.type] : [];
      if (types.includes('string') && resolved.maxLength === undefined && !resolved.enum && resolved.const === undefined && resolved.format !== 'date-time' && resolved.format !== 'uuid') unbounded.push(path);
      if (types.includes('array') && resolved.maxItems === undefined) unbounded.push(`${path} (items)`);
      for (const [name, child] of Object.entries(resolved.properties ?? {})) walk(child, `${path}.${name}`, depth + 1);
      if (resolved.items) walk(resolved.items, `${path}[]`, depth + 1);
    };
    for (const name of ['VisibilitySnapshot', 'GapList', 'Competitor', 'ContentEditorDocument', 'WorkspaceFromBrief']) walk(schemas[name]!, name);
    expect(unbounded).toEqual([]);
  });

  it('the capability list of the contract is the one the extension knows', () => {
    expect((schemas['Capability'] as { 'x-values'?: string[] })['x-values']).toEqual([...ALL_CAPABILITIES]);
  });
});

/**
 * docs/legiit-api/schemas: every request body as a standalone JSON Schema file, for a team that validates with a
 * JSON Schema library and not with an OpenAPI tool. That the files are current is checked with the reference
 * ("contract hygiene" below).
 */
describe('the standalone JSON Schema files', () => {
  const SCHEMAS_DIR = join(KIT_DIR, 'schemas');
  const withBody = operations.filter((op) => op.requestSchema);
  const schemaFile = (op: Operation): string => `${op.operationId}.request.schema.json`;
  const schemaOf = (op: Operation) => JSON.parse(readFileSync(join(SCHEMAS_DIR, schemaFile(op)), 'utf8')) as Record<string, unknown>;
  // Strict: a keyword that is not JSON Schema 2020-12 ("x-values", a typing mistake) fails the compilation.
  const compile = (schema: Record<string, unknown>) => {
    const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
    addFormats(ajv);
    return ajv.compile(schema);
  };

  it('there is one for every endpoint that takes a body, and nothing else in the folder', () => {
    expect(readdirSync(SCHEMAS_DIR).sort()).toEqual(withBody.map(schemaFile).sort());
  });

  it('each is JSON Schema 2020-12 with standard keywords only, and without a reference to another file', () => {
    for (const op of withBody) {
      const schema = schemaOf(op);
      expect(schema['$schema'], schemaFile(op)).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(String(schema['$comment']), schemaFile(op)).toContain(contract.info.version);
      expect(JSON.stringify(schema), schemaFile(op)).not.toMatch(/"\$ref"|"x-/);
      expect(() => compile(schema), schemaFile(op)).not.toThrow();
    }
  });

  it('each accepts every example of its endpoint and refuses {}', () => {
    for (const op of withBody) {
      const validate = compile(schemaOf(op));
      for (const requestFile of requestFilesOf(op)) expect(validate(read(requestFile)), `${requestFile}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(validate({}), schemaFile(op)).toBe(false);
    }
  });

  it('they accept what a later extension version may send, and refuse what the contract refuses', () => {
    const snapshots = compile(schemaOf(operations.find((op) => op.operationId === 'saveVisibilitySnapshot')!));
    const snapshot = read<Record<string, unknown>>('saveVisibilitySnapshot.request.json');
    // A field that is not known, and a value that is not in an open list ("Values in this version"): accepted.
    expect(snapshots({ ...snapshot, addedByALaterExtensionVersion: { anything: true } })).toBe(true);
    expect(snapshots({ ...snapshot, mode: 'a-mode-added-later' })).toBe(true);
    // A closed list, a missing field, a wrong type, a text over its limit: refused.
    expect(snapshots({ ...snapshot, firstOrganicFold: 'middle' })).toBe(false);
    expect(snapshots({ ...snapshot, keyword: undefined })).toBe(false);
    expect(snapshots({ ...snapshot, keyword: 42 })).toBe(false);
    expect(snapshots({ ...snapshot, keyword: 'k'.repeat(LIMITS.snapshot.keyword + 1) })).toBe(false);
    // maxLength counts characters, the contract counts UTF-16 units: a text of emoji at the limit of the contract is inside both.
    const emoji = '🦷'.repeat(LIMITS.snapshot.keyword / 2);
    expect(emoji).toHaveLength(LIMITS.snapshot.keyword);
    expect(snapshots({ ...snapshot, keyword: emoji })).toBe(true);
    expect(validators('VisibilitySnapshot')({ ...snapshot, keyword: emoji })).toBe(true);
    // A URL that a strict URI validator refuses, and a contact that is an e-mail link.
    const gaps = compile(schemaOf(operations.find((op) => op.operationId === 'saveGapList')!));
    const list = read<{ rows: Record<string, unknown>[] }>('saveGapList.request.json');
    const row = { ...list.rows[0], url: 'https://example.com/a|b?x=[1]', contacts: [{ kind: 'contact', label: 'Write to us', url: 'mailto:hello@example.com' }] };
    expect(gaps({ ...list, rows: [row] })).toBe(true);
    expect(gaps({ ...list, rows: [{ ...row, pageType: 'a-type-added-later' }] })).toBe(true);
    expect(gaps({ ...list, rows: [] })).toBe(false);
  });

  it('they give the same verdict as the schemas inside openapi.yaml, also on bodies with one field missing or of the wrong type', () => {
    for (const op of withBody) {
      const standalone = compile(schemaOf(op));
      const inContract = validators(op.requestSchema!);
      const first = read<Record<string, unknown>>(requestFilesOf(op)[0]!);
      const bodies: unknown[] = [first, {}, [], null, 'text', ...Object.keys(first).map((key) => ({ ...first, [key]: undefined })), ...Object.keys(first).map((key) => ({ ...first, [key]: { not: 'expected' } }))];
      for (const body of bodies) expect(standalone(body), `${schemaFile(op)} with ${JSON.stringify(body)?.slice(0, 80)}`).toBe(inContract(body));
    }
  });
});

describe('contract hygiene', () => {
  it('is a well-formed OpenAPI 3.1 document: every reference resolves and no schema keyword is misspelt', () => {
    expect((contract as unknown as { openapi: string }).openapi).toMatch(/^3\.1\./);
    // Every "$ref" in the document points at something that exists.
    const dangling: string[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') {
          const target = value.replace(/^#\//, '').split('/').reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], contract);
          if (target === undefined) dangling.push(value);
        } else visit(value);
      }
    };
    visit(contract);
    expect(dangling).toEqual([]);

    // Strict compilation refuses unknown keywords ("maxlength", "require"…), so a typo cannot silently switch a rule off.
    const strict = new Ajv2020({ strict: true, allowUnionTypes: true, validateFormats: false });
    for (const keyword of ['components', 'x-examples', 'x-values', 'x-uses', 'x-capability', 'x-called-when', 'x-extension-reaction']) strict.addKeyword(keyword);
    strict.addSchema({ $id: 'https://legiit.invalid/strict', components: { schemas: contract.components.schemas } });
    for (const name of Object.keys(contract.components.schemas)) {
      expect(() => strict.getSchema(`https://legiit.invalid/strict#/components/schemas/${name}`), name).not.toThrow();
    }

    // Every operation has an id, a summary, when it is called, and a reply with a JSON schema; every parameter and reply it names exists.
    for (const [path, methods] of Object.entries(contract.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const op = operation as unknown as { operationId?: string; summary?: string; 'x-called-when'?: string; parameters?: { $ref: string }[]; responses: Record<string, unknown> };
        const where = `${method.toUpperCase()} ${path}`;
        expect(op.operationId, where).toMatch(/^[a-zA-Z]+$/);
        expect(op.summary?.length ?? 0, where).toBeGreaterThan(10);
        expect(op['x-called-when']?.length ?? 0, where).toBeGreaterThan(10);
        expect(Object.keys(op.responses).some((status) => /^2\d\d$/.test(status)), where).toBe(true);
        expect((path.match(/\{(\w+)\}/g) ?? []).length, where).toBe((op.parameters ?? []).filter((p) => p.$ref.endsWith('/BusinessId')).length);
      }
    }
  });

  it('no line of a description starts with a number and a full stop by accident (some Markdown readers start a list there)', () => {
    // "…answer\n502. Both tries…" is one paragraph on GitHub, and a numbered list that loses the 502 in other readers.
    const accidents: string[] = [];
    const visit = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((item, index) => visit(item, `${path}[${index}]`));
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'description' && typeof value === 'string') {
          const lines = value.split('\n');
          lines.forEach((line, index) => {
            const before = lines[index - 1] ?? '';
            const startsList = /^\s{0,3}\d{1,9}[.)] /.test(line);
            const listGoesOn = before.trim() === '' || /^\s*(\d{1,9}[.)]|[-*+]) /.test(before) || /^\s{2,}\S/.test(before);
            if (index > 0 && startsList && !listGoesOn) accidents.push(`${path}.description: "${line.trim().slice(0, 40)}"`);
          });
        } else visit(value, `${path}.${key}`);
      }
    };
    visit(contract, '');
    expect(accidents).toEqual([]);
  });

  it('has one operation per client method, in the documented order', () => {
    expect(operations.map((o) => o.operationId).sort()).toEqual((Object.keys(METHOD_CAPABILITY) as LegiitMethod[]).sort());
  });

  it('describes every field, so the generated reference has no blank rows', () => {
    const missing: string[] = [];
    const walk = (schema: Record<string, unknown> | undefined, path: string): void => {
      if (!schema || typeof schema !== 'object') return;
      if (typeof schema['$ref'] === 'string') return;
      const properties = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
      for (const [name, child] of Object.entries(properties ?? {})) {
        const childPath = `${path}.${name}`;
        if (typeof child['$ref'] !== 'string' && !child['description'] && !child['enum'] && !child['properties'] && !(child['items'] as Record<string, unknown> | undefined)?.['properties']) {
          missing.push(childPath);
        }
        walk(child, childPath);
        walk(child['items'] as Record<string, unknown> | undefined, `${childPath}[]`);
      }
    };
    for (const [name, schema] of Object.entries(contract.components.schemas)) walk(schema as Record<string, unknown>, name);
    expect(missing).toEqual([]);
  });

  it('the generated files are up to date: the reference, the contract with examples, the JSON Schema files', () => {
    execFileSync(process.execPath, ['scripts/build-api-reference.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
    const reference = readFileSync(join(KIT_DIR, 'reference.md'), 'utf8');
    for (const op of operations) expect(reference).toContain(`${op.method} ${op.path}`);
  });

  it('the reference keeps the sections that are copied into other documents, and each of its links leads somewhere', () => {
    const reference = readFileSync(join(KIT_DIR, 'reference.md'), 'utf8').replace(/```[\s\S]*?```/g, '');
    const headings = [...reference.matchAll(/^(#{1,6}) (.+)$/gm)].map((match) => ({ level: match[1]!.length, text: match[2]! }));
    // One "##" section per endpoint, then the shared parts, the shared types and the errors.
    expect(headings.filter((h) => h.level === 2).map((h) => h.text)).toEqual([...operations.map((op, index) => `${index + 1}. ${op.method} ${op.path}`), 'Shared parameters and responses', 'Shared types', 'Errors']);
    // A link inside the file points at a heading, by the id that GitHub gives it; that heading exists once.
    const slug = (heading: string): string => heading.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    const ids = headings.map((h) => slug(h.text));
    const targets = [...reference.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!);
    expect(targets.length).toBeGreaterThan(40);
    for (const target of targets) {
      if (target.startsWith('#')) expect(ids.filter((id) => `#${id}` === target), target).toHaveLength(1);
      else expect(existsSync(join(KIT_DIR, target)), target).toBe(true);
    }
    // The endpoint table at the top links to every endpoint.
    for (const [index, op] of operations.entries()) expect(reference).toContain(`| ${index + 1} | [\`${op.method} ${op.path}\`](#${slug(`${index + 1}. ${op.method} ${op.path}`)}) |`);
    // No two-column table without a header row: some converters drop it.
    expect(reference).not.toMatch(/^\| \| \|$/m);
    // Every row of a table has as many cells as its header, and no code span holds a "|" that would split a cell.
    const cells = (line: string): number => line.split(/(?<!\\)\|/).length - 2;
    let header = 0;
    for (const line of reference.split('\n')) {
      if (!line.startsWith('|')) header = 0;
      else {
        if (header === 0) header = cells(line);
        expect(cells(line), line.slice(0, 80)).toBe(header);
        expect((line.match(/`[^`]*`/g) ?? []).filter((span) => span.includes('|')), line.slice(0, 80)).toEqual([]);
      }
    }
  });

  it('every example file is shown in the reference and built into openapi.examples.json', () => {
    const reference = readFileSync(join(KIT_DIR, 'reference.md'), 'utf8');
    const inBundle: string[] = [];
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(collect);
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'examples' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
          for (const example of Object.values(value as Record<string, { value?: unknown }>)) if (example && typeof example === 'object' && 'value' in example) inBundle.push(JSON.stringify(example.value));
        } else collect(value);
      }
    };
    collect(JSON.parse(readFileSync(join(KIT_DIR, 'openapi.examples.json'), 'utf8')));
    expect(exampleFiles().length).toBeGreaterThan(40);
    for (const name of exampleFiles()) {
      expect(reference, name).toContain(`\`examples/${name}\``);
      expect(inBundle, name).toContain(JSON.stringify(read(name)));
    }
    // A request example says how large it is as sent, so that nobody has to keep such a number by hand.
    for (const name of Object.keys(built)) expect(reference, name).toContain(`\`examples/${name}\`. As sent, without white space: ${new TextEncoder().encode(JSON.stringify(read(name))).length.toLocaleString('en-US')} bytes.`);
  });

  it('the reference carries every "what the extension does" note of the contract', () => {
    const reference = readFileSync(join(KIT_DIR, 'reference.md'), 'utf8').replace(/\s+/g, ' ');
    const notes: string[] = [];
    const collect = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'x-extension-reaction' && typeof value === 'string') notes.push(value.trim().replace(/\s+/g, ' '));
        else collect(value);
      }
    };
    collect(contract);
    expect(notes.length).toBeGreaterThan(5);
    for (const note of notes) expect(reference, note).toContain(note);
  });

  it('shows every screenshot of the kit in the guide, and the guide names no image that is not there', () => {
    const guide = readFileSync(join(KIT_DIR, 'README.md'), 'utf8');
    const shown = [...guide.matchAll(/<img src="images\/([a-z-]+\.png)" width="(\d+)" alt="([^"<>]+)">/g)].map((match) => match[1]!);
    const files = readdirSync(join(KIT_DIR, 'images')).sort();
    expect([...shown].sort()).toEqual(files);
    expect(files.length).toBe(5);
    // Each image has a line under it that says what the reader sees.
    for (const name of shown) expect(guide, name).toMatch(new RegExp(`<img src="images/${name}"[^\\n]*>\\n\\n\\*[^\\n]+\\*\\n`));
  });

  it('writes no placeholder in angle brackets where a Markdown renderer would swallow it', () => {
    // "<token>" outside a code span is read as an HTML tag and vanishes on GitHub, in Swagger UI and in Postman.
    const tag = /<\/?[A-Za-z][^<>]*>/;
    const outsideCode = (text: string): string => text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
    const offending: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        if ((path.endsWith('.description') || path.endsWith('.summary') || path.includes('x-')) && tag.test(outsideCode(node))) offending.push(`openapi.yaml ${path}: ${tag.exec(outsideCode(node))![0]}`);
      } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
      }
    };
    walk(contract, '');
    // The one real tag of the kit is an image of the guide, written with its width because the files have 2 pixels per CSS pixel.
    const image = /<img src="images\/[a-z-]+\.png" width="\d+" alt="[^"<>]+">/g;
    for (const file of ['README.md', 'reference.md', 'captured-requests.md', 'decisions.md']) {
      const text = outsideCode(readFileSync(join(KIT_DIR, file), 'utf8').replace(image, ' ')).replace(/<!--[\s\S]*?-->/g, ' ');
      for (const line of text.split('\n')) if (tag.test(line)) offending.push(`${file}: ${tag.exec(line)![0]} in "${line.trim().slice(0, 80)}"`);
    }
    expect(offending).toEqual([]);
  });
});
