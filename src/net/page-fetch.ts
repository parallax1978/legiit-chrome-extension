/** Fetches an HTML page from a granted site, with a timeout and a size cap. */
import { errorMessage, isAbortError, timeoutSignal } from '@/lib/async';
import { safeHttpUrl } from '@/lib/sanitize';
import { guardedFetch, PermissionRequiredError } from './guarded-fetch';

export interface FetchedHtml {
  url: string;
  finalUrl: string;
  ok: boolean;
  status: number;
  html: string;
  error: string | null;
  /** True when the failure was a missing site permission. */
  needsPermission: boolean;
}

export interface FetchPageOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 3_000_000;

/** Reads at most `maxBytes` of the body, then stops the download. */
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const slice = chunk.subarray(0, out.length - offset);
    out.set(slice, offset);
    offset += slice.byteLength;
  }
  return out;
}

/** Decodes HTML bytes using the charset from the header or an early <meta>, defaulting to UTF-8. */
export function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  let label = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (!label) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
    label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<FetchedHtml> {
  const failure = (error: string, status = 0, needsPermission = false): FetchedHtml => ({
    url,
    finalUrl: url,
    ok: false,
    status,
    html: '',
    error,
    needsPermission,
  });
  if (!safeHttpUrl(url)) return failure('Not a web address');
  const timer = timeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);
  try {
    const response = await guardedFetch(url, 'page', {
      signal: timer.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    const finalUrl = safeHttpUrl(response.url) ?? url;
    if (!response.ok) return { ...failure(`The site answered ${response.status}`, response.status), finalUrl };
    const contentType = response.headers.get('content-type');
    if (contentType && !/html|xml|text\/plain/i.test(contentType)) {
      return { ...failure(`Not an HTML page (${contentType.split(';')[0]})`, response.status), finalUrl };
    }
    const bytes = await readCapped(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
    return {
      url,
      finalUrl,
      ok: true,
      status: response.status,
      html: decodeHtml(bytes, contentType),
      error: null,
      needsPermission: false,
    };
  } catch (error) {
    if (error instanceof PermissionRequiredError) return failure('Site access not granted', 0, true);
    if (options.signal?.aborted) throw error;
    if (isAbortError(error) || (error instanceof DOMException && error.name === 'TimeoutError')) {
      return failure('Timed out');
    }
    return failure(errorMessage(error) === 'Failed to fetch' ? 'Could not reach the site' : errorMessage(error));
  } finally {
    timer.clear();
  }
}
