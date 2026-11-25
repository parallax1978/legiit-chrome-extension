/**
 * DEFINITION OF DONE: "The only network destinations are web.archive.org,
 * pages fetched after an explicit permission grant, and the Legiit host when
 * connected. Prove it with a test."
 *
 * How the proof works. The harness (lens.ts) routes every http(s) request of
 * the whole browser profile: web pages, extension pages, content scripts,
 * workers and the extension's service worker. Nothing reaches the real
 * network; every request is recorded with who made it. The first test checks
 * that the recorder really sees each kind of requester, so that "no request"
 * in the later tests means no request. The rest drive every feature and
 * compare what was requested with what is allowed.
 */
import type { Page } from '@playwright/test';
import { expect, fixtureManifest, LEGIIT_ORIGIN, scenario, test, WAYBACK_ORIGIN, type Lens, type SeenRequest } from './lens';

const U = scenario.urls;
const origin = (url: string) => new URL(url).origin;
const describe = (r: SeenRequest) => `${r.method} ${r.url} (from ${r.from || 'unknown'})`;

/** Requests the extension made that are not allowed by the rule under test. */
function violations(lens: Lens, allowed: (r: SeenRequest) => boolean): string[] {
  return lens.extensionRequests().filter((r) => !allowed(r)).map(describe);
}

const isWayback = (r: SeenRequest) => r.url.startsWith(`${WAYBACK_ORIGIN}/cdx/search/cdx?`) || /^https:\/\/web\.archive\.org\/web\/\d{14}id_\//.test(r.url);
/** A request made inside a web page, to that page's own site (Instant Brief reading the site the user invoked it on). */
const isOwnSite = (r: SeenRequest) => /^https?:/.test(r.from) && origin(r.from) === origin(r.url);
const isLegiit = (r: SeenRequest) => r.url.startsWith(`${LEGIIT_ORIGIN}/v1/`);
const fromExtensionPage = (r: SeenRequest) => r.from.startsWith('chrome-extension://');

/** Uses every feature the way a person without an account and without any site grant can. */
async function useEverything(lens: Lens, options: { brandsAlreadyTracked?: boolean } = {}): Promise<{ invokedOrigins: string[] }> {
  if (!options.brandsAlreadyTracked) await lens.trackScenarioBrands();

  // Google results, in every fixture state, with the strip; the panel on one of them.
  for (const url of [U.serpFull!, U.serpPlain!, U.serpFeatured!, U.serpLocal!, U.serpChurn!, U.serpAiMode!, U.serpUnrecognised!]) await lens.open(url);
  const serp = await lens.open(U.serpFull!);
  await expect.poll(() => lens.stripText(serp.page)).toContain('Click potential');
  const onSerp = await lens.openPanel(serp.tabId, 'click');
  await expect(onSerp.getByTestId('history-table')).toBeVisible();
  await lens.downloadText(onSerp, () => onSerp.getByTestId('cp-export').click());
  await onSerp.getByTestId('tab-why').click();
  await expect(onSerp.getByTestId('wnm-gaps')).toBeVisible();
  await lens.downloadText(onSerp, () => onSerp.getByTestId('gap-export').click());

  // AI answers on all four sites.
  for (const url of [U.chatgpt!, U.gemini!, U.perplexity!, U.copilot!, U.chatgptUnrecognised!]) {
    const answer = await lens.open(url);
    const panel = await lens.openPanel(answer.tabId, 'why');
    await expect(panel.getByTestId('panel-why')).toBeVisible();
    await panel.close();
  }

  // An ordinary page: invoke the extension, look up its history, build a brief.
  const article = await lens.open(U.rewindPage!);
  const onArticle = await lens.openPanel(article.tabId, 'rewind');
  await lens.invoke(article.page);
  await onArticle.getByTestId('rewind-load').click();
  await expect(onArticle.getByTestId('rewind-timeline')).toBeVisible();

  const site = await lens.open(U.site!);
  const onSite = await lens.openPanel(site.tabId, 'brief');
  await lens.invoke(site.page);
  await onSite.getByTestId('brief-build').click();
  await expect(onSite.getByTestId('brief-result')).toBeVisible();
  await lens.downloadText(onSite, () => onSite.getByTestId('brief-markdown').click());

  // New or Noise up to the point where Chrome would ask for permission.
  const target = await lens.open(U.targetArticle!);
  const onTarget = await lens.openPanel(target.tabId, 'noise');
  await lens.invoke(target.page);
  await expect(onTarget.getByTestId('permission-line')).toBeVisible();

  // The extension's own pages.
  for (const path of ['options.html', 'onboarding.html', 'health.html']) await lens.openExtensionPage(path);
  return { invokedOrigins: [origin(U.rewindPage!), origin(U.site!), origin(U.targetArticle!)] };
}

/** Stands in for the user's answer to Chrome's permission prompt, which automation cannot click. */
async function answerPermissionPrompt(panel: Page, granted: boolean): Promise<void> {
  await panel.evaluate((answer) => {
    chrome.permissions.request = (() => Promise.resolve(answer)) as typeof chrome.permissions.request;
  }, granted);
}

test.describe('network destinations', () => {
  test('the recorder sees requests from every part of the extension', async ({ lens }) => {
    const probe = `${WAYBACK_ORIGIN}/cdx/search/cdx?url=probe.example&probe=`;
    // Service worker.
    await lens.worker.evaluate((url) => fetch(url).then(() => undefined, () => undefined), `${probe}worker`);
    // Extension page.
    const options = await lens.openExtensionPage('options.html');
    await options.evaluate((url) => fetch(url).then(() => undefined, () => undefined), `${probe}page`);
    // A web page (content scripts share the page's network stack and show up the same way).
    const { page } = await lens.open(U.plainPage!);
    await page.evaluate(() => fetch('/probe-from-page').then(() => undefined, () => undefined));
    // A host nobody expects is cut off and recorded as such.
    await options.evaluate(() => fetch('https://unexpected-host.test/collect').then(() => undefined, () => undefined));

    const seen = (suffix: string) => lens.requests.find((r) => r.url.endsWith(suffix));
    expect(seen('probe=worker')).toMatchObject({ from: 'service-worker' });
    expect(seen('probe=page')?.from).toMatch(/^chrome-extension:\/\/[a-p]{32}\/options\.html$/);
    expect(seen('/probe-from-page')).toMatchObject({ from: U.plainPage, resourceType: 'fetch' });
    expect(seen('/collect')).toMatchObject({ served: 'blocked', host: 'unexpected-host.test' });
    // extensionRequests() keeps all four: none of them is "the user's own browsing".
    expect(lens.extensionRequests().map((r) => r.url).filter((u) => /probe|collect/.test(u))).toHaveLength(4);
  });

  test('without an account and without site grants, only web.archive.org and the site being analyzed are contacted', async ({ lens }) => {
    const { invokedOrigins } = await useEverything(lens);

    expect(violations(lens, (r) => isWayback(r) || isOwnSite(r))).toEqual([]);

    const made = lens.extensionRequests();
    // Rewind: the capture index and captures, fetched by the panel.
    const wayback = made.filter(isWayback);
    expect(wayback.length).toBeGreaterThan(2);
    expect(wayback.every(fromExtensionPage)).toBe(true);
    expect(wayback.every((r) => r.method === 'GET' && !r.authorization && r.body === null)).toBe(true);
    // Instant Brief: pages of the site the user invoked the extension on, fetched inside that tab.
    const ownSite = made.filter(isOwnSite);
    expect(ownSite.length).toBeGreaterThan(3);
    expect(ownSite.every((r) => invokedOrigins.includes(origin(r.url)) && r.method === 'GET')).toBe(true);
    // Nothing else: not Legiit, not Google, not an AI site, not a model host, nothing from the service worker.
    expect(made.filter((r) => r.url.startsWith(LEGIIT_ORIGIN))).toEqual([]);
    expect(lens.legiit.requests).toEqual([]);
    expect(made.filter((r) => /google\.|chatgpt\.com|perplexity\.ai|microsoft\.com|huggingface|jsdelivr/.test(r.host))).toEqual([]);
    expect(lens.requests.filter((r) => r.from === 'service-worker')).toEqual([]);
    expect(lens.requests.filter((r) => r.served === 'blocked')).toEqual([]);
    // No request carried data out: every one is a GET without a body.
    expect(made.filter((r) => r.method !== 'GET' || r.body !== null)).toEqual([]);
    // And nothing went wrong anywhere on the way: pages, content scripts, side panel, service worker.
    expect(await lens.allErrors()).toEqual([]);
  });

  test('errors would be noticed: in a page, in a content script’s page, and in the service worker', async ({ lens }) => {
    const { page } = await lens.open(U.plainPage!);
    await page.evaluate(() => console.error('deliberate page error'));
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('deliberate uncaught page error');
      }, 0);
    });
    await lens.worker.evaluate(() => {
      console.error('deliberate worker console error');
      void Promise.reject(new Error('deliberate worker rejection'));
    });
    await page.waitForTimeout(300);
    const all = (await lens.allErrors()).join('\n');
    expect(all).toContain('deliberate page error');
    expect(all).toContain('deliberate uncaught page error');
    expect(all).toContain('deliberate worker console error');
    expect(all).toContain('unhandled rejection: deliberate worker rejection');
  });

  test('Google and AI pages are only read: the content scripts send nothing', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const pages = [U.serpFull!, U.serpPlain!, U.serpLocal!, U.serpAiMode!, U.chatgpt!, U.gemini!, U.perplexity!, U.copilot!];
    for (const url of pages) {
      const { page, tabId } = await lens.open(url);
      const panel = await lens.openPanel(tabId, 'why');
      await expect(panel.getByTestId('panel-why')).toBeVisible();
      // No navigation or reload was triggered by the extension either.
      expect(page.url()).toBe(url);
    }
    expect(lens.extensionRequests().map(describe)).toEqual([]);
    // The user's own browsing was the only traffic: one document per page opened.
    const documents = lens.requests.filter((r) => r.resourceType === 'document' && /^https:/.test(r.url));
    expect(documents.map((r) => r.url)).toEqual(pages);
  });

  test('a page cannot make the extension fetch for it, and the site reader stays on its site', async ({ lens }) => {
    const { page, tabId } = await lens.open(U.site!);
    const panel = await lens.openPanel(tabId, 'brief');
    await lens.invoke(page);
    await expect(panel.getByTestId('brief-build')).toBeEnabled();
    const before = lens.extensionRequests().length;

    // The in-page reader refuses addresses on other sites, including the allowed hosts.
    const reply = await panel.evaluate(
      (id) =>
        chrome.tabs.sendMessage(id, {
          type: 'lens:fetch-same-origin',
          urls: ['https://www.lakesidesmiles.example/', 'https://web.archive.org/web/2024/https://example.com/', 'https://lens.legiit.com/v1/session', 'javascript:alert(1)'],
        }) as Promise<{ pages: { ok: boolean; error: string | null }[] }>,
      tabId,
    );
    expect(reply.pages.map((p) => [p.ok, p.error])).toEqual([
      [false, 'Not on this site'],
      [false, 'Not on this site'],
      [false, 'Not on this site'],
      [false, 'Not on this site'],
    ]);

    // Messages from the web page itself never reach the agent or the service worker.
    await page.evaluate(() => {
      window.postMessage({ type: 'lens:fetch-same-origin', urls: ['https://www.lakesidesmiles.example/'] }, '*');
      window.postMessage({ type: 'lens:get-page' }, '*');
    });
    expect(await page.evaluate(() => typeof (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome?.runtime?.sendMessage)).toBe('undefined');
    await page.waitForTimeout(300);
    expect(lens.extensionRequests()).toHaveLength(before);
  });

  test('connecting a Legiit account adds exactly one destination, the Legiit API', async ({ lens }) => {
    const options = await lens.openExtensionPage('options.html');
    await options.getByTestId('legiit-token').fill('demo-token');
    await options.getByTestId('legiit-connect').click();
    await options.getByTestId('legiit-business').selectOption('biz_brightpath');
    await expect(options.getByText(/were pre-filled from/)).toBeVisible();

    // The same brands, this time pre-filled from the account's Business Details.
    await useEverything(lens, { brandsAlreadyTracked: true });
    const serp = await lens.open(U.serpFull!);
    const panel = await lens.openPanel(serp.tabId, 'click');
    await panel.getByTestId('save-saveVisibilitySnapshot').click();
    await panel.getByTestId('save-confirm').click();
    await expect(panel.getByTestId('save-result')).toContainText('Saved');

    expect(violations(lens, (r) => isWayback(r) || isOwnSite(r) || isLegiit(r))).toEqual([]);
    const legiit = lens.extensionRequests().filter(isLegiit);
    expect(legiit.every((r) => fromExtensionPage(r) && r.authorization)).toBe(true);
    // The token never travels anywhere else.
    expect(lens.requests.filter((r) => r.authorization && !isLegiit(r))).toEqual([]);
    // One write, the one the user confirmed. Everything else was a read of the account's own data.
    expect(legiit.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['POST /v1/businesses/biz_brightpath/visibility-snapshots']);
    expect([...new Set(legiit.filter((r) => r.method === 'GET').map((r) => new URL(r.url).pathname))].sort()).toEqual(['/v1/businesses', '/v1/businesses/biz_brightpath', '/v1/industry-pulse', '/v1/session']);
    expect(lens.requests.filter((r) => r.from === 'service-worker')).toEqual([]);
    expect(lens.requests.filter((r) => r.served === 'blocked')).toEqual([]);
  });

  test('declining Chrome’s permission prompt means nothing is fetched', async ({ lens }) => {
    await lens.trackScenarioBrands();
    await lens.open(U.serpPlain!);
    const serp = await lens.open(U.serpFull!);

    const why = await lens.openPanel(serp.tabId, 'why');
    await answerPermissionPrompt(why, false);
    await why.getByTestId('scan-sources').click();
    await expect(why.getByTestId('scan-denied')).toBeVisible();

    const target = await lens.open(U.targetArticle!);
    const noise = await lens.openPanel(target.tabId, 'noise');
    await lens.invoke(target.page);
    await answerPermissionPrompt(noise, false);
    await noise.getByTestId('noise-run').click();
    await expect(noise.getByTestId('noise-denied')).toHaveText('Permission was not granted, so nothing was fetched.');

    expect(lens.extensionRequests().map(describe)).toEqual([]);
  });

  test('even if the panel believed access was granted, the network layer refuses a site Chrome has not granted', async ({ lens }) => {
    await lens.trackScenarioBrands();
    await lens.open(U.serpPlain!);
    const target = await lens.open(U.targetArticle!);
    const noise = await lens.openPanel(target.tabId, 'noise');
    await lens.invoke(target.page);
    // The prompt "says yes" but Chrome holds no permission for these sites.
    await answerPermissionPrompt(noise, true);
    await noise.getByTestId('noise-run').click();
    await expect(noise.getByTestId('noise-error')).toHaveText('None of the comparison pages could be read.');
    expect(lens.extensionRequests().map(describe)).toEqual([]);
    expect(await lens.worker.evaluate(() => chrome.permissions.contains({ origins: ['*://*.capitoldentalcare.example/*'] }))).toBe(false);
  });
});

test.describe('network destinations with sites granted', () => {
  test.use({ grantFixtureSites: true });

  test('scans and comparisons fetch only the pages listed, on sites Chrome has granted', async ({ lens }) => {
    await lens.trackScenarioBrands();
    await lens.open(U.serpPlain!);
    const serp = await lens.open(U.serpFull!);
    const why = await lens.openPanel(serp.tabId, 'why');
    await why.getByTestId('scan-sources').click();
    await expect(why.getByRole('button', { name: 'Scan again' })).toBeVisible({ timeout: 30_000 });
    await expect(why.getByTestId('scan-result').first()).toBeVisible();

    const target = await lens.open(U.targetArticle!);
    const noise = await lens.openPanel(target.tabId, 'noise');
    await lens.invoke(target.page);
    await noise.getByText(/pages will be read/).click();
    const listed = await noise.getByTestId('noise-compare').locator('details li').allInnerTexts();
    await noise.getByTestId('noise-run').click();
    await expect(noise.getByTestId('noise-result')).toBeVisible({ timeout: 60_000 });

    const made = lens.extensionRequests();
    expect(made.length).toBeGreaterThan(8);
    expect(made.every((r) => fromExtensionPage(r) && r.method === 'GET' && !r.authorization && r.body === null)).toBe(true);
    // Each one is a page of the results the user had open (the fixture set), on a site Chrome holds a permission for.
    const serpLinks = new Set([...(await serp.page.locator('a[href^="http"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href)))]);
    const comparison = new Set(listed);
    for (const request of made) {
      expect(serpLinks.has(request.url) || comparison.has(request.url), describe(request)).toBe(true);
      const granted = await lens.worker.evaluate((url) => chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] }), request.url);
      expect(granted, describe(request)).toBe(true);
    }
    expect(lens.requests.filter((r) => r.from === 'service-worker')).toEqual([]);
    expect(lens.requests.filter((r) => r.served === 'blocked')).toEqual([]);
    expect(fixtureManifest.routes.length).toBeGreaterThan(20);
  });

  test('the embedding worker cannot reach the network at all', async ({ lens }) => {
    await lens.open(U.serpPlain!);
    const target = await lens.open(U.targetArticle!);
    const noise = await lens.openPanel(target.tabId, 'noise');
    await lens.invoke(target.page);
    await noise.getByTestId('noise-run').click();
    await expect(noise.getByTestId('noise-result')).toBeVisible({ timeout: 60_000 });

    const [worker] = noise.workers();
    expect(worker, 'the embedding worker').toBeDefined();
    const before = lens.requests.length;
    const outcome = await worker!.evaluate(async () => {
      const attempt = (url: string) => fetch(url).then((r) => `fetched ${r.status}`, (e: Error) => e.message);
      return {
        hub: await attempt('https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/config.json'),
        archive: await attempt('https://web.archive.org/cdx/search/cdx?url=example.com'),
        own: await attempt('/models/Xenova/all-MiniLM-L6-v2/config.json'),
      };
    });
    expect(outcome.hub).toContain('Blocked: the embedding worker only loads files from the extension package');
    expect(outcome.archive).toContain('Blocked: the embedding worker only loads files from the extension package');
    expect(outcome.own).toBe('fetched 200');
    expect(lens.requests).toHaveLength(before);
  });
});
