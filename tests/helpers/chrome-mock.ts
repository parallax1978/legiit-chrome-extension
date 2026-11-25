/** A small in-memory stand-in for the chrome.* APIs the unit tests touch. */
import { vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

function event() {
  const listeners = new Set<Listener>();
  return {
    addListener: (l: Listener) => listeners.add(l),
    removeListener: (l: Listener) => listeners.delete(l),
    hasListener: (l: Listener) => listeners.has(l),
    emit: (...args: unknown[]) => {
      for (const l of [...listeners]) l(...args);
    },
  };
}

export interface ChromeMock {
  store: Map<string, unknown>;
  granted: Set<string>;
  /** Required hosts the user switched off under the extension's "Site access" in Chrome. */
  withheld: Set<string>;
  /** What chrome.permissions.request resolves to (the user's answer to Chrome's prompt). */
  requestAnswer: boolean;
  requested: string[][];
  reset(): void;
}

export function installChromeMock(): ChromeMock {
  const store = new Map<string, unknown>();
  const granted = new Set<string>();
  const storageChanged = event();
  const permissionsAdded = event();
  const permissionsRemoved = event();
  const withheld = new Set<string>();
  const state: ChromeMock = {
    store,
    granted,
    withheld,
    requestAnswer: true,
    requested: [],
    reset() {
      store.clear();
      granted.clear();
      withheld.clear();
      state.requestAnswer = true;
      state.requested = [];
    },
  };

  const local = {
    async get(keys?: string | string[] | null) {
      const out: Record<string, unknown> = {};
      const wanted = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      for (const key of wanted) if (store.has(key)) out[key] = structuredClone(store.get(key));
      return out;
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: store.get(key), newValue: structuredClone(value) };
        store.set(key, structuredClone(value));
      }
      storageChanged.emit(changes, 'local');
    },
    async remove(keys: string | string[]) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        changes[key] = { oldValue: store.get(key) };
        store.delete(key);
      }
      storageChanged.emit(changes, 'local');
    },
    async clear() {
      store.clear();
    },
    setAccessLevel: vi.fn(async () => undefined),
  };

  const manifest = {
    manifest_version: 3,
    name: 'Legiit Lens',
    version: '0.0.0-test',
    host_permissions: ['https://web.archive.org/*', 'https://lens.legiit.com/*'],
    content_scripts: [{ matches: ['https://www.google.com/search*', 'https://chatgpt.com/*'], js: ['x.js'] }],
  };

  const chromeMock = {
    runtime: {
      id: 'test-extension-id',
      getURL: (path: string) => `chrome-extension://test-extension-id/${path.replace(/^\//, '')}`,
      getManifest: () => manifest,
      sendMessage: vi.fn(async () => undefined),
      onMessage: event(),
      onInstalled: event(),
      lastError: undefined,
    },
    storage: { local, onChanged: storageChanged },
    permissions: {
      async contains(query: { origins?: string[] }) {
        // Hosts of the manifest are granted at install, unless the user withheld them afterwards.
        return (query.origins ?? []).every((o) => granted.has(o) || (manifest.host_permissions.includes(o) && !withheld.has(o)));
      },
      async request(query: { origins?: string[] }) {
        state.requested.push([...(query.origins ?? [])]);
        if (state.requestAnswer) {
          for (const o of query.origins ?? []) {
            granted.add(o);
            withheld.delete(o);
          }
        }
        return state.requestAnswer;
      },
      async remove(query: { origins?: string[] }) {
        for (const o of query.origins ?? []) granted.delete(o);
        return true;
      },
      async getAll() {
        return {
          permissions: ['activeTab', 'scripting', 'storage', 'sidePanel', 'contextMenus'],
          origins: [...manifest.host_permissions, 'https://www.google.com/*', 'https://chatgpt.com/*', ...granted],
        };
      },
      onAdded: permissionsAdded,
      onRemoved: permissionsRemoved,
    },
    tabs: {
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
      create: vi.fn(async () => ({})),
      onActivated: event(),
      onUpdated: event(),
    },
    scripting: { executeScript: vi.fn(async () => []), insertCSS: vi.fn(async () => undefined) },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  return state;
}
