/** Shared state for the side panel and options page: settings, Legiit connection and the target tab. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { pickProvider, type AiProvider } from '@/ai/provider';
import { BrandMatcher } from '@/brands/matcher';
import { errorMessage, isAbortError } from '@/lib/async';
import { can, connect as connectLegiit, disconnect as disconnectLegiit, DISCONNECTED, loadConnection, resetUnavailable, type Connection } from '@/legiit/connection';
import type { LegiitMethod } from '@/legiit/client';
import type { InvokeIntent, PanelEvent } from '@/model/messages';
import { requestLegiitAccess } from '@/net/permissions';
import { activeTabId, pinnedTabId, probeTab, type Access } from '@/panel/tabs';
import { DEFAULT_SETTINGS, getSettings, onLegiitTokenChanged, onSettingsChanged, trackedBrands, updateSettings, type Settings } from '@/storage/settings';

/* ------------------------------ Settings ------------------------------ */

interface SettingsValue {
  settings: Settings;
  loaded: boolean;
  update: (updater: (draft: Settings) => Settings | void) => Promise<void>;
  matcher: BrandMatcher;
}

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  /** What the page shows right now, including changes that are still being stored. */
  const latest = useRef(settings);
  latest.current = settings;
  /** Number of this page's own changes that are still being stored. */
  const pending = useRef(0);

  useEffect(() => {
    let alive = true;
    void getSettings().then((s) => {
      if (alive && pending.current === 0) setSettings(s);
      if (alive) setLoaded(true);
    });
    // Changes made elsewhere (options page, panel, service worker). While this page has changes of its
    // own on the way, the stored value is older than what is on screen: it is picked up when they finish.
    const stop = onSettingsChanged((s) => {
      if (alive && pending.current === 0) setSettings(s);
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const update = useCallback(async (updater: (draft: Settings) => Settings | void) => {
    // Show the change at once (controlled inputs must not lag behind the click), then store it.
    const draft = structuredClone(latest.current);
    const optimistic = updater(draft) ?? draft;
    latest.current = optimistic;
    setSettings(optimistic);
    pending.current += 1;
    let stored: Settings | null = null;
    let failure: unknown = null;
    try {
      stored = await updateSettings(updater);
    } catch (error) {
      failure = error;
    }
    pending.current -= 1;
    if (pending.current === 0) {
      // The last change has landed: show exactly what is stored (also if a change was refused).
      const settled = stored ?? (await getSettings());
      latest.current = settled;
      setSettings(settled);
    }
    if (failure) throw failure;
  }, []);
  const matcher = useMemo(() => new BrandMatcher(trackedBrands(settings)), [settings]);
  const value = useMemo(() => ({ settings, loaded, update, matcher }), [settings, loaded, update, matcher]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('SettingsProvider is missing');
  return value;
}

/* ------------------------------ Legiit connection ------------------------------ */

interface ConnectionValue {
  connection: Connection;
  loading: boolean;
  /** Resolves with the new connection, so the caller can tell which account it is. */
  connect: (token: string) => Promise<Connection>;
  /** Checks the stored token again after a failed check. Call from a click: it may have to ask Chrome for access. */
  retry: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** True when the UI for this Legiit method should be shown. */
  can: (method: LegiitMethod) => boolean;
  /** Re-reads capability state after a request came back "not available". */
  refreshCapabilities: () => void;
}

const ConnectionContext = createContext<ConnectionValue | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection>(DISCONNECTED);
  const [loading, setLoading] = useState(true);
  /** Goes up when an endpoint turned out to be missing: every consumer then asks `can` again. */
  const [revision, bump] = useState(0);

  /** True while this page itself is connecting or disconnecting: its own token change needs no reload. */
  const changingRef = useRef(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const next = await loadConnection();
    // Loading can delete a token that Legiit refused. The reload that deletion triggers finds no token and no
    // error; the reason must stay on screen until the user connects again.
    setConnection((previous) => (next.status === 'disconnected' && next.error === null && previous.error !== null ? previous : next));
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
    // Another extension page (options, panel) connected or disconnected. What was found missing belonged to the
    // session before: with a new token every feature gets its chance again.
    return onLegiitTokenChanged(() => {
      if (changingRef.current) return;
      resetUnavailable();
      void reload();
    });
  }, [reload]);

  /** Stable, so effects can depend on it without running again. */
  const refreshCapabilities = useCallback(() => bump((n) => n + 1), []);

  const value = useMemo<ConnectionValue>(
    () => ({
      connection,
      loading,
      retry: async () => {
        // First thing in the click: if the user withheld the Legiit host in Chrome, this is where Chrome asks.
        await requestLegiitAccess();
        resetUnavailable();
        setLoading(true);
        setConnection(await loadConnection());
        setLoading(false);
      },
      connect: async (token) => {
        await requestLegiitAccess();
        changingRef.current = true;
        try {
          const next = await connectLegiit(token);
          setConnection(next);
          return next;
        } finally {
          changingRef.current = false;
        }
      },
      disconnect: async () => {
        changingRef.current = true;
        try {
          await disconnectLegiit();
          setConnection(DISCONNECTED);
        } finally {
          changingRef.current = false;
        }
      },
      can: (method) => can(connection, method),
      refreshCapabilities,
    }),
    // `revision` is listed on purpose: `can` also reads which endpoints were found missing on this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connection, loading, refreshCapabilities, revision],
  );
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionValue {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error('ConnectionProvider is missing');
  return value;
}

/** The AI provider in effect, following the documented order. */
export function useAiProvider(): AiProvider | null {
  const { connection, can: allowed } = useConnection();
  const { settings } = useSettings();
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const legiitClient = allowed('completeAI') ? connection.client : null;
  useEffect(() => {
    let alive = true;
    void pickProvider({ legiitClient, chromePromptOptIn: settings.ai.chromePromptOptIn }).then((p) => alive && setProvider(p));
    return () => {
      alive = false;
    };
  }, [legiitClient, settings.ai.chromePromptOptIn]);
  return provider;
}

/* ------------------------------ Target tab ------------------------------ */

interface TargetValue {
  access: Access | { status: 'loading' };
  /** Increments whenever the page reports that its content changed. */
  epoch: number;
  /** Set when the user invoked the extension with a specific intent (e.g. "check selected text"). */
  intent: { intent: InvokeIntent; at: number } | null;
  refresh: () => void;
}

const TargetContext = createContext<TargetValue | null>(null);

/** How long to wait between attempts to read a tab the user has just invoked the extension on (about 2 s in total). */
const INVOKED_RETRY_DELAYS_MS = [100, 250, 500, 1200];

export function TargetProvider({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<TargetValue['access']>({ status: 'loading' });
  const [epoch, setEpoch] = useState(0);
  const [intent, setIntent] = useState<TargetValue['intent']>(null);
  const tabIdRef = useRef<number | null>(null);
  const requestRef = useRef(0);

  /**
   * Finds out what the panel can see in the target tab.
   *
   * `justInvoked` means Chrome has just told the service worker that the user
   * invoked the extension on this tab, which grants access to it. On a busy
   * machine the first attempt to read the page can still be refused (seen in
   * tests; the grant seems to reach the page slightly after the event reaches
   * us). So after an invocation a refusal is not final; the probe is repeated
   * for about two seconds before the panel concludes it has no access.
   */
  const resolve = useCallback(async (forcedTabId?: number, justInvoked = false) => {
    const request = ++requestRef.current;
    const pinned = pinnedTabId();
    const tabId = pinned ?? forcedTabId ?? (await activeTabId());
    tabIdRef.current = tabId;
    let result = await probeTab(tabId);
    if (justInvoked) {
      for (const wait of INVOKED_RETRY_DELAYS_MS) {
        if (result.status !== 'no-access' || request !== requestRef.current) break;
        await new Promise((done) => setTimeout(done, wait));
        if (request !== requestRef.current) break;
        result = await probeTab(tabId);
      }
    }
    // A newer probe may have started while this one was running.
    if (request === requestRef.current) {
      setAccess(result);
      setEpoch((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    void resolve();
    void chrome.storage.session
      ?.get('lastInvoke')
      .then((stored) => {
        const last = stored['lastInvoke'] as (PanelEvent & { at: number }) | undefined;
        if (last && Date.now() - last.at < 8000) setIntent({ intent: last.intent, at: last.at });
      })
      .catch(() => undefined);

    const onActivated = () => void resolve();
    const onUpdated = (tabId: number, changeInfo: { status?: string }) => {
      if (tabId === tabIdRef.current && changeInfo.status === 'complete') void resolve();
    };
    const onMessage = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id || typeof message !== 'object' || message === null) return undefined;
      const event = message as { type?: unknown; tabId?: unknown; intent?: unknown };
      if (event.type === 'lens:invoked' && typeof event.tabId === 'number') {
        // The user just invoked the extension on this tab: Chrome has granted access to it.
        const pinned = pinnedTabId();
        if (pinned === null || pinned === event.tabId) {
          void resolve(event.tabId, true);
          if (event.intent === 'selection' || event.intent === 'analyze') setIntent({ intent: event.intent, at: Date.now() });
        }
      } else if (event.type === 'lens:page-changed' && sender.tab?.id === tabIdRef.current) {
        setEpoch((n) => n + 1);
      }
      return undefined;
    };
    if (pinnedTabId() === null) chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [resolve]);

  const value = useMemo<TargetValue>(() => ({ access, epoch, intent, refresh: () => void resolve() }), [access, epoch, intent, resolve]);
  return <TargetContext.Provider value={value}>{children}</TargetContext.Provider>;
}

export function useTarget(): TargetValue {
  const value = useContext(TargetContext);
  if (!value) throw new Error('TargetProvider is missing');
  return value;
}

/* ------------------------------ Long-running tasks ------------------------------ */

export interface TaskState<T> {
  status: 'idle' | 'running' | 'done' | 'error';
  result: T | null;
  error: string | null;
  progress: { done: number; total: number; label: string } | null;
}

export interface Task<T> extends TaskState<T> {
  run: (job: (tools: { signal: AbortSignal; progress: (done: number, total: number, label?: string) => void }) => Promise<T>) => Promise<T | null>;
  cancel: () => void;
  reset: () => void;
}

/** Runs one cancellable job at a time and tracks its progress, result and error. */
export function useTask<T>(): Task<T> {
  const [state, setState] = useState<TaskState<T>>({ status: 'idle', result: null, error: null, progress: null });
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);

  const run = useCallback<Task<T>['run']>(async (job) => {
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    setState({ status: 'running', result: null, error: null, progress: null });
    try {
      const result = await job({
        signal: mine.signal,
        progress: (done, total, label = '') => {
          if (alive.current && controller.current === mine) setState((s) => ({ ...s, progress: { done, total, label } }));
        },
      });
      if (alive.current && controller.current === mine) setState({ status: 'done', result, error: null, progress: null });
      return result;
    } catch (error) {
      if (alive.current && controller.current === mine) {
        setState(
          mine.signal.aborted || isAbortError(error)
            ? { status: 'idle', result: null, error: null, progress: null }
            : { status: 'error', result: null, error: errorMessage(error), progress: null },
        );
      }
      return null;
    }
  }, []);

  const cancel = useCallback(() => {
    controller.current?.abort();
    setState({ status: 'idle', result: null, error: null, progress: null });
  }, []);
  const reset = useCallback(() => setState({ status: 'idle', result: null, error: null, progress: null }), []);
  return { ...state, run, cancel, reset };
}
