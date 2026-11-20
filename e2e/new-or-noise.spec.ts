/**
 * New or Noise, with the real bundled model running inside the extension.
 * The comparison pages are fetched by the extension, which needs an optional
 * host permission; these tests run against a copy of the build that already
 * holds it for the fixture domains (see lens.ts).
 */
import { expect, scenario, test } from './lens';

const TARGET = scenario.urls.targetArticle!;
const ONLY_HERE = [
  'At BrightPath Dental we use an air-polishing system that lifts stains without scraping.',
  'Our South Austin hygienists book fifty-minute appointments so nobody is rushed.',
  'In our 2025 patient survey, 68 percent of patients on a four-month schedule reported less bleeding when flossing.',
  'We send a text reminder three weeks before you are due, with a link to pick your own time.',
];
const COMPARISON_URLS = [
  'https://www.capitoldentalcare.example/blog/how-often-teeth-cleaning',
  'https://www.familydentalfacts.example/how-often-dental-cleaning',
  'https://www.lakesidesmiles.example/blog/dental-cleaning-schedule',
  'https://www.nationaloralhealth.example/cleanings',
  'https://www.smilehealthdaily.example/teeth-cleaning-frequency',
];

test.describe('New or Noise (sites granted)', () => {
  test.use({ grantFixtureSites: true });

  test('classifies the sentences of a page against the open results with the on-device model', async ({ lens }) => {
    await lens.open(scenario.urls.serpPlain!);
    const { page, tabId } = await lens.open(TARGET);
    const panel = await lens.openPanel(tabId, 'noise');
    await lens.invoke(page);

    // The target keyword defaults to the page title, and the matching open results page is offered.
    await expect(panel.getByTestId('noise-keyword')).toHaveValue('How Often Should You Get Your Teeth Cleaned');
    await expect(panel.getByTestId('noise-results-select')).toContainText('“how often should you get your teeth cleaned” — open results page, 8 results');
    // The page's own site is left out of the comparison set.
    await expect(panel.getByText('7 pages will be read')).toBeVisible();

    await panel.getByTestId('noise-run').click();
    const result = panel.getByTestId('noise-result');
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByTestId('noise-fallback')).toHaveCount(0);
    await expect(panel.getByTestId('noise-method')).toContainText('on-device sentence embeddings (all-MiniLM-L6-v2)');
    await expect(panel.getByTestId('noise-method')).toContainText('scores 0.72 or higher');
    await expect(result).toContainText('5 pages');
    await expect(result).toContainText('“most” = 3 or more');

    // The four first-hand statements are the only sentences nobody else makes.
    await expect(panel.getByTestId('sentence-only')).toHaveCount(4);
    const only = (await panel.getByTestId('sentence-only').allInnerTexts()).map((t) => t.split('\n')[0]);
    expect(only).toEqual(ONLY_HERE);
    const share = Number((await panel.getByTestId('noise-only-share').innerText()).match(/(\d+)%/)![1]);
    expect(share).toBeGreaterThan(40);
    expect(share).toBeLessThan(60);
    await expect(panel.getByTestId('sentence-most').filter({ hasText: 'every six months' })).toHaveCount(1);
    await expect(panel.getByTestId('sentence-some').filter({ hasText: 'insurance plans cover two cleanings' })).toHaveCount(1);

    // What most competing pages cover and this page does not.
    await expect(panel.getByTestId('noise-missing')).toContainText('X-rays');
    // Two results have no page behind them: reported, not fatal.
    const pages = panel.getByTestId('noise-pages');
    await expect(pages.getByText('Read', { exact: true })).toHaveCount(5);
    await expect(pages.getByText('The site answered 404')).toHaveCount(2);

    // The filter narrows the list.
    await panel.getByTestId('noise-filter').selectOption('only');
    await expect(panel.getByTestId('sentence-most')).toHaveCount(0);
    await expect(panel.getByTestId('sentence-only')).toHaveCount(4);

    // Network: the comparison pages, fetched once each by the panel. The model and its runtime come from the package.
    const fetched = lens.extensionRequests().filter((r) => r.from.startsWith('chrome-extension://'));
    expect(fetched.map((r) => r.url).sort()).toEqual(
      [...COMPARISON_URLS, 'https://www.texasdentalboard.example/patients/cleanings', 'https://www.zilkerfamilydentistry.example/blog/cleaning-faq'].sort(),
    );
    expect(lens.requests.filter((r) => /huggingface|jsdelivr|cdn\./.test(r.host))).toEqual([]);
    expect(lens.requests.filter((r) => r.served === 'blocked')).toEqual([]);
    expect(lens.errors.filter((e) => !e.includes('404 (Not Found)'))).toEqual([]);
  });

  test('highlights the classes on the live page without changing its DOM', async ({ lens }) => {
    await lens.open(scenario.urls.serpPlain!);
    const { page, tabId } = await lens.open(TARGET);
    const panel = await lens.openPanel(tabId, 'noise');
    await lens.invoke(page);
    await panel.getByTestId('noise-run').click();
    await expect(panel.getByTestId('noise-result')).toBeVisible({ timeout: 60_000 });

    const domBefore = await page.evaluate(() => document.documentElement.outerHTML);
    await page.bringToFront();
    const shotBefore = await page.screenshot();

    await panel.getByTestId('noise-highlight').click();
    await expect(panel.getByTestId('noise-highlight-status')).toContainText('the CSS Custom Highlight API, which does not change the page’s structure');
    const applied = Number((await panel.getByTestId('noise-highlight-status').innerText()).match(/Highlighted (\d+) sentence/)![1]);
    const total = await panel.getByTestId('noise-sentences').locator('.sentence').count();
    expect(applied).toBe(total);

    // Registered highlights are visible from the page itself; the DOM is byte-for-byte the same.
    const state = await page.evaluate(() => {
      const registry = (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights;
      const paragraph = document.querySelector('article p, main p')!;
      return {
        names: [...registry.keys()].sort(),
        only: registry.get('legiit-lens-only')?.size ?? 0,
        colour: getComputedStyle(paragraph, '::highlight(legiit-lens-only)').backgroundColor,
        html: document.documentElement.outerHTML,
      };
    });
    expect(state.names).toEqual(['legiit-lens-most', 'legiit-lens-only', 'legiit-lens-some']);
    expect(state.only).toBe(4);
    expect(state.colour).toBe('rgba(52, 211, 153, 0.45)');
    expect(state.html).toBe(domBefore);
    await page.bringToFront();
    const shotDuring = await page.screenshot();
    expect(shotDuring.equals(shotBefore)).toBe(false);

    // Removing the highlights puts the page back exactly as it was.
    await panel.bringToFront();
    await panel.getByTestId('noise-highlight').click();
    await expect(panel.getByTestId('noise-highlight-status')).toHaveCount(0);
    expect(await page.evaluate(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.size)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(domBefore);
    await page.bringToFront();
    expect((await page.screenshot()).equals(shotBefore)).toBe(true);
    expect(lens.errors.filter((e) => !e.includes('404 (Not Found)'))).toEqual([]);
  });

  test('exports the sentences as CSV', async ({ lens }) => {
    await lens.open(scenario.urls.serpPlain!);
    const { page, tabId } = await lens.open(TARGET);
    const panel = await lens.openPanel(tabId, 'noise');
    await lens.invoke(page);
    await panel.getByTestId('noise-run').click();
    await expect(panel.getByTestId('noise-result')).toBeVisible({ timeout: 60_000 });

    const csv = await lens.downloadText(panel, () => panel.getByTestId('noise-export').click());
    expect(csv.name).toBe('new-or-noise-how-often-should-you-get-your-teeth-cleaned.csv');
    const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('keyword,page,kind,class,pages_saying_this,pages_compared,best_similarity,words,text,closest_match_url');
    const sentenceRows = lines.filter((l) => l.includes(',sentence on page,'));
    expect(sentenceRows).toHaveLength(await panel.getByTestId('noise-sentences').locator('.sentence').count());
    expect(sentenceRows.filter((l) => l.includes(',Only here,'))).toHaveLength(4);
    expect(sentenceRows[0]).toContain(`How Often Should You Get Your Teeth Cleaned,${TARGET},sentence on page,`);
    expect(lines.filter((l) => l.includes(',missing from page,Covered by most competitors,')).length).toBeGreaterThan(0);
  });

  test('checks pasted text against pasted URLs, with no page access at all', async ({ lens }) => {
    // A Google results tab is the "current tab": pasted mode does not need it.
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'noise');
    await panel.getByTestId('noise-mode-pasted').check();
    await panel.getByTestId('noise-paste').fill(
      'Most dentists recommend a professional cleaning every six months. Our clinic cat, Biscuit, greets every patient at the front desk on Tuesdays and Thursdays.',
    );
    await panel.getByTestId('noise-keyword').fill('teeth cleaning frequency');
    await panel.getByTestId('noise-source-urls').check();
    await panel.getByTestId('noise-urls').fill(`${COMPARISON_URLS.slice(0, 3).join('\n')}\nnot a url\njavascript:alert(1)`);
    await expect(panel.getByText('3 pages will be read')).toBeVisible();
    await panel.getByTestId('noise-run').click();

    await expect(panel.getByTestId('noise-result')).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByTestId('sentence-most')).toContainText('every six months');
    await expect(panel.getByTestId('sentence-only')).toContainText('Biscuit');
    // Nothing on a live page to highlight in this mode.
    await expect(panel.getByTestId('noise-highlight')).toHaveCount(0);
    expect(lens.errors).toEqual([]);
  });

  test('checks only the selected text when asked', async ({ lens }) => {
    await lens.open(scenario.urls.serpPlain!);
    const { page, tabId } = await lens.open(TARGET);
    const panel = await lens.openPanel(tabId, 'noise');
    await lens.invoke(page);
    await panel.getByTestId('noise-mode-selection').check();

    // Nothing selected yet: a clear message, no result.
    await panel.getByTestId('noise-run').click();
    await expect(panel.getByTestId('noise-error')).toHaveText('Select some text on the page first, then compare again.');

    await page.evaluate((needle) => {
      const paragraph = [...document.querySelectorAll('p')].find((p) => p.textContent?.includes(needle));
      if (!paragraph) throw new Error('fixture paragraph not found');
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, 'air-polishing system');
    await panel.getByTestId('noise-run').click();
    await expect(panel.getByTestId('noise-result')).toBeVisible({ timeout: 60_000 });
    const sentences = await panel.getByTestId('noise-sentences').locator('.sentence').count();
    expect(sentences).toBeGreaterThan(0);
    expect(sentences).toBeLessThan(6);
    await expect(panel.getByTestId('sentence-only').first()).toContainText('air-polishing system');
  });

  test('says where it cannot run and what it needs', async ({ lens }) => {
    // On a results page: this is a source, not a page to check.
    const serp = await lens.open(scenario.urls.serpPlain!);
    const onSerp = await lens.openPanel(serp.tabId, 'noise');
    await expect(onSerp.getByTestId('noise-wrong-page')).toBeVisible();
    await expect(onSerp.getByTestId('noise-run')).toBeDisabled();
    await serp.page.close();

    // No results page open and nothing saved: the panel asks for one, or for URLs.
    const { page, tabId } = await lens.open(TARGET);
    const panel = await lens.openPanel(tabId, 'noise');
    await lens.invoke(page);
    await expect(panel.getByTestId('noise-no-results')).toBeVisible();
    await expect(panel.getByTestId('noise-run')).toBeDisabled();

    // Every comparison page fails: an error, not a wrong answer.
    await panel.getByTestId('noise-source-urls').check();
    await panel.getByTestId('noise-urls').fill('https://www.texasdentalboard.example/patients/cleanings');
    await panel.getByTestId('noise-run').click();
    await expect(panel.getByTestId('noise-error')).toHaveText('None of the comparison pages could be read.');
  });
});

test.describe('New or Noise without the model', () => {
  test.use({ grantFixtureSites: true, removeModel: true });

  test('falls back to word overlap and says so', async ({ lens }) => {
    await lens.open(scenario.urls.serpPlain!);
    const { page, tabId } = await lens.open(TARGET);
    const panel = await lens.openPanel(tabId, 'noise');
    await lens.invoke(page);
    await panel.getByTestId('noise-run').click();

    await expect(panel.getByTestId('noise-result')).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByTestId('noise-fallback')).toContainText('The on-device model could not be loaded');
    await expect(panel.getByTestId('noise-fallback')).toContainText('compared by shared words instead, which misses paraphrases');
    await expect(panel.getByTestId('noise-method')).toContainText('word overlap');
    await expect(panel.getByTestId('noise-method')).toContainText('scores 0.5 or higher');
    // Still useful: the first-hand statements are still "only here".
    const only = (await panel.getByTestId('sentence-only').allInnerTexts()).map((t) => t.split('\n')[0]);
    for (const sentence of ONLY_HERE) expect(only).toContain(sentence);
    // The failed model load did not go looking for the model anywhere else.
    expect(lens.requests.filter((r) => /huggingface|jsdelivr/.test(r.host))).toEqual([]);
    expect(lens.requests.filter((r) => r.served === 'blocked')).toEqual([]);
  });
});

test.describe('New or Noise (no sites granted)', () => {
  test('explains the permission it will ask for before fetching anything', async ({ lens }) => {
    await lens.open(scenario.urls.serpPlain!);
    const { page, tabId } = await lens.open(TARGET);
    const panel = await lens.openPanel(tabId, 'noise');
    await lens.invoke(page);
    await expect(panel.getByTestId('permission-line')).toContainText('Chrome will ask to let Legiit Lens read these 7 sites');
    await expect(panel.getByTestId('permission-line')).toContainText('to compare them with your page');
    // Nothing has been fetched by the extension so far.
    expect(lens.extensionRequests()).toEqual([]);
  });
});
