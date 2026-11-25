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
import { applyBusinessDetails, applyConnectedUser, clearBusinessDetails, unselectBusiness } from '@/legiit/prefill';
import { LIMITS, MAX_REPLY_BYTES, MAX_REQUEST_BYTES, TIMEOUT_MS } from '@/legiit/limits';
import { ALL_CAPABILITIES, type GapListPayload, type WorkspaceFromBriefPayload } from '@/legiit/types';
import { hasLegiitAccess, requestLegiitAccess } from '@/net/permissions';
import { getPack } from '@/selectors';
import { LexicalEngine } from '@/similarity/engine';
import { parseSerp } from '@/serp/parse';
import { DEFAULT_SETTINGS, getLegiitToken, parseSettings } from '@/storage/settings';
import { buildExampleNoiseReport } from '../helpers/api-examples';
import type { ChromeMock } from '../helpers/chrome-mock';
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
    expect(calls[0]!.url).toBe('https://lens.legiit.com/v1/session');
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer demo-token');
    expect(new Headers(calls[0]!.init.headers).get('x-legiit-client')).toBe('legiit-lens/9.9.9');
  });

  it('sends each save as JSON to its endpoint and returns the saved id and link', async () => {
    const { client, state, calls } = httpClient();
    const saved = await client.saveVisibilitySnapshot('biz_brightpath', snapshotPayload(snapshot));
    expect(saved).toEqual({ id: 'vis_1', url: 'https://app.legiit.example/command-center/visibility/vis_1' });
    expect(calls[0]!.url).toBe('https://lens.legiit.com/v1/businesses/biz_brightpath/visibility-snapshots');
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
      baseUrl: 'https://lens.legiit.com',
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
    await expect(client.saveGapList('b', gapPayload(presence, buildGapRows(presence)))).rejects.toMatchObject({ code: 'rejected', message: 'Legiit could not find it (404)' });
    // The code "not_found" only means "business missing" where the path names a business. A framework that puts
    // that code on every 404 must not turn "this endpoint is not built" into an error message.
    for (const call of [() => client.getSession(), () => client.listBusinesses(), () => client.getIndustryPulse(), () => client.createWorkspaceFromBrief(workspaceExample()), () => client.completeAI({ task: 'rewind', system: 's', prompt: 'p', maxOutputTokens: 700 })]) {
      expect(isUnavailable(await call().catch((e: unknown) => e))).toBe(true);
    }
  });

  it('takes a 401 as a verdict on the token only when the API says so in its error body', async () => {
    const confirmed = await answering(() => errorBody(401, 'unauthorised', 'Token revoked')).client.getSession().catch((e: unknown) => e);
    expect(confirmed).toMatchObject({ code: 'unauthorised', status: 401, definite: true });
    for (const reply of [
      new Response('', { status: 401 }),
      new Response('<html>401 Authorization Required</html>', { status: 401 }),
      Response.json({ message: 'Unauthenticated.' }, { status: 401 }),
      // Other envelopes that use the key "error": a text, an empty object, a list, a gateway's numeric code.
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
      Response.json({ error: {} }, { status: 401 }),
      Response.json({ error: [] }, { status: 401 }),
      Response.json({ error: { code: 401, message: 'Jwt is missing', status: 'UNAUTHENTICATED' } }, { status: 401 }),
    ]) {
      const bare = await answering(() => reply).client.getSession().catch((e: unknown) => e);
      expect(bare).toMatchObject({ code: 'unauthorised', status: 401, definite: false });
    }
    // A gateway's bare 401 keeps the stored token and says so; the API's own 401 deletes it.
    await new TokenAuthProvider().store('valid-but-gateway-is-down');
    const kept = await loadConnection(answering(() => new Response('', { status: 401 })).client);
    expect(kept).toMatchObject({ status: 'disconnected', error: 'Legiit answered 401 without saying why, so your token was kept. Try again, or paste a new token.', tokenKept: true });
    expect(await getLegiitToken()).toBe('valid-but-gateway-is-down');
    const removed = await loadConnection(answering(() => errorBody(401, 'unauthorised', 'Token revoked')).client);
    expect(removed).toMatchObject({ status: 'disconnected', error: 'Your Legiit token was not accepted. Paste a new one to reconnect.' });
    expect(await getLegiitToken()).toBeNull();
    // A slow 401 for an old token says nothing about a newer token stored in the meantime: that one is checked instead.
    await new TokenAuthProvider().store('old');
    let asked = 0;
    const slow = answering(async () => {
      asked += 1;
      if (asked > 1) return Response.json({ user: { id: 'u-new' }, capabilities: [] });
      await new TokenAuthProvider().store('new');
      return errorBody(401, 'unauthorised', 'Token revoked');
    });
    expect(await loadConnection(slow.client)).toMatchObject({ status: 'connected', error: null });
    expect(asked).toBe(2);
    expect(await getLegiitToken()).toBe('new');
    // When the newer token is refused as well, it is that refusal which counts.
    await new TokenAuthProvider().store('old');
    const both = answering(async () => {
      await new TokenAuthProvider().store('new');
      return errorBody(401, 'unauthorised', 'Token revoked');
    });
    expect(await loadConnection(both.client)).toMatchObject({ status: 'disconnected', tokenKept: false, error: 'Your Legiit token was not accepted. Paste a new one to reconnect.' });
    expect(await getLegiitToken()).toBeNull();
    await disconnect();
  });

  it('refuses a reply that is too large to be real, and never follows a redirect', async () => {
    const huge = await answering(() => new Response('{}', { status: 200, headers: { 'content-length': String(MAX_REPLY_BYTES + 1) } })).client.getSession().catch((e: unknown) => e);
    expect(huge).toMatchObject({ code: 'invalid-response', message: 'Legiit sent a reply that is too large to read' });
    const long = await answering(() => new Response(`{"user":{"id":"u"},"pad":"${'x'.repeat(MAX_REPLY_BYTES)}"}`)).client.getSession().catch((e: unknown) => e);
    expect(long).toMatchObject({ code: 'invalid-response', message: 'Legiit sent a reply that is too large to read' });

    for (const status of [301, 302, 303, 307, 308]) {
      const fetchSpy = vi.fn(async () => new Response(null, { status, headers: { location: 'https://lens.legiit.com/v1/session/' } }));
      vi.stubGlobal('fetch', fetchSpy);
      try {
        await new TokenAuthProvider().store('demo-token');
        expect(await loadConnection()).toMatchObject({ status: 'disconnected', error: 'Could not reach Legiit: The Legiit API answered with a redirect instead of a reply' });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0]).toMatchObject(['https://lens.legiit.com/v1/session', { redirect: 'manual', credentials: 'omit' }]);
        expect(await getLegiitToken()).toBe('demo-token');
      } finally {
        vi.unstubAllGlobals();
        await disconnect();
      }
    }
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
    const make = (fetch: () => Promise<Response>) => new HttpLegiitClient({ baseUrl: 'https://lens.legiit.com', auth: new StaticAuthProvider('t'), fetch });
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

  it('does not take an error reply that stops half-way for a verdict of the server', async () => {
    const competitor = { name: 'n', domains: [] };
    // The headers arrive, the body never finishes: that is the time limit, whatever the status says.
    const stalled = (status: number) => (_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":'));
          init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
        },
      });
      return new Response(body, { status });
    };
    for (const status of [401, 404, 422]) {
      const error = await answering(stalled(status), { timeoutMs: 20 }).client.addCompetitor('b', competitor).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'network', message: 'Legiit did not answer in time' });
      // Not "this endpoint does not exist": the save action must not be hidden for it.
      expect(isUnavailable(error)).toBe(false);
    }
    // The connection drops in the middle of the body.
    const dropped = (status: number) => () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":'));
            controller.error(new TypeError('network error'));
          },
        }),
        { status },
      );
    for (const status of [401, 404, 422]) {
      const error = await answering(dropped(status)).client.addCompetitor('b', competitor).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'network' });
      expect((error as LegiitError).message).toMatch(/^Could not reach Legiit: /);
    }
    // A complete reply in another shape is still read by its status.
    expect(isUnavailable(await answering(() => new Response('<h1>Not Found</h1>', { status: 404 })).client.addCompetitor('b', competitor).catch((e: unknown) => e))).toBe(true);
  });

  it('shows a link only for an address that can be opened', async () => {
    const saved = (url: unknown) => answering(() => Response.json({ id: 'x', url }, { status: 201 })).client.addCompetitor('b', { name: 'n', domains: [] });
    expect(await saved('https://app.legiit.com/command-center/x/1')).toEqual({ id: 'x', url: 'https://app.legiit.com/command-center/x/1' });
    expect((await saved('http://localhost:8000/x/1')).url).toBe('http://localhost:8000/x/1');
    // The save counts, the link does not: a relative path, no scheme, another scheme, a broken host, too long.
    for (const url of ['/command-center/x/1', 'app.legiit.com/x/1', 'javascript:alert(1)', 'ftp://legiit.com/x', 'https://a b.example/x', `https://app.legiit.com/${'x'.repeat(2048)}`, '', 7, {}, null, undefined]) {
      expect(await saved(url), JSON.stringify(url)).toEqual({ id: 'x', url: null });
    }
  });

  it('measures a reply without a Content-Length in bytes as well', async () => {
    // 2 million three-byte characters are 6 MB: more than the limit, although fewer than 5 million characters.
    const streamed = (text: string) => () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        }),
        { status: 200 },
      );
    const big = JSON.stringify({ user: { id: 'u', name: '漢'.repeat(2_000_000) }, capabilities: [] });
    expect(streamed(big)().headers.get('content-length')).toBeNull();
    await expect(answering(streamed(big)).client.getSession()).rejects.toMatchObject({ code: 'invalid-response', message: 'Legiit sent a reply that is too large to read' });
    // Just as many characters in one-byte text are 2 MB and are read.
    const small = JSON.stringify({ user: { id: 'u', name: 'x'.repeat(2_000_000) }, capabilities: [] });
    expect((await answering(streamed(small)).client.getSession()).user.id).toBe('u');
  });

  it('never puts an id into a path that it could not be part of', async () => {
    const loneSurrogate = String.fromCharCode(0xd800);
    const { client, calls } = answering((url) => {
      const path = new URL(url).pathname;
      if (path === '/v1/businesses') return Response.json({ businesses: [{ id: '..', name: 'Up' }, { id: '.', name: 'Here' }, { id: loneSurrogate, name: 'Broken' }, { id: ' ', name: 'Blank' }, { id: 'ok/1', name: 'Fine' }] });
      return Response.json({ id: '..' }, { status: 201 });
    });
    // Such a row is skipped like any other row that cannot be read.
    expect(await client.listBusinesses()).toEqual([{ id: 'ok/1', name: 'Fine', domain: null }]);
    // An id with a slash is one path segment.
    await client.addCompetitor('ok/1', { name: 'n', domains: [] }).catch(() => undefined);
    expect(new URL(calls.at(-1)!.url).pathname).toBe('/v1/businesses/ok%2F1/competitors');
    // A saved item whose id is unusable is not reported as saved.
    await expect(client.addCompetitor('ok', { name: 'n', domains: [] })).rejects.toMatchObject({ code: 'invalid-response' });
    // A stored id of that kind is never sent, and the failure is a rejected promise like every other.
    const before = calls.length;
    for (const bad of ['..', '.', '', loneSurrogate]) {
      await expect(client.getBusinessDetails(bad)).rejects.toMatchObject({ code: 'rejected' });
      await expect(client.saveGapList(bad, {} as GapListPayload)).rejects.toMatchObject({ code: 'rejected' });
      await expect(client.addCompetitor(bad, { name: 'n', domains: [] })).rejects.toMatchObject({ code: 'rejected' });
    }
    expect(calls).toHaveLength(before);
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
    await expect(answering(() => Response.json({ user: { id: 'u' }, capabilities: 'all' })).client.getSession()).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('skips a row it cannot read instead of losing the whole reply', async () => {
    const { client } = answering((url) => {
      const path = new URL(url).pathname;
      if (path === '/v1/session') return Response.json({ user: { id: 'u', name: 365, email: { nested: true } }, plan: { name: 'agency' }, capabilities: ['ai'] });
      if (path === '/v1/businesses') {
        return Response.json({
          businesses: [{ id: 1, name: null }, { name: 'No id at all' }, 'not an object', null, { id: '', name: 'Empty id' }, { id: 2, name: 2024, domain: 7 }, { id: 9007199254740993, name: 'Id too large for a number' }],
        });
      }
      if (path === '/v1/businesses/1') {
        return Response.json({
          id: 'another-form-of-the-id',
          name: null,
          brandNames: ['Acme', null, 42, { no: 1 }],
          domains: 'acme.example',
          competitors: [{ name: null, domains: ['rival.example', null] }, 'junk', { name: 'Named Only' }, { domains: 'solo.example' }],
          focusKeywords: true,
          avatars: [{ name: 'A', description: 5 }, { description: 'no name' }],
        });
      }
      return Response.json({
        updatedAt: 1763640000,
        events: [
          { date: 'March 5', title: 'Not a date' },
          { date: '2026-13-45', title: 'Not a real day' },
          { date: '2026-03-05', title: 'Good', type: 9, url: ['x'] },
          { title: 'No date' },
          null,
          { date: '2026-01-02T23:00:00-05:00', title: 404 },
        ],
      });
    });
    expect(await client.getSession()).toEqual({ user: { id: 'u', name: '365', email: null }, plan: null, capabilities: ['ai'] });
    expect(await client.listBusinesses()).toEqual([
      { id: '1', name: '', domain: null },
      { id: '2', name: '2024', domain: '7' },
    ]);
    const details = await client.getBusinessDetails('1');
    expect(details).toEqual({
      id: 'another-form-of-the-id',
      name: '',
      brandNames: ['Acme', '42'],
      domains: ['acme.example'],
      competitors: [
        { name: '', domains: ['rival.example'] },
        { name: 'Named Only', domains: [] },
        { name: '', domains: ['solo.example'] },
      ],
      focusKeywords: [],
      avatars: [{ name: 'A', description: '5' }],
    });
    expect(await client.getIndustryPulse()).toEqual({
      updatedAt: '1763640000',
      events: [
        { date: '2026-03-05', title: 'Good', type: '9', url: null },
        { date: '2026-01-02', title: '404', type: 'news', url: null },
      ],
    });
    // Whatever was read can be stored: a competitor without a name is tracked under its domain, and a business
    // with a name but nothing else still becomes the user's own brand.
    const stored = applyBusinessDetails(DEFAULT_SETTINGS, { ...details, id: '1' });
    expect(parseSettings(stored)).toEqual(stored);
    expect(stored.myBrands.map((b) => [b.name, b.domains])).toEqual([['Acme', ['acme.example']]]);
    expect(stored.competitors.map((b) => [b.name, b.domains])).toEqual([
      ['rival.example', ['rival.example']],
      ['Named Only', []],
      ['solo.example', ['solo.example']],
    ]);
    expect(stored.legiit.businessId).toBe('1');
    // A business with nothing to look for adds no brand of the user's own.
    const empty = applyBusinessDetails(DEFAULT_SETTINGS, { id: '3', name: '', brandNames: [], domains: [], competitors: [], focusKeywords: [], avatars: [] });
    expect(empty.myBrands).toEqual([]);
    expect(empty.legiit.businessId).toBe('3');
    // A fallback name taken from a very long domain is cut to what the settings can hold.
    const longDomain = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example`;
    const long = applyBusinessDetails(DEFAULT_SETTINGS, { id: '4', name: '', brandNames: [], domains: [longDomain], competitors: [{ name: '', domains: [longDomain] }], focusKeywords: [], avatars: [] });
    expect(parseSettings(long)).toEqual(long);
    expect(long.myBrands[0]!.name).toHaveLength(160);
    expect(long.myBrands[0]!.domains).toEqual([longDomain]);

    // What a reply cannot do without is still required.
    for (const body of [{}, { businesses: null }, { businesses: 'none' }, [{ id: 1, name: 'bare array' }], { data: { businesses: [] } }]) {
      await expect(answering(() => Response.json(body)).client.listBusinesses()).rejects.toMatchObject({ code: 'invalid-response' });
    }
    for (const body of [{}, { events: null }, [{ date: '2026-03-05', title: 'bare array' }]]) {
      await expect(answering(() => Response.json(body)).client.getIndustryPulse()).rejects.toMatchObject({ code: 'invalid-response' });
    }
    for (const body of [{}, { text: null }, { text: ['a'] }, { data: { text: 'wrapped' } }]) {
      await expect(answering(() => Response.json(body)).client.completeAI({ task: 'rewind', system: 's', prompt: 'p', maxOutputTokens: 700 })).rejects.toMatchObject({ code: 'invalid-response' });
    }
    for (const body of [{ data: { id: 1 } }, { id: null }, { id: 1.5 }, { id: 9007199254740993 }, { id: '   ' }]) {
      await expect(answering(() => Response.json(body, { status: 201 })).client.addCompetitor('b', { name: 'n', domains: [] })).rejects.toMatchObject({ code: 'invalid-response' });
    }
    // Business details must look like a business: anything else would wipe the brands that were pre-filled before.
    for (const body of [{}, { data: { name: 'Wrapped' } }, { error: { code: 'x', message: 'sent with 200' } }, { brand_names: ['snake_case only'] }, [], 'text', null]) {
      await expect(answering(() => Response.json(body)).client.getBusinessDetails('1')).rejects.toMatchObject({ code: 'invalid-response' });
    }
    expect(await answering(() => Response.json({ domains: ['only-domains.example'] })).client.getBusinessDetails('1')).toMatchObject({ name: '', domains: ['only-domains.example'] });
  });

  it('understands the forms that JSON encoders and model APIs commonly produce', async () => {
    const { client } = answering((url) => {
      const path = new URL(url).pathname;
      // A filtered PHP array is encoded as an object with numeric keys.
      if (path === '/v1/session') return Response.json({ user: { id: 'u' }, capabilities: { 0: 'businesses', 2: 'ai' } });
      if (path === '/v1/businesses') return Response.json({ businesses: { 1: { id: 1, name: 'One' }, 3: { id: 3, name: 'Three' } } });
      if (path === '/v1/businesses/1') return Response.json({ name: 'One', domains: { 0: 'one.example', 4: 'uno.example' }, competitors: { 2: { name: 'Rival', domains: { 1: 'rival.example' } } } });
      if (path === '/v1/industry-pulse') return Response.json({ events: { 7: { date: '2026-02-30', title: 'Day that does not exist' }, 9: { date: '2026-02-28', title: 'Real day' } } });
      // The model's structured output placed in "text" as an object instead of a string.
      if (path === '/v1/ai/completions') return Response.json({ text: { avatars: [], nextSteps: ['One'] } });
      return Response.json({ id: 5, url: `https://app.legiit.example/${'x'.repeat(3000)}` }, { status: 201 });
    });
    expect((await client.getSession()).capabilities).toEqual(['businesses', 'ai']);
    expect(await client.listBusinesses()).toEqual([{ id: '1', name: 'One', domain: null }, { id: '3', name: 'Three', domain: null }]);
    expect(await client.getBusinessDetails('1')).toMatchObject({ domains: ['one.example', 'uno.example'], competitors: [{ name: 'Rival', domains: ['rival.example'] }] });
    expect((await client.getIndustryPulse()).events).toEqual([{ date: '2026-02-28', title: 'Real day', type: 'news', url: null }]);
    expect((await client.completeAI({ task: 'brief', system: 's', prompt: 'p', responseSchema: { type: 'object' }, maxOutputTokens: 2000 })).text).toBe('{"avatars":[],"nextSteps":["One"]}');
    // Without a schema the reply is plain text: an object is not text.
    await expect(client.completeAI({ task: 'rewind', system: 's', prompt: 'p', maxOutputTokens: 700 })).rejects.toMatchObject({ code: 'invalid-response' });
    // A link that is too long to be whole is not shown at all.
    expect(await client.addCompetitor('1', { name: 'n', domains: [] })).toEqual({ id: '5', url: null });
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
    expect(get).toEqual({ url: 'https://lens.legiit.com/v1/session', method: 'GET', cache: 'no-store', headers: { accept: 'application/json', authorization: 'Bearer t', 'x-legiit-client': 'legiit-lens/1.2.3' } });
    expect(save).toMatchObject({ url: 'https://lens.legiit.com/v1/businesses/biz%201%2F%C3%BC/gap-lists', method: 'POST', cache: 'no-store' });
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
    expect(next.legiit).toEqual({ userId: null, businessId: 'biz_brightpath', businessName: 'BrightPath Dental', focusKeywords: ['best dentist in austin'], avatars: [{ name: 'Busy parent', description: 'd' }] });
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

  it('forgets the chosen business when another Legiit user connects', () => {
    const first = applyConnectedUser(DEFAULT_SETTINGS, 'user-1');
    expect(first.legiit.userId).toBe('user-1');
    const chosen = applyBusinessDetails(first, details);
    expect(chosen.legiit).toMatchObject({ userId: 'user-1', businessId: 'biz_brightpath' });
    // The same user again (a new token, a reconnect): nothing is lost.
    const again = applyConnectedUser(chosen, 'user-1');
    expect(again).toEqual(chosen);
    // Another user: the business and what was pre-filled from it belong to the other account.
    const typed = { id: 'm', name: 'Typed By Hand', domains: [], aliases: [], source: 'manual' as const };
    const other = applyConnectedUser({ ...chosen, competitors: [...chosen.competitors, typed] }, 'user-2');
    expect(other.legiit).toEqual({ userId: 'user-2', businessId: null, businessName: null, focusKeywords: [], avatars: [] });
    expect(other.myBrands).toEqual([]);
    expect(other.competitors).toEqual([typed]);
    expect(parseSettings(other)).toEqual(other);
    // Disconnecting forgets the user as well.
    expect(clearBusinessDetails(chosen).legiit.userId).toBeNull();
    // Unselecting the business ("Choose a business…") does not: the same user is still connected.
    const unselected = unselectBusiness(chosen);
    expect(unselected.legiit).toEqual({ userId: 'user-1', businessId: null, businessName: null, focusKeywords: [], avatars: [] });
    expect(unselected.myBrands).toEqual([]);
    // So choosing again, and then connecting as another user, still clears the business.
    const chosenAgain = applyBusinessDetails(unselected, details);
    expect(applyConnectedUser(chosenAgain, 'user-2').legiit).toMatchObject({ userId: 'user-2', businessId: null });
    // A business whose user was never recorded is treated as another user's.
    const unknownOwner = { ...chosen, legiit: { ...chosen.legiit, userId: null } };
    expect(applyConnectedUser(unknownOwner, 'user-1').legiit).toMatchObject({ userId: 'user-1', businessId: null });
    expect(applyConnectedUser(DEFAULT_SETTINGS, 'user-1').legiit).toMatchObject({ userId: 'user-1', businessId: null });
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

  it('does not send something that cannot be a token, and keeps a working token when a new one fails', async () => {
    const client = new MockLegiitClient();
    for (const pasted of ['two words', 'line\nbreak', 'tab\there', 'emoji-😀', 'ünïcode', 'x'.repeat(4097)]) {
      await expect(connect(pasted, client)).rejects.toMatchObject({ code: 'unauthorised', message: expect.stringContaining('does not look like a Legiit token') });
    }
    expect(client.calls).toHaveLength(0);
    expect(await getLegiitToken()).toBeNull();
    expect((await connect(`  ${'x'.repeat(4096)}  `, client)).status).toBe('connected');

    // Pasting a second token that Legiit refuses leaves the first one in place.
    await connect('good-token', client);
    await expect(connect('typo-token', new MockLegiitClient({ unauthorised: true }))).rejects.toMatchObject({ code: 'unauthorised' });
    expect(await getLegiitToken()).toBe('good-token');
    // So does a server that cannot be reached at that moment.
    class Down extends MockLegiitClient {
      override async getSession(): Promise<never> {
        throw new LegiitError('server', 'Legiit had a problem (503)', 503);
      }
    }
    await expect(connect('another-token', new Down())).rejects.toMatchObject({ code: 'server' });
    expect(await getLegiitToken()).toBe('good-token');
    await disconnect();
  });

  it('stores a token only after Legiit accepted it, and never deletes the stored one for a failure that is no verdict', async () => {
    // Nothing is on the device while the check is under way, so no other extension page sees an unconfirmed token.
    const during: (string | null)[] = [];
    const state = createMockState();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      during.push(await getLegiitToken());
      return mockLegiitFetch(state)(url, init);
    }));
    try {
      await expect(connect('not-a-real-token')).rejects.toMatchObject({ code: 'unauthorised' });
      expect(await getLegiitToken()).toBeNull();
      expect((await connect('demo-token')).status).toBe('connected');
      expect(during).toEqual([null, null]);
      expect(await getLegiitToken()).toBe('demo-token');
    } finally {
      vi.unstubAllGlobals();
    }
    // The user pastes the token that is already stored while Legiit is failing: it stays.
    class Failing extends MockLegiitClient {
      constructor(private readonly failure: LegiitError) {
        super();
      }
      override async getSession(): Promise<never> {
        throw this.failure;
      }
    }
    for (const failure of [
      new LegiitError('server', 'Legiit had a problem (503)', 503),
      new LegiitError('network', 'Legiit did not answer in time'),
      new LegiitError('rejected', 'Legiit rejected the request (403): Your account is suspended', 403),
      new LegiitError('unauthorised', 'Legiit did not accept the token', 401, false),
    ]) {
      await expect(connect('demo-token', new Failing(failure))).rejects.toBe(failure);
      expect(await getLegiitToken(), failure.message).toBe('demo-token');
    }
    // Legiit's own refusal of that very token deletes it, as at any other session check.
    await expect(connect('demo-token', new Failing(new LegiitError('unauthorised', 'Legiit did not accept the token', 401, true)))).rejects.toMatchObject({ code: 'unauthorised' });
    expect(await getLegiitToken()).toBeNull();
  });

  it('says so when Chrome is not letting the extension reach Legiit, and can ask for the access back', async () => {
    const chromeMock = (globalThis as unknown as { __chromeMock: ChromeMock }).__chromeMock;
    class Unreachable extends MockLegiitClient {
      override async getSession(): Promise<never> {
        throw new LegiitError('network', 'Could not reach Legiit: Failed to fetch');
      }
    }
    await new TokenAuthProvider().store('demo-token');
    // Normal case: the host is granted, so a network failure is reported as it is.
    expect(await hasLegiitAccess()).toBe(true);
    expect(await loadConnection(new Unreachable())).toMatchObject({ status: 'disconnected', tokenKept: true, error: 'Could not reach Legiit: Failed to fetch' });
    // The user switched the Legiit host off under the extension's site access in Chrome.
    chromeMock.withheld.add('https://lens.legiit.com/*');
    expect(await hasLegiitAccess()).toBe(false);
    expect(await loadConnection(new Unreachable())).toMatchObject({ status: 'disconnected', tokenKept: true, error: 'Chrome is not letting Legiit Lens reach lens.legiit.com. Click “Try again” to allow it.' });
    expect(await getLegiitToken()).toBe('demo-token');
    // At Connect the same reason is given, not just "failed to fetch".
    await expect(connect('another-token', new Unreachable())).rejects.toMatchObject({ code: 'network', message: 'Chrome is not letting Legiit Lens reach lens.legiit.com. Click Connect again and allow it.' });
    expect(await getLegiitToken()).toBe('demo-token');
    // A click asks Chrome for exactly that host, and nothing is asked when it is already there.
    chromeMock.requestAnswer = false;
    expect(await requestLegiitAccess()).toBe(false);
    chromeMock.requestAnswer = true;
    expect(await requestLegiitAccess()).toBe(true);
    expect(await requestLegiitAccess()).toBe(true);
    expect(chromeMock.requested).toEqual([['https://lens.legiit.com/*'], ['https://lens.legiit.com/*']]);
    expect(await hasLegiitAccess()).toBe(true);
    await disconnect();
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
      expect(fetchSpy.mock.calls[0]![0]).toBe('https://lens.legiit.com/v1/session');
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
    components: { schemas: Record<string, { 'x-values'?: string[] }> };
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
    expect(contract.components.schemas['Capability']?.['x-values']).toEqual([...ALL_CAPABILITIES]);
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
