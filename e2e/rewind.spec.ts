/** Rewind: page history from the Wayback Machine, with web.archive.org answered from fixtures. */
import { expect, scenario, test, WAYBACK_ORIGIN } from './lens';

const PAGE = scenario.urls.rewindPage!;

test.describe('Rewind', () => {
  test('shows a dated timeline of on-page changes for a typed address, with no page access', async ({ lens }) => {
    const { tabId } = await lens.open(scenario.urls.plainPage!);
    const panel = await lens.openPanel(tabId, 'rewind');
    await panel.getByTestId('rewind-url').fill(PAGE);
    await panel.getByTestId('rewind-load').click();

    await expect(panel.getByTestId('rewind-captures')).toContainText('8 distinct captures');
    await expect(panel.getByTestId('rewind-captures')).toContainText('8 read');
    const entries = panel.getByTestId('timeline-entry');
    await expect(entries).toHaveCount(7);
    // Newest first.
    await expect(entries.first()).toContainText('2026-06-21');
    await expect(entries.first()).toContainText('Title changed from');
    await expect(panel.getByTestId('rewind-timeline')).toContainText('Meta robots added: “noindex, follow”');
    await expect(panel.getByTestId('rewind-timeline')).toContainText('Canonical changed from');
    await expect(panel.getByTestId('rewind-timeline')).toContainText('H2: removed “FAQ”');
    await expect(panel.getByTestId('rewind-summary')).toContainText('7 changes found across 8 captures, from 2023-03-10 to 2026-06-21.');
    await expect(panel.getByTestId('rewind-summary')).toContainText('Largest content cut');

    // It asked the Wayback Machine only: the index once, then each capture in its unmodified (id_) form.
    const requests = lens.extensionRequests();
    expect(new Set(requests.map((r) => new URL(r.url).origin))).toEqual(new Set([WAYBACK_ORIGIN]));
    const cdx = requests.filter((r) => r.url.includes('/cdx/search/cdx'));
    expect(cdx).toHaveLength(1);
    const query = new URL(cdx[0]!.url).searchParams;
    expect(query.get('url')).toBe(PAGE);
    expect(query.get('output')).toBe('json');
    expect(query.get('collapse')).toBe('digest');
    expect(query.getAll('filter')).toContain('statuscode:200');
    const captures = requests.filter((r) => r.url.includes('/web/'));
    expect(captures).toHaveLength(8);
    expect(captures.every((r) => /\/web\/\d{14}id_\/https:\/\/www\.brightpathdental\.example\/services\/teeth-whitening$/.test(r.url))).toBe(true);
    expect(lens.errors).toEqual([]);
  });

  test('filters to the changes in the N days before a date', async ({ lens }) => {
    const { tabId } = await lens.open(scenario.urls.plainPage!);
    const panel = await lens.openPanel(tabId, 'rewind');
    await panel.getByTestId('rewind-url').fill(PAGE);
    await panel.getByTestId('rewind-load').click();
    await expect(panel.getByTestId('timeline-entry')).toHaveCount(7);

    await panel.getByTestId('filter-date').fill('2025-02-01');
    await panel.getByTestId('filter-days').selectOption('30');
    await expect(panel.getByTestId('timeline-entry')).toHaveCount(1);
    await expect(panel.getByTestId('timeline-entry')).toContainText('2025-01-20');
    await expect(panel.getByTestId('timeline-entry')).toContainText('noindex');

    await panel.getByTestId('filter-days').selectOption('7');
    await expect(panel.getByTestId('timeline-empty')).toContainText('No changes were captured in the 7 days before 2025-02-01.');
    await panel.getByRole('button', { name: 'Show all' }).click();
    await expect(panel.getByTestId('timeline-entry')).toHaveCount(7);
  });

  test('compares any two dates field by field', async ({ lens }) => {
    const { tabId } = await lens.open(scenario.urls.plainPage!);
    const panel = await lens.openPanel(tabId, 'rewind');
    await panel.getByTestId('rewind-url').fill(PAGE);
    await panel.getByTestId('rewind-load').click();
    const diff = panel.getByTestId('diff-table');
    await expect(diff).toBeVisible();
    // Defaults to first versus last capture.
    await expect(diff.locator('tr', { hasText: 'Title' }).first()).toContainText('changed');
    await expect(diff.locator('ins.diff').first()).toBeVisible();
    await expect(diff.locator('del.diff').first()).toBeVisible();

    await panel.getByTestId('diff-from').selectOption('20240805070000');
    await panel.getByTestId('diff-to').selectOption('20250120120000');
    await expect(diff.locator('tr', { hasText: 'Meta robots' })).toContainText('noindex, follow');
    await expect(diff.locator('tr', { hasText: 'Canonical' })).toContainText('changed');
    await expect(diff.locator('tr', { hasText: 'Title' }).first()).not.toContainText('changed');
  });

  test('has a clear empty state when the archive has no captures', async ({ lens }) => {
    const { tabId } = await lens.open(scenario.urls.plainPage!);
    const panel = await lens.openPanel(tabId, 'rewind');
    await panel.getByTestId('rewind-url').fill(scenario.urls.noCapturesPage!);
    await panel.getByTestId('rewind-load').click();
    await expect(panel.getByTestId('rewind-empty')).toContainText('No captures found');
    await expect(panel.getByTestId('rewind-timeline')).toHaveCount(0);
    expect(lens.extensionRequests()).toHaveLength(1);
    expect(lens.errors).toEqual([]);
  });

  test('samples at most 24 captures and reads from its cache the second time', async ({ lens }) => {
    const { tabId } = await lens.open(scenario.urls.plainPage!);
    const panel = await lens.openPanel(tabId, 'rewind');
    // The home page has 60 distinct captures in the index; only fixtures for the whitening page exist, so reads fail gracefully.
    await panel.getByTestId('rewind-url').fill(scenario.urls.site!);
    await panel.getByTestId('rewind-load').click();
    await expect(panel.getByTestId('rewind-captures')).toContainText('60 distinct captures');
    await expect(panel.getByTestId('rewind-captures')).toContainText('24 could not be read');
    expect(lens.extensionRequests().filter((r) => r.url.includes('/web/'))).toHaveLength(24);

    // A page whose captures were read: the second lookup makes no requests at all.
    await panel.getByTestId('rewind-url').fill(PAGE);
    await panel.getByTestId('rewind-load').click();
    await expect(panel.getByTestId('timeline-entry')).toHaveCount(7);
    const before = lens.extensionRequests().length;
    await panel.getByTestId('rewind-load').click();
    await expect(panel.getByTestId('timeline-entry')).toHaveCount(7);
    expect(lens.extensionRequests().length).toBe(before);
  });

  test('pre-fills the address of the page the user invoked the extension on', async ({ lens }) => {
    const { page, tabId } = await lens.open(PAGE.replace('/services/teeth-whitening', '/'));
    const panel = await lens.openPanel(tabId, 'rewind');
    await expect(panel.getByTestId('access-card')).toBeVisible();
    await expect(panel.getByTestId('rewind-url')).toHaveValue('');
    await lens.invoke(page);
    await expect(panel.getByTestId('rewind-url')).toHaveValue('https://www.brightpathdental.example/');
    // Nothing is looked up until the user asks.
    expect(lens.extensionRequests()).toEqual([]);
  });
});
