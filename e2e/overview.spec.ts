/** The Overview: the first screen of the panel, in plain words, on every kind of page. */
import { expect, scenario, test } from './lens';

const U = scenario.urls;

test.describe('Overview', () => {
  test('says where the user stands on a results page and what to do next', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { tabId } = await lens.open(U.serpFull!);
    const panel = await lens.openPanel(tabId);

    await expect(panel.getByTestId('tab-overview')).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByTestId('overview-headline')).toHaveText('You are #6 for “best dentist in austin”.');
    const answer = panel.getByTestId('overview-answer');
    await expect(answer).toContainText('This search: very crowded');
    await expect(answer).toContainText('Your result is about 3 screens down');
    await expect(answer).toContainText("Google's AI answer names Lakeside Smiles, Capitol Dental Care and Zilker Family Dentistry, not you.");
    await expect(answer).toContainText('2 ads, the AI answer and a map of local businesses come before the first result');
    // Plain words only: nothing a searcher would not say.
    expect(await answer.innerText()).not.toMatch(/\bpx\b|\bfold\b|organic|\bgrade\b/i);

    // Three next steps, each with the tool that does it and a page on Legiit where it can be bought.
    const steps = panel.getByTestId('overview-steps');
    await expect(steps.locator('li')).toHaveCount(3);
    await expect(panel.getByTestId('step-lists')).toContainText('3 pages that look like “best of” lists rank here');
    await expect(panel.getByTestId('step-lists').getByRole('link')).toHaveAttribute('href', 'https://legiit.com/categories/seo/guest-posts');
    await expect(panel.getByTestId('step-ai-sources').getByRole('link')).toHaveAttribute('href', 'https://legiit.com/categories/seo/backlinks');
    await expect(panel.getByTestId('step-local').getByRole('link')).toHaveAttribute('href', 'https://legiit.com/categories/seo/local-seo');

    // The search is remembered by itself.
    const keywords = panel.getByTestId('overview-keywords');
    await expect(keywords.getByTestId('keyword-row')).toHaveCount(1);
    await expect(keywords.getByTestId('keyword-row')).toContainText('best dentist in austin');
    await expect(keywords.getByTestId('keyword-row')).toContainText('#6');
    await expect(keywords.getByTestId('keyword-row')).toContainText('Not in the AI answer');
    await expect(keywords.getByRole('link', { name: 'best dentist in austin' })).toHaveAttribute('href', 'https://www.google.com/search?q=best%20dentist%20in%20austin');

    // A step opens its tool; the tools have names that say what they give.
    await panel.getByTestId('step-open-lists').click();
    await expect(panel.getByTestId('panel-why')).toBeVisible();
    await expect(panel.getByTestId('tab-why')).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByTestId('tab-why')).toHaveText('Who’s beating me');
    await expect(panel.getByTestId('tab-click')).toHaveText('This search');
    await expect(panel.getByTestId('tab-noise')).toHaveText('Content check');
    await expect(panel.getByTestId('tab-rewind')).toHaveText('What changed');

    // Back on the Overview, "See the whole page" opens the measurements.
    await panel.getByTestId('tab-overview').click();
    await panel.getByTestId('overview-details').click();
    await expect(panel.getByTestId('panel-click')).toBeVisible();
    await expect(panel.getByTestId('cp-grade')).toContainText('Very crowded');

    // Reading a results page, and remembering it, asks nothing of anyone.
    expect(lens.extensionRequests()).toEqual([]);
    expect(lens.errors).toEqual([]);
  });

  test('asks one thing when it does not know the user: which site is theirs', async ({ lens }) => {
    const { tabId } = await lens.open(U.serpFull!);
    const panel = await lens.openPanel(tabId);

    // Without a site, it describes the page and does not speak about "you".
    await expect(panel.getByTestId('overview-headline')).toHaveText('9 results for “best dentist in austin”. The first is from austinhealthguide.example.');
    await expect(panel.getByTestId('overview-steps')).toHaveCount(0);
    await expect(panel.getByTestId('overview-my-site')).toBeVisible();
    await expect(panel.getByTestId('my-site-save')).toBeDisabled();

    // One field, typed any way people type a site.
    await panel.getByTestId('my-site-input').fill('https://www.BrightPathDental.example/about');
    await panel.getByTestId('my-site-save').click();
    await expect(panel.getByTestId('overview-my-site')).toHaveCount(0);
    await expect(panel.getByTestId('overview-headline')).toHaveText('You are #6 for “best dentist in austin”.');
    await expect(panel.getByTestId('overview-steps').locator('li')).not.toHaveCount(0);
    // It is an ordinary brand in Settings from then on.
    await panel.getByTestId('tab-settings').click();
    await expect(panel.getByTestId('panel-settings')).toContainText('My brands');
    await expect(panel.locator('input[value="brightpathdental.example"]')).toHaveCount(1);
  });

  test('says it plainly when the user is not on the page, in the panel and on the page itself', async ({ lens }) => {
    await lens.setSettings({ myBrands: [{ id: 'me', name: 'Northgate Dental', domains: ['northgatedental.example'], aliases: [], source: 'manual' }], competitors: [], agency: { name: '', logoDataUrl: null } });
    const { page, tabId } = await lens.open(U.serpPlain!);
    await expect.poll(() => lens.stripText(page)).toContain('You not on this page');
    const panel = await lens.openPanel(tabId);
    await expect(panel.getByTestId('overview-headline')).toHaveText('You are not on page 1 for “how often should you get your teeth cleaned”.');
    await expect(panel.getByTestId('overview-answer')).toContainText('The top results are from capitoldentalcare.example, smilehealthdaily.example, lakesidesmiles.example and 5 more.');
    await expect(panel.getByTestId('overview-answer')).toContainText('This search: open');
    await expect(panel.getByTestId('keyword-row')).toContainText('Not on page 1');
    // The one next step works from here: the page to check is asked for, with the user's home page filled in.
    await panel.getByTestId('step-open-compare').click();
    await expect(panel.getByTestId('panel-noise')).toBeVisible();
    await expect(panel.getByTestId('noise-address')).toHaveValue('https://northgatedental.example/');
  });

  test('checks the basics of an ordinary page and points to the tools for it', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { page, tabId } = await lens.open(U.targetArticle!);
    const panel = await lens.openPanel(tabId);
    // Before the user asks, the page is not read: the panel says how to ask.
    await expect(panel.getByTestId('access-card')).toBeVisible();
    await expect(panel.getByTestId('overview-answer')).toHaveCount(0);

    await lens.invoke(page);
    await expect(panel.getByTestId('overview-headline')).toHaveText(/^(No basic problems on|\d+ things? to fix on) your page\.$/);
    await expect(panel.getByTestId('step-content')).toContainText('Check whether it says anything the pages it competes with do not.');
    await panel.getByTestId('step-open-history').click();
    await expect(panel.getByTestId('panel-rewind')).toBeVisible();
    await expect(panel.getByTestId('rewind-url')).toHaveValue(U.targetArticle!);
    expect(lens.extensionRequests()).toEqual([]);
  });

  test('has a place to start when there is no page to read, and keeps the keywords in view', async ({ lens }) => {
    await lens.trackScenarioBrands();
    // Two searches the user looked at.
    for (const url of [U.serpFull!, U.serpPlain!]) {
      const serp = await lens.open(url);
      const onSerp = await lens.openPanel(serp.tabId);
      await expect(onSerp.getByTestId('keyword-row').first()).toBeVisible();
      await onSerp.close();
    }
    const blank = await lens.open(U.plainPage!);
    const panel = await lens.openPanel(blank.tabId);
    const rows = panel.getByTestId('keyword-row');
    await expect(rows).toHaveCount(2);
    // Newest first, each with the user's place.
    await expect(rows.nth(0)).toContainText('how often should you get your teeth cleaned');
    await expect(rows.nth(0)).toContainText('#5');
    await expect(rows.nth(0)).toContainText('No AI answer');
    await expect(rows.nth(1)).toContainText('best dentist in austin');
    await expect(rows.nth(1)).toContainText('#6');
  });
});
