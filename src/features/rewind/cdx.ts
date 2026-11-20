/**
 * Wayback Machine CDX index: which captures exist for a URL.
 * https://web.archive.org/cdx/search/cdx — status 200 only, collapsed by
 * content digest so consecutive identical captures appear once.
 */
import { WAYBACK_ORIGIN } from '@/config/constants';
import { safeHttpUrl } from '@/lib/sanitize';

export interface Capture {
  /** 14-digit Wayback timestamp, UTC: YYYYMMDDhhmmss. */
  timestamp: string;
  /** Capture time in milliseconds since the epoch. */
  time: number;
  /** The URL as it was captured. */
  original: string;
  digest: string;
  length: number | null;
}

export const CDX_FIELDS = ['timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'] as const;
export const DEFAULT_SAMPLE_SIZE = 24;
const CDX_LIMIT = 5000;

export function cdxUrl(pageUrl: string): string {
  const params = new URLSearchParams({
    url: pageUrl,
    output: 'json',
    fl: CDX_FIELDS.join(','),
    collapse: 'digest',
    limit: String(CDX_LIMIT),
  });
  params.append('filter', 'statuscode:200');
  params.append('filter', 'mimetype:text/html');
  return `${WAYBACK_ORIGIN}/cdx/search/cdx?${params.toString()}`;
}

/** The capture exactly as archived: the "id_" form returns the original HTML with no Wayback rewriting. */
export function rawCaptureUrl(capture: Pick<Capture, 'timestamp' | 'original'>): string {
  return `${WAYBACK_ORIGIN}/web/${capture.timestamp}id_/${capture.original}`;
}

/** The capture as a person would open it in the Wayback Machine. */
export function viewCaptureUrl(capture: Pick<Capture, 'timestamp' | 'original'>): string {
  return `${WAYBACK_ORIGIN}/web/${capture.timestamp}/${capture.original}`;
}

export function parseTimestamp(timestamp: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(timestamp);
  if (!m) return null;
  const time = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return Number.isNaN(time) ? null : time;
}

/**
 * Parses a CDX JSON response (an array of rows whose first row names the
 * columns). Unknown shapes, bad rows and non-http URLs are dropped. Returns
 * captures oldest first.
 */
export function parseCdx(json: unknown): Capture[] {
  if (!Array.isArray(json) || json.length < 2) return [];
  const header = json[0];
  if (!Array.isArray(header)) return [];
  const column = (name: string): number => header.indexOf(name);
  const iTimestamp = column('timestamp');
  const iOriginal = column('original');
  const iDigest = column('digest');
  const iLength = column('length');
  const iStatus = column('statuscode');
  if (iTimestamp < 0 || iOriginal < 0) return [];

  const captures: Capture[] = [];
  const seen = new Set<string>();
  for (const row of json.slice(1)) {
    if (!Array.isArray(row)) continue;
    const timestamp = typeof row[iTimestamp] === 'string' ? row[iTimestamp] : '';
    const time = parseTimestamp(timestamp);
    const original = safeHttpUrl(row[iOriginal]);
    if (time === null || !original || timestamp.length !== 14) continue;
    if (iStatus >= 0 && row[iStatus] !== '200') continue;
    if (seen.has(timestamp)) continue;
    seen.add(timestamp);
    const length = iLength >= 0 ? Number.parseInt(String(row[iLength]), 10) : Number.NaN;
    captures.push({
      timestamp,
      time,
      original,
      digest: iDigest >= 0 && typeof row[iDigest] === 'string' ? row[iDigest].slice(0, 64) : '',
      length: Number.isFinite(length) ? length : null,
    });
  }
  return captures.sort((a, b) => a.time - b.time);
}

/**
 * Picks at most `max` captures, evenly spread through the list and always
 * including the first and the last, so the whole history is covered.
 */
export function sampleCaptures(captures: readonly Capture[], max = DEFAULT_SAMPLE_SIZE): Capture[] {
  if (max <= 0) return [];
  if (captures.length <= max) return [...captures];
  if (max === 1) return [captures[captures.length - 1]!];
  const picked = new Set<number>();
  for (let i = 0; i < max; i++) picked.add(Math.round((i * (captures.length - 1)) / (max - 1)));
  return [...picked].sort((a, b) => a - b).map((index) => captures[index]!);
}

export function formatCaptureDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
