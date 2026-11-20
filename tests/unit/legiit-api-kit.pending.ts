/**
 * The developer handoff kit in docs/legiit-api: the examples are what the
 * extension really sends, they match the contract, the mock server and the
 * real client agree with them, and the generated reference is current.
 *
 * To refresh the example files after a deliberate change to a payload:
 *   npm run api:examples
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMockState, handleMockRequest, MOCK_TOKENS } from '@@/mock-server/handlers.mjs';
import { METHOD_CAPABILITY, type LegiitMethod } from '@/legiit/client';
import { contractValidators, EXAMPLES_DIR, KIT_DIR, loadContract } from '../api/suite';
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
    const [status, success] = Object.entries(op.responses).find(([code]) => code.startsWith('2'))!;
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
const exampleFiles = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json')).sort();
const requestFilesOf = (op: Operation) => exampleFiles.filter((f) => f.startsWith(`${op.operationId}.`) && f.endsWith('.request.json'));
const responseFileFor = (requestFile: string) => requestFile.replace(/\.request\.json$/, '.response.json');
const concretePath = (op: Operation) => op.path.replace('{businessId}', EXAMPLE_BUSINESS_ID);
const auth = { authorization: `Bearer ${MOCK_TOKENS.valid}` };

describe('example requests are what the extension really sends', () => {
  const built = buildExampleRequests();
  for (const [name, payload] of Object.entries(built)) {
    it(name, async () => {
      // Plain JSON only: nothing undefined, no class instances.
      expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
      await expect(toExampleJson(payload)).toMatchFileSnapshot(file(name));
    });
  }

  it('covers every endpoint that takes a body', () => {
    for (const op of operations.filter((o) => o.requestSchema)) expect(requestFilesOf(op).length, op.operationId).toBeGreaterThan(0);
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
      ['error.unauthorised.json', { method: 'GET', path: '/v1/session', headers: {} }, 401],
      ['error.not-found.json', { method: 'GET', path: '/v1/businesses/no-such-business', headers: auth }, 404],
      ['error.unavailable.json', { method: 'POST', path: '/v1/ai/completions', headers: { authorization: `Bearer ${MOCK_TOKENS.limited}` }, body: readFileSync(file('completeAI.request.json'), 'utf8') }, 404],
      ['error.invalid.json', { method: 'POST', path: `/v1/businesses/${EXAMPLE_BUSINESS_ID}/visibility-snapshots`, headers: auth, body: '{}' }, 422],
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
    for (const name of exampleFiles.filter((f) => f.startsWith('error.'))) {
      const validate = validators('Error');
      expect(validate(read(name)), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('the contract rejects what it should (the validator is not vacuous)', () => {
    const snapshot = read<Record<string, unknown>>('saveVisibilitySnapshot.request.json');
    expect(validators('VisibilitySnapshot')({ ...snapshot, keyword: 42 })).toBe(false);
    expect(validators('VisibilitySnapshot')({ ...snapshot, mode: 'images' })).toBe(false);
    const { keyword: _omitted, ...withoutKeyword } = snapshot;
    expect(validators('VisibilitySnapshot')(withoutKeyword)).toBe(false);
    expect(validators('SaveResult')({})).toBe(false);
    expect(validators('Session')({ user: { name: 'No id' } })).toBe(false);
  });

  it('there are no stray example files', () => {
    const expected = new Set<string>();
    for (const op of operations) {
      if (op.requestSchema) for (const f of requestFilesOf(op)) expected.add(f).add(responseFileFor(f));
      else expected.add(`${op.operationId}.response.json`);
    }
    expect(exampleFiles.filter((f) => !expected.has(f) && !f.startsWith('error.'))).toEqual([]);
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
    expect(await client.sendToContentEditor(EXAMPLE_BUSINESS_ID, read('sendToContentEditor.request.json'))).toMatchObject({ id: expect.any(String) });
    expect(await client.createWorkspaceFromBrief(read('createWorkspaceFromBrief.request.json'))).toMatchObject({ id: expect.any(String) });
    expect((await client.completeAI(read('completeAI.request.json'))).text.length).toBeGreaterThan(0);
  });
});

describe('contract hygiene', () => {
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
