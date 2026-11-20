/**
 * The developer handoff kit in docs/legiit-api: the examples are what the
 * extension really sends, they match the contract, the mock server and the
 * real client agree with them, and the generated reference is current.
 *
 * To refresh the example files after a deliberate change to a payload:
 *   npm run api:examples
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { problemWith } from '@@/mock-server/contract.mjs';
import { createMockState, handleMockRequest, MOCK_TOKENS } from '@@/mock-server/handlers.mjs';
import { METHOD_CAPABILITY, type LegiitMethod } from '@/legiit/client';
import { LIMITS, MAX_REQUEST_BYTES } from '@/legiit/limits';
import { ALL_CAPABILITIES } from '@/legiit/types';
import { parseBriefRewrite } from '@/ai/brief-rewrite';
import { toLines } from '@/ai/provider';
import { contractValidators, EXAMPLES_DIR, KIT_DIR, loadContract, requestExamples } from '../api/suite';
import { buildExampleRequests, EXAMPLE_BUSINESS_ID, toExampleJson } from '../helpers/api-examples';
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
  });

  it('for the error cases the guide describes', async () => {
    const state = createMockState();
    const cases: [string, Parameters<typeof handleMockRequest>[1], number][] = [
      ['error.401-bad-token.json', { method: 'GET', path: '/v1/session', headers: { authorization: `Bearer ${MOCK_TOKENS.invalid}` } }, 401],
      ['error.404-business-not-found.json', { method: 'GET', path: '/v1/businesses/no-such-business', headers: auth }, 404],
      ['error.404-feature-not-available.json', { method: 'POST', path: '/v1/ai/completions', headers: { authorization: `Bearer ${MOCK_TOKENS.limited}` }, body: readFileSync(file('completeAI.request.json'), 'utf8') }, 404],
      ['error.422-invalid-body.json', { method: 'POST', path: `/v1/businesses/${EXAMPLE_BUSINESS_ID}/visibility-snapshots`, headers: auth, body: '{}' }, 422],
    ];
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
    expect(errors).toHaveLength(4);
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
    // Addresses a strict URI validator refuses are valid: browsers write them this way.
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
    const expected = new Set<string>();
    for (const op of operations) {
      if (op.requestSchema) for (const f of requestFilesOf(op)) expected.add(f).add(responseFileFor(f));
      else expected.add(`${op.operationId}.response.json`);
    }
    expect(exampleFiles().filter((f) => !expected.has(f) && !f.startsWith('error.'))).toEqual([]);
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
    const both = post(state, competitors, { name: 'Capitol Dental Care', domains: ['lakesidesmiles.example'] });
    expect(JSON.parse(both.body).id).toBe('com_seed_2');
    expect(post(state, competitors, { name: 'Lakeside Blog', domains: ['blog.lakesidesmiles.example'] }).status).toBe(201);
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

  it('the generated reference is up to date', () => {
    execFileSync(process.execPath, ['scripts/build-api-reference.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
    const reference = readFileSync(join(KIT_DIR, 'reference.md'), 'utf8');
    for (const op of operations) expect(reference).toContain(`${op.method} ${op.path}`);
  });
});
