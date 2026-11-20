/**
 * The page agent: the only code that answers the extension from inside a web
 * page. It is shared by the two static content scripts (Google results, AI
 * sites) and by the script injected on demand into a page the user invoked
 * the extension on.
 *
 * It only reads the page. The one thing it adds is highlighting, on request.
 */
import type { AiSiteId } from '@/config/sites';
import { cleanText, safeHttpUrl } from '@/lib/sanitize';
import { asTabRequest, type TabRequest } from '@/model/messages';
import type { AnswerData, PageSnapshot, PingReply, SelectorHealth, SerpData } from '@/model/schemas';
import { readBrandStyle } from './brand-style';
import { applyHighlights, clearHighlights } from './highlighter';
import { fetchSameOrigin } from './same-origin-fetch';

export interface AgentOptions {
  kind: PingReply['agent'];
  site?: AiSiteId | null;
  /** Google only: true on a results page that has a query. */
  isSerp?: () => boolean;
  getSerp?: () => SerpData;
  getAnswer?: () => AnswerData;
  selectorHealth?: () => SelectorHealth;
  /** Development builds only: saves the page as a test fixture. */
  devSaveFixture?: () => unknown;
}

const MAX_HTML = 4_000_000;
const FLAG = '__legiitLensAgent';

/** The page's current HTML, without scripts (JSON-LD is kept) so it is smaller and inert. */
export function snapshotPage(): PageSnapshot {
  const clone = document.documentElement.cloneNode(true) as Element;
  for (const el of clone.querySelectorAll('script:not([type="application/ld+json" i]), noscript, template')) el.remove();
  const serialised = `<!doctype html>\n${clone.outerHTML}`;
  return {
    kind: 'page',
    url: safeHttpUrl(location.href) ?? location.href,
    title: cleanText(document.title, 500),
    html: serialised.length > MAX_HTML ? serialised.slice(0, MAX_HTML) : serialised,
    truncated: serialised.length > MAX_HTML,
    selection: (window.getSelection()?.toString() ?? '').slice(0, 50_000),
    capturedAt: Date.now(),
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
  };
}

async function handle(request: TabRequest, options: AgentOptions): Promise<unknown> {
  switch (request.type) {
    case 'lens:ping': {
      const reply: PingReply = {
        ok: true,
        agent: options.kind,
        site: options.site ?? null,
        url: safeHttpUrl(location.href) ?? location.href,
        title: cleanText(document.title, 500),
        serp: options.isSerp?.() ?? false,
      };
      return reply;
    }
    case 'lens:get-serp':
      return options.getSerp ? options.getSerp() : { error: 'Not a Google results page' };
    case 'lens:get-answer':
      return options.getAnswer ? options.getAnswer() : { error: 'Not an AI answer page' };
    case 'lens:get-page':
      return snapshotPage();
    case 'lens:fetch-same-origin':
      return fetchSameOrigin(request.urls);
    case 'lens:get-brand-style':
      return readBrandStyle();
    case 'lens:highlight':
      return applyHighlights(request.groups);
    case 'lens:clear-highlight':
      clearHighlights();
      return { applied: 0, missed: 0, method: 'none' };
    case 'lens:selector-health':
      return options.selectorHealth ? options.selectorHealth() : { error: 'No selector pack applies to this page' };
    case 'lens:dev-save-fixture':
      return options.devSaveFixture ? options.devSaveFixture() : { error: 'Not available in this build' };
  }
}

/** Installs the message listener once per page. Returns false if an agent was already there. */
export function installAgent(options: AgentOptions): boolean {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope[FLAG]) return false;
  scope[FLAG] = options.kind;
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // Only this extension's own pages and service worker may talk to the agent.
    if (sender.id !== chrome.runtime.id) return undefined;
    const request = asTabRequest(message);
    if (!request) return undefined;
    handle(request, options).then(
      (result) => sendResponse(result),
      (error) => sendResponse({ error: error instanceof Error ? error.message : 'Failed' }),
    );
    return true; // the reply is asynchronous
  });
  return true;
}
