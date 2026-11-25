/**
 * Test harness: Chromium with the built extension loaded, every network
 * request intercepted and answered from /fixtures, and helpers to drive the
 * extension the way a user would.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, chromium, expect, type BrowserContext, type CDPSession, type Page, type Route, type Worker } from '@playwright/test';
import { createMockState, handleMockRequest, type MockState } from '../mock-server/handlers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');
export const DIST = join(ROOT, 'dist');
const FIXTURES = join(ROOT, 'fixtures');

interface Manifest {
  routes: { url: string; file: string; contentType: string }[];
  cdx: Record<string, string>;
}

export const fixtureManifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')) as Manifest;
export const scenario = JSON.parse(readFileSync(join(FIXTURES, 'scenario.json'), 'utf8')) as {
  me: { name: string; domain: string; aliases: string[] };
  competitors: { name: string; domain: string; aliases: string[] }[];
  urls: Record<string, string>;
};

export const LEGIIT_ORIGIN = 'https://lens.legiit.com';
export const WAYBACK_ORIGIN = 'https://web.archive.org';

export interface SeenRequest {
  url: string;
  host: string;
  method: string;
  /** "document" for page navigations the test (acting as the user) performed. */
  resourceType: string;
  /** URL of the frame that made the request, or "service-worker". */
  from: string;
  served: 'fixture' | 'legiit-mock' | 'not-found' | 'blocked';
  /** True when the request carried an Authorization header (the Legiit token). */
  authorization: boolean;
  /** The request body, when there was one. */
  body: string | null;
}

export interface LensOptions {
  /**
   * Adds the fixture domains (*.example) to the copy of the manifest under
   * test. Chrome's permission prompt cannot be answered by automation, so the
   * scans that need an optional host permission run against a build whose
   * only difference is that these test domains are already granted.
   */
  grantFixtureSites: boolean;
  /**
   * Removes the bundled embedding model from the copy of the extension under
   * test, to exercise the "model failed to load" path of New or Noise.
   */
  removeModel: boolean;
  /** Size of the browser window that fixture pages render in. */
  windowSize: { width: number; height: number };
}

export interface Lens {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  extensionDir: string;
  /** Every http(s) request any part of the browser made, in order. */
  requests: SeenRequest[];
  /** Console errors and uncaught exceptions from pages, content scripts and the service worker. */
  errors: string[];
  legiit: MockState;
  /** Opens a fixture page at its real URL and returns the page with its tab id. */
  open(url: string): Promise<{ page: Page; tabId: number }>;
  /** Opens the side panel UI bound to a tab (the same page the real side panel loads). */
  openPanel(tabId: number, view?: string): Promise<Page>;
  /** Opens one of the extension's own pages. */
  openExtensionPage(path: string): Promise<Page>;
  /**
   * Invokes the extension on a tab exactly as a toolbar click does (through
   * the DevTools protocol). This is what grants activeTab.
   */
  invoke(page: Page): Promise<void>;
  /** Writes extension settings (tracked brands etc.) as the options page would. */
  setSettings(settings: Record<string, unknown>): Promise<void>;
  trackScenarioBrands(): Promise<void>;
  /** Requests made by the extension itself (everything except pages the test navigated to). */
  extensionRequests(): SeenRequest[];
  /** Reads the text of the results strip. It lives in a closed shadow root, so this goes through the DevTools protocol. */
  stripText(page: Page): Promise<string | null>;
  /** Clicks a button inside the strip with a real mouse click. */
  clickStrip(page: Page, label: string): Promise<void>;
  /** True when Chrome has the extension's real side panel open (not the tab the tests drive). */
  realSidePanelOpen(): Promise<boolean>;
  /** Reads the text of a file the extension offered as a download. */
  downloadText(page: Page, trigger: () => Promise<void>): Promise<{ name: string; text: string }>;
  /**
   * Everything that went wrong anywhere: `errors`, plus uncaught exceptions
   * and unhandled promise rejections inside the service worker (which do not
   * show up as console messages).
   */
  allErrors(): Promise<string[]>;
}

interface DomNode {
  nodeId: number;
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: (DomNode & { shadowRootType?: string })[];
}

function findNode(node: DomNode, predicate: (n: DomNode) => boolean): DomNode | null {
  if (predicate(node)) return node;
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

function textOf(node: DomNode): string {
  if (node.nodeName === '#text') return node.nodeValue;
  if (node.nodeName === 'STYLE') return '';
  return (node.children ?? []).map(textOf).join(' ');
}

async function stripShadow(context: BrowserContext, page: Page): Promise<{ cdp: CDPSession; shadow: DomNode & { shadowRootType?: string } } | null> {
  const cdp = await context.newCDPSession(page);
  const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as unknown as { root: DomNode };
  const host = findNode(root, (n) => n.attributes?.includes('data-legiit-lens-strip') ?? false);
  const shadow = host?.shadowRoots?.[0];
  if (!shadow) {
    await cdp.detach();
    return null;
  }
  return { cdp, shadow };
}

/**
 * The user's own browsing: page navigations, and a page loading its own
 * same-origin images, styles, fonts and scripts. Everything else was caused
 * by the extension: requests from extension pages, from the service worker,
 * from a worker, and any fetch/XHR issued inside a web page (fixture pages
 * contain no scripts, so those can only come from a content script).
 */
function isUsersOwnBrowsing(request: SeenRequest): boolean {
  if (request.from.startsWith('chrome-extension://') || request.from === 'service-worker' || request.from === '') return false;
  if (request.resourceType === 'document') return true;
  let sameOrigin = false;
  try {
    sameOrigin = new URL(request.from).origin === new URL(request.url).origin;
  } catch {
    sameOrigin = false;
  }
  return sameOrigin && ['image', 'stylesheet', 'font', 'media', 'script'].includes(request.resourceType);
}

function contentTypeFor(file: string, fallback: string): string {
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.png')) return 'image/png';
  return fallback;
}

function findFixture(url: URL): { file: string; contentType: string } | null {
  const clean = new URL(url.href);
  clean.hash = '';
  // Wayback CDX index: chosen by its "url" parameter.
  if (clean.origin === WAYBACK_ORIGIN && clean.pathname === '/cdx/search/cdx') {
    const target = clean.searchParams.get('url') ?? '';
    return { file: fixtureManifest.cdx[target] ?? 'wayback/cdx-empty.json', contentType: 'application/json' };
  }
  const exact = fixtureManifest.routes.find((r) => r.url === clean.href || r.url === clean.href.replace(/\/$/, '') || `${r.url}/` === clean.href);
  if (exact) return { file: exact.file, contentType: contentTypeFor(exact.file, exact.contentType) };
  // Images and icons on fixture sites: one small placeholder image, so fixture pages load without errors of their own.
  if (/\.example$/.test(clean.hostname) && /\.(png|jpe?g|ico|webp|gif)$/i.test(clean.pathname)) {
    return { file: 'site/assets/brightpath-logo.png', contentType: 'image/png' };
  }
  // Google results: same host and path, same query and mode.
  if (/^www\.google\./.test(clean.hostname) && clean.pathname === '/search') {
    const match = fixtureManifest.routes.find((r) => {
      const candidate = new URL(r.url);
      return (
        candidate.hostname === clean.hostname &&
        candidate.pathname === '/search' &&
        candidate.searchParams.get('q') === clean.searchParams.get('q') &&
        (candidate.searchParams.get('udm') ?? '') === (clean.searchParams.get('udm') ?? '')
      );
    });
    if (match) return { file: match.file, contentType: match.contentType };
  }
  return null;
}

export const test = base.extend<LensOptions & { lens: Lens }>({
  grantFixtureSites: [false, { option: true }],
  removeModel: [false, { option: true }],
  windowSize: [{ width: 1280, height: 800 }, { option: true }],

  lens: async ({ grantFixtureSites, removeModel, windowSize }, use) => {
    if (!existsSync(join(DIST, 'manifest.json'))) throw new Error('dist/ is missing. Run "npm run build" first (npm run e2e does this for you).');

    // The extension under test: dist/ as built, or a copy whose manifest additionally grants the fixture domains.
    let extensionDir = DIST;
    let scratch: string | null = null;
    if (grantFixtureSites || removeModel) {
      scratch = mkdtempSync(join(tmpdir(), 'lens-ext-'));
      cpSync(DIST, scratch, { recursive: true });
      if (grantFixtureSites) {
        const manifestPath = join(scratch, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { host_permissions: string[] };
        manifest.host_permissions = [...manifest.host_permissions, '*://*.example/*', '*://*.reddit.com/*', '*://*.youtube.com/*'];
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      }
      if (removeModel) rmSync(join(scratch, 'models'), { recursive: true, force: true });
      extensionDir = scratch;
    }

    const profile = mkdtempSync(join(tmpdir(), 'lens-profile-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: windowSize,
      deviceScaleFactor: 1,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--enable-unsafe-extension-debugging'],
    });

    const requests: SeenRequest[] = [];
    const errors: string[] = [];
    const legiit = createMockState();

    await context.route('**/*', async (route: Route) => {
      const request = route.request();
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        return route.abort();
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return route.continue();
      const seen: SeenRequest = {
        url: url.href,
        host: url.host,
        method: request.method(),
        resourceType: request.resourceType(),
        from: request.serviceWorker() ? 'service-worker' : (request.frame()?.url() ?? ''),
        served: 'not-found',
        authorization: 'authorization' in request.headers(),
        body: request.postData(),
      };
      requests.push(seen);

      if (url.origin === LEGIIT_ORIGIN) {
        const reply = handleMockRequest(legiit, { method: request.method(), path: url.pathname + url.search, headers: request.headers(), body: request.postData() });
        seen.served = 'legiit-mock';
        return route.fulfill({ status: reply.status, headers: reply.headers, body: reply.body });
      }
      const fixture = findFixture(url);
      if (fixture) {
        seen.served = 'fixture';
        return route.fulfill({ status: 200, contentType: fixture.contentType, body: readFileSync(join(FIXTURES, fixture.file)) });
      }
      // Never let a test reach the real network.
      if (/\.example$/.test(url.hostname) || url.origin === WAYBACK_ORIGIN || /(^|\.)google\.|chatgpt\.com|perplexity\.ai|microsoft\.com/.test(url.hostname)) {
        return route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><title>Not found</title><p>No fixture for this address.</p>' });
      }
      seen.served = 'blocked';
      return route.abort();
    });

    const watch = (page: Page) => {
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`[console] ${page.url().slice(0, 60)}: ${message.text()}`);
      });
      page.on('pageerror', (error) => errors.push(`[exception] ${page.url().slice(0, 60)}: ${error.message}`));
    };
    context.on('page', watch);
    for (const page of context.pages()) watch(page);

    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    worker.on('console', (message) => {
      if (message.type() === 'error') errors.push(`[service worker] ${message.text()}`);
    });
    const extensionId = new URL(worker.url()).host;
    // Uncaught errors in the service worker are not console messages: collect them inside the worker.
    await worker.evaluate(() => {
      const scope = self as unknown as { __lensErrors?: string[] } & typeof globalThis;
      if (scope.__lensErrors) return;
      const collected: string[] = (scope.__lensErrors = []);
      scope.addEventListener('error', (event) => collected.push(`[service worker] uncaught: ${(event as ErrorEvent).message}`));
      scope.addEventListener('unhandledrejection', (event) => {
        const reason = (event as PromiseRejectionEvent).reason as { message?: string } | undefined;
        collected.push(`[service worker] unhandled rejection: ${reason?.message ?? String(reason)}`);
      });
    });

    // Installing opens the onboarding page; wait for it so later "active tab" lookups are stable.
    const onboarding = context.pages().find((p) => p.url().includes('onboarding.html')) ?? (await context.waitForEvent('page', { predicate: (p) => p.url().includes('onboarding.html'), timeout: 15_000 }).catch(() => null));
    await onboarding?.waitForLoadState('domcontentloaded').catch(() => undefined);

    const browser = context.browser();
    let cdp: CDPSession | null = null;
    const tabIds = new WeakMap<Page, number>();
    const activeTabId = () =>
      worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return tab?.id ?? -1;
      });

    const lens: Lens = {
      context,
      worker,
      extensionId,
      extensionDir,
      requests,
      errors,
      legiit,
      async open(url) {
        // Without the "tabs" permission the extension cannot match a tab to an address, so the new tab is
        // recognised as the one that was not there before, once Chrome reports it as the active tab.
        const before = await worker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.id));
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'load' });
        await page.bringToFront();
        let tabId = -1;
        await expect
          .poll(
            async () => {
              tabId = await activeTabId();
              return tabId > 0 && !before.includes(tabId);
            },
            { message: 'the opened page becomes the active tab', timeout: 10_000 },
          )
          .toBe(true);
        tabIds.set(page, tabId);
        return { page, tabId };
      },
      async openPanel(tabId, view) {
        const page = await context.newPage();
        await page.setViewportSize({ width: 420, height: 900 });
        await page.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${tabId}${view ? `&view=${view}` : ''}`);
        await page.getByTestId('target-line').or(page.getByText('No page to look at')).first().waitFor();
        return page;
      },
      async openExtensionPage(path) {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/${path}`);
        return page;
      },
      async invoke(page) {
        if (!browser) throw new Error('Browser handle is not available');
        // A toolbar click always lands on the tab the user is looking at; Chrome grants activeTab to the active tab only.
        // Bringing a tab to the front is not instant on a busy machine, so wait until Chrome agrees.
        await page.bringToFront();
        const expected = tabIds.get(page);
        if (expected !== undefined) await expect.poll(activeTabId, { message: 'the page is the active tab before the action is triggered', timeout: 10_000 }).toBe(expected);
        cdp ??= await browser.newBrowserCDPSession();
        const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
        const target = targetInfos.find((t) => t.type === 'tab' && t.url === page.url());
        if (!target) throw new Error(`No tab target for ${page.url()}`);
        await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
        if (expected === undefined || !/^https?:/.test(page.url())) return;
        // Chrome's own view of the result: from now on the extension may run a script in this tab.
        // (Asked from the service worker, so the side panel's own logic is not involved.)
        const granted = () =>
          worker.evaluate(
            (id) =>
              chrome.scripting.executeScript({ target: { tabId: id }, func: () => true }).then(
                () => true,
                (error: Error) => error.message,
              ),
            expected,
          );
        await expect.poll(granted, { message: 'Chrome granted activeTab for the invoked tab', timeout: 5_000 }).toBe(true);
      },
      async setSettings(settings) {
        await worker.evaluate(async (value) => chrome.storage.local.set({ settings: value }), settings);
      },
      async trackScenarioBrands() {
        await lens.setSettings({
          myBrands: [{ id: 'me', name: scenario.me.name, domains: [scenario.me.domain], aliases: scenario.me.aliases, source: 'manual' }],
          competitors: scenario.competitors.map((c, i) => ({ id: `c${i + 1}`, name: c.name, domains: [c.domain], aliases: c.aliases, source: 'manual' })),
          agency: { name: 'North Star SEO', logoDataUrl: null },
        });
      },
      extensionRequests() {
        return requests.filter((r) => !isUsersOwnBrowsing(r));
      },
      async stripText(page) {
        const found = await stripShadow(context, page);
        if (!found) return null;
        await found.cdp.detach();
        return textOf(found.shadow).replace(/\s+/g, ' ').trim();
      },
      async clickStrip(page, label) {
        const found = await stripShadow(context, page);
        if (!found) throw new Error('The strip is not on the page');
        const button = findNode(found.shadow, (n) => n.nodeName === 'BUTTON' && textOf(n).trim() === label);
        if (!button) throw new Error(`No "${label}" button in the strip`);
        const { model } = (await found.cdp.send('DOM.getBoxModel', { nodeId: button.nodeId })) as { model: { content: number[] } };
        const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number, number, number];
        await found.cdp.detach();
        await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
      },
      async realSidePanelOpen() {
        if (!browser) return false;
        cdp ??= await browser.newBrowserCDPSession();
        const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
        return targetInfos.some((t) => t.url === `chrome-extension://${extensionId}/sidepanel.html`);
      },
      async downloadText(page, trigger) {
        const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
        const path = await download.path();
        return { name: download.suggestedFilename(), text: readFileSync(path, 'utf8') };
      },
      async allErrors() {
        const fromWorker = await worker.evaluate(() => (self as unknown as { __lensErrors?: string[] }).__lensErrors ?? ['[service worker] was restarted: its error log is gone']);
        return [...errors, ...fromWorker];
      },
    };

    await use(lens);

    await context.close();
    rmSync(profile, { recursive: true, force: true });
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  },
});

export { expect };
