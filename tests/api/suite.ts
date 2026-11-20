/**
 * Conformance suite for the Legiit Command Center API.
 *
 * It talks to a running API over HTTP with the same client code the extension
 * ships (src/legiit/http-client.ts), sends the example requests from
 * docs/legiit-api/examples (real payloads built by the extension), and checks
 * every reply twice: against the OpenAPI contract and against what the
 * extension accepts. When every check passes, the extension works with that
 * API.
 *
 * Used in two places:
 *   - tests/api/conformance.test.ts   run by the backend team against their API (npm run api:check)
 *   - tests/unit/legiit-api-kit.test.ts   run against the bundled mock server, so the suite itself is known to be right
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
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
  /** false = read-only run: nothing is created in the account. */
  writes: boolean;
}

interface RawReply {
  status: number;
  contentType: string;
  text: string;
  json: unknown;
  ms: number;
}

/** A reply slower than this is reported as a warning: the user is looking at a spinner. */
const SLOW_MS = 5_000;

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

export function defineConformanceSuite(options: ConformanceOptions): void {
  const validators = contractValidators();
  const warnings: string[] = [];
  const created: string[] = [];
  const timings: { what: string; ms: number }[] = [];
  let session: LegiitSession | null = null;
  let businessId: string | null = null;

  const url = (path: string) => `${options.baseUrl().replace(/\/+$/, '')}${path}`;

  /** A request exactly as the extension sends it (headers included), without the client's interpretation of the reply. */
  async function raw(method: 'GET' | 'POST', path: string, init: { token?: string | null; body?: unknown; idempotencyKey?: string; timeoutMs?: number } = {}): Promise<RawReply> {
    const token = init.token === undefined ? options.token() : init.token;
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
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', text, json, ms };
  }

  const client = () =>
    new HttpLegiitClient({
      baseUrl: options.baseUrl(),
      auth: new StaticAuthProvider(options.token()),
      fetch: (target, init) => fetch(target, init),
      clientVersion: 'conformance',
    });

  const has = (capability: Capability) => session?.capabilities.includes(capability) ?? false;

  function expectContract(name: string, body: unknown, what: string): void {
    const validate = validators(name);
    expect(validate(body), `${what} does not match the contract schema "${name}": ${describeErrors(validate)}`).toBe(true);
  }

  function expectErrorBody(reply: RawReply, what: string): void {
    expect(reply.contentType, `${what}: the error must be JSON`).toMatch(/application\/json/i);
    expectContract('Error', reply.json, `${what}: error body`);
  }

  /** The body must come back as JSON with one of the given statuses, never as a redirect. */
  function expectStatus(reply: RawReply, allowed: number[], what: string): void {
    expect(reply.status < 300 || reply.status >= 400, `${what}: answered with a redirect (${reply.status}). Answer on the URL that was called: the extension refuses a redirect to another host, and a redirected POST can lose its body`).toBe(true);
    expect(allowed, `${what}: expected HTTP ${allowed.join(' or ')}, got ${reply.status}. Body: ${reply.text.slice(0, 300)}`).toContain(reply.status);
  }

  const needs = (capability: Capability, test: { skip: (note?: string) => void }) => {
    if (!has(capability)) test.skip(`capability "${capability}" is not enabled for this account`);
  };
  const needsWrites = (test: { skip: (note?: string) => void }) => {
    if (!options.writes) test.skip('read-only run (LEGIIT_API_WRITE=0)');
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
      `  Capabilities off:      ${off.join(', ') || 'none'}${off.length ? '  (their checks were skipped)' : ''}`,
      `  Business used:         ${businessId ?? 'none'}`,
      `  Created in this run:   ${created.length ? created.join(', ') : 'nothing'}`,
      `  Slowest request:       ${timings.length ? `${Math.max(...timings.map((t) => t.ms))} ms` : 'n/a'}`,
      ...(warnings.length ? ['  Warnings (not failures):', ...warnings.map((w) => `    - ${w}`)] : ['  Warnings:              none']),
      '',
    ];
    console.log(lines.join('\n'));
  });

  describe('A. Token and transport', () => {
    it('A1  GET /v1/session with a valid token answers 200 with the session', async () => {
      const reply = await raw('GET', '/v1/session');
      expectStatus(reply, [200], 'GET /v1/session');
      expect(reply.contentType).toMatch(/application\/json/i);
      expectContract('Session', reply.json, 'GET /v1/session');
    });

    it('A2  the extension accepts that session', async () => {
      const result = await client().getSession();
      expect(result.user.id.length).toBeGreaterThan(0);
      if (!result.user.name && !result.user.email) warnings.push('The session has no user name and no e-mail, so the extension shows "Legiit account" after "Connected".');
      if (result.capabilities.length === 0) warnings.push('The session lists no capabilities, so the extension shows no Legiit feature at all.');
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

    it('A5  an unknown path answers 404, 405 or 501 (the extension reads that as "not available yet")', async () => {
      const reply = await raw('GET', '/v1/conformance-check-no-such-endpoint');
      expectStatus(reply, [404, 405, 501], 'GET of an unknown path');
    });

    it('A6  a valid token is never answered with 401', async () => {
      // 401 means "this token is bad": the extension deletes it. A feature that is off answers 404; a refusal for another reason answers 403.
      for (const path of ['/v1/session', '/v1/businesses', '/v1/industry-pulse', '/v1/businesses/conformance-check-no-such-business']) {
        const reply = await raw('GET', path);
        expect(reply.status, `GET ${path} with a valid token`).not.toBe(401);
      }
    });

    it('A7  a token is accepted whatever the capitalisation of "Bearer" and the header name', async () => {
      const response = await fetch(url('/v1/session'), { headers: { authorization: `bearer ${options.token()}`, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS.default) });
      if (response.status !== 200) warnings.push(`A7: "authorization: bearer <token>" in lower case was answered with ${response.status}. Chrome sends "Authorization: Bearer", so this works, but HTTP header names and the scheme are case-insensitive.`);
    });
  });

  describe('B. Reading account data', () => {
    it('B1  GET /v1/businesses lists the account\'s businesses', async (test) => {
      needs('businesses', test);
      const reply = await raw('GET', '/v1/businesses');
      expectStatus(reply, [200], 'GET /v1/businesses');
      expectContract('BusinessList', reply.json, 'GET /v1/businesses');
      const list = await client().listBusinesses();
      expect(list.length, 'The test account needs at least one business for the remaining checks').toBeGreaterThan(0);
      expect(new Set(list.map((b) => b.id)).size, 'business ids must be unique').toBe(list.length);
      if (list.some((b) => !b.name)) warnings.push('B1: a business has an empty name; the extension shows its domain or id in the drop-down instead.');
    });

    it('B2  GET /v1/businesses/{id} returns Business Details the extension can pre-fill from', async (test) => {
      needs('businesses', test);
      expect(businessId, 'no business to read').not.toBeNull();
      const reply = await raw('GET', `/v1/businesses/${encodeURIComponent(businessId!)}`);
      expectStatus(reply, [200], 'GET /v1/businesses/{id}');
      expectContract('BusinessDetails', reply.json, 'GET /v1/businesses/{id}');
      const details = await client().getBusinessDetails(businessId!);
      expect(String(details.id)).toBe(String(businessId));
      if (details.domains.length === 0 && details.brandNames.length === 0) warnings.push('The business has no domains and no brand names, so nothing is pre-filled as "my brand" beyond its name.');
    });

    it('B3  an unknown business id answers 404 with error.code "not_found"', async (test) => {
      needs('businesses', test);
      const reply = await raw('GET', '/v1/businesses/conformance-check-no-such-business');
      expectStatus(reply, [404], 'GET /v1/businesses/{unknown id}');
      expectErrorBody(reply, 'GET /v1/businesses/{unknown id}');
      expect((reply.json as { error: { code: string } }).error.code, 'error.code tells the extension that the business is missing, not the whole feature').toBe('not_found');
    });

    it('B4  GET /v1/industry-pulse returns dated events', async (test) => {
      needs('industryPulse', test);
      const reply = await raw('GET', '/v1/industry-pulse');
      expectStatus(reply, [200], 'GET /v1/industry-pulse');
      expectContract('IndustryPulse', reply.json, 'GET /v1/industry-pulse');
      const pulse = await client().getIndustryPulse();
      for (const event of pulse.events) expect(Number.isNaN(Date.parse(`${event.date}T00:00:00Z`)), `event.date "${event.date}" must be a real calendar date, YYYY-MM-DD`).toBe(false);
      if (pulse.events.length === 0) warnings.push('B4: industry pulse has no events, so the Rewind tab shows no date shortcuts.');
      const dates = pulse.events.map((e) => e.date);
      if (dates.join() !== [...dates].sort().reverse().join()) warnings.push('B4: industry pulse events are not newest first. The extension shows the first 8 as they come.');
    });
  });

  const businessPath = (suffix: string) => `/v1/businesses/${encodeURIComponent(businessId ?? '')}/${suffix}`;
  const saves: { id: string; capability: Capability; name: string; operationId: string; path: () => string; needsBusiness: boolean }[] = [
    { id: 'C1', capability: 'visibilitySnapshots', name: 'a visibility snapshot', operationId: 'saveVisibilitySnapshot', path: () => businessPath('visibility-snapshots'), needsBusiness: true },
    { id: 'C2', capability: 'gapLists', name: 'a gap list', operationId: 'saveGapList', path: () => businessPath('gap-lists'), needsBusiness: true },
    { id: 'C3', capability: 'competitors', name: 'a competitor', operationId: 'addCompetitor', path: () => businessPath('competitors'), needsBusiness: true },
    { id: 'C4', capability: 'contentEditor', name: 'a content analysis', operationId: 'sendToContentEditor', path: () => businessPath('content-editor/documents'), needsBusiness: true },
    { id: 'C5', capability: 'workspaces', name: 'a workspace from a brief', operationId: 'createWorkspaceFromBrief', path: () => '/v1/workspaces/from-brief', needsBusiness: false },
  ];

  describe('C. Saving (creates test data in the account)', () => {
    for (const save of saves) {
      it(`${save.id}  POST saves ${save.name} and returns its id`, async (test) => {
        needs(save.capability, test);
        needsWrites(test);
        if (save.needsBusiness) expect(businessId, 'no business to save into').not.toBeNull();
        // Every example of this request, including the ones with empty-looking values (null, "", []), which are valid.
        for (const file of requestExamples(save.operationId)) {
          const what = `POST ${save.path()} with examples/${file}`;
          const reply = await raw('POST', save.path(), { body: example(file), idempotencyKey: randomUUID() });
          expectStatus(reply, [200, 201], what);
          expect(reply.contentType, `${what}: the reply must be JSON`).toMatch(/application\/json/i);
          expectContract('SaveResult', reply.json, what);
          const result = reply.json as { id: string | number; url?: string | null };
          created.push(`${save.name} ${result.id}`);
          if (result.url) expect(result.url, 'url must be an absolute https link the user can open').toMatch(/^https:\/\/\S+$/);
          else warnings.push(`${save.id}: no "url" in the reply to ${file}, so the extension shows "Saved" without an "Open in Command Center" link.`);
        }
      });
    }

    it('C6  a body the API cannot accept answers 400 or 422 with a message for the user', async (test) => {
      needs('visibilitySnapshots', test);
      needsWrites(test);
      const reply = await raw('POST', businessPath('visibility-snapshots'), { body: {} });
      expectStatus(reply, [400, 422], 'POST of an empty object');
      expectErrorBody(reply, 'POST of an empty object');
      expect((reply.json as { error: { message: string } }).error.message.length, 'error.message is shown to the user').toBeGreaterThan(0);
    });

    it('C7  fields the API does not know are ignored, not rejected', async (test) => {
      needs('competitors', test);
      needsWrites(test);
      const body = { name: 'Conformance Check Extra Field', domains: ['conformance-extra-field.example'], addedByALaterExtensionVersion: { anything: true } };
      const reply = await raw('POST', businessPath('competitors'), { body });
      expectStatus(reply, [200, 201], 'POST with an unknown extra field');
      created.push(`a competitor ${(reply.json as { id: string }).id}`);
    });

    it('C8  saving into an unknown business answers 404 with error.code "not_found"', async (test) => {
      needs('visibilitySnapshots', test);
      needsWrites(test);
      const reply = await raw('POST', '/v1/businesses/conformance-check-no-such-business/visibility-snapshots', { body: example('saveVisibilitySnapshot.request.json') });
      expectStatus(reply, [404], 'POST into an unknown business');
      expectErrorBody(reply, 'POST into an unknown business');
      expect((reply.json as { error: { code: string } }).error.code).toBe('not_found');
    });

    it('C9  text outside ASCII is stored as sent (UTF-8)', async (test) => {
      needs('competitors', test);
      needsWrites(test);
      const name = 'Zahnärzte München – “Lächeln” 東京 😀';
      const reply = await raw('POST', businessPath('competitors'), { body: { name, domains: ['zahnaerzte-muenchen.example'] } });
      expectStatus(reply, [200, 201], 'POST with non-ASCII text');
      created.push(`a competitor ${(reply.json as { id: string }).id}`);
      if (has('businesses')) {
        const listed = (await client().getBusinessDetails(businessId!)).competitors.map((c) => c.name);
        if (!listed.includes(name)) warnings.push(`C9: the competitor "${name}" was saved but GET /v1/businesses/{id} does not list it under that exact name (it lists: ${listed.slice(-3).join(' | ') || 'none'}). Check that text is stored as UTF-8 and that added competitors show up in Business Details.`);
      }
    });

    it('C10 the extension\'s own client completes every save', async (test) => {
      needsWrites(test);
      const api = client();
      const done: string[] = [];
      const key = () => ({ idempotencyKey: randomUUID() });
      try {
        if (has('visibilitySnapshots') && businessId) done.push((await api.saveVisibilitySnapshot(businessId, example('saveVisibilitySnapshot.request.json'), key())).id);
        if (has('gapLists') && businessId) done.push((await api.saveGapList(businessId, example('saveGapList.request.json'), key())).id);
        if (has('competitors') && businessId) done.push((await api.addCompetitor(businessId, example('addCompetitor.request.json'), key())).id);
        if (has('contentEditor') && businessId) done.push((await api.sendToContentEditor(businessId, example('sendToContentEditor.request.json'), key())).id);
        if (has('workspaces')) done.push((await api.createWorkspaceFromBrief(example('createWorkspaceFromBrief.request.json'), key())).id);
      } catch (error) {
        throw new Error(`The extension would show an error: ${error instanceof LegiitError ? `${error.code} (HTTP ${error.status}): ${error.message}` : String(error)}`);
      }
      for (const id of done) created.push(`item ${id}`);
    });

    it('C11 the same competitor added twice is one competitor', async (test) => {
      needs('competitors', test);
      needsWrites(test);
      const body = { name: 'Conformance Check Twice', domains: ['conformance-twice.example'] };
      const first = await raw('POST', businessPath('competitors'), { body, idempotencyKey: randomUUID() });
      const second = await raw('POST', businessPath('competitors'), { body, idempotencyKey: randomUUID() });
      expectStatus(first, [200, 201], 'POST of a competitor');
      expectStatus(second, [200, 201], 'POST of the same competitor again (answer 200 or 201 with the existing id, not 409)');
      created.push(`a competitor ${(first.json as { id: string }).id}`);
      if (String((first.json as { id: unknown }).id) !== String((second.json as { id: unknown }).id)) {
        warnings.push('C11: adding the same competitor twice returned two different ids. Recommended: return the id of the existing competitor instead of creating a second one.');
      }
    });

    it('C12 a repeated Idempotency-Key does not store the item twice (recommended)', async (test) => {
      needs('visibilitySnapshots', test);
      needsWrites(test);
      const idempotencyKey = randomUUID();
      const body = example('saveVisibilitySnapshot.request.json');
      const first = await raw('POST', businessPath('visibility-snapshots'), { body, idempotencyKey });
      const second = await raw('POST', businessPath('visibility-snapshots'), { body, idempotencyKey });
      expectStatus(first, [200, 201], 'POST with an Idempotency-Key');
      expectStatus(second, [200, 201], 'the same POST again with the same Idempotency-Key');
      created.push(`a visibility snapshot ${(first.json as { id: string }).id}`);
      if (String((first.json as { id: unknown }).id) !== String((second.json as { id: unknown }).id)) {
        warnings.push('C12: the same save sent twice with the same Idempotency-Key returned two different ids, so a retry after a timeout creates a duplicate. Recommended: return the first reply again.');
      }
    });

    it('C13 the largest body the extension can send (1 MB) is not refused for its size', async (test) => {
      needs('workspaces', test);
      needsWrites(test);
      const brief = example<Record<string, unknown>>('createWorkspaceFromBrief.request.json');
      // Markdown at its 200,000-character limit, in 3-byte characters: about 600 KB of UTF-8, well inside the 1 MB the extension allows itself.
      const body = { ...brief, businessName: 'Conformance Check Large Body', markdown: '漢'.repeat(200_000) };
      expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(MAX_REQUEST_BYTES);
      const reply = await raw('POST', '/v1/workspaces/from-brief', { body, idempotencyKey: randomUUID() });
      expect(reply.status, 'a 600 KB body was refused as too large (413). Allow request bodies of up to 1 MB').not.toBe(413);
      expectStatus(reply, [200, 201], 'POST of a 600 KB workspace brief');
      created.push(`a workspace ${(reply.json as { id: string }).id}`);
    });
  });

  describe('D. AI rewrite', () => {
    it('D1  POST /v1/ai/completions returns text the extension can show as bullet points', async (test) => {
      needs('ai', test);
      const reply = await raw('POST', '/v1/ai/completions', { body: example('completeAI.request.json'), timeoutMs: TIMEOUT_MS.ai });
      expectStatus(reply, [200], 'POST /v1/ai/completions');
      expectContract('AiCompletionResponse', reply.json, 'POST /v1/ai/completions');
      const lines = toLines((reply.json as { text: string }).text);
      expect(lines.length, 'the reply must contain at least one line of text').toBeGreaterThan(0);
      if (lines.length < 3) warnings.push(`D1: the reply has ${lines.length} line(s); the prompt asks for 3 to 6 bullet points.`);
    });

    it('D2  with responseSchema, the reply text is JSON that matches the schema', async (test) => {
      needs('ai', test);
      const request = example<{ responseSchema: Record<string, unknown> }>('completeAI.brief.request.json');
      const reply = await raw('POST', '/v1/ai/completions', { body: request, timeoutMs: TIMEOUT_MS.ai });
      expectStatus(reply, [200], 'POST /v1/ai/completions with responseSchema');
      expectContract('AiCompletionResponse', reply.json, 'POST /v1/ai/completions with responseSchema');
      const text = (reply.json as { text: string }).text;
      expect(parseBriefRewrite(text), `The extension could not use this reply. It needs a JSON object with exactly three avatars and one to eight next steps. Got: ${text.slice(0, 300)}`).not.toBeNull();
    });

    it('D3  a request without a prompt answers 400 or 422, not 500', async (test) => {
      needs('ai', test);
      const reply = await raw('POST', '/v1/ai/completions', { body: { task: 'rewind' }, timeoutMs: TIMEOUT_MS.ai });
      expectStatus(reply, [400, 422], 'POST /v1/ai/completions without system and prompt');
      expectErrorBody(reply, 'POST /v1/ai/completions without system and prompt');
    });
  });
}
