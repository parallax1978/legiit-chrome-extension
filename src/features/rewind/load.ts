/**
 * Loads Rewind data from the Wayback Machine politely: the CDX index once,
 * then at most 24 sampled captures, 2 at a time, backing off on 429/503,
 * with every result cached in IndexedDB.
 */
import { parseHtml } from '@/extract/html';
import { extractPageFacts, type PageFacts } from '@/extract/page-facts';
import { errorMessage, isAbortError, mapLimit, sleep } from '@/lib/async';
import { decodeHtml, readCapped } from '@/net/page-fetch';
import { cdxUrl, DEFAULT_SAMPLE_SIZE, parseCdx, rawCaptureUrl, sampleCaptures, type Capture } from './cdx';
import type { CaptureFacts } from './diff';

export interface RewindCache {
  getCdx(url: string): Promise<{ fetchedAt: number; captures: Capture[] } | undefined>;
  putCdx(url: string, captures: Capture[], fetchedAt: number): Promise<void>;
  getCapture(key: string): Promise<PageFacts | undefined>;
  putCapture(key: string, url: string, timestamp: string, facts: PageFacts, fetchedAt: number): Promise<void>;
}

export interface RewindDeps {
  /** Performs a request to web.archive.org (guardedFetch with purpose "wayback"). */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  cache?: RewindCache;
  now?: () => number;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export const MAX_CONCURRENT = 2;
export const MAX_RETRIES = 4;
export const CDX_CACHE_MS = 6 * 60 * 60 * 1000;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60_000;
const MAX_CAPTURE_BYTES = 3_000_000;

export class WaybackError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WaybackError';
  }
}

/**
 * A shared pause: when the archive says "slow down" every in-flight worker
 * waits until the same moment, instead of each retrying on its own.
 */
export class Backoff {
  private resumeAt = 0;

  constructor(
    private readonly now: () => number,
    private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>,
    private readonly random: () => number,
  ) {}

  async wait(signal?: AbortSignal): Promise<void> {
    const delay = this.resumeAt - this.now();
    if (delay > 0) await this.sleepFn(delay, signal);
  }

  /** Delay for a given attempt: Retry-After when the server sends one, else exponential with jitter. */
  delayFor(attempt: number, retryAfter: string | null): number {
    const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN;
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(MAX_DELAY_MS, seconds * 1000);
    const exponential = BASE_DELAY_MS * 2 ** attempt;
    return Math.min(MAX_DELAY_MS, Math.round(exponential * (0.75 + this.random() * 0.5)));
  }

  pause(ms: number): void {
    this.resumeAt = Math.max(this.resumeAt, this.now() + ms);
  }
}

function makeBackoff(deps: RewindDeps): Backoff {
  return new Backoff(deps.now ?? Date.now, deps.sleep ?? sleep, deps.random ?? Math.random);
}

/** GET with retry on 429 and 503. Other failures are returned to the caller as-is. */
export async function fetchWithBackoff(url: string, deps: RewindDeps, backoff: Backoff, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await backoff.wait(signal);
    const response = await deps.fetch(url, { signal });
    if (response.status !== 429 && response.status !== 503) return response;
    if (attempt >= MAX_RETRIES) throw new WaybackError('The Wayback Machine is rate-limiting requests. Try again in a few minutes.', response.status);
    backoff.pause(backoff.delayFor(attempt, response.headers.get('retry-after')));
  }
}

export interface LoadIndexResult {
  captures: Capture[];
  fromCache: boolean;
}

/** All distinct captures of a URL, oldest first. An empty list means the archive has none. */
export async function loadCaptureIndex(
  pageUrl: string,
  deps: RewindDeps,
  options: { signal?: AbortSignal; forceRefresh?: boolean } = {},
): Promise<LoadIndexResult> {
  const now = (deps.now ?? Date.now)();
  if (!options.forceRefresh) {
    const cached = await deps.cache?.getCdx(pageUrl).catch(() => undefined);
    if (cached && now - cached.fetchedAt < CDX_CACHE_MS) return { captures: cached.captures, fromCache: true };
  }
  const response = await fetchWithBackoff(cdxUrl(pageUrl), deps, makeBackoff(deps), options.signal);
  if (!response.ok) throw new WaybackError(`The Wayback Machine answered ${response.status}.`, response.status);
  const body = await response.text();
  let json: unknown = [];
  if (body.trim()) {
    try {
      json = JSON.parse(body);
    } catch {
      throw new WaybackError('The Wayback Machine sent a response that could not be read.', response.status);
    }
  }
  const captures = parseCdx(json);
  await deps.cache?.putCdx(pageUrl, captures, now).catch(() => undefined);
  return { captures, fromCache: false };
}

export interface CaptureResult {
  capture: Capture;
  facts: PageFacts | null;
  error: string | null;
  fromCache: boolean;
}

export function captureKey(capture: Pick<Capture, 'timestamp' | 'original'>): string {
  return `${capture.timestamp}|${capture.original}`;
}

/**
 * Reads the given captures (already sampled), two at a time. A capture that
 * fails is reported with its error and does not stop the others.
 */
export async function loadCaptureFacts(
  captures: readonly Capture[],
  deps: RewindDeps,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<CaptureResult[]> {
  const backoff = makeBackoff(deps);
  const now = deps.now ?? Date.now;
  let done = 0;
  return mapLimit(captures, MAX_CONCURRENT, async (capture) => {
    const key = captureKey(capture);
    let result: CaptureResult;
    try {
      const cached = await deps.cache?.getCapture(key).catch(() => undefined);
      if (cached) {
        result = { capture, facts: cached, error: null, fromCache: true };
      } else {
        const response = await fetchWithBackoff(rawCaptureUrl(capture), deps, backoff, options.signal);
        if (!response.ok) throw new WaybackError(`Capture not available (${response.status})`, response.status);
        const html = decodeHtml(await readCapped(response, MAX_CAPTURE_BYTES), response.headers.get('content-type'));
        const facts = extractPageFacts(parseHtml(html), capture.original);
        await deps.cache?.putCapture(key, capture.original, capture.timestamp, facts, now()).catch(() => undefined);
        result = { capture, facts, error: null, fromCache: false };
      }
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error;
      result = { capture, facts: null, error: errorMessage(error), fromCache: false };
    }
    done++;
    options.onProgress?.(done, captures.length);
    return result;
  });
}

export function toCaptureFacts(results: readonly CaptureResult[]): CaptureFacts[] {
  const out: CaptureFacts[] = [];
  for (const r of results) if (r.facts) out.push({ capture: r.capture, facts: r.facts });
  return out;
}

export { DEFAULT_SAMPLE_SIZE, sampleCaptures };
