import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createMockState, handleMockRequest } from '@@/mock-server/handlers.mjs';
import { BrandMatcher } from '@/brands/matcher';
import { computeClickPotential } from '@/features/click-potential/metrics';
import { toSnapshot } from '@/features/click-potential/snapshot';
import { composeBrief } from '@/features/instant-brief/compose';
import { extractBusinessFacts } from '@/features/instant-brief/extract';
import { briefToMarkdown } from '@/features/instant-brief/markdown';
import { buildGapRows } from '@/features/why-not-me/gap';
import { buildSerpPresence } from '@/features/why-not-me/presence';
import { StaticAuthProvider, TokenAuthProvider } from '@/legiit/auth';
import { isUnavailable, LegiitError, METHOD_CAPABILITY, type LegiitClient, type LegiitMethod } from '@/legiit/client';
import { can, connect, disconnect, DISCONNECTED, loadConnection, noteFailure, resetUnavailable, type Connection } from '@/legiit/connection';
import { HttpLegiitClient } from '@/legiit/http-client';
import { MockLegiitClient } from '@/legiit/mock-client';
import { contentEditorPayload, gapPayload, snapshotPayload, workspacePayload } from '@/legiit/payloads';
import { applyBusinessDetails, clearBusinessDetails } from '@/legiit/prefill';
import { ALL_CAPABILITIES } from '@/legiit/types';
import { getPack } from '@/selectors';
import { parseSerp } from '@/serp/parse';
import { DEFAULT_SETTINGS, getLegiitToken, parseSettings } from '@/storage/settings';
import { fixtureDoc, scenario, scenarioBrands, serpEnv } from '../helpers/fixtures';
import { httpClient, mockLegiitFetch } from '../helpers/legiit';

const matcher = new BrandMatcher(scenarioBrands);
const doc = fixtureDoc('google/serp-full.html');
const serp = parseSerp(doc, getPack('google'), serpEnv(doc, scenario.urls.serpFull!));
const snapshot = toSnapshot(serp, computeClickPotential(serp, matcher));
const presence = buildSerpPresence(serp, matcher);

afterEach(() => {
  resetUnavailable();
});

describe('HTTP client against the mock API', () => {
  it('reads the session, businesses and business details', async () => {
    const { client, calls } = httpClient();
    const session = await client.getSession();
    expect(session.user.name).toBe('Dana Whitfield');
    expect(session.capabilities).toEqual(ALL_CAPABILITIES);
    expect((await client.listBusinesses()).map((b) => b.id)).toEqual(['biz_brightpath', 'biz_oakline']);
    const details = await client.getBusinessDetails('biz_brightpath');
    expect(details.competitors.map((c) => c.name)).toEqual(['Lakeside Smiles', 'Capitol Dental Care', 'Zilker Family Dentistry']);
    expect(details.focusKeywords).toContain('best dentist in austin');
    expect(calls[0]!.url).toBe('https://api.legiit.com/v1/session');
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer demo-token');
    expect(new Headers(calls[0]!.init.headers).get('x-legiit-client')).toBe('legiit-lens/9.9.9');
  });

  it('sends each save as JSON to its endpoint and returns the saved id and link', async () => {
    const { client, state, calls } = httpClient();
    const saved = await client.saveVisibilitySnapshot('biz_brightpath', snapshotPayload(snapshot));
    expect(saved).toEqual({ id: 'vis_1', url: 'https://app.legiit.example/command-center/visibility/vis_1' });
    expect(calls[0]!.url).toBe('https://api.legiit.com/v1/businesses/biz_brightpath/visibility-snapshots');
    expect(calls[0]!.init.method).toBe('POST');
    expect(state.saved.visibilitySnapshots[0]!.payload).toEqual(snapshotPayload(snapshot));

    await client.saveGapList('biz_brightpath', gapPayload(presence, buildGapRows(presence)));
    await client.addCompetitor('biz_brightpath', { name: 'Austin Emergency Dental', domain: 'austinemergencydental.example' });
    expect(state.saved.gapLists).toHaveLength(1);
    expect(state.saved.competitors[0]!.payload).toEqual({ name: 'Austin Emergency Dental', domain: 'austinemergencydental.example' });
    expect((await client.getIndustryPulse()).events[0]).toMatchObject({ type: 'algorithm-update' });
    expect((await client.completeAI({ task: 'rewind', system: 's', prompt: 'Task: x\n- First fact\n- Second fact' })).text).toContain('First fact');
  });

  it('never makes a request without a token', async () => {
    const { client, calls } = httpClient(null);
    await expect(client.getSession()).rejects.toMatchObject({ code: 'unauthorised' });
    expect(calls).toHaveLength(0);
  });

  it('maps HTTP failures to typed errors', async () => {
    await expect(httpClient('invalid').client.getSession()).rejects.toMatchObject({ code: 'unauthorised', status: 401 });
    const limited = httpClient('limited-token').client;
    expect((await limited.getSession()).capabilities).toEqual(['businesses', 'visibilitySnapshots', 'industryPulse']);
    const unavailable = await limited.saveGapList('biz_brightpath', gapPayload(presence, [])).catch((e: unknown) => e);
    expect(isUnavailable(unavailable)).toBe(true);
    const rejected = await httpClient().client.addCompetitor('biz_brightpath', { name: '', domain: null }).catch((e: unknown) => e);
    expect(rejected).toMatchObject({ code: 'rejected', status: 422, message: 'Legiit rejected the request (422): name is required' });
  });

  it('treats 404, 405 and 501 as "endpoint not available yet"', async () => {
    for (const status of [404, 405, 501]) {
      const client = new HttpLegiitClient({ baseUrl: 'https://api.legiit.com', auth: new StaticAuthProvider('t'), fetch: async () => new Response('', { status }) });
      expect(isUnavailable(await client.getIndustryPulse().catch((e: unknown) => e))).toBe(true);
    }
  });

  it('reports server errors, network errors and malformed replies', async () => {
    const make = (fetch: () => Promise<Response>) => new HttpLegiitClient({ baseUrl: 'https://api.legiit.com', auth: new StaticAuthProvider('t'), fetch });
    await expect(make(async () => new Response('x', { status: 503 })).getSession()).rejects.toMatchObject({ code: 'server' });
    await expect(make(async () => { throw new TypeError('Failed to fetch'); }).getSession()).rejects.toMatchObject({ code: 'network' });
    await expect(make(async () => new Response('<html>', { status: 200 })).getSession()).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(make(async () => Response.json({ user: { id: 5 } })).getSession()).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('tolerates optional fields being absent', async () => {
    const client = new HttpLegiitClient({
      baseUrl: 'https://api.legiit.com',
      auth: new StaticAuthProvider('t'),
      fetch: async () => Response.json({ user: { id: 'u', name: 'N' } }),
    });
    expect(await client.getSession()).toEqual({ user: { id: 'u', name: 'N', email: null }, plan: null, capabilities: [] });
  });
});

describe('in-memory mock client', () => {
  it('implements every method of the interface', async () => {
    const mock: LegiitClient = new MockLegiitClient();
    expect((await mock.getSession()).capabilities).toHaveLength(8);
    expect(await mock.listBusinesses()).toHaveLength(2);
    expect((await mock.getBusinessDetails('biz_oakline')).name).toBe('Oakline Roofing');
    expect((await mock.saveVisibilitySnapshot('biz_brightpath', snapshotPayload(snapshot))).id).toBe('visibility_1');
    expect((await mock.getIndustryPulse()).events.length).toBeGreaterThan(2);
    expect((mock as MockLegiitClient).saved).toHaveLength(1);
  });

  it('can simulate a limited account and a rejected token', async () => {
    const limited = new MockLegiitClient({ capabilities: ['businesses'] });
    expect(isUnavailable(await limited.getIndustryPulse().catch((e: unknown) => e))).toBe(true);
    await expect(new MockLegiitClient({ unauthorised: true }).getSession()).rejects.toMatchObject({ code: 'unauthorised' });
  });
});

describe('save payloads (what the user is shown is what is sent)', () => {
  it('builds the visibility snapshot payload', () => {
    const payload = snapshotPayload(snapshot);
    expect(payload).toMatchObject({
      keyword: 'best dentist in austin',
      capturedAt: '2026-11-20T12:00:00.000Z',
      googleHost: 'www.google.com',
      viewport: { width: 1280, height: 800 },
      location: 'Austin, Texas',
      firstOrganicTopPx: 1431,
      firstOrganicFold: 'Below the fold',
      grade: { letter: 'F', score: 0, estimate: true },
    });
    expect(payload.organic).toHaveLength(9);
    expect(payload.tracked.find((t) => t.owner === 'mine')).toEqual({ owner: 'mine', name: 'BrightPath Dental', position: 6, topPx: 2475, fold: 'Below the fold' });
    // Plain JSON only.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('builds the gap list, content editor and workspace payloads', () => {
    const rows = buildGapRows(presence);
    const gaps = gapPayload(presence, rows);
    expect(gaps).toMatchObject({ source: 'Google results', subject: 'best dentist in austin' });
    expect(gaps.rows).toHaveLength(rows.length);
    expect(Object.keys(gaps.rows[0]!).sort()).toEqual(
      ['actionable', 'competitors', 'contacts', 'domain', 'evidence', 'pageType', 'position', 'scanned', 'surface', 'title', 'url'].sort(),
    );

    const content = contentEditorPayload({
      targetKeyword: 'teeth cleaning',
      pageUrl: 'https://a.example/x',
      pageTitle: 'T',
      comparedUrls: ['https://b.example/'],
      report: {
        engine: 'embedding', engineLabel: 'e', threshold: 0.72, pagesCompared: 1, mostNeeds: 1,
        sentences: [
          { text: 'Unique line here.', words: 3, cls: 'only', pages: 0, bestScore: 0.1, closest: null },
          { text: 'Common line here.', words: 3, cls: 'most', pages: 1, bestScore: 0.9, closest: null },
        ],
        totalWords: 6, words: { most: 3, some: 0, only: 3 }, share: { most: 0.5, some: 0, only: 0.5 },
        missing: [{ text: 'Missing point.', pages: 1, urls: ['https://b.example/'] }],
      },
    });
    expect(content).toEqual({
      targetKeyword: 'teeth cleaning',
      pageUrl: 'https://a.example/x',
      pageTitle: 'T',
      method: { engine: 'embedding', threshold: 0.72, pagesCompared: 1 },
      wordShare: { saidByMost: 0.5, saidBySome: 0, onlyHere: 0.5 },
      onlyHere: ['Unique line here.'],
      missingPoints: [{ text: 'Missing point.', pages: 1, urls: ['https://b.example/'] }],
      comparedUrls: ['https://b.example/'],
    });

    const facts = extractBusinessFacts([{ url: 'https://www.brightpathdental.example/', kind: 'home', doc: fixtureDoc('site/index.html') }]);
    const brief = composeBrief({ id: 'b', now: Date.UTC(2026, 10, 20), facts, issues: [], competitors: [{ name: 'Lakeside Smiles', domain: null, source: 'manual' }] });
    const workspace = workspacePayload(brief, briefToMarkdown(brief, { name: 'North Star SEO', logoDataUrl: null }));
    expect(workspace).toMatchObject({ businessName: 'BrightPath Dental', siteUrl: 'https://www.brightpathdental.example/', competitors: [{ name: 'Lakeside Smiles', domain: null }] });
    expect(workspace.avatars).toHaveLength(3);
    expect(workspace.avatars.every((a) => a.draft)).toBe(true);
    expect(workspace.markdown).toContain('# Client brief: BrightPath Dental');
  });
});

describe('pre-filling tracked brands from Business Details', () => {
  const details = {
    id: 'biz_brightpath',
    name: 'BrightPath Dental',
    brandNames: ['BrightPath Dental', 'Bright Path Dental'],
    domains: ['https://www.BrightPathDental.example/'],
    competitors: [{ name: 'Lakeside Smiles', domains: ['lakesidesmiles.example'] }, { name: ' ', domains: [] }],
    focusKeywords: ['best dentist in austin'],
    avatars: [{ name: 'Busy parent', description: 'd' }],
  };

  it('adds the business and its competitors as Legiit-sourced entries', () => {
    const next = applyBusinessDetails(DEFAULT_SETTINGS, details);
    expect(next.myBrands).toEqual([
      { id: expect.stringMatching(/^legiit-/), name: 'BrightPath Dental', domains: ['brightpathdental.example'], aliases: ['Bright Path Dental'], source: 'legiit' },
    ]);
    expect(next.competitors.map((c) => [c.name, c.domains, c.source])).toEqual([['Lakeside Smiles', ['lakesidesmiles.example'], 'legiit']]);
    expect(next.legiit).toEqual({ businessId: 'biz_brightpath', businessName: 'BrightPath Dental', focusKeywords: ['best dentist in austin'], avatars: [{ name: 'Busy parent', description: 'd' }] });
    expect(parseSettings(next)).toEqual(next);
  });

  it('keeps what the user typed, avoids duplicates and replaces a previous business', () => {
    const manual = parseSettings({
      myBrands: [{ id: 'm', name: 'brightpath dental', domains: [], aliases: [], source: 'manual' }],
      competitors: [
        { id: 'c', name: 'Other Rival', domains: ['lakesidesmiles.example'], aliases: [], source: 'manual' },
        { id: 'old', name: 'Old Legiit Rival', domains: [], aliases: [], source: 'legiit' },
      ],
    });
    const next = applyBusinessDetails(manual, details);
    expect(next.myBrands.map((b) => b.id)).toEqual(['m']);
    expect(next.competitors.map((b) => b.id)).toEqual(['c']);
    const cleared = clearBusinessDetails(applyBusinessDetails(DEFAULT_SETTINGS, details));
    expect(cleared).toEqual(DEFAULT_SETTINGS);
  });
});

describe('connection', () => {
  it('makes no request at all when no token is stored', async () => {
    const client = new MockLegiitClient();
    expect(await loadConnection(client)).toBe(DISCONNECTED);
    expect(client.calls).toHaveLength(0);
  });

  it('connects with a pasted token and restores the connection later', async () => {
    const client = new MockLegiitClient();
    const connection = await connect('  demo-token ', client);
    expect(connection.status).toBe('connected');
    expect(await getLegiitToken()).toBe('demo-token');
    expect((await loadConnection(client)).session?.user.name).toBe('Dana Whitfield');
    await disconnect();
    expect(await getLegiitToken()).toBeNull();
    expect(await loadConnection(client)).toBe(DISCONNECTED);
  });

  it('forgets a token that Legiit rejects', async () => {
    await expect(connect('bad', new MockLegiitClient({ unauthorised: true }))).rejects.toMatchObject({ code: 'unauthorised' });
    expect(await getLegiitToken()).toBeNull();
    await expect(connect('   ', new MockLegiitClient())).rejects.toBeInstanceOf(LegiitError);
    await new TokenAuthProvider().store('expired');
    const restored = await loadConnection(new MockLegiitClient({ unauthorised: true }));
    expect(restored).toMatchObject({ status: 'disconnected', error: 'Your Legiit token was not accepted. Paste a new one to reconnect.' });
    expect(await getLegiitToken()).toBeNull();
  });

  it('explains when the API does not exist yet, and keeps nothing', async () => {
    class NotBuiltYet extends MockLegiitClient {
      override async getSession(): Promise<never> {
        throw new LegiitError('unavailable', 'x', 404);
      }
    }
    await expect(connect('token', new NotBuiltYet())).rejects.toMatchObject({ message: 'The Legiit API is not available yet. Nothing was saved.' });
    expect(await getLegiitToken()).toBeNull();
  });

  it('shows UI only for capabilities the account has, and hides it after a "not available" reply', async () => {
    const limited = await connect('t', new MockLegiitClient({ capabilities: ['businesses', 'visibilitySnapshots'] }));
    expect(can(limited, 'saveVisibilitySnapshot')).toBe(true);
    expect(can(limited, 'saveGapList')).toBe(false);
    expect(can(limited, 'completeAI')).toBe(false);
    expect(can(limited, 'getSession')).toBe(true);
    expect(can(DISCONNECTED, 'saveVisibilitySnapshot')).toBe(false);
    noteFailure('saveVisibilitySnapshot', new LegiitError('unavailable', 'gone', 404));
    expect(can(limited, 'saveVisibilitySnapshot')).toBe(false);
    noteFailure('listBusinesses', new LegiitError('server', 'boom', 500));
    expect(can(limited, 'listBusinesses')).toBe(true);
  });

  it('goes through the guarded network layer to the configured Legiit origin only', async () => {
    const state = createMockState();
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => mockLegiitFetch(state)(url, init));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const connection: Connection = await connect('demo-token');
      expect(connection.session?.plan).toBe('agency');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.legiit.com/v1/session');
      expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('API contract (docs/legiit-api-contract.yaml)', () => {
  const contract = parseYaml(readFileSync(resolve(__dirname, '../../docs/legiit-api-contract.yaml'), 'utf8')) as {
    openapi: string;
    paths: Record<string, Record<string, { operationId: string; 'x-capability'?: string }>>;
    components: { schemas: Record<string, { enum?: string[] }> };
  };
  const operations = Object.entries(contract.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ path, method: method.toUpperCase(), ...op })),
  );

  it('is OpenAPI 3.1 and has one operation per client method', () => {
    expect(contract.openapi).toMatch(/^3\.1/);
    expect(operations.map((o) => o.operationId).sort()).toEqual((Object.keys(METHOD_CAPABILITY) as LegiitMethod[]).sort());
  });

  it('declares the same capability for each operation as the client', () => {
    for (const op of operations) expect(op['x-capability'] ?? null, op.operationId).toBe(METHOD_CAPABILITY[op.operationId as LegiitMethod]);
    expect(contract.components.schemas['Capability']?.enum).toEqual([...ALL_CAPABILITIES]);
  });

  it('is implemented, path for path, by the mock server', () => {
    const state = createMockState();
    for (const op of operations) {
      const path = op.path.replace('{businessId}', 'biz_brightpath');
      const response = handleMockRequest(state, { method: op.method, path, headers: { authorization: 'Bearer demo-token' }, body: op.method === 'POST' ? '{}' : null });
      // A known route answers 200/201, or 422 for the deliberately empty body: never "no route".
      expect([200, 201, 422], `${op.method} ${op.path}`).toContain(response.status);
    }
    expect(handleMockRequest(state, { method: 'GET', path: '/v1/unknown', headers: { authorization: 'Bearer demo-token' } }).status).toBe(404);
    expect(handleMockRequest(state, { method: 'GET', path: '/v1/session', headers: {} }).status).toBe(401);
  });
});
