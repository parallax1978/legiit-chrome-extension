/**
 * Connection state for Legiit Command Center. Connecting is optional: with
 * no token stored, the extension never contacts the Legiit host.
 */
import { LEGIIT_API_BASE_URL } from '@/config/runtime';
import { guardedFetch } from '@/net/guarded-fetch';
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
}

export const DISCONNECTED: Connection = { status: 'disconnected', session: null, client: null, error: null };

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
  if (!(await auth.isConfigured())) return DISCONNECTED;
  try {
    const session = await client.getSession();
    return { status: 'connected', session, client, error: null };
  } catch (error) {
    if (error instanceof LegiitError && error.code === 'unauthorised') {
      await auth.clear();
      return { ...DISCONNECTED, error: 'Your Legiit token was not accepted. Paste a new one to reconnect.' };
    }
    const message = error instanceof LegiitError && error.code === 'unavailable' ? 'The Legiit API is not available yet.' : error instanceof Error ? error.message : 'Could not reach Legiit';
    return { ...DISCONNECTED, error: message };
  }
}

/** Stores the token and verifies it. The token is removed again if Legiit does not accept it. */
export async function connect(token: string, client: LegiitClient = createClient()): Promise<Connection> {
  const trimmed = token.trim();
  if (!trimmed) throw new LegiitError('unauthorised', 'Paste your Legiit API token first');
  await auth.store(trimmed);
  unavailable.clear();
  try {
    const session = await client.getSession();
    return { status: 'connected', session, client, error: null };
  } catch (error) {
    await auth.clear();
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
  const capability = METHOD_CAPABILITY[method];
  if (capability && isUnavailable(error)) unavailable.add(capability);
}

export function resetUnavailable(): void {
  unavailable.clear();
}
