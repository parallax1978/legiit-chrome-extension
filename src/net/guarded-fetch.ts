/**
 * The one place in the extension that performs network requests.
 *
 * ESLint forbids `fetch`, XMLHttpRequest, WebSocket and EventSource everywhere
 * else, so every request has a declared purpose and is checked against this
 * policy before it leaves the device:
 *
 *   wayback  only https://web.archive.org                        (Rewind)
 *   legiit   only the configured Legiit API origin               (when connected)
 *   page     any http(s) page on a site the user explicitly
 *            granted through Chrome's permission prompt          (source scans, comparisons)
 *
 * Requests never carry cookies or a referrer. A page that redirects to a site
 * the user did not grant is discarded unread. A Legiit request is never
 * redirected at all.
 */
import { LEGIIT_ORIGIN, WAYBACK_ORIGIN } from '@/config/runtime';
import { safeHttpUrl } from '@/lib/sanitize';
import { hasAccess } from './permissions';

export type FetchPurpose = 'wayback' | 'legiit' | 'page';

export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkPolicyError';
  }
}

export class PermissionRequiredError extends Error {
  constructor(readonly url: string) {
    super(`Site access has not been granted for ${new URL(url).hostname}`);
    this.name = 'PermissionRequiredError';
  }
}

export interface NetworkLogEntry {
  at: number;
  host: string;
  purpose: FetchPurpose;
  /** HTTP status, or 0 when the request failed before a response. */
  status: number;
}

const log: NetworkLogEntry[] = [];
const listeners = new Set<() => void>();
const MAX_LOG = 300;

function record(entry: NetworkLogEntry): void {
  log.push(entry);
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  for (const listener of listeners) listener();
}

/** Every request made by this extension context since it started. Shown in Settings → Privacy. */
export function networkLog(): readonly NetworkLogEntry[] {
  return log;
}

export function onNetworkLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Throws unless `url` is allowed for `purpose`. Exported for tests. */
export function assertAllowed(url: string, purpose: FetchPurpose): URL {
  const safe = safeHttpUrl(url);
  if (!safe) throw new NetworkPolicyError('Only http(s) URLs can be requested');
  const target = new URL(safe);
  if (purpose === 'wayback' && target.origin !== WAYBACK_ORIGIN) {
    throw new NetworkPolicyError(`Wayback requests must go to ${WAYBACK_ORIGIN}`);
  }
  if (purpose === 'legiit' && target.origin !== LEGIIT_ORIGIN) {
    throw new NetworkPolicyError(`Legiit requests must go to ${LEGIIT_ORIGIN}`);
  }
  return target;
}

export async function guardedFetch(url: string, purpose: FetchPurpose, init: RequestInit = {}): Promise<Response> {
  const target = assertAllowed(url, purpose);
  if (purpose === 'page' && !(await hasAccess(target.href))) {
    throw new PermissionRequiredError(target.href);
  }
  let response: Response;
  try {
    response = await fetch(target.href, {
      ...init,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      // The Legiit API answers on the address that was called. A redirect is never followed there: Chrome would
      // repeat a redirected POST as a GET without its body, and the reply to that GET would be taken for the answer.
      redirect: purpose === 'legiit' ? 'manual' : 'follow',
    });
  } catch (error) {
    record({ at: Date.now(), host: target.host, purpose, status: 0 });
    throw error;
  }
  record({ at: Date.now(), host: target.host, purpose, status: response.status });
  if (purpose === 'legiit' && (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))) {
    throw new NetworkPolicyError('The Legiit API answered with a redirect instead of a reply');
  }

  // Where did the request actually end up?
  const finalUrl = safeHttpUrl(response.url) ?? target.href;
  const finalOrigin = new URL(finalUrl).origin;
  if (purpose === 'wayback' && finalOrigin !== WAYBACK_ORIGIN) {
    throw new NetworkPolicyError('The Wayback Machine redirected to another site');
  }
  if (purpose === 'legiit' && finalOrigin !== LEGIIT_ORIGIN) {
    throw new NetworkPolicyError('The Legiit API redirected to another site');
  }
  if (purpose === 'page' && finalOrigin !== target.origin && !(await hasAccess(finalUrl))) {
    throw new NetworkPolicyError(`Redirected to ${new URL(finalUrl).hostname}, which has not been granted`);
  }
  return response;
}
