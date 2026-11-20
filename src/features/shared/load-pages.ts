/**
 * Fetches and digests a set of pages with a concurrency limit, an optional
 * cache and progress reporting. Shared by "Scan sources" (Why Not Me) and by
 * the comparison set (New or Noise). The fetcher is injected, so the same
 * code runs against the guarded network layer, the tab transport and tests.
 */
import { digestHtml, failedDigest, type PageDigest } from '@/extract/digest';
import { mapLimit } from '@/lib/async';
import { urlKey } from '@/lib/url';
import type { FetchedHtml } from '@/net/page-fetch';

export interface PageCache {
  get(key: string): Promise<PageDigest | undefined>;
  put(key: string, digest: PageDigest): Promise<void>;
}

export interface LoadPagesDeps {
  fetchPage: (url: string, options: { signal?: AbortSignal }) => Promise<FetchedHtml>;
  cache?: PageCache;
  now?: () => number;
}

export interface LoadPagesOptions {
  concurrency?: number;
  /** Cached digests older than this are fetched again. */
  maxAgeMs?: number;
  onProgress?: (done: number, total: number, latest: PageDigest) => void;
  signal?: AbortSignal;
}

export const PAGE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function loadPages(urls: readonly string[], deps: LoadPagesDeps, options: LoadPagesOptions = {}): Promise<PageDigest[]> {
  const now = deps.now ?? Date.now;
  const maxAge = options.maxAgeMs ?? PAGE_CACHE_MAX_AGE_MS;
  let done = 0;
  return mapLimit(urls, options.concurrency ?? 3, async (url) => {
    let digest: PageDigest | undefined;
    const key = urlKey(url);
    try {
      const cached = await deps.cache?.get(key);
      if (cached && cached.ok && now() - cached.fetchedAt < maxAge) digest = { ...cached, url };
    } catch {
      // A broken cache must not stop the scan.
    }
    if (!digest) {
      if (options.signal?.aborted) {
        digest = failedDigest(url, 'Cancelled', 0, false, now());
      } else {
        const fetched = await deps.fetchPage(url, { signal: options.signal });
        if (fetched.ok) {
          try {
            digest = digestHtml(fetched.html, url, fetched.finalUrl, fetched.status, now());
          } catch {
            digest = failedDigest(url, 'The page could not be read', fetched.status, false, now());
          }
          if (digest.ok) {
            try {
              await deps.cache?.put(key, digest);
            } catch {
              // Caching is best effort.
            }
          }
        } else {
          digest = failedDigest(url, fetched.error ?? 'Could not fetch the page', fetched.status, fetched.needsPermission, now());
        }
      }
    }
    done++;
    options.onProgress?.(done, urls.length, digest);
    return digest;
  });
}
