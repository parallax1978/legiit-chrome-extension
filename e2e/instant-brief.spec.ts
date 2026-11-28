/** Instant Brief, built from the fixture business site after a real activeTab grant (no extra permissions). */
import { readFileSync } from 'node:fs';
import { expect, scenario, test } from './lens';

const SITE = scenario.urls.site!;

test.describe('Instant Brief', () => {
  test('builds a client brief from the site in the current tab', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { page, tabId } = await lens.open(SITE);
    const panel = await lens.openPanel(tabId, 'brief');
    await lens.invoke(page);

    await expect(panel.getByTestId('brief-disclosure')).toContainText('Reads up to 8 pages of brightpathdental.example');
    await expect(panel.getByTestId('brief-disclosure')).toContainText('Nothing is sent anywhere');
    await panel.getByTestId('brief-build').click();

    const result = panel.getByTestId('brief-result');
    await expect(result).toContainText('BrightPath Dental');
    await expect(result).toContainText('7 pages read');
    await expect(result).toContainText('built-in templates (no AI)');

    // Business
    const business = panel.getByTestId('brief-business');
    await expect(business).toContainText('(512) 555-0142');
    await expect(business).toContainText('hello@brightpathdental.example');
    await expect(business).toContainText('2410 South Lamar Blvd, Suite 120, Austin, TX 78704, US');
    await expect(business).toContainText('Dentist, LocalBusiness');
    await expect(business).toContainText('South Austin');
    await expect(business).toContainText('Facebook: https://www.facebook.example/brightpathdental');
    await expect(business).toContainText('Tone of voice');
    // Offer
    await expect(panel.getByTestId('brief-offer')).toContainText('Teeth whitening');
    await expect(panel.getByTestId('brief-offer')).toContainText('gentle dentistry in south austin');
    await expect(panel.getByTestId('brief-offer')).toContainText('I used to dread the dentist');
    // Customers: three avatars, labelled draft
    await expect(panel.getByTestId('brief-customers')).toContainText('Draft avatars');
    await expect(panel.getByTestId('brief-customers').locator('h3')).toHaveText(['Draft — The urgent need', 'Draft — The careful researcher', 'Draft — The regular']);
    // Competitors come from tracked brands
    await expect(panel.getByTestId('brief-competitors').first()).toContainText('Lakeside Smiles');
    // Issues planted in the fixture site
    await expect(panel.getByTestId('brief-issues')).toContainText('Missing meta description');
    await expect(panel.getByTestId('brief-issues')).toContainText('More than one H1 heading');
    await expect(panel.getByTestId('brief-next')).toContainText('Missing meta description (1 page).');

    // Brand colours measured on the live page, and the logo read as an image.
    await expect(panel.getByTestId('brief-colors')).toContainText('#0e7c86');
    await expect(panel.getByTestId('brief-logo')).toHaveAttribute('src', /^data:image\/png;base64,/);

    // The only requests: the site's own pages (and its logo), fetched from inside the tab. Nothing else.
    const requests = lens.extensionRequests();
    expect(requests.length).toBeGreaterThanOrEqual(6);
    expect(new Set(requests.map((r) => new URL(r.url).origin))).toEqual(new Set(['https://www.brightpathdental.example']));
    expect(requests.map((r) => new URL(r.url).pathname).sort()).toEqual(
      ['/about', '/assets/brightpath-logo.png', '/blog/how-often-teeth-cleaning', '/contact', '/locations', '/pricing', '/services'].sort(),
    );
    expect(requests.every((r) => r.from.startsWith('https://www.brightpathdental.example/'))).toBe(true);
    expect(lens.errors).toEqual([]);
  });

  test('reuses Click Potential and Why Not Me data in the Search presence section', async ({ lens }) => {
    await lens.trackScenarioBrands();
    // The user looked at a results page first; its snapshot is saved on the device.
    const serp = await lens.open(scenario.urls.serpFull!);
    await expect((await lens.openPanel(serp.tabId, 'click')).getByTestId('history-table')).toBeVisible();

    const { page, tabId } = await lens.open(SITE);
    const panel = await lens.openPanel(tabId, 'brief');
    await lens.invoke(page);
    await panel.getByTestId('brief-build').click();
    const search = panel.getByTestId('brief-search');
    await expect(search).toContainText('“best dentist in austin”');
    await expect(search).toContainText('Organic position #6 (below the fold)');
    await expect(search).toContainText('organic click potential F (0/100, estimate)');
    await expect(search).toContainText('Competitors present and the business absent in: AI Overview, Local pack, Forums, Ads');
    await expect(panel.getByTestId('brief-next')).toContainText('competitors appear in ai overview, local pack, forums, ads and BrightPath Dental does not');
  });

  test('lets the user add competitors by hand or pull them from an open results page', async ({ lens }) => {
    const serp = await lens.open(scenario.urls.serpLocal!);
    await expect.poll(() => lens.stripText(serp.page)).toContain('Click potential');
    const { page, tabId } = await lens.open(SITE);
    const panel = await lens.openPanel(tabId, 'brief');
    await lens.invoke(page);
    await panel.getByTestId('brief-build').click();
    await expect(panel.getByTestId('brief-competitors').last()).toContainText('No competitors have been added yet.');

    await panel.getByTestId('brief-competitor-name').fill('Lakeside Smiles');
    await panel.getByLabel('Competitor domain').fill('https://www.LakesideSmiles.example/about');
    await panel.getByTestId('brief-competitor-add').click();
    await panel.getByTestId('brief-pull-results').click();
    await expect(panel.getByText('Added 4 sites from “emergency dentist austin”')).toBeVisible();
    await panel.getByLabel('austinemergencydental.example').check();
    await panel.getByTestId('brief-update-competitors').click();

    const competitors = panel.getByTestId('brief-competitors').last();
    await expect(competitors).toContainText('Lakeside Smiles (lakesidesmiles.example)');
    await expect(competitors).toContainText('austinemergencydental.example');
    await expect(competitors).not.toContainText('nationaloralhealth.example');
  });

  test('exports Markdown with the agency name and no Legiit branding', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { page, tabId } = await lens.open(SITE);
    const panel = await lens.openPanel(tabId, 'brief');
    await lens.invoke(page);
    await panel.getByTestId('brief-build').click();
    await expect(panel.getByTestId('brief-result')).toBeVisible();

    const markdown = await lens.downloadText(panel, () => panel.getByTestId('brief-markdown').click());
    expect(markdown.name).toBe('client-brief-brightpath-dental.md');
    expect(markdown.text.split('\n')[0]).toBe('# Client brief: BrightPath Dental');
    expect(markdown.text).toContain('Prepared by North Star SEO');
    for (const heading of ['## Business', '## Offer', '## Customers', '## Competitors', '## Search presence', '## Issues', '## Next steps']) {
      expect(markdown.text).toContain(heading);
    }
    expect(markdown.text).not.toMatch(/legiit/i);
  });

  test('opens a print-ready page that produces a PDF with the agency name and logo', async ({ lens }) => {
    const logo = `data:image/png;base64,${readFileSync('fixtures/site/assets/brightpath-logo.png').toString('base64')}`;
    await lens.setSettings({ agency: { name: 'North Star SEO', logoDataUrl: logo } });
    const { page, tabId } = await lens.open(SITE);
    const panel = await lens.openPanel(tabId, 'brief');
    await lens.invoke(page);
    await panel.getByTestId('brief-build').click();
    await expect(panel.getByTestId('brief-result')).toBeVisible();

    const [print] = await Promise.all([lens.context.waitForEvent('page'), panel.getByTestId('brief-print').click()]);
    await expect(print.getByTestId('print-brief')).toContainText('Client brief: BrightPath Dental');
    await expect(print.getByTestId('print-brief')).toContainText('Prepared by North Star SEO');
    await expect(print.getByTestId('print-agency-logo')).toHaveAttribute('src', logo);
    await expect(print.getByTestId('print-button')).toBeVisible();
    expect(await print.getByTestId('print-brief').innerText()).not.toMatch(/legiit/i);
    expect(await print.title()).toBe('Client brief: BrightPath Dental');

    // The page prints to a real PDF (this is what "Save as PDF" in Chrome's print dialog produces).
    const pdf = await print.pdf({ format: 'A4', printBackground: true });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(20_000);
    expect(lens.errors).toEqual([]);
  });

  test('keeps briefs on the device and explains itself when it cannot run', async ({ lens }) => {
    const { page, tabId } = await lens.open(SITE);
    const panel = await lens.openPanel(tabId, 'brief');
    await expect(panel.getByTestId('brief-build')).toBeDisabled();
    await lens.invoke(page);
    await panel.getByTestId('brief-build').click();
    await expect(panel.getByTestId('brief-saved')).toContainText('BrightPath Dental');

    // On a Google results page there is no business site in the tab: the tab asks for the address of one.
    const serp = await lens.open(scenario.urls.serpPlain!);
    const other = await lens.openPanel(serp.tabId, 'brief');
    await expect(other.getByTestId('brief-address')).toHaveValue('');
    await expect(other.getByTestId('brief-build')).toBeDisabled();
    // A Google page is no business website, and is never requested.
    await other.getByTestId('brief-address').fill(scenario.urls.serpPlain!);
    await expect(other.getByTestId('brief-form')).toContainText('A Google or AI page is not a business website');
    await expect(other.getByTestId('brief-build')).toBeDisabled();
    // The saved brief is still listed there, and a missing brief id on the print page is handled.
    await expect(other.getByTestId('brief-saved')).toContainText('BrightPath Dental');
    const missing = await lens.openExtensionPage('print.html?id=nope');
    await expect(missing.getByTestId('print-missing')).toBeVisible();
  });

  test('handles a site with almost nothing on it', async ({ lens }) => {
    const { page, tabId } = await lens.open(scenario.urls.plainPage!);
    const panel = await lens.openPanel(tabId, 'brief');
    await lens.invoke(page);
    await panel.getByTestId('brief-build').click();
    await expect(panel.getByTestId('brief-result')).toContainText('plain.example');
    await expect(panel.getByTestId('brief-result')).toContainText('1 page read');
    // The site has no home page (it answers 404): the brief says so and carries on with what it has.
    await expect(panel.getByTestId('brief-unread')).toHaveText('1 page could not be read and was left out: /');
    await expect(panel.getByTestId('brief-offer')).toContainText('No services or products could be read');
    await expect(panel.getByTestId('brief-customers').locator('h3')).toHaveCount(3);
    // The only console line is Chrome's own note about that 404, in the page's console. Nothing from the extension.
    expect(lens.errors).toEqual(['[console] https://plain.example/hello: Failed to load resource: the server responded with a status of 404 (Not Found)']);
  });
});

test.describe('Instant Brief by address (site granted)', () => {
  test.use({ grantFixtureSites: true });

  test('builds a brief for a website named by its address, from a results page', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const serp = await lens.open(scenario.urls.serpPlain!);
    const panel = await lens.openPanel(serp.tabId, 'brief');

    // No business website is in the tab. The box starts with the user's own site; any address can be typed.
    await expect(panel.getByTestId('brief-address')).toHaveValue('https://brightpathdental.example/');
    await panel.getByTestId('brief-address').fill(SITE);
    await expect(panel.getByTestId('permission-line')).toContainText('brightpathdental.example');
    await expect(panel.getByTestId('permission-line')).toContainText('for this brief');
    await panel.getByTestId('brief-build').click();

    // The same brief as when the site is the tab: the same pages are read.
    const result = panel.getByTestId('brief-result');
    await expect(result).toContainText('BrightPath Dental');
    await expect(result).toContainText('7 pages read');
    await expect(panel.getByTestId('brief-business')).toContainText('(512) 555-0142');
    await expect(panel.getByTestId('brief-offer')).toContainText('Teeth whitening');
    await expect(panel.getByTestId('brief-saved')).toContainText('BrightPath Dental');

    // Every request went to that one site, without cookies. Nothing was asked of Google.
    const fetched = lens.extensionRequests();
    expect(fetched.length).toBeGreaterThan(3);
    expect([...new Set(fetched.map((r) => new URL(r.url).hostname))]).toEqual(['www.brightpathdental.example']);
    expect(lens.errors).toEqual([]);
  });
});
