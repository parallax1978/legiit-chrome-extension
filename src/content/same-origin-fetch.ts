/**
 * Fetches pages of the site the user is on, from inside that page.
 *
 * This is the second (and last) sanctioned network path besides
 * src/net/guarded-fetch.ts. It runs in a content script, where a same-origin
 * request needs no extra permission, and it is locked to the page's own
 * origin: Instant Brief uses it to read up to 8 navigation pages of the
 * current site after the user clicks "Build brief". No cookies are sent.
 */
import type { FetchedPage, SameOriginFetchReply } from '@/model/schemas';

const MAX_PAGES = 8;
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 3;

function sameOriginUrl(value: string): string | null {
  try {
    const url = new URL(value, location.href);
    return url.origin === location.origin && (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : null;
  } catch {
    return null;
  }
}

async function fetchOne(requested: string): Promise<FetchedPage> {
  const fail = (error: string, status = 0): FetchedPage => ({ url: requested, finalUrl: null, ok: false, status, html: '', error });
  const url = sameOriginUrl(requested);
  if (!url) return fail('Not on this site');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    // A redirect that leaves the site is not read.
    if (!sameOriginUrl(response.url || url)) return fail('Redirected to another site', response.status);
    if (!response.ok) return fail(`The site answered ${response.status}`, response.status);
    const type = response.headers.get('content-type') ?? '';
    if (type && !/html|xml/i.test(type)) return fail('Not an HTML page', response.status);
    const text = await response.text();
    return { url: requested, finalUrl: response.url || url, ok: true, status: response.status, html: text.slice(0, MAX_BYTES), error: null };
  } catch (error) {
    return fail(controller.signal.aborted ? 'Timed out' : error instanceof Error ? 'Could not load the page' : 'Could not load the page');
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSameOrigin(urls: readonly string[]): Promise<SameOriginFetchReply> {
  const list = urls.slice(0, MAX_PAGES);
  const pages = new Array<FetchedPage>(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
      while (next < list.length) {
        const index = next++;
        pages[index] = await fetchOne(list[index]!);
      }
    }),
  );
  return { pages };
}

/** Reads a same-origin image as a raster data URL (for the business logo in a brief). */
export async function sameOriginImageDataUrl(value: string, maxBytes = 300_000): Promise<string | null> {
  const url = sameOriginUrl(value);
  if (!url) return null;
  try {
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok || !sameOriginUrl(response.url || url)) return null;
    const blob = await response.blob();
    if (blob.size === 0 || blob.size > maxBytes || !/^image\/(png|jpeg|webp|gif)$/.test(blob.type)) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
