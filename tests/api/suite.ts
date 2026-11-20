/**
 * Conformance suite for the Legiit Command Center API.
 *
 * It talks to a running API over HTTP with the same client code the extension
 * ships (src/legiit/http-client.ts), sends the example requests from
 * docs/legiit-api/examples (real payloads built by the extension), and checks
 * every reply twice: against the OpenAPI contract and against what the
 * extension accepts.
 *
 * A failed check means the reply breaks the contract; most failures would show
 * an error to a user of the extension. A warning in the summary is a
 * recommendation.
 *
 * Used in two places:
 *   - tests/api/conformance.test.ts             run by the backend team against their API (npm run api:check)
 *   - tests/unit/legiit-api-conformance.test.ts  run against the bundled mock server, so the suite itself is known to be right
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseBriefRewrite } from '@/ai/brief-rewrite';
import { toLines } from '@/ai/provider';
import { StaticAuthProvider } from '@/legiit/auth';
import { LegiitError } from '@/legiit/client';
import { HttpLegiitClient } from '@/legiit/http-client';
import { MAX_REQUEST_BYTES, TIMEOUT_MS } from '@/legiit/limits';
import { ALL_CAPABILITIES, type Capability, type LegiitSession } from '@/legiit/types';

export const KIT_DIR = resolve(__dirname, '../../docs/legiit-api');
export const EXAMPLES_DIR = resolve(KIT_DIR, 'examples');

export interface ConformanceOptions {
  /** Base URL of the API under test, for example https://staging-api.legiit.com (a path prefix is allowed). */
  baseUrl: () => string;
  /** A valid API token of a test account. */
  token: () => string;
  /** The business to save into. Default: the first business the API lists. */
  businessId?: () => string | undefined;
  /** The id of a business that belongs to ANOTHER user. When given, the suite checks that this token cannot reach it. */
  otherBusinessId?: () => string | undefined;
  /** false = read-only run: nothing is created in the account. */
  writes: boolean;
}

interface RawReply {
  status: number;
  contentType: string;
  cacheControl: string;
  text: string;
  json: unknown;
  ms: number;
}

/** A reply slower than this is reported as a warning: the user is looking at a spinner. */
const SLOW_MS = 5_000;

/** Every test item the suite creates carries this text where the body has a name, so it can be found and removed. */
export const TEST_DATA_PREFIX = 'Conformance Check';

type Schema = Record<string, unknown>;

export function loadContract(): Record<string, unknown> {
  return parseYaml(readFileSync(resolve(KIT_DIR, 'openapi.yaml'), 'utf8')) as Record<string, unknown>;
}

export function example<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(resolve(EXAMPLES_DIR, file), 'utf8')) as T;
}

/** Every example request of one operation: "saveGapList.request.json", "addCompetitor.name-only.request.json"… */
export function requestExamples(operationId: string): string[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((file) => file.startsWith(`${operationId}.`) && file.endsWith('.request.json'))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** Validators for the contract's schemas, by name ("Session", "SaveResult"…). */
export function contractValidators(contract: Record<string, unknown> = loadContract()): (name: string) => ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateSchema: false });
  addFormats(ajv);
  ajv.addSchema({ ...contract, $id: 'https://legiit.invalid/contract' });
  return (name: string) => {
    const found = ajv.getSchema(`https://legiit.invalid/contract#/components/schemas/${name}`);
    if (!found) throw new Error(`The contract has no schema called ${name}`);
    return found;
  };
}

function describeErrors(validate: ValidateFunction): string {
  return (validate.errors ?? []).map((e) => `${e.instancePath || '(body)'} ${e.message ?? ''}`.trim()).join('; ');
}

/**
 * Keys of a reply that the contract does not know but that are a contract key
 * in another spelling ("brand_names" for "brandNames"). The extension ignores
 * unknown keys, so such a key is silently treated as absent: the data is
 * simply missing in the extension, with no error anywhere.
 */
export function misspeltKeys(contract: Record<string, unknown>, schemaName: string, body: unknown): string[] {
  const schemas = (contract['components'] as { schemas: Record<string, Schema> }).schemas;
  const resolveRef = (schema: Schema | undefined): Schema | undefined => {
    const ref = schema?.['$ref'];
    return typeof ref === 'string' ? { ...schemas[ref.split('/').at(-1)!], ...schema, $ref: undefined } : schema;
  };
  const plain = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');
  const found: string[] = [];
  const walk = (schemaNode: Schema | undefined, value: unknown, path: string): void => {
    const schema = resolveRef(schemaNode);
    if (!schema) return;
    if (Array.isArray(value)) {
      for (const [index, item] of value.slice(0, 20).entries()) walk(schema['items'] as Schema | undefined, item, `${path}[${index}]`);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
    const known = new Map(Object.keys(properties).map((name) => [plain(name), name]));
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) walk(properties[key], child, path ? `${path}.${key}` : key);
      else if (known.has(plain(key))) found.push(`"${path ? `${path}.` : ''}${key}" is not read: the extension expects "${known.get(plain(key))}"`);
    }
  };
  walk(schemas[schemaName], body, '');
  return found;
}

/** An id that does not exist, in the same form as a real one: digits stay digits, a UUID stays a UUID. */
export function unknownIdLike(id: string | null): string {
  if (id && /^\d+$/.test(id)) return '9'.repeat(Math.min(Math.max(id.length + 3, 12), 15));
  if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return randomUUID();
  return 'conformance-check-no-such-business';
}

export function defineConformanceSuite(options: ConformanceOptions): void {
  const contract = loadContract();
  const validators = contractValidators(contract);
  const warnings: string[] = [];
  const created: string[] = [];
  const timings: { what: string; ms: number }[] = [];
  let session: LegiitSession | null = null;
  let businessId: string | null = null;

  const url = (path: string) => `${options.baseUrl().replace(/\/+$/, '')}${path}`;

  /** A request exactly as the extension sends it (headers included), without the client's interpretation of the reply. */
  async function raw(
    method: 'GET' | 'POST',
    path: string,
    init: { token?: string | null; body?: unknown; rawBody?: string; idempotencyKey?: string; timeoutMs?: number } = {},
  ): Promise<RawReply> {
    const token = init.token === undefined ? options.token() : init.token;
    const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
    const started = Date.now();
    const response = await fetch(url(path), {
      method,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS.default),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: 'application/json',
        'X-Legiit-Client': 'legiit-lens/conformance',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
    const text = await response.text();
    const ms = Date.now() - started;
    timings.push({ what: `${method} ${path}`, ms });
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', cacheControl: response.headers.get('cache-control') ?? '', text, json, ms };
  }

  const client = () =>
    new HttpLegiitClient({
      baseUrl: options.baseUrl(),
      auth: new StaticAuthProvider(options.token()),
      fetch: (target, init) => fetch(target, init),
      clientVersion: 'conformance',
    });

  const has = (capability: Capability) => session?.capabilities.includes(capability) ?? false;

  /** The reply matches the contract schema, and has no contract key in another spelling. */
  function expectContract(name: string, body: unknown, what: string): void {
    const validate = validators(name);
    expect(validate(body), `${what} does not match the contract schema "${name}": ${describeErrors(validate)}`).toBe(true);
    expect(misspeltKeys(contract, name, body), `${what}: keys are camelCase and case-sensitive`).toEqual([]);
  }

  function expectErrorBody(reply: RawReply, what: string): void {
    expect(reply.contentType, `${what}: the error must be JSON, also when your framework produces it by itself`).toMatch(/application\/json/i);
    expectContract('Error', reply.json, `${what}: error body`);
  }

  const errorCode = (reply: RawReply): string | undefined => (reply.json as { error?: { code?: string } } | undefined)?.error?.code;

  /** The body must come back as JSON with one of the given statuses, never as a redirect. */
  function expectStatus(reply: RawReply, allowed: number[], what: string): void {
    expect(reply.status < 300 || reply.status >= 400, `${what}: answered with a redirect (${reply.status}). Answer on the URL that was called: the extension never follows a redirect`).toBe(true);
    expect(allowed, `${what}: expected HTTP ${allowed.join(' or ')}, got ${reply.status}. Body: ${reply.text.slice(0, 300)}`).toContain(reply.status);
  }

  const needs = (capability: Capability, test: { skip: (note?: string) => void }) => {
    if (!has(capability)) test.skip(`capability "${capability}" is not enabled for this account`);
  };
  const needsWrites = (test: { skip: (note?: string) => void }) => {
    if (!options.writes) test.skip('read-only run: nothing is created');
  };

  const businessPath = (suffix: string, id: string | null = businessId) => `/v1/businesses/${encodeURIComponent(id ?? '')}/${suffix}`;

  interface Save {
    id: string;
    capability: Capability;
    name: string;
    operationId: string;
    /** The path for a business id; null for the one save that has no business in its path. */
    suffix: string | null;
  }
  const saves: Save[] = [
    { id: 'C1', capability: 'visibilitySnapshots', name: 'visibility snapshot', operationId: 'saveVisibilitySnapshot', suffix: 'visibility-snapshots' },
    { id: 'C2', capability: 'gapLists', name: 'gap list', operationId: 'saveGapList', suffix: 'gap-lists' },
    { id: 'C3', capability: 'competitors', name: 'competitor', operationId: 'addCompetitor', suffix: 'competitors' },
    { id: 'C4', capability: 'contentEditor', name: 'content analysis', operationId: 'sendToContentEditor', suffix: 'content-editor/documents' },
    { id: 'C5', capability: 'workspaces', name: 'workspace', operationId: 'createWorkspaceFromBrief', suffix: null },
  ];
  const pathOf = (save: Save, id: string | null = businessId) => (save.suffix === null ? '/v1/workspaces/from-brief' : businessPath(save.suffix, id));
  /** A save that can be used for a check that is not about one kind of item: the first one this account has. */
  const anySave = (): Save | undefined => saves.find((save) => has(save.capability) && (save.suffix === null || businessId !== null));
  const needsAnySave = (test: { skip: (note?: string) => void }): Save => {
    needsWrites(test);
    const save = anySave();
    if (!save) test.skip('no save capability is enabled for this account');
    return save!;
  };

  /** An example body, marked so that the item it creates can be recognised as test data. */
  function testBody(save: Save, file: string): Record<string, unknown> {
    const body = example<Record<string, unknown>>(file);
    const variant = file.replace(/\.request\.json$/, '');
    if (save.operationId === 'addCompetitor') return { ...body, name: `${TEST_DATA_PREFIX}: ${String(body['name'])}` };
    if (save.operationId === 'createWorkspaceFromBrief') return { ...body, briefId: `conformance-check-${variant}`, businessName: `${TEST_DATA_PREFIX}: ${String(body['businessName'])}` };
    return body;
  }
  const note = (save: Save, reply: RawReply): void => {
    created.push(`${save.name} ${String((reply.json as { id?: unknown } | undefined)?.id)}`);
  };

  beforeAll(async () => {
    // Everything else depends on the session and on a business to work with.
    try {
      session = await client().getSession();
    } catch {
      session = null;
    }
    if (session?.capabilities.includes('businesses')) {
      try {
        const chosen = options.businessId?.();
        businessId = chosen ?? (await client().listBusinesses())[0]?.id ?? null;
      } catch {
        businessId = null;
      }
    }
  });

  afterAll(() => {
    const slow = timings.filter((t) => t.ms > SLOW_MS);
    for (const t of slow) {
      const limit = t.what.includes('/v1/ai/') ? TIMEOUT_MS.ai : TIMEOUT_MS.default;
      if (t.what.includes('/v1/ai/') && t.ms < 20_000) continue;
      warnings.push(`${t.what} took ${(t.ms / 1000).toFixed(1)} s. The extension gives up after ${limit / 1000} s.`);
    }
    const off = ALL_CAPABILITIES.filter((c) => !has(c));
    const lines = [
      '',
      'Legiit API conformance summary',
      `  API under test:        ${options.baseUrl()}`,
      `  Account:               ${session ? `${session.user.name || session.user.email || `user ${session.user.id}`} (plan: ${session.plan ?? 'none'})` : 'NOT CONNECTED: the session check failed'}`,
      `  Capabilities on:       ${session?.capabilities.join(', ') || 'none'}`,
      `  Capabilities off:      ${off.join(', ') || 'none'}${off.length ? '  (their checks were skipped, so this run does not prove them)' : ''}`,
      `  Business used:         ${businessId ?? 'none'}`,
      `  Requests sent:         ${timings.length}, the slowest took ${timings.length ? Math.max(...timings.map((t) => t.ms)) : 0} ms`,
      `  Created in this run:   ${created.length ? created.join(', ') : 'nothing'}`,
      ...(created.length ? [`                         (competitors and workspaces are named "${TEST_DATA_PREFIX}: …")`] : []),
      ...(warnings.length ? ['  Warnings (recommendations, not failures):', ...warnings.map((w) => `    - ${w}`)] : ['  Warnings:              none']),
      '',
    ];
    // The runner (scripts/api-check.mjs) prints the summary after the test results, so it is the last thing on
    // screen. Without the runner it goes to the console, wherever the test reporter puts it.
    const file = process.env['LEGIIT_API_SUMMARY_FILE'];
    if (file) writeFileSync(file, lines.join('\n'));
    else console.log(lines.join('\n'));
  });

  describe('A. Token and transport', () => {
    it('A1  GET /v1/session with a valid token answers 200 with the session', async () => {
      const reply = await raw('GET', '/v1/session');
      expectStatus(reply, [200], 'GET /v1/session');
      expect(reply.contentType, 'GET /v1/session: the reply must be JSON').toMatch(/application\/json/i);
      expectContract('Session', reply.json, 'GET /v1/session');
      const listed = (reply.json as { capabilities: unknown[] }).capabilities;
      const unknown = listed.filter((name) => !ALL_CAPABILITIES.includes(name as Capability));
      if (unknown.length > 0) warnings.push(`A1: the session lists capability names the extension does not know and ignores: ${unknown.map(String).join(', ')}. Check the spelling (names are case-sensitive): ${ALL_CAPABILITIES.join(', ')}.`);
      if (!/no-store/i.test(reply.cacheControl)) warnings.push('A1: the reply has no "Cache-Control: no-store" header. The extension does not cache, but a proxy in between might.');
    });

    it('A2  the extension accepts that session', async () => {
      const result = await client().getSession();
      expect(result.user.id.length, 'the session has no user id the extension can read').toBeGreaterThan(0);
      if (!result.user.name && !result.user.email) warnings.push('A2: the session has no user name and no e-mail, so the extension shows "Legiit account" after "Connected".');
      if (result.capabilities.length === 0) warnings.push('A2: the session lists no capabilities, so the extension shows no Legiit feature at all.');
      const needsBusiness = (['visibilitySnapshots', 'gapLists', 'competitors', 'contentEditor'] as Capability[]).filter((c) => result.capabilities.includes(c));
      if (needsBusiness.length > 0 && !result.capabilities.includes('businesses')) {
        warnings.push(`A2: ${needsBusiness.join(', ')} listed without "businesses": the user cannot choose a business, so these saves stay disabled.`);
      }
    });

    it('A3  no Authorization header answers 401 with an error body', async () => {
      const reply = await raw('GET', '/v1/session', { token: null });
      expectStatus(reply, [401], 'GET /v1/session without a token');
      expectErrorBody(reply, 'GET /v1/session without a token');
    });

    it('A4  an unknown token answers 401 with an error body', async () => {
      const reply = await raw('GET', '/v1/session', { token: 'conformance-check-not-a-real-token' });
      expectStatus(reply, [401], 'GET /v1/session with an unknown token');
      expectErrorBody(reply, 'GET /v1/session with an unknown token');
    });

    it('A5  an unknown path answers 404, 405 or 501, and not with the code "not_found"', async () => {
      const reply = await raw('GET', '/v1/conformance-check-no-such-endpoint');
      expectStatus(reply, [404, 405, 501], 'GET of an unknown path');
      // "not_found" is reserved for a missing business. On an endpoint that does not exist it would make the
      // extension show an error where it should quietly hide a feature that is not built yet.
      expect(errorCode(reply), 'the code "not_found" is reserved for a missing business; an unknown path must use another code or no body').not.toBe('not_found');
    });

    it('A6  a valid token is never answered with 401', async () => {
      // 401 means "this token is bad": the extension deletes it. A feature that is off answers 404; a refusal for another reason answers 403.
      for (const path of ['/v1/session', '/v1/businesses', '/v1/industry-pulse', `/v1/businesses/${encodeURIComponent(unknownIdLike(businessId))}`]) {
        const reply = await raw('GET', path);
        expect(reply.status, `GET ${path} with a valid token`).not.toBe(401);
      }
    });

    it('A7  the word "Bearer" is matched without regard to case', async () => {
      const response = await fetch(url('/v1/session'), { headers: { authorization: `bearer ${options.token()}`, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS.default) });
      if (response.status !== 200) warnings.push(`A7: "authorization: bearer <token>" in lower case was answered with ${response.status}. Chrome sends "Bearer", so the extension works, but HTTP says the scheme is case-insensitive.`);
    });
  });

  describe('B. Reading account data', () => {
    it("B1  GET /v1/businesses lists the account's businesses", async (test) => {
      needs('businesses', test);
      const reply = await raw('GET', '/v1/businesses');
      expectStatus(reply, [200], 'GET /v1/businesses');
      expectContract('BusinessList', reply.json, 'GET /v1/businesses');
      const list = await client().listBusinesses();
      expect(list.length, 'The test account needs at least one business for the remaining checks').toBeGreaterThan(0);
      expect(new Set(list.map((b) => b.id)).size, 'business ids must be unique').toBe(list.length);
      const sent = (reply.json as { businesses: unknown[] }).businesses.length;
      expect(list.length, 'the extension could not read every business of the reply (an id is missing, empty or longer than 120 characters)').toBe(Math.min(sent, 500));
      if (sent > 500) warnings.push(`B1: the reply lists ${sent} businesses; the extension shows the first 500.`);
      if (list.some((b) => !b.name)) warnings.push('B1: a business has an empty name; the extension shows its domain or id in the drop-down instead.');
    });

    it('B2  GET /v1/businesses/{id} returns Business Details the extension can pre-fill from', async (test) => {
      needs('businesses', test);
      expect(businessId, 'no business to read').not.toBeNull();
      const reply = await raw('GET', `/v1/businesses/${encodeURIComponent(businessId!)}`);
      expectStatus(reply, [200], 'GET /v1/businesses/{id}');
      expectContract('BusinessDetails', reply.json, 'GET /v1/businesses/{id}');
      const details = await client().getBusinessDetails(businessId!);
      expect(String(details.id), 'Business Details must carry the same id as the list').toBe(String(businessId));
      if (details.domains.length === 0 && details.brandNames.length === 0) warnings.push('B2: the business has no domains and no brand names, so nothing is pre-filled as "my brand" beyond its name.');
    });

    it('B3  an unknown business id answers 404 with error.code "not_found"', async (test) => {
      needs('businesses', test);
      const id = unknownIdLike(businessId);
      const reply = await raw('GET', `/v1/businesses/${encodeURIComponent(id)}`);
      expectStatus(reply, [404], `GET /v1/businesses/${id} (an id that does not exist)`);
      expectErrorBody(reply, 'GET /v1/businesses/{unknown id}');
      expect(errorCode(reply), 'error.code tells the extension that the business is missing, not the whole feature').toBe('not_found');
      // An id of another form than yours (text where you use numbers). The extension only sends ids that you gave
      // it, so this is about robustness: never a server error, never 401, and best the same answer as above.
      const ODD = 'conformance-check-no-such-business';
      if (id === ODD) return;
      const odd = await raw('GET', `/v1/businesses/${ODD}`);
      const what = `GET /v1/businesses/${ODD} (an id of another form than yours)`;
      expect(odd.status >= 400 && odd.status < 500 && odd.status !== 401, `${what}: answered HTTP ${odd.status}. It must be a 4xx other than 401 (best: 404 with the code "not_found"), never a server error. Body: ${odd.text.slice(0, 300)}`).toBe(true);
      if (!(odd.status === 404 && errorCode(odd) === 'not_found')) {
        warnings.push(`B3: an id of another form than yours answered HTTP ${odd.status}${errorCode(odd) ? ` "${errorCode(odd)}"` : ''} instead of 404 "not_found". The extension never sends such an id today; it would after a change of your id scheme, and would then ${odd.status === 404 ? 'take the feature for "not built" and hide it' : 'show "Legiit rejected the request"'} instead of saying that the business is gone.`);
      }
    });

    it('B4  GET /v1/industry-pulse returns dated events', async (test) => {
      needs('industryPulse', test);
      const reply = await raw('GET', '/v1/industry-pulse');
      expectStatus(reply, [200], 'GET /v1/industry-pulse');
      expectContract('IndustryPulse', reply.json, 'GET /v1/industry-pulse');
      const pulse = await client().getIndustryPulse();
      const sent = (reply.json as { events: unknown[] }).events.length;
      expect(pulse.events.length, 'the extension could not read every event of the reply (a date is not a real day written as YYYY-MM-DD)').toBe(Math.min(sent, 200));
      if (pulse.events.length === 0) warnings.push('B4: industry pulse has no events, so the Rewind tab shows no date shortcuts.');
      const dates = pulse.events.map((e) => e.date);
      if (dates.join() !== [...dates].sort().reverse().join()) warnings.push('B4: industry pulse events are not newest first. The extension shows the first 8 as they come.');
    });

    it('B5  a business of another user answers 404 "not_found", like one that does not exist', async (test) => {
      const other = options.otherBusinessId?.();
      if (!other) test.skip('no business of another user was given (optional)');
      const read = await raw('GET', `/v1/businesses/${encodeURIComponent(other!)}`);
      expectStatus(read, [404], "GET of another user's business");
      expect(errorCode(read)).toBe('not_found');
      for (const save of saves.filter((s) => s.suffix !== null && has(s.capability))) {
        const reply = await raw('POST', pathOf(save, other!), { body: testBody(save, requestExamples(save.operationId)[0]!), idempotencyKey: randomUUID() });
        expectStatus(reply, [404], `POST ${pathOf(save, other!)} into another user's business`);
        expect(errorCode(reply)).toBe('not_found');
      }
    });
  });

  describe('C. Saving (creates test data in the account)', () => {
    for (const save of saves) {
      it(`${save.id}  POST saves a ${save.name} and returns its id`, async (test) => {
        needs(save.capability, test);
        needsWrites(test);
        if (save.suffix !== null) expect(businessId, 'no business to save into').not.toBeNull();
        // Every example of this request, including the ones whose values look empty (null, "", []): those are valid.
        for (const file of requestExamples(save.operationId)) {
          const what = `POST ${pathOf(save)} with examples/${file}`;
          const reply = await raw('POST', pathOf(save), { body: testBody(save, file), idempotencyKey: randomUUID() });
          expectStatus(reply, [200, 201], what);
          expect(reply.contentType, `${what}: the reply must be JSON`).toMatch(/application\/json/i);
          expectContract('SaveResult', reply.json, what);
          note(save, reply);
          const address = (reply.json as { url?: string | null }).url;
          if (!address) warnings.push(`${save.id}: no "url" in the reply to ${file}, so the extension shows "Saved" without an "Open in Command Center" link.`);
          else {
            expect(address, 'url must be an absolute address without spaces that the user can open').toMatch(/^https?:\/\/\S+$/);
            if (!address.startsWith('https://')) warnings.push(`${save.id}: "url" is not an https address (${address.slice(0, 60)}). Fine on a local test system; use https in production.`);
          }
        }
      });
    }

    it('C6  a body the API cannot accept answers 400 or 422 with a message for the user', async (test) => {
      const save = needsAnySave(test);
      const reply = await raw('POST', pathOf(save), { body: {} });
      expectStatus(reply, [400, 422], `POST ${pathOf(save)} with an empty object`);
      expectErrorBody(reply, 'POST of an empty object');
      expect((reply.json as { error: { message: string } }).error.message.length, 'error.message is shown to the user').toBeGreaterThan(0);
    });

    it('C7  a body that is not JSON answers 400 or 422, not 500', async (test) => {
      const save = needsAnySave(test);
      const reply = await raw('POST', pathOf(save), { rawBody: '{"cut off": ' });
      expectStatus(reply, [400, 422], `POST ${pathOf(save)} with a body that is not JSON`);
      expectErrorBody(reply, 'POST of a body that is not JSON');
    });

    it('C8  fields the API does not know are ignored, and a save without Idempotency-Key is accepted', async (test) => {
      const save = needsAnySave(test);
      // No Idempotency-Key on purpose: the extension sends one, other clients (curl) do not. Do not require it.
      const body = { ...testBody(save, requestExamples(save.operationId)[0]!), addedByALaterExtensionVersion: { anything: true } };
      const reply = await raw('POST', pathOf(save), { body });
      expectStatus(reply, [200, 201], `POST ${pathOf(save)} with an unknown extra field and no Idempotency-Key`);
      note(save, reply);
    });

    it('C9  saving into an unknown business answers 404 with error.code "not_found"', async (test) => {
      needsWrites(test);
      const targets = saves.filter((s) => s.suffix !== null && has(s.capability));
      if (targets.length === 0) test.skip('no save into a business is enabled for this account');
      const id = unknownIdLike(businessId);
      for (const save of targets) {
        const what = `POST ${pathOf(save, id)} (a business that does not exist)`;
        const reply = await raw('POST', pathOf(save, id), { body: testBody(save, requestExamples(save.operationId)[0]!), idempotencyKey: randomUUID() });
        expectStatus(reply, [404], what);
        expectErrorBody(reply, what);
        expect(errorCode(reply), `${what}: without the code "not_found" the extension takes this for "endpoint not built" and hides the button`).toBe('not_found');
      }
    });

    it('C10 text outside ASCII is stored as sent (UTF-8)', async (test) => {
      needs('competitors', test);
      needsWrites(test);
      const name = `${TEST_DATA_PREFIX}: Zahnärzte München – “Lächeln” 東京 😀`;
      const reply = await raw('POST', businessPath('competitors'), { body: { name, domains: ['zahnaerzte-muenchen.example'] }, idempotencyKey: randomUUID() });
      expectStatus(reply, [200, 201], 'POST with non-ASCII text');
      created.push(`competitor ${String((reply.json as { id: unknown }).id)}`);
      if (has('businesses')) {
        const listed = (await client().getBusinessDetails(businessId!)).competitors.map((c) => c.name);
        if (!listed.includes(name)) warnings.push(`C10: the competitor "${name}" was saved but GET /v1/businesses/{id} does not list it under that exact name (it lists: ${listed.slice(-3).join(' | ') || 'none'}). Check that text is stored as UTF-8 and that added competitors show up in Business Details.`);
      }
    });

    it("C11 the extension's own client completes every save", async (test) => {
      needsWrites(test);
      if (!anySave()) test.skip('no save capability is enabled for this account');
      const api = client();
      const key = () => ({ idempotencyKey: randomUUID() });
      const body = (save: Save) => testBody(save, requestExamples(save.operationId)[0]!) as never;
      try {
        if (has('visibilitySnapshots') && businessId) created.push(`visibility snapshot ${(await api.saveVisibilitySnapshot(businessId, body(saves[0]!), key())).id}`);
        if (has('gapLists') && businessId) created.push(`gap list ${(await api.saveGapList(businessId, body(saves[1]!), key())).id}`);
        if (has('competitors') && businessId) created.push(`competitor ${(await api.addCompetitor(businessId, body(saves[2]!), key())).id}`);
        if (has('contentEditor') && businessId) created.push(`content analysis ${(await api.sendToContentEditor(businessId, body(saves[3]!), key())).id}`);
        if (has('workspaces')) created.push(`workspace ${(await api.createWorkspaceFromBrief(body(saves[4]!), key())).id}`);
      } catch (error) {
        throw new Error(`The extension would show an error: ${error instanceof LegiitError ? `${error.code} (HTTP ${error.status}): ${error.message}` : String(error)}`);
      }
    });

    it('C12 the same competitor added twice is one competitor (recommended)', async (test) => {
      needs('competitors', test);
      needsWrites(test);
      const body = { name: `${TEST_DATA_PREFIX}: Twice`, domains: ['conformance-twice.example'] };
      const first = await raw('POST', businessPath('competitors'), { body, idempotencyKey: randomUUID() });
      const second = await raw('POST', businessPath('competitors'), { body: { ...body, name: `  ${body.name.toUpperCase()} ` }, idempotencyKey: randomUUID() });
      expectStatus(first, [200, 201], 'POST of a competitor');
      expectStatus(second, [200, 201], 'POST of the same competitor again (answer 200 or 201 with the existing id, not 409)');
      created.push(`competitor ${String((first.json as { id: unknown }).id)}`);
      if (String((first.json as { id: unknown }).id) !== String((second.json as { id: unknown }).id)) {
        warnings.push('C12: adding the same competitor twice (the name in another letter case) returned two different ids. Recommended: return the id of the existing competitor instead of creating a second one.');
      }
    });

    it('C13 a repeated Idempotency-Key does not store the item twice (recommended)', async (test) => {
      const save = needsAnySave(test);
      const idempotencyKey = randomUUID();
      const body = testBody(save, requestExamples(save.operationId)[0]!);
      const first = await raw('POST', pathOf(save), { body, idempotencyKey });
      const second = await raw('POST', pathOf(save), { body, idempotencyKey });
      expectStatus(first, [200, 201], 'POST with an Idempotency-Key');
      expectStatus(second, [200, 201], 'the same POST again with the same Idempotency-Key');
      note(save, first);
      if (String((first.json as { id: unknown }).id) !== String((second.json as { id: unknown }).id)) {
        warnings.push('C13: the same save sent twice with the same Idempotency-Key returned two different ids, so a retry after a timeout creates a duplicate. Recommended: return the first reply again.');
      }
    });

    it('C14 a brief of 600 KB is not refused for its size', async (test) => {
      needs('workspaces', test);
      needsWrites(test);
      const brief = testBody(saves[4]!, 'createWorkspaceFromBrief.request.json');
      // Markdown at its 200,000-character limit, in 3-byte characters: about 600 KB of UTF-8, inside the 1 MB the extension allows itself.
      const body = { ...brief, briefId: 'conformance-check-large-body', businessName: `${TEST_DATA_PREFIX}: Large Body`, markdown: '漢'.repeat(200_000) };
      expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(MAX_REQUEST_BYTES);
      const reply = await raw('POST', '/v1/workspaces/from-brief', { body, idempotencyKey: randomUUID() });
      expect(reply.status, 'a 600 KB body was refused as too large (413). Accept request bodies of up to 1 MB: raise the limit of your framework or proxy').not.toBe(413);
      expectStatus(reply, [200, 201], 'POST of a 600 KB workspace brief (check the size of the column that stores "markdown")');
      note(saves[4]!, reply);
    });

    it('C15 the same brief sent again is the same workspace (recommended)', async (test) => {
      needs('workspaces', test);
      needsWrites(test);
      const brief = { ...testBody(saves[4]!, 'createWorkspaceFromBrief.request.json'), briefId: 'conformance-check-sent-twice', businessName: `${TEST_DATA_PREFIX}: Sent Twice` };
      const first = await raw('POST', '/v1/workspaces/from-brief', { body: brief, idempotencyKey: randomUUID() });
      // The user changed the competitors of the brief and sent it again: a new key, the same briefId.
      const second = await raw('POST', '/v1/workspaces/from-brief', { body: { ...brief, competitors: [] }, idempotencyKey: randomUUID() });
      expectStatus(first, [200, 201], 'POST of a brief');
      expectStatus(second, [200, 201], 'POST of the same brief again');
      note(saves[4]!, first);
      if (String((first.json as { id: unknown }).id) !== String((second.json as { id: unknown }).id)) {
        warnings.push('C15: the same briefId sent twice created two workspaces. Recommended: update the first one and return its id (unless Legiit decided otherwise).');
      }
    });
  });

  describe('D. AI rewrite (calls your model three times)', () => {
    it('D1  POST /v1/ai/completions returns text the extension can show as bullet points', async (test) => {
      needs('ai', test);
      const reply = await raw('POST', '/v1/ai/completions', { body: example('completeAI.request.json'), timeoutMs: TIMEOUT_MS.ai });
      expectStatus(reply, [200], 'POST /v1/ai/completions');
      expectContract('AiCompletionResponse', reply.json, 'POST /v1/ai/completions');
      const lines = toLines((reply.json as { text: string }).text);
      expect(lines.length, 'the reply must contain at least one line of text').toBeGreaterThan(0);
      if (lines.length < 3) warnings.push(`D1: the reply has ${lines.length} line(s); the prompt asks for 3 to 6 bullet points.`);
    });

    it('D2  with responseSchema, the reply text is JSON that the extension can use', async (test) => {
      needs('ai', test);
      const request = example<{ responseSchema: Record<string, unknown> }>('completeAI.brief.request.json');
      const reply = await raw('POST', '/v1/ai/completions', { body: request, timeoutMs: TIMEOUT_MS.ai });
      expectStatus(reply, [200], 'POST /v1/ai/completions with responseSchema');
      expectContract('AiCompletionResponse', reply.json, 'POST /v1/ai/completions with responseSchema');
      const text = (reply.json as { text: string }).text;
      expect(parseBriefRewrite(text), `The extension could not use this reply. "text" must be a string that holds one JSON object with three avatars (each with name, who, wants, worries) and at least one next step. Got: ${text.slice(0, 300)}`).not.toBeNull();
    });

    it('D3  a request without a prompt answers 400 or 422, not 500', async (test) => {
      needs('ai', test);
      const reply = await raw('POST', '/v1/ai/completions', { body: { task: 'rewind' }, timeoutMs: TIMEOUT_MS.ai });
      expectStatus(reply, [400, 422], 'POST /v1/ai/completions without system and prompt');
      expectErrorBody(reply, 'POST /v1/ai/completions without system and prompt');
    });
  });
}
