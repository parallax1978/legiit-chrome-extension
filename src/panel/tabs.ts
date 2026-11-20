/**
 * How the side panel reaches the page in a tab.
 *
 * Without the "tabs" permission the panel cannot see a tab's URL. It learns
 * about a page only through an agent running in it: a static content script
 * (Google results, AI sites) or the page agent injected on demand, which
 * Chrome only allows after the user invoked the extension on that tab
 * (activeTab) or granted the site.
 */
import type * as v from 'valibot';
import type { TabRequest } from '@/model/messages';
import { parseOrNull, PingReplySchema, SerpDataSchema, type PingReply, type SerpData } from '@/model/schemas';

export type Access =
  | { status: 'none' }
  | { status: 'no-access'; tabId: number }
  | { status: 'ready'; tabId: number; ping: PingReply };

export class TabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TabError';
  }
}

/** The tab this panel is pinned to through ?tab=<id> (used by tests and by "open panel in a tab"). */
export function pinnedTabId(): number | null {
  const value = Number(new URLSearchParams(location.search).get('tab'));
  return Number.isInteger(value) && value > 0 ? value : null;
}

export async function activeTabId(): Promise<number | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

/** Sends a request to the agent in a tab and validates the reply. */
export async function sendToTab<TSchema extends v.GenericSchema>(
  tabId: number,
  request: TabRequest,
  schema: TSchema,
): Promise<v.InferOutput<TSchema>> {
  let reply: unknown;
  try {
    reply = await chrome.tabs.sendMessage(tabId, request);
  } catch {
    throw new TabError('The page is not reachable. Reload it or analyze it again.');
  }
  if (reply && typeof reply === 'object' && 'error' in reply && typeof (reply as { error: unknown }).error === 'string') {
    throw new TabError((reply as { error: string }).error.slice(0, 200));
  }
  const parsed = parseOrNull(schema, reply);
  if (parsed === null) throw new TabError('The page sent data in an unexpected shape.');
  return parsed;
}

async function ping(tabId: number): Promise<PingReply | null> {
  try {
    return parseOrNull(PingReplySchema, await chrome.tabs.sendMessage(tabId, { type: 'lens:ping' } satisfies TabRequest));
  } catch {
    return null;
  }
}

/**
 * Finds out whether the panel can read a tab. If no agent answers, it tries
 * to inject one; Chrome refuses unless the user invoked the extension on this
 * tab (activeTab) or granted the site, in which case the result is "no-access".
 */
export async function probeTab(tabId: number | null): Promise<Access> {
  if (tabId === null) return { status: 'none' };
  let reply = await ping(tabId);
  if (!reply) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['/page-agent.js'] });
      reply = await ping(tabId);
    } catch {
      reply = null;
    }
  }
  return reply ? { status: 'ready', tabId, ping: reply } : { status: 'no-access', tabId };
}

export interface OpenResultsPage {
  tabId: number;
  serp: SerpData;
}

/** Google results pages open in this window (they answer through their content script). */
export async function findResultsPages(): Promise<OpenResultsPage[]> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ currentWindow: true });
  } catch {
    return [];
  }
  const found = await Promise.all(
    tabs.map(async (tab): Promise<OpenResultsPage | null> => {
      if (tab.id === undefined) return null;
      const reply = await ping(tab.id);
      if (!reply || reply.agent !== 'google' || !reply.serp) return null;
      try {
        const serp = await sendToTab(tab.id, { type: 'lens:get-serp' }, SerpDataSchema);
        return serp.recognised && serp.organic.length > 0 ? { tabId: tab.id, serp } : null;
      } catch {
        return null;
      }
    }),
  );
  return found.filter((f): f is OpenResultsPage => f !== null);
}
