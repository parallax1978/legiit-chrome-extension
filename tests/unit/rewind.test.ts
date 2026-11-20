import { describe, expect, it, vi } from 'vitest';
import { parseHtml } from '@/extract/html';
import { extractPageFacts, type PageFacts } from '@/extract/page-facts';
import { cdxUrl, parseCdx, parseTimestamp, rawCaptureUrl, sampleCaptures, viewCaptureUrl, type Capture } from '@/features/rewind/cdx';
import { buildTimeline, changesBefore, diffFacts, explainTimeline, wordDiff, type CaptureFacts } from '@/features/rewind/diff';
import {
  Backoff,
  captureKey,
  fetchWithBackoff,
  loadCaptureFacts,
  loadCaptureIndex,
  MAX_CONCURRENT,
  toCaptureFacts,
  WaybackError,
  type RewindCache,
  type RewindDeps,
} from '@/features/rewind/load';
import { fixtureJson, fixtureText, scenario } from '../helpers/fixtures';

const PAGE = scenario.urls.rewindPage!;
const cdxJson = fixtureJson('wayback/cdx-teeth-whitening.json');
const captures = parseCdx(cdxJson);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

/** Serves the Wayback fixtures for the real URLs the feature requests. */
function waybackFetch(extra: (url: string) => Response | undefined = () => undefined) {
  return vi.fn(async (url: string): Promise<Response> => {
    const override = extra(url);
    if (override) return override;
    const u = new URL(url);
    if (u.pathname === '/cdx/search/cdx') {
      const target = u.searchParams.get('url');
      if (target === PAGE) return json(cdxJson);
      if (target === scenario.urls.noCapturesPage) return json(fixtureText('wayback/cdx-empty.json'));
      return json([]);
    }
    const m = /^\/web\/(\d{14})id_\/(.+)$/.exec(u.pathname + u.search);
    if (m) {
      try {
        return new Response(fixtureText(`wayback/captures/${m[1]}.html`), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      } catch {
        return json('not found', 404);
      }
    }
    return json('not found', 404);
  });
}

function memoryCache(): RewindCache & { cdx: Map<string, unknown>; facts: Map<string, PageFacts> } {
  const cdx = new Map<string, { fetchedAt: number; captures: Capture[] }>();
  const facts = new Map<string, PageFacts>();
  return {
    cdx,
    facts,
    getCdx: async (url) => cdx.get(url),
    putCdx: async (url, list, fetchedAt) => void cdx.set(url, { fetchedAt, captures: list }),
    getCapture: async (key) => facts.get(key),
    putCapture: async (key, _url, _ts, f) => void facts.set(key, f),
  };
}

function factsOf(timestamp: string): PageFacts {
  return extractPageFacts(parseHtml(fixtureText(`wayback/captures/${timestamp}.html`)), PAGE);
}

const allFacts: CaptureFacts[] = captures.map((capture) => ({ capture, facts: factsOf(capture.timestamp) }));

describe('CDX index', () => {
  it('builds the documented query', () => {
    const url = new URL(cdxUrl(PAGE));
    expect(url.origin + url.pathname).toBe('https://web.archive.org/cdx/search/cdx');
    expect(url.searchParams.get('url')).toBe(PAGE);
    expect(url.searchParams.get('output')).toBe('json');
    expect(url.searchParams.get('collapse')).toBe('digest');
    expect(url.searchParams.getAll('filter')).toContain('statuscode:200');
  });

  it('builds unmodified (id_) and viewable capture URLs', () => {
    const capture = { timestamp: '20230310101112', original: PAGE };
    expect(rawCaptureUrl(capture)).toBe(`https://web.archive.org/web/20230310101112id_/${PAGE}`);
    expect(viewCaptureUrl(capture)).toBe(`https://web.archive.org/web/20230310101112/${PAGE}`);
  });

  it('parses rows oldest first with UTC times', () => {
    expect(captures).toHaveLength(8);
    expect(captures[0]).toMatchObject({ timestamp: '20230310101112', original: PAGE, time: Date.UTC(2023, 2, 10, 10, 11, 12) });
    expect(captures.map((c) => c.time)).toEqual([...captures.map((c) => c.time)].sort((a, b) => a - b));
    expect(captures[0]?.length).toBe(9000);
    expect(parseTimestamp('20260621110000')).toBe(Date.UTC(2026, 5, 21, 11, 0, 0));
    expect(parseTimestamp('nope')).toBeNull();
  });

  it('tolerates empty, malformed and hostile responses', () => {
    expect(parseCdx([])).toEqual([]);
    expect(parseCdx(null)).toEqual([]);
    expect(parseCdx({ error: 'x' })).toEqual([]);
    expect(parseCdx([['timestamp', 'original']])).toEqual([]);
    expect(parseCdx([['foo', 'bar'], ['1', '2']])).toEqual([]);
    const messy = parseCdx([
      ['timestamp', 'original', 'statuscode', 'digest', 'length'],
      ['20240101000000', 'https://a.example/', '200', 'D1', '10'],
      ['20240101000000', 'https://a.example/', '200', 'D1', '10'], // duplicate timestamp
      ['2024', 'https://a.example/', '200', 'D2', '10'], // short timestamp
      ['20240201000000', 'javascript:alert(1)', '200', 'D3', '10'],
      ['20240301000000', 'https://a.example/', '301', 'D4', '10'],
      'not a row',
      ['20230101000000', 'https://a.example/', '200', 'D5', 'n/a'],
    ]);
    expect(messy.map((c) => c.timestamp)).toEqual(['20230101000000', '20240101000000']);
    expect(messy[0]?.length).toBeNull();
  });

  it('samples at most 24 captures, evenly, keeping the first and last', () => {
    const large = parseCdx(fixtureJson('wayback/cdx-large.json'));
    expect(large).toHaveLength(60);
    const sample = sampleCaptures(large);
    expect(sample).toHaveLength(24);
    expect(sample[0]).toBe(large[0]);
    expect(sample[23]).toBe(large[59]);
    const gaps = sample.slice(1).map((c, i) => large.indexOf(c) - large.indexOf(sample[i]!));
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    expect(sampleCaptures(captures)).toHaveLength(8);
    expect(sampleCaptures(large, 1)).toEqual([large[59]]);
    expect(sampleCaptures(large, 0)).toEqual([]);
  });
});

describe('loading from the Wayback Machine', () => {
  it('loads and caches the capture index', async () => {
    const fetch = waybackFetch();
    const cache = memoryCache();
    const deps: RewindDeps = { fetch, cache, now: () => 1_000 };
    const first = await loadCaptureIndex(PAGE, deps);
    expect(first).toMatchObject({ fromCache: false });
    expect(first.captures).toHaveLength(8);
    const second = await loadCaptureIndex(PAGE, deps);
    expect(second.fromCache).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    await loadCaptureIndex(PAGE, deps, { forceRefresh: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    await loadCaptureIndex(PAGE, { fetch, cache, now: () => 1_000 + 7 * 60 * 60 * 1000 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('returns an empty list when the archive has no captures', async () => {
    const result = await loadCaptureIndex(scenario.urls.noCapturesPage!, { fetch: waybackFetch() });
    expect(result.captures).toEqual([]);
    expect(explainTimeline([], 0)).toEqual(['The Wayback Machine has no captures of this page.']);
  });

  it('raises a readable error on a server failure or unreadable body', async () => {
    await expect(loadCaptureIndex(PAGE, { fetch: async () => json('oops', 500) })).rejects.toMatchObject({ name: 'WaybackError', status: 500 });
    await expect(loadCaptureIndex(PAGE, { fetch: async () => json('<html>not json') })).rejects.toBeInstanceOf(WaybackError);
  });

  it('reads captures at most two at a time and reports progress', async () => {
    let running = 0;
    let peak = 0;
    const base = waybackFetch();
    const fetch = vi.fn(async (url: string) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return base(url);
    });
    const progress = vi.fn();
    const results = await loadCaptureFacts(captures, { fetch }, { onProgress: progress });
    expect(peak).toBe(MAX_CONCURRENT);
    expect(MAX_CONCURRENT).toBe(2);
    expect(results.every((r) => r.facts !== null)).toBe(true);
    expect(results.map((r) => r.capture.timestamp)).toEqual(captures.map((c) => c.timestamp));
    expect(progress).toHaveBeenCalledTimes(8);
    expect(progress.mock.calls[7]).toEqual([8, 8]);
    expect(fetch.mock.calls.every(([url]) => /\/web\/\d{14}id_\//.test(url))).toBe(true);
  });

  it('caches extracted facts so a second run makes no requests', async () => {
    const fetch = waybackFetch();
    const cache = memoryCache();
    await loadCaptureFacts(captures, { fetch, cache });
    expect(cache.facts.size).toBe(8);
    expect(cache.facts.has(captureKey(captures[0]!))).toBe(true);
    const again = await loadCaptureFacts(captures, { fetch, cache });
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(again.every((r) => r.fromCache)).toBe(true);
  });

  it('backs off on 429 using Retry-After, then succeeds', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    let clock = 0;
    const deps: RewindDeps = {
      fetch: waybackFetch(() => (++calls <= 2 ? json('slow down', 429, { 'retry-after': '7' }) : undefined)),
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      random: () => 0.5,
    };
    const result = await loadCaptureIndex(PAGE, deps);
    expect(result.captures).toHaveLength(8);
    expect(sleeps).toEqual([7000, 7000]);
    expect(calls).toBe(3);
  });

  it('backs off exponentially when the server gives no Retry-After, and gives up after the retry limit', async () => {
    const sleeps: number[] = [];
    let clock = 0;
    const deps: RewindDeps = {
      fetch: vi.fn(async () => json('busy', 503)),
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      random: () => 0.5,
    };
    const backoff = new Backoff(deps.now!, deps.sleep!, deps.random!);
    await expect(fetchWithBackoff('https://web.archive.org/x', deps, backoff)).rejects.toMatchObject({ name: 'WaybackError', status: 503 });
    expect(sleeps).toEqual([2000, 4000, 8000, 16000]);
    expect(deps.fetch).toHaveBeenCalledTimes(5);
    expect(backoff.delayFor(10, null)).toBe(60_000);
    expect(backoff.delayFor(0, '120')).toBe(60_000);
  });

  it('makes every worker wait when one of them is rate-limited', async () => {
    let clock = 0;
    const waits: number[] = [];
    const backoff = new Backoff(() => clock, async (ms) => void waits.push(ms), () => 0.5);
    backoff.pause(5000);
    await backoff.wait();
    await backoff.wait();
    expect(waits).toEqual([5000, 5000]);
    clock = 6000;
    await backoff.wait();
    expect(waits).toHaveLength(2);
  });

  it('reports a capture that cannot be read without failing the rest', async () => {
    const results = await loadCaptureFacts(captures.slice(0, 3), {
      fetch: waybackFetch((url) => (url.includes('20230902083000') ? json('gone', 404) : undefined)),
    });
    expect(results.map((r) => r.error)).toEqual([null, 'Capture not available (404)', null]);
    expect(toCaptureFacts(results)).toHaveLength(2);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(loadCaptureFacts(captures, { fetch }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('differ', () => {
  const at = (timestamp: string) => allFacts.find((c) => c.capture.timestamp === timestamp)!.facts;

  it('reports text, list and number changes between two captures', () => {
    const changes = diffFacts(at('20230310101112'), at('20230902083000'));
    expect(changes.map((c) => c.field)).toEqual(['metaDescription', 'h2', 'wordCount']);
    expect(changes[0]).toMatchObject({ kind: 'text', significant: true });
    expect(changes[1]).toMatchObject({ kind: 'list', added: ['Before and after'], removed: [] });
    expect(changes[1]!.summary).toBe('H2: added “Before and after”');
    const words = changes[2]!;
    expect(words.kind === 'number' && words.delta > 80 && words.significant).toBe(true);
  });

  it('flags a canonical change and a noindex', () => {
    const changes = diffFacts(at('20240805070000'), at('20250120120000'));
    expect(changes.map((c) => c.field)).toEqual(['canonical', 'metaRobots']);
    expect(changes[0]!.summary).toBe(
      'Canonical changed from “https://www.brightpathdental.example/services/teeth-whitening” to “https://www.brightpathdental.example/”',
    );
    expect(changes[1]!.summary).toBe('Meta robots added: “noindex, follow”');
  });

  it('reports removed sections, schema types and link counts', () => {
    const removed = diffFacts(at('20240218141500'), at('20240805070000'));
    expect(removed.find((c) => c.field === 'h2')).toMatchObject({ removed: ['FAQ'], added: [] });
    expect(removed.find((c) => c.field === 'jsonLdTypes')).toMatchObject({ removed: ['FAQPage'] });
    const cut = removed.find((c) => c.field === 'wordCount')!;
    expect(cut.kind === 'number' && cut.delta < -200).toBe(true);
    const links = diffFacts(at('20230902083000'), at('20240218141500')).find((c) => c.field === 'internalLinks')!;
    expect(links).toMatchObject({ kind: 'number', delta: 5, significant: true });
    const hreflang = diffFacts(at('20250120120000'), at('20250315090000')).find((c) => c.field === 'hreflangCount')!;
    expect(hreflang).toMatchObject({ before: 0, after: 2, significant: true });
  });

  it('reports nothing for identical facts and treats small counting changes as minor', () => {
    expect(diffFacts(at('20230310101112'), at('20230310101112'))).toEqual([]);
    const base = at('20230310101112');
    const minor = diffFacts(base, { ...base, wordCount: base.wordCount + 4, externalLinks: base.externalLinks + 1 });
    expect(minor.map((c) => [c.field, c.significant])).toEqual([
      ['wordCount', false],
      ['externalLinks', false],
    ]);
  });

  it('handles repeated list items correctly', () => {
    const base = at('20230310101112');
    const changes = diffFacts({ ...base, h2: ['A', 'A', 'B'] }, { ...base, h2: ['A', 'B', 'B'] });
    expect(changes[0]).toMatchObject({ added: ['B'], removed: ['A'] });
  });

  it('builds a dated timeline between consecutive distinct captures', () => {
    const timeline = buildTimeline(allFacts);
    expect(timeline).toHaveLength(7);
    expect(timeline.map((e) => e.to.capture.timestamp.slice(0, 8))).toEqual([
      '20230902', '20240218', '20240805', '20250120', '20250315', '20251102', '20260621',
    ]);
    expect(timeline[1]!.changes.map((c) => c.field)).toEqual(['title', 'internalLinks']);
    for (const entry of timeline) expect(entry.from.capture.time).toBeLessThan(entry.to.capture.time);
  });

  it('skips captures whose facts did not change and accepts unordered input', () => {
    const duplicate: CaptureFacts = { capture: { ...captures[1]!, timestamp: '20231001000000', time: Date.UTC(2023, 9, 1) }, facts: at('20230902083000') };
    const timeline = buildTimeline([...allFacts, duplicate].reverse());
    expect(timeline).toHaveLength(7);
    expect(timeline.some((e) => e.to.capture.timestamp === '20231001000000' || e.from.capture.timestamp === '20231001000000')).toBe(false);
    expect(buildTimeline([])).toEqual([]);
    expect(buildTimeline([allFacts[0]!])).toEqual([]);
  });

  it('filters to the changes in the N days before a date', () => {
    const timeline = buildTimeline(allFacts);
    const date = Date.UTC(2025, 1, 1); // 1 Feb 2025
    expect(changesBefore(timeline, date, 30).map((e) => e.to.capture.timestamp.slice(0, 8))).toEqual(['20250120']);
    expect(changesBefore(timeline, date, 200).map((e) => e.to.capture.timestamp.slice(0, 8))).toEqual(['20240805', '20250120']);
    expect(changesBefore(timeline, date, 5)).toEqual([]);
    // The end date itself is included.
    expect(changesBefore(timeline, Date.UTC(2025, 0, 20, 3), 0)).toHaveLength(1);
  });

  it('produces a word-level diff for the two-date view', () => {
    expect(wordDiff('Teeth Whitening in Austin | BrightPath Dental', 'Teeth Whitening Austin TX – From $199 | BrightPath Dental')).toEqual([
      { type: 'same', text: 'Teeth Whitening' },
      { type: 'removed', text: 'in' },
      { type: 'same', text: 'Austin' },
      { type: 'added', text: 'TX – From $199' },
      { type: 'same', text: '| BrightPath Dental' },
    ]);
    expect(wordDiff('', 'new text')).toEqual([{ type: 'added', text: 'new text' }]);
    expect(wordDiff('same', 'same')).toEqual([{ type: 'same', text: 'same' }]);
    expect(wordDiff('gone', '')).toEqual([{ type: 'removed', text: 'gone' }]);
  });

  it('summarises the history in plain language', () => {
    const lines = explainTimeline(buildTimeline(allFacts), allFacts.length);
    expect(lines[0]).toBe('7 changes found across 8 captures, from 2023-03-10 to 2026-06-21.');
    expect(lines[1]).toContain('2025-01-20: Meta robots added: “noindex, follow”');
    expect(lines[2]).toMatch(/^Largest content cut: \d+ words removed between 2024-02-18 and 2024-08-05\.$/);
    expect(explainTimeline([], 1)[0]).toMatch(/Only one capture/);
    expect(explainTimeline([], 5)[0]).toMatch(/No on-page changes/);
  });
});
