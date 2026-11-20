/**
 * Everything read from a web page is untrusted. These helpers bound and clean
 * page-derived strings before they are stored, rendered, exported or sent.
 */

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤﻿]/g;

/**
 * Cuts a string to at most `max` UTF-16 units without splitting a surrogate
 * pair. A plain slice() can end on the first half of an emoji; that lone half
 * is not valid Unicode, and strict JSON stores (PostgreSQL jsonb, for one)
 * refuse it.
 */
export function cutText(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = max > 0 && /[\uD800-\uDBFF]/.test(value.charAt(max - 1)) ? max - 1 : max;
  return value.slice(0, Math.max(0, end));
}

/** Collapse whitespace, strip control and bidi-override characters, cap the length. */
export function cleanText(value: unknown, maxLength = 500): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLength ? `${cutText(cleaned, maxLength - 1).trimEnd()}…` : cleaned;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Returns a copy of a JSON value in which every string is well-formed Unicode
 * (a lone surrogate becomes U+FFFD). Applied to everything that leaves the
 * device, whatever page text it was built from.
 */
export function wellFormedDeep<T>(value: T): T {
  if (typeof value === 'string') return value.replace(LONE_SURROGATE, '\uFFFD') as T;
  if (Array.isArray(value)) return value.map((item) => wellFormedDeep(item as unknown)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, wellFormedDeep(child)])) as T;
  }
  return value;
}

/** Like cleanText but keeps paragraph breaks (used for long answer and article text). */
export function cleanMultiline(value: unknown, maxLength = 20_000): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(CONTROL_CHARS, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cutText(cleaned, maxLength);
}

const MAX_URL_LENGTH = 2048;

/**
 * Returns a normalised absolute http(s) URL, or null. Rejects javascript:,
 * data:, blob:, file: and anything else; strips embedded credentials.
 */
export function safeHttpUrl(value: unknown, base?: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = base ? new URL(trimmed, base) : new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  url.username = '';
  url.password = '';
  const href = url.href;
  return href.length > MAX_URL_LENGTH ? null : href;
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && safeHttpUrl(value) !== null;
}

/** Lower-cased hostname without a leading "www.". Empty string when the URL is not http(s). */
export function domainOf(url: string | null | undefined): string {
  const safe = safeHttpUrl(url ?? '');
  if (!safe) return '';
  return stripWww(new URL(safe).hostname);
}

export function stripWww(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h.startsWith('www.') ? h.slice(4) : h;
}

/** Normalise user-typed domains: accepts "https://www.Example.com/path" and returns "example.com". */
export function normalizeDomainInput(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
  const safe = safeHttpUrl(withScheme);
  if (!safe) return null;
  const host = stripWww(new URL(safe).hostname);
  // Require something that looks like a registrable domain (or localhost for testing).
  if (!/^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)$/.test(host)) return null;
  return host;
}

/** A filesystem-safe slug for export file names. */
export function slugify(value: string, fallback = 'export'): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\\/|:]+/g, ' ')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/[\s._]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return slug || fallback;
}

/** Only raster image data URLs are accepted for the agency logo (no SVG: it can carry script). */
export function isSafeImageDataUrl(value: unknown, maxBytes = 400_000): value is string {
  if (typeof value !== 'string') return false;
  if (value.length > Math.ceil(maxBytes * 1.37) + 64) return false;
  return /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}
