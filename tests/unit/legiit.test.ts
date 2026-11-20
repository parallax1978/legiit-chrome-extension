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
import { classifySentences } from '@/features/new-or-noise/classify';
import { buildGapRows } from '@/features/why-not-me/gap';
import { buildSerpPresence } from '@/features/why-not-me/presence';
import { StaticAuthProvider, TokenAuthProvider } from '@/legiit/auth';
import { isUnavailable, LegiitError, METHOD_CAPABILITY, type LegiitClient, type LegiitMethod } from '@/legiit/client';
import { can, connect, disconnect, DISCONNECTED, loadConnection, noteFailure, resetUnavailable, type Connection } from '@/legiit/connection';
import { HttpLegiitClient, type HttpClientOptions } from '@/legiit/http-client';
import { MockLegiitClient } from '@/legiit/mock-client';
import { contentEditorPayload, gapPayload, snapshotPayload, workspacePayload } from '@/legiit/payloads';
import { applyBusinessDetails, clearBusinessDetails } from '@/legiit/prefill';
import { LIMITS, MAX_REQUEST_BYTES, TIMEOUT_MS } from '@/legiit/limits';
import { ALL_CAPABILITIES, type WorkspaceFromBriefPayload } from '@/legiit/types';
import { getPack } from '@/selectors';
import { LexicalEngine } from '@/similarity/engine';
import { parseSerp } from '@/serp/parse';
import { DEFAULT_SETTINGS, getLegiitToken, parseSettings } from '@/storage/settings';
import { buildExampleNoiseReport } from '../helpers/api-examples';
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

function workspaceExample(): WorkspaceFromBriefPayload {
  const facts = extractBusinessFacts([{ url: 'https://www.brightpathdental.example/', kind: 'home', doc: fixtureDoc('site/index.html') }]);
  const brief = composeBrief({ id: 'b', now: Date.UTC(2026, 10, 20), facts, issues: [], competitors: [] });
  return workspacePayload(brief, briefToMarkdown(brief, { name: 'North Star SEO', logoDataUrl: null }));
}

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
    await client.addCompetitor('biz_brightpath', { name: 'Austin Emergency Dental', domains: ['austinemergencydental.example'] });
    expect(state.saved.gapLists).toHaveLength(1);
    expect(state.saved.competitors[0]!.payload).toEqual({ name: 'Austin Emergency Dental', domains: ['austinemergencydental.example'] });
    expect((await client.getIndustryPulse()).events[0]).toMatchObject({ type: 'algorithm-update' });
    expect((await client.completeAI({ task: 'rewind', system: 's', prompt: 'Task: x\n- First fact\n- Second fact', maxOutputTokens: 700 })).text).toContain('First fact');
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
    const rejected = await httpClient().client.addCompetitor('biz_brightpath', { name: '', domains: [] }).catch((e: unknown) => e);
    expect(rejected).toMatchObject({ code: 'rejected', status: 422, message: 'Legiit rejected the request (422): name is required' });
  });

  const answering = (respond: (url: string, init: RequestInit) => Response | Promise<Response>, options: Partial<HttpClientOptions> = {}) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new HttpLegiitClient({
      baseUrl: 'https://api.legiit.com',
      auth: new StaticAuthProvider('t'),
      fetch: async (url, init = {}) => {
        calls.push({ url, init });
        return respond(url, init);
      },
      ...options,
    });
    return { client, calls };
  };
  const errorBody = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

  it('treats 404, 405 and 501 as "endpoint not available yet"', async () => {
    for (const status of [404, 405, 501]) {
      const { client } = answering(() => new Response('', { status }));
      expect(isUnavailable(await client.getIndustryPulse().catch((e: unknown) => e))).toBe(true);
    }
    // A framework's own 404 page or JSON is still "not available".
    for (const body of ['<html>Not Found</html>', '{"message":"Not Found"}', '{"error":"nope"}', 'null']) {
      const { client } = answering(() => new Response(body, { status: 404, headers: { 'content-type': 'application/json' } }));
      expect(isUnavailable(await client.getIndustryPulse().catch((e: unknown) => e))).toBe(true);
    }
  });

  it('tells "that business does not exist" apart from "this endpoint does not exist"', async () => {
    const missing = await httpClient().client.saveVisibilitySnapshot('biz_deleted', snapshotPayload(snapshot)).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: 'rejected', status: 404, message: 'Legiit could not find it (404): No such business' });
    expect(isUnavailable(missing)).toBe(false);
    const details = await httpClient().client.getBusinessDetails('biz_deleted').catch((e: unknown) => e);
    expect(details).toMatchObject({ code: 'rejected', status: 404 });
    const { client } = answering(() => errorBody(404, 'not_found', ''));
    await expect(client.getSession()).rejects.toMatchObject({ code: 'rejected', message: 'Legiit could not find it (404)' });
  });

  it('only 401 means the token is bad: 403 and other refusals keep it and show the reason', async () => {
    const { client } = answering(() => errorBody(403, 'forbidden', 'Your plan does not include gap lists'));
    await expect(client.getSession()).rejects.toMatchObject({ code: 'rejected', status: 403, message: 'Legiit rejected the request (403): Your plan does not include gap lists' });
    await new TokenAuthProvider().store('still-good');
    expect(await loadConnection(client)).toMatchObject({ status: 'disconnected', error: 'Legiit rejected the request (403): Your plan does not include gap lists' });
    expect(await getLegiitToken()).toBe('still-good');
    await disconnect();

    for (const [status, text] of [[400, 'Bad JSON'], [409, 'Already there'], [413, 'Too big'], [422, 'keyword is required'], [429, 'Slow down']] as const) {
      await expect(answering(() => errorBody(status, 'x', text)).client.getSession()).rejects.toMatchObject({ code: 'rejected', status, message: `Legiit rejected the request (${status}): ${text}` });
    }
    // The server's message is shown as one plain line of at most 200 characters.
    const noisy = await answering(() => errorBody(422, 'invalid', `first\n\tsecond\u0000 ${'x'.repeat(400)}`)).client.getSession().catch((e: unknown) => e);
    expect((noisy as LegiitError).message).toMatch(/^Legiit rejected the request \(422\): first second x+…$/);
    expect((noisy as LegiitError).message.length).toBeLessThanOrEqual('Legiit rejected the request (422): '.length + 200);
    // No body, or a body in another shape: the status alone is reported.
    await expect(answering(() => new Response('oops', { status: 422 })).client.getSession()).rejects.toMatchObject({ message: 'Legiit rejected the request (422)' });
    await expect(answering(() => Response.json({ message: 'Laravel style' }, { status: 422 })).client.getSession()).rejects.toMatchObject({ message: 'Legiit rejected the request (422)' });
  });

  it('reports server errors, network errors and malformed replies', async () => {
    const make = (fetch: () => Promise<Response>) => new HttpLegiitClient({ baseUrl: 'https://api.legiit.com', auth: new StaticAuthProvider('t'), fetch });
    await expect(make(async () => new Response('x', { status: 503 })).getSession()).rejects.toMatchObject({ code: 'server' });
    await expect(make(async () => { throw new TypeError('Failed to fetch'); }).getSession()).rejects.toMatchObject({ code: 'network', message: 'Could not reach Legiit: Failed to fetch' });
    await expect(make(async () => new Response('<html>', { status: 200 })).getSession()).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(make(async () => new Response(null, { status: 204 })).getSession()).rejects.toMatchObject({ code: 'invalid-response' });
    for (const body of [{ user: {} }, { user: { id: '' } }, { user: { id: 1.5 } }, { user: { id: true } }, { user: 'x' }, [], null, 'text']) {
      await expect(make(async () => Response.json(body)).getSession()).rejects.toMatchObject({ code: 'invalid-response' });
    }
    // A save must be confirmed by a JSON body with an id: an empty 2xx is not taken for a success.
    await expect(make(async () => new Response('', { status: 201 })).addCompetitor('b', { name: 'n', domains: [] })).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(make(async () => Response.json({ ok: true }, { status: 201 })).addCompetitor('b', { name: 'n', domains: [] })).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('gives up when Legiit does not answer in time', async () => {
    const hanging = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    await expect(answering(hanging, { timeoutMs: 20 }).client.getSession()).rejects.toMatchObject({ code: 'network', message: 'Legiit did not answer in time' });
    // The limit also covers a reply whose body never finishes.
    const stalled = (_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"user":'));
          init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200 });
    };
    await expect(answering(stalled, { timeoutMs: 20 }).client.getSession()).rejects.toMatchObject({ code: 'network', message: 'Legiit did not answer in time' });
    expect(TIMEOUT_MS).toEqual({ default: 20_000, ai: 60_000 });
  });

  it('reads replies tolerantly: integer ids, missing or null optional fields, unknown fields and capabilities', async () => {
    const { client } = answering((url) => {
      const path = new URL(url).pathname;
      if (path === '/v1/session') return Response.json({ user: { id: 42, name: null, extra: 1 }, plan: null, capabilities: ['ai', 'teleport', 7, 'businesses', 'ai'], added: 'later' });
      if (path === '/v1/businesses') return Response.json({ businesses: [{ id: 7, name: 'Acme', domain: null, owner: { id: 1 } }], total: 1 });
      if (path === '/v1/businesses/7') return Response.json({ id: 7, name: 'Acme', brandNames: null, competitors: [{ name: 'Rival', domains: null }], avatars: [{ name: 'A' }] });
      if (path === '/v1/industry-pulse') return Response.json({ events: [{ date: '2026-03-05T10:00:00Z', title: 'Core update', type: 'brand-new-kind' }, { date: '2026-01-02', title: 'Other' }] });
      return Response.json({ id: 9001 }, { status: 201 });
    });
    expect(await client.getSession()).toEqual({ user: { id: '42', name: '', email: null }, plan: null, capabilities: ['businesses', 'ai'] });
    expect(await client.listBusinesses()).toEqual([{ id: '7', name: 'Acme', domain: null }]);
    expect(await client.getBusinessDetails('7')).toEqual({ id: '7', name: 'Acme', brandNames: [], domains: [], competitors: [{ name: 'Rival', domains: [] }], focusKeywords: [], avatars: [{ name: 'A', description: '' }] });
    expect(await client.getIndustryPulse()).toEqual({
      updatedAt: null,
      events: [
        { date: '2026-03-05', title: 'Core update', type: 'brand-new-kind', url: null },
        { date: '2026-01-02', title: 'Other', type: 'news', url: null },
      ],
    });
    expect(await client.addCompetitor('7', { name: 'n', domains: [] })).toEqual({ id: '9001', url: null });
    await expect(answering(() => Response.json({ events: [{ date: 'March 5', title: 'x' }] })).client.getIndustryPulse()).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(answering(() => Response.json({ user: { id: 'u' }, capabilities: 'all' })).client.getSession()).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('cuts text and lists that are longer than the limits instead of failing', async () => {
    const long = 'n'.repeat(5000);
    const { client } = answering((url) => {
      const path = new URL(url).pathname;
      if (path === '/v1/businesses') return Response.json({ businesses: Array.from({ length: 700 }, (_, i) => ({ id: `b${i}`, name: long })) });
      if (path === '/v1/ai/completions') return Response.json({ text: `${'t'.repeat(19_999)}😀 more`, model: long });
      return Response.json({
        id: 'b',
        name: long,
        brandNames: Array.from({ length: 50 }, () => long),
        domains: Array.from({ length: 50 }, (_, i) => `d${i}.example`),
        competitors: Array.from({ length: 300 }, (_, i) => ({ name: `${i} ${long}`, domains: Array.from({ length: 40 }, (_, j) => `c${i}-${j}.example`) })),
        focusKeywords: Array.from({ length: 300 }, () => long),
        avatars: Array.from({ length: 40 }, () => ({ name: long, description: long })),
      });
    });
    const businesses = await client.listBusinesses();
    expect(businesses).toHaveLength(500);
    expect(businesses[0]!.name).toHaveLength(200);
    const details = await client.getBusinessDetails('b');
    expect([details.name.length, details.brandNames.length, details.brandNames[0]!.length, details.domains.length]).toEqual([200, 30, 160, 30]);
    expect([details.competitors.length, details.competitors[0]!.name.length, details.competitors[0]!.domains.length]).toEqual([200, 160, 30]);
    expect([details.focusKeywords.length, details.focusKeywords[0]!.length, details.avatars.length, details.avatars[0]!.description.length]).toEqual([200, 200, 20, 2000]);
    const completion = await client.completeAI({ task: 'rewind', system: 's', prompt: 'p', maxOutputTokens: 700 });
    expect(completion.text).toHaveLength(19_999);
    expect(completion.text.isWellFormed()).toBe(true);
    expect(completion.model).toHaveLength(120);
    // Whatever arrives, it can be stored as tracked brands.
    const stored = applyBusinessDetails(DEFAULT_SETTINGS, details);
    expect(parseSettings(stored)).toEqual(stored);
    expect(stored.myBrands[0]!.name).toHaveLength(160);
    expect(stored.competitors).toHaveLength(200);
    // An id is never cut: one that is too long is refused.
    await expect(answering(() => Response.json({ id: 'x'.repeat(201) }, { status: 201 })).client.addCompetitor('b', { name: 'n', domains: [] })).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('sends what the contract promises: headers, no cache, a retry key on saves only', async () => {
    const { client, calls } = answering((url) => (new URL(url).pathname === '/v1/session' ? Response.json({ user: { id: 'u' } }) : Response.json({ id: 'x', text: 'ok' }, { status: 201 })), { clientVersion: '1.2.3' });
    await client.getSession();
    await client.saveGapList('biz 1/ü', gapPayload(presence, buildGapRows(presence)), { idempotencyKey: 'key-1' });
    await client.completeAI({ task: 'rewind', system: 's', prompt: 'p', maxOutputTokens: 700 });
    const [get, save, ai] = calls.map((c) => ({ url: c.url, method: c.init.method, cache: c.init.cache, headers: Object.fromEntries(new Headers(c.init.headers).entries()) }));
    expect(get).toEqual({ url: 'https://api.legiit.com/v1/session', method: 'GET', cache: 'no-store', headers: { accept: 'application/json', authorization: 'Bearer t', 'x-legiit-client': 'legiit-lens/1.2.3' } });
    expect(save).toMatchObject({ url: 'https://api.legiit.com/v1/businesses/biz%201%2F%C3%BC/gap-lists', method: 'POST', cache: 'no-store' });
    expect(save!.headers).toEqual({ accept: 'application/json', authorization: 'Bearer t', 'content-type': 'application/json', 'idempotency-key': 'key-1', 'x-legiit-client': 'legiit-lens/1.2.3' });
    expect(Object.keys(ai!.headers).sort()).toEqual(['accept', 'authorization', 'content-type', 'x-legiit-client']);
    expect(typeof calls[1]!.init.body).toBe('string');
  });

  it('never sends a body larger than 1 MB', async () => {
    const { client, calls } = answering(() => Response.json({ id: 'x' }, { status: 201 }));
    const huge = { ...workspaceExample(), markdown: 'é'.repeat(600_000) };
    const error = await client.createWorkspaceFromBrief(huge).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'rejected', status: 0 });
    expect((error as LegiitError).message).toMatch(/^This is too large to send to Legiit \(1,1\d\d KB; the limit is 1024 KB\)\. Nothing was sent\.$/);
    expect(calls).toHaveLength(0);
    expect(MAX_REQUEST_BYTES).toBe(1_048_576);
    await client.createWorkspaceFromBrief({ ...huge, markdown: 'é'.repeat(400_000) });
    expect(calls).toHaveLength(1);
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
    const payload = snapshotPayload(snapshot, scenarioBrands);
    expect(payload).toMatchObject({
      keyword: 'best dentist in austin',
      capturedAt: '2026-11-20T12:00:00.000Z',
      googleHost: 'www.google.com',
      mode: 'web',
      resultsOffset: 0,
      viewport: { width: 1280, height: 800 },
      location: 'Austin, Texas',
      firstOrganicTopPx: 1431,
      firstOrganicFold: 'below',
      grade: { letter: 'F', score: 0, estimate: true },
    });
    expect(payload.organic).toHaveLength(9);
    expect(payload.organic.map((o) => o.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(payload.tracked.find((t) => t.owner === 'mine')).toEqual({ owner: 'mine', name: 'BrightPath Dental', position: 6, topPx: 2475, fold: 'below' });
    // Plain JSON only.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('lists every tracked brand in a snapshot, found first, and says which were not found', () => {
    const brands = {
      mine: scenarioBrands.mine,
      competitors: [...scenarioBrands.competitors, { id: 'brand-absent', name: 'Nowhere Dental', domains: ['nowhere-dental.example'], aliases: [] }],
    };
    const payload = snapshotPayload(snapshot, brands);
    expect(payload.tracked).toHaveLength(brands.mine.length + brands.competitors.length);
    const found = payload.tracked.filter((t) => t.position !== null);
    expect(found.length).toBeGreaterThan(1);
    expect(payload.tracked.slice(0, found.length)).toEqual(found);
    for (const t of found) expect(payload.organic[t.position! - 1]).toMatchObject({ position: t.position, topPx: t.topPx, fold: t.fold });
    expect(payload.tracked.at(-1)).toEqual({ owner: 'competitor', name: 'Nowhere Dental', position: null, topPx: null, fold: null });
    // Without the list of tracked brands only the brands that were found are sent.
    expect(snapshotPayload(snapshot).tracked).toEqual(found);
  });

  it('reads the results offset from the page address', () => {
    const second = { ...snapshot, url: 'https://www.google.com/search?q=best+dentist+in+austin&start=10' };
    expect(snapshotPayload(second).resultsOffset).toBe(10);
    for (const start of ['-10', '1.5', 'abc', '']) {
      expect(snapshotPayload({ ...snapshot, url: `https://www.google.com/search?q=x&start=${start}` }).resultsOffset).toBe(0);
    }
    expect(snapshotPayload({ ...snapshot, url: 'https://www.google.com/search?q=x&start=99999' }).resultsOffset).toBe(1000);
  });

  it('never sends more than the limits of the contract allow', () => {
    const long = 'x'.repeat(10_000);
    const big = {
      ...snapshot,
      keyword: long,
      locationText: long,
      organic: Array.from({ length: 150 }, (_, i) => ({ position: i + 1, domain: `${long}.example`, url: `https://a.example/${long}`, title: long, top: i * 100, fold: 'below' as const })),
      tracked: [
        { owner: 'mine' as const, brandId: 'me', name: long, position: 3, top: 200, fold: 'below' as const },
        { owner: 'competitor' as const, brandId: 'far', name: 'Far Away', position: 140, top: 14_000, fold: 'below' as const },
      ],
    };
    const payload = snapshotPayload(big, { mine: [], competitors: Array.from({ length: 400 }, (_, i) => ({ id: `c${i}`, name: `Competitor ${i}`, domains: [], aliases: [] })) });
    expect(payload.keyword).toHaveLength(LIMITS.snapshot.keyword);
    expect(payload.keyword.endsWith('…')).toBe(true);
    expect(payload.location).toHaveLength(LIMITS.snapshot.location);
    expect(payload.organic).toHaveLength(LIMITS.snapshot.organic);
    expect(payload.organic[0]!.title).toHaveLength(LIMITS.snapshot.title);
    expect(payload.organic[0]!.url).toHaveLength(LIMITS.url);
    expect(payload.organic[0]!.domain).toHaveLength(LIMITS.domain);
    expect(payload.tracked).toHaveLength(LIMITS.snapshot.tracked);
    expect(payload.tracked[0]!.name).toHaveLength(LIMITS.brandName);
    // A brand whose result is not among the results sent is reported as not found.
    expect(payload.tracked.find((t) => t.name === 'Far Away')).toBeUndefined();
    expect(payload.tracked.every((t) => t.position === null || t.position <= LIMITS.snapshot.organic)).toBe(true);

    const row = buildGapRows(presence)[0]!;
    const gaps = gapPayload(
      { ...presence, subject: long, sourceLabel: long },
      Array.from({ length: 1200 }, () => ({
        ...row,
        surface: long,
        title: long,
        url: `https://a.example/${long}`,
        domain: `${long}.example`,
        evidence: long,
        competitors: Array.from({ length: 300 }, () => long),
        contacts: [
          ...Array.from({ length: 30 }, (_, i) => ({ kind: 'contact' as const, label: long, url: `https://a.example/contact-${i}` })),
          { kind: 'author' as const, label: 'Too long', url: `https://a.example/${long}` },
        ],
      })),
    );
    expect(gaps.source).toHaveLength(LIMITS.gapList.source);
    expect(gaps.subject).toHaveLength(LIMITS.gapList.subject);
    expect(gaps.rows).toHaveLength(LIMITS.gapList.rows);
    const first = gaps.rows[0]!;
    expect(first.surface).toHaveLength(LIMITS.gapList.surface);
    expect(first.title).toHaveLength(LIMITS.gapList.title);
    expect(first.url).toHaveLength(LIMITS.url);
    expect(first.domain).toHaveLength(LIMITS.domain);
    expect(first.evidence).toHaveLength(LIMITS.gapList.evidence);
    expect(first.competitors).toHaveLength(LIMITS.gapList.competitors);
    expect(first.competitors[0]).toHaveLength(LIMITS.brandName);
    expect(first.contacts).toHaveLength(LIMITS.gapList.contacts);
    expect(first.contacts[0]!.label).toHaveLength(LIMITS.gapList.contactLabel);
    expect(first.contacts.some((c) => c.label === 'Too long')).toBe(false);
  });

  it('sends well-formed text only: no half of a surrogate pair survives a cut', () => {
    const emoji = '😀';
    const keyword = `${'k'.repeat(LIMITS.snapshot.keyword - 2)}${emoji}${emoji}`;
    const payload = snapshotPayload({ ...snapshot, keyword, locationText: `Austin \uD83D Texas` });
    expect(payload.keyword.isWellFormed()).toBe(true);
    expect(payload.keyword.length).toBeLessThanOrEqual(LIMITS.snapshot.keyword);
    expect(payload.location).toBe('Austin \uFFFD Texas');
    expect(JSON.stringify(payload)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  it('builds the gap list, content editor and workspace payloads', async () => {
    const rows = buildGapRows(presence);
    const gaps = gapPayload(presence, rows);
    expect(gaps).toMatchObject({ source: 'Google results', subject: 'best dentist in austin' });
    expect(gaps.rows).toHaveLength(rows.length);
    expect(Object.keys(gaps.rows[0]!).sort()).toEqual(
      ['actionable', 'competitors', 'contacts', 'domain', 'evidence', 'pageType', 'position', 'scanned', 'surface', 'surfaceId', 'title', 'url'].sort(),
    );
    expect(gaps.rows.map((r) => r.surfaceId)).toEqual(rows.map((r) => r.surfaceId));
    for (const r of gaps.rows) {
      // The rules the contract states for a row.
      expect(r.position === null).toBe(r.pageType === 'surface');
      expect(r.domain === null).toBe(r.url === null);
      expect(r.competitors.length).toBeGreaterThan(0);
      if (!r.scanned) expect(r.contacts).toEqual([]);
    }

    const noise = await buildExampleNoiseReport();
    const content = contentEditorPayload({ targetKeyword: '  teeth  cleaning ', source: 'page', pageUrl: 'https://a.example/x', pageTitle: noise.title, capturedAt: Date.UTC(2026, 10, 20, 12), report: noise.report });
    expect(content).toMatchObject({
      targetKeyword: 'teeth cleaning',
      source: 'page',
      pageUrl: 'https://a.example/x',
      capturedAt: '2026-11-20T12:00:00.000Z',
      method: { engine: 'lexical', threshold: 0.5, pagesCompared: 5 },
    });
    expect(Object.keys(content)).toEqual(['targetKeyword', 'source', 'pageUrl', 'pageTitle', 'capturedAt', 'method', 'wordShare', 'onlyHere', 'missingPoints', 'comparedUrls']);
    // The relations the contract states.
    expect(content.comparedUrls).toHaveLength(content.method.pagesCompared);
    expect(content.wordShare.saidByMost + content.wordShare.saidBySome + content.wordShare.onlyHere).toBeCloseTo(1, 3);
    expect(content.onlyHere.length).toBeGreaterThan(0);
    expect(content.onlyHere).toEqual(noise.report.sentences.filter((s) => s.cls === 'only').map((s) => s.text));
    expect(content.missingPoints.length).toBeGreaterThan(0);
    for (const point of content.missingPoints) {
      expect(point.urls).toHaveLength(point.pages);
      expect(point.pages).toBeGreaterThanOrEqual(3);
      expect(point.urls.every((url) => content.comparedUrls.includes(url))).toBe(true);
    }
    // A page that loaded without usable text is not counted and not listed.
    const withEmptyPage = await classifySentences(
      noise.report.sentences.map((s) => ({ text: s.text, words: s.words })),
      [{ url: 'https://empty.example/', title: '', sentences: [] }, { url: 'https://b.example/', title: '', sentences: [{ text: 'Completely unrelated sentence about roofing materials today.', words: 7 }] }],
      new LexicalEngine(),
    );
    const single = contentEditorPayload({ targetKeyword: '', source: 'pasted', pageUrl: null, pageTitle: '', capturedAt: 0, report: withEmptyPage });
    expect(single).toMatchObject({ targetKeyword: '', source: 'pasted', pageUrl: null, pageTitle: '', method: { pagesCompared: 1 }, comparedUrls: ['https://b.example/'], missingPoints: [], wordShare: { saidByMost: 0, saidBySome: 0, onlyHere: 1 } });
    // Selected or pasted text is cleaned like page text before it leaves.
    const dirty = { ...withEmptyPage, sentences: [{ text: 'A line\u0000 with\u200B  control\tcharacters inside it.', words: 7, cls: 'only' as const, pages: 0, bestScore: 0, closest: null }] };
    expect(contentEditorPayload({ targetKeyword: 'k', source: 'selection', pageUrl: 'https://a.example/', pageTitle: 't', capturedAt: 0, report: dirty }).onlyHere).toEqual(['A line with control characters inside it.']);

    const facts = extractBusinessFacts([{ url: 'https://www.brightpathdental.example/', kind: 'home', doc: fixtureDoc('site/index.html') }]);
    const brief = composeBrief({ id: 'b', now: Date.UTC(2026, 10, 20), facts, issues: [], competitors: [{ name: 'Lakeside Smiles', domain: null, source: 'manual' }] });
    const workspace = workspacePayload(brief, briefToMarkdown(brief, { name: 'North Star SEO', logoDataUrl: null }));
    expect(workspace).toMatchObject({ businessName: 'BrightPath Dental', siteUrl: 'https://www.brightpathdental.example/', competitors: [{ name: 'Lakeside Smiles', domains: [] }] });
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

describe('API contract (docs/legiit-api/openapi.yaml)', () => {
  const contract = parseYaml(readFileSync(resolve(__dirname, '../../docs/legiit-api/openapi.yaml'), 'utf8')) as {
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
