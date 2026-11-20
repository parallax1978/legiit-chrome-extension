/** The extension's own pages: options, onboarding and the selector health check. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, ROOT, scenario, test } from './lens';

const bundledGooglePack = JSON.parse(readFileSync(join(ROOT, 'src/selectors/google.json'), 'utf8')) as { site: string; version: string; slots: Record<string, unknown> };

test.describe('options page', () => {
  test('tracked brands are cleaned up, saved and used straight away', async ({ lens }) => {
    const serp = await lens.open(scenario.urls.serpFull!);
    await expect.poll(() => lens.stripText(serp.page)).toContain('Click potential');
    expect(await lens.stripText(serp.page)).not.toContain('You #');

    const options = await lens.openExtensionPage('options.html');
    await expect(options.getByTestId('options-page')).toContainText('Legiit Lens settings');
    await options.getByTestId('add-mine').click();
    const mine = options.getByTestId('brand-mine');
    await expect(mine).toHaveCount(1);
    await mine.getByTestId('brand-name').fill('  BrightPath Dental ');
    // Pasted as people paste them: a full address, upper case, a duplicate and something that is not a domain.
    await mine.getByTestId('brand-domains').fill('https://WWW.BrightPathDental.example/services?x=1, brightpathdental.example, not a domain');
    await mine.getByTestId('brand-aliases').fill('Bright Path Dental, BrightPath, BrightPath');
    await mine.getByTestId('brand-aliases').blur();
    await expect(mine.getByTestId('brand-domains')).toHaveValue('brightpathdental.example');

    await options.getByTestId('add-competitor').click();
    const competitor = options.getByTestId('brand-competitor');
    await expect(competitor).toHaveCount(1);
    await competitor.getByTestId('brand-name').fill('Lakeside Smiles');
    await competitor.getByTestId('brand-domains').fill('lakesidesmiles.example');
    await competitor.getByTestId('brand-domains').blur();

    const stored = await lens.worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings as { myBrands: { name: string; domains: string[]; aliases: string[] }[]; competitors: { name: string }[] });
    expect(stored.myBrands).toMatchObject([{ name: 'BrightPath Dental', domains: ['brightpathdental.example'], aliases: ['Bright Path Dental', 'BrightPath'] }]);
    expect(stored.competitors).toMatchObject([{ name: 'Lakeside Smiles' }]);

    // The results page that was already open picks the brands up without a reload.
    await expect.poll(() => lens.stripText(serp.page)).toContain('You #6 · below the fold');

    // Still there after closing and reopening the page; removable.
    await options.reload();
    await expect(options.getByTestId('brand-mine').getByTestId('brand-name')).toHaveValue('BrightPath Dental');
    await options.getByTestId('brand-competitor').getByRole('button', { name: 'Remove Lakeside Smiles' }).click();
    await expect(options.getByTestId('brand-competitor')).toHaveCount(0);
    expect(lens.extensionRequests()).toEqual([]);
    expect(lens.errors).toEqual([]);
  });

  test('agency name and logo are stored for exports; unsuitable files are refused', async ({ lens }) => {
    const options = await lens.openExtensionPage('options.html');
    await options.getByTestId('agency-name').fill('North Star SEO');
    await options.getByTestId('agency-name').blur();

    await options.getByTestId('agency-logo-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
    await expect(options.getByText('Use a PNG, JPEG or WebP image.')).toBeVisible();
    await options.getByTestId('agency-logo-input').setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(300_001) });
    await expect(options.getByText('The logo must be smaller than 300 KB.')).toBeVisible();
    // An SVG could carry script, so it is not accepted as a logo.
    await options.getByTestId('agency-logo-input').setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    await expect(options.getByText('Use a PNG, JPEG or WebP image.')).toBeVisible();
    await expect(options.getByTestId('agency-logo')).toHaveCount(0);

    await options.getByTestId('agency-logo-input').setInputFiles(join(ROOT, 'fixtures/site/assets/brightpath-logo.png'));
    await expect(options.getByTestId('agency-logo')).toHaveAttribute('src', /^data:image\/png;base64,/);
    const agency = await lens.worker.evaluate(async () => ((await chrome.storage.local.get('settings')).settings as { agency: { name: string; logoDataUrl: string } }).agency);
    expect(agency.name).toBe('North Star SEO');
    expect(agency.logoDataUrl.startsWith('data:image/png;base64,')).toBe(true);

    await options.getByRole('button', { name: 'Remove logo' }).click();
    await expect(options.getByTestId('agency-logo')).toHaveCount(0);
  });

  test('shows what is stored on the device and erases it on request', async ({ lens }) => {
    await lens.trackScenarioBrands();
    // Viewing a results page with the panel open saves one snapshot.
    const serp = await lens.open(scenario.urls.serpFull!);
    await expect((await lens.openPanel(serp.tabId, 'click')).getByTestId('history-table')).toBeVisible();

    const options = await lens.openExtensionPage('options.html');
    await expect(options.getByTestId('storage-summary')).toContainText('1 snapshot · 0 briefs · 0 cached Wayback captures · 0 cached pages');
    await expect(options.getByTestId('sites-empty')).toBeVisible();
    await expect(options.getByTestId('network-empty')).toBeVisible();
    await expect(options.getByTestId('ai-provider')).toContainText('Built-in templates');

    await options.getByTestId('clear-history').click();
    await expect(options.getByTestId('storage-summary')).toContainText('0 snapshots');
    // Brands survive "clear history"...
    await expect(options.getByTestId('brand-mine')).toHaveCount(1);
    // ...and are gone after "erase everything".
    await options.getByTestId('erase-all').click();
    await expect(options.getByTestId('options-page')).toBeVisible();
    await expect(options.getByTestId('brand-mine')).toHaveCount(0);
    expect(await lens.worker.evaluate(async () => Object.keys(await chrome.storage.local.get(null)))).toEqual([]);
    expect(lens.extensionRequests()).toEqual([]);
  });

  test('opting in to Chrome’s built-in AI is safe where the browser does not offer it', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const options = await lens.openExtensionPage('options.html');
    await options.getByTestId('ai-optin').check();
    await expect(options.getByTestId('settings-ai')).toContainText(/This browser does not offer built-in AI|does not meet Chrome’s requirements|Available after a one-time model download|Ready on this device/);
    // Whatever the browser answers, every feature still has its template text and nothing is requested.
    const serp = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(serp.tabId, 'click');
    await expect(panel.getByTestId('cp-summary')).toContainText('The first organic result starts 1,431 px from the top of the page');
    expect(lens.extensionRequests()).toEqual([]);
    expect(lens.errors).toEqual([]);
  });
});

test.describe('onboarding page', () => {
  test('explains what the extension does, reads and never sends, and leads to settings', async ({ lens }) => {
    const onboarding = await lens.openExtensionPage('onboarding.html');
    await expect(onboarding.getByTestId('onboarding')).toContainText('Shows how visible a web page or brand is in Google results and AI answers, and what explains it.');
    for (const feature of ['Click Potential', 'Why Not Me', 'Rewind', 'New or Noise', 'Instant Brief']) await expect(onboarding.getByTestId('onboarding-does')).toContainText(feature);
    await expect(onboarding.getByTestId('onboarding-does')).toContainText('Everything works without an account.');
    await expect(onboarding.getByTestId('onboarding-reads')).toContainText('chatgpt.com, gemini.google.com, perplexity.ai and copilot.microsoft.com');
    await expect(onboarding.getByTestId('onboarding-reads')).toContainText('web.archive.org');
    await expect(onboarding.getByTestId('onboarding-never')).toContainText('No analytics, no tracking');

    const [options] = await Promise.all([lens.context.waitForEvent('page'), onboarding.getByTestId('onboarding-settings').click()]);
    await expect(options.getByTestId('options-page')).toBeVisible();
    expect(lens.extensionRequests()).toEqual([]);
    expect(lens.errors).toEqual([]);
  });
});

test.describe('selector health check', () => {
  test('reports, per open page, which selector matched and where a fallback was needed', async ({ lens }) => {
    const health = await lens.openExtensionPage('health.html');
    await expect(health.getByTestId('health-packs')).toContainText(bundledGooglePack.version);
    await health.getByTestId('health-run').click();
    await expect(health.getByTestId('health-none')).toBeVisible();

    await lens.open(scenario.urls.serpFull!);
    await lens.open(scenario.urls.serpChurn!);
    await lens.open(scenario.urls.serpUnrecognised!);
    await lens.open(scenario.urls.chatgpt!);
    // An ordinary page has no content script and is not listed.
    await lens.open(scenario.urls.plainPage!);
    await health.bringToFront();
    await health.getByTestId('health-run').click();

    const reports = health.getByTestId('health-report');
    await expect(reports).toHaveCount(4);
    // Current markup: every required slot matches on its primary selector.
    await expect(reports.nth(0)).toContainText('Required slots match');
    await expect(reports.nth(0).locator('tr', { hasText: 'organicTitleLink' })).toContainText('primary');
    // Renamed classes (the google.co.uk fixture): still read, through fallbacks.
    await expect(reports.nth(1)).toContainText('Required slots match');
    await expect(reports.nth(1).getByText(/^fallback \d+ of \d+$/).first()).toBeVisible();
    // A page with none of the expected markup is called out.
    await expect(reports.nth(2)).toContainText(/\d+ required slots? not matching/);
    await expect(reports.nth(3)).toContainText('chatgpt');
    await expect(reports.nth(3)).toContainText('Required slots match');

    const text = await health.getByTestId('health-text').inputValue();
    expect(text).toContain(`google ${bundledGooglePack.version} ${scenario.urls.serpFull}`);
    expect(text).toMatch(/fallback\s+\w+ matched=\d+ candidate=[2-9]\/\d+/);
    expect(text).toMatch(/MISSING\s+\w+ matched=0/);
    expect(lens.extensionRequests()).toEqual([]);
    expect(lens.errors).toEqual([]);
  });

  test('accepts a newer selector pack as data, validates it, and uses it', async ({ lens }) => {
    const health = await lens.openExtensionPage('health.html');
    const save = async (json: string) => {
      await health.getByTestId('override-json').fill(json);
      await health.getByTestId('override-save').click();
    };

    await save('{ not json');
    await expect(health.getByTestId('override-message')).toHaveText('That is not valid JSON.');
    await save(JSON.stringify({ site: 'google', version: '2099.01.01-1', slots: { organicTitleLink: 'a h3' } }));
    await expect(health.getByTestId('override-message')).toContainText('Not a valid selector pack for “google”');
    await save(JSON.stringify({ ...bundledGooglePack, site: 'chatgpt', version: '2099.01.01-1' }));
    await expect(health.getByTestId('override-message')).toContainText('Not a valid selector pack for “google”');
    await save(JSON.stringify({ ...bundledGooglePack, version: '2020.01.01-1' }));
    await expect(health.getByTestId('override-message')).toContainText('is not newer than the bundled');
    // Selectors are data: something that looks like script is just a selector that matches nothing.
    await save(JSON.stringify({ ...bundledGooglePack, version: '2099.01.01-1' }));
    await expect(health.getByTestId('override-message')).toContainText('Saved. google pages opened from now on use version 2099.01.01-1.');
    await expect(health.getByTestId('health-packs').locator('tr', { hasText: 'google' })).toContainText('override');

    // A page opened afterwards is read with the override, and reads the same.
    const serp = await lens.open(scenario.urls.serpFull!);
    await expect.poll(() => lens.stripText(serp.page)).toContain('Click potential');
    await health.bringToFront();
    await health.getByTestId('health-run').click();
    await expect(health.getByTestId('health-report')).toContainText('2099.01.01-1');
    await expect(health.getByTestId('health-report')).toContainText('Required slots match');

    await health.getByRole('button', { name: 'Remove override' }).click();
    await expect(health.getByTestId('health-packs').locator('tr', { hasText: 'google' })).not.toContainText('override');
    expect(lens.extensionRequests()).toEqual([]);
    expect(lens.errors).toEqual([]);
  });
});
