/**
 * Authentication is isolated behind AuthProvider so the pasted-token flow can
 * be replaced by OAuth without touching the client or the UI.
 */
import { getLegiitToken, setLegiitToken } from '@/storage/settings';

export interface AuthProvider {
  readonly kind: 'token' | 'oauth';
  /** Headers to attach to every request, or null when not signed in. */
  headers(): Promise<Record<string, string> | null>;
  isConfigured(): Promise<boolean>;
  clear(): Promise<void>;
}

/** v1: the user pastes an API token from Command Center. Stored in extension storage (trusted contexts only). */
export class TokenAuthProvider implements AuthProvider {
  readonly kind = 'token' as const;

  async headers(): Promise<Record<string, string> | null> {
    const token = await getLegiitToken();
    return token ? { Authorization: `Bearer ${token}` } : null;
  }

  async isConfigured(): Promise<boolean> {
    return (await getLegiitToken()) !== null;
  }

  async store(token: string): Promise<void> {
    await setLegiitToken(token);
  }

  async clear(): Promise<void> {
    await setLegiitToken(null);
  }
}

/** A fixed token, for tests and scripts. */
export class StaticAuthProvider implements AuthProvider {
  readonly kind = 'token' as const;

  constructor(private token: string | null) {}

  async headers(): Promise<Record<string, string> | null> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : null;
  }

  async isConfigured(): Promise<boolean> {
    return this.token !== null;
  }

  async clear(): Promise<void> {
    this.token = null;
  }
}
