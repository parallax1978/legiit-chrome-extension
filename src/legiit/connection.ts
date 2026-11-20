/**
 * Connection state for Legiit Command Center. Connecting is optional: with
 * no token stored, the extension never contacts the Legiit host.
 */
import { PRODUCT_NAME } from '@/config/constants';
import { LEGIIT_API_BASE_URL } from '@/config/runtime';
import { guardedFetch } from '@/net/guarded-fetch';
import { hasLegiitAccess } from '@/net/permissions';
import { getLegiitToken, setLegiitToken } from '@/storage/settings';
import { TokenAuthProvider } from './auth';
import { isUnavailable, LegiitError, METHOD_CAPABILITY, type LegiitClient, type LegiitMethod } from './client';
import { HttpLegiitClient } from './http-client';
import type { Capability, LegiitSession } from './types';

export interface Connection {
  status: 'disconnected' | 'connected';
  session: LegiitSession | null;
  client: LegiitClient | null;
  /** Set when a stored token could not be used (expired, server unreachable…). */
  error: string | null;
  /** True when a token is stored although the session could not be confirmed: the check can simply be tried again. */
  tokenKept: boolean;
}

export const DISCONNECTED: Connection = { status: 'disconnected', session: null, client: null, error: null, tokenKept: false };

const auth = new TokenAuthProvider();

/** Capabilities that answered "not available" during this session, on top of what the session reported. */
const unavailable = new Set<Capability>();

export function createClient(): LegiitClient {
  return new HttpLegiitClient({
    baseUrl: LEGIIT_API_BASE_URL,
    auth,
    fetch: (url, init) => guardedFetch(url, 'legiit', init),
    clientVersion: typeof chrome !== 'undefined' ? chrome.runtime?.getManifest?.().version : undefined,
  });
}

/** Restores the connection from a stored token. Makes no request when there is no token. */
export async function loadConnection(client: LegiitClient = createClient()): Promise<Connection> {
  const token = await getLegiitToken();
  if (token === null) return DISCONNECTED;
  try {
    const session = await client.getSession();
    return { status: 'connected', session, client, error: null, tokenKept: true };
  } catch (error) {
    if (error instanceof LegiitError && error.code === 'unauthorised') {
      if (!error.definite) {
        // A 401 without the API's own error body can come from something in front of the API (a gateway, a proxy,
        // an outage). Deleting the token for it would log every user out at once, so the token stays.
        return { ...DISCONNECTED, tokenKept: true, error: 'Legiit answered 401 without saying why, so your token was kept. Try again, or paste a new token.' };
      }
      // Delete the token that was refused, not a newer one that another page stored in the meantime.
      if ((await getLegiitToken()) === token) await auth.clear();
      return { ...DISCONNECTED, error: 'Your Legiit token was not accepted. Paste a new one to reconnect.' };
    }
    return { ...DISCONNECTED, tokenKept: true, error: await describeFailure(error) };
  }
}

/** Why the session could not be read, in words for the user. The token is kept in all of these cases. */
async function describeFailure(error: unknown): Promise<string> {
  if (error instanceof LegiitError && error.code === 'unavailable') return 'The Legiit API is not available yet.';
  if (error instanceof LegiitError && error.code === 'network' && !(await hasLegiitAccess())) {
    // The user switched off the extension's access to the Legiit host in Chrome. Asking for it back needs a click.
    return `Chrome is not letting ${PRODUCT_NAME} reach ${new URL(LEGIIT_API_BASE_URL).host}. Click “Try again” to allow it.`;
  }
  return error instanceof Error ? error.message : 'Could not reach Legiit';
}

/** A token travels in an HTTP header: printable ASCII without spaces, and not absurdly long. */
const TOKEN_SHAPE = /^[\x21-\x7E]{1,4096}$/;

/** Stores the token and verifies it. The token is removed again if Legiit does not accept it. */
export async function connect(token: string, client: LegiitClient = createClient()): Promise<Connection> {
  const trimmed = token.trim();
  if (!trimmed) throw new LegiitError('unauthorised', 'Paste your Legiit API token first');
  if (!TOKEN_SHAPE.test(trimmed)) {
    throw new LegiitError('unauthorised', 'That does not look like a Legiit token: a token has no spaces, line breaks or unusual characters. Copy it again from Command Center.');
  }
  // A token that was already stored (and may still be good) comes back if the new one cannot be confirmed.
  const previous = await getLegiitToken();
  await auth.store(trimmed);
  unavailable.clear();
  try {
    const session = await client.getSession();
    return { status: 'connected', session, client, error: null, tokenKept: true };
  } catch (error) {
    await setLegiitToken(previous === trimmed ? null : previous);
    if (isUnavailable(error)) throw new LegiitError('unavailable', 'The Legiit API is not available yet. Nothing was saved.', 404);
    throw error;
  }
}

export async function disconnect(): Promise<void> {
  await auth.clear();
  unavailable.clear();
}

/** Should the UI for this method be shown? */
export function can(connection: Connection, method: LegiitMethod): boolean {
  if (connection.status !== 'connected' || !connection.session) return false;
  const capability = METHOD_CAPABILITY[method];
  if (capability === null) return true;
  return connection.session.capabilities.includes(capability) && !unavailable.has(capability);
}

/** Call when a request came back "not available": its UI is hidden from then on. */
export function noteFailure(method: LegiitMethod, error: unknown): void {
  if (isUnavailable(error)) markUnavailable(method);
}

/** Hides the UI of a method whose endpoint turned out not to exist, until this page is reopened or the user reconnects (on any page). */
export function markUnavailable(method: LegiitMethod): void {
  const capability = METHOD_CAPABILITY[method];
  if (capability) unavailable.add(capability);
}

/** Gives every hidden feature its chance again: the session is being read afresh (a new token, or "Try again"). */
export function resetUnavailable(): void {
  unavailable.clear();
}
