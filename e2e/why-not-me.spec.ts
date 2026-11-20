/** Why Not Me on Google results and on the four AI sites, on fixtures served for the real URLs. */
import { expect, scenario, test } from './lens';

const U = scenario.urls;

test.describe('Why Not Me on Google results', () => {
  test('marks where the user and competitors appear on each surface', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { tabId } = await lens.open(U.serpFull!);
    const panel = await lens.openPanel(tabId, 'why');

    await expect(panel.getByTestId('wnm-presence')).toContainText('“best dentist in austin”');
    await expect(panel.getByTestId('surface-ai_overview')).toContainText('Competitors, not you');
    await expect(panel.getByTestId('surface-ai_overview')).toContainText('Lakeside Smiles');
    await expect(panel.getByTestId('surface-organic')).toContainText('You and competitors');
    await expect(panel.getByTestId('surface-organic')).toContainText('#6');
    await expect(panel.getByTestId('surface-local_pack')).toContainText('Competitors, not you');
    await expect(panel.getByTestId('surface-local_pack')).toContainText('Zilker Family Dentistry');
    await expect(panel.getByTestId('surface-forum')).toContainText('Competitors, not you');
    await expect(panel.getByTestId('surface-video')).toContainText('You and competitors');
    await expect(panel.getByTestId('wnm-summary')).toContainText('Your brand appears on 2 of 6 surfaces: organic results, videos.');
    expect(lens.errors).toEqual([]);
  });

  test('builds a sortable gap list and exports it as CSV', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { tabId } = await lens.open(U.serpFull!);
    const panel = await lens.openPanel(tabId, 'why');
    const rows = panel.getByTestId('gap-row');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThan(8);
    // Default order: highest priority first (AI Overview).
    await expect(rows.first()).toContainText('AI Overview');

    await panel.getByTestId('gap-sort').selectOption('position');
    await expect(rows.first()).toContainText(/Organic #2|AI Overview citation|Local pack/);
    await panel.getByTestId('gap-sort').selectOption('domain');
    const domains = await rows.evaluateAll((els) => els.map((el) => el.querySelector('.muted')?.textContent ?? ''));
    expect(domains.length).toBe(count);

    const csv = await lens.downloadText(panel, () => panel.getByTestId('gap-export').click());
    expect(csv.name).toBe('gap-list-best-dentist-in-austin.csv');
    const lines = csv.text.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('source,query_or_question,surface,position,title,url,domain,competitors_present,your_brand_present,evidence,page_type,actionable,scanned,contact_links');
    expect(lines.length).toBe(count + 1);
    expect(csv.text).toContain('Lakeside Smiles; Capitol Dental Care');
  });

  test('asks for brands when none are tracked, and shows absent surfaces as absent', async ({ lens }) => {
    const { tabId } = await lens.open(U.serpPlain!);
    const panel = await lens.openPanel(tabId, 'why');
    await expect(panel.getByTestId('brands-needed')).toBeVisible();
    await expect(panel.getByTestId('surface-ai_overview')).toContainText('Not on this page');
    await expect(panel.getByTestId('surface-local_pack')).toContainText('Not on this page');
    await expect(panel.getByTestId('gap-empty')).toContainText('Add competitors in Settings');
    await panel.getByTestId('brands-needed').getByRole('button', { name: 'Open Settings' }).click();
    await expect(panel.getByTestId('panel-settings')).toBeVisible();
  });

  test('reads Google AI Mode as an AI answer', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { tabId } = await lens.open(U.serpAiMode!);
    const panel = await lens.openPanel(tabId, 'why');
    await expect(panel.getByTestId('wnm-presence')).toContainText('Google AI Mode');
    await expect(panel.getByTestId('surface-ai_overview')).toContainText('Competitors, not you');
    await expect(panel.getByTestId('gap-row').first()).toContainText('AI Overview text');
  });

  test('does not fetch any source before Chrome has granted the sites', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { tabId } = await lens.open(U.serpFull!);
    const panel = await lens.openPanel(tabId, 'why');
    await expect(panel.getByTestId('permission-line')).toContainText('Chrome will ask to let Legiit Lens read these 5 sites');
    await expect(panel.getByTestId('permission-line')).toContainText('austinhealthguide.example');
    await expect(panel.getByTestId('permission-line')).toContainText('nothing is sent to Legiit');
    // This build has no access to those sites. Clicking raises Chrome's prompt, which nobody answers here.
    await panel.getByTestId('scan-sources').click();
    await panel.waitForTimeout(1500);
    await expect(panel.getByTestId('scan-results')).toHaveCount(0);
    expect(lens.extensionRequests()).toEqual([]);
  });
});

test.describe('Why Not Me: scan sources (sites granted)', () => {
  test.use({ grantFixtureSites: true });

  test('reads cited and list-style pages: competitors named, whether you are, and who to contact', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { tabId } = await lens.open(U.serpFull!);
    const panel = await lens.openPanel(tabId, 'why');
    await panel.getByTestId('scan-sources').click();

    const results = panel.getByTestId('scan-result');
    await expect(results).toHaveCount(5);
    const list = results.filter({ hasText: '10 Best Dentists in Austin (2026)' });
    await expect(list).toContainText('Does not name you');
    await expect(list).toContainText('Lakeside Smiles ×2');
    await expect(list).toContainText('Zilker Family Dentistry ×2');
    await expect(list).toContainText('Who to contact');
    await expect(list.getByRole('link', { name: 'Suggest a dentist' })).toHaveAttribute('href', 'https://www.austinhealthguide.example/suggest-a-dentist');
    await expect(list.getByRole('link', { name: 'Maya Ortiz' })).toBeVisible();
    // On Google with an AI Overview, each cited page also shows the passages closest to the overview text.
    // (Matched with the bundled on-device embedding model, running in the panel.)
    await expect(list.getByTestId('passage')).toHaveCount(2);
    const passages = (await list.getByTestId('passage').allInnerTexts()).join('\n');
    expect(passages).toContain('Zilker Family Dentistry is a popular choice for families with young children');
    expect(passages).toMatch(/\d+% similar to: “Families with young children often choose Zilker Family Dentistry\.”/);

    // The gap list now carries scan evidence and contact links.
    const scanned = panel.getByTestId('gap-row').filter({ hasText: 'Scanned' });
    await expect(scanned.first()).toBeVisible();
    await expect(panel.getByTestId('gap-list')).toContainText('never mentions you');
    await expect(panel.getByTestId('gap-list').getByRole('link', { name: 'Get listed' }).first()).toBeVisible();

    // Only the five source pages were fetched, each from a granted site, without cookies.
    const fetched = lens.extensionRequests();
    expect(fetched.map((r) => r.url).sort()).toEqual(
      [
        'https://smilecompare.example/lakeside-smiles-vs-capitol-dental-care',
        'https://texaslocalpicks.example/austin/top-rated-dentists',
        'https://www.austinhealthguide.example/best-dentists-austin',
        'https://www.capitoldentalcare.example/',
        'https://www.lakesidesmiles.example/',
      ].sort(),
    );
    expect(lens.errors).toEqual([]);
  });

  test('reports a page that cannot be fetched without failing the scan', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { tabId } = await lens.open(U.gemini!);
    const panel = await lens.openPanel(tabId, 'why');
    await panel.getByTestId('scan-sources').click();
    await expect(panel.getByTestId('scan-result')).toHaveCount(3);
    await expect(panel.getByTestId('scan-result').filter({ hasText: 'Capitol Dental Care' }).first()).toBeVisible();
    // Scanning again reads from the local cache: no new requests.
    const before = lens.extensionRequests().length;
    await panel.getByTestId('scan-sources').click();
    await expect(panel.getByTestId('scan-result')).toHaveCount(3);
    expect(lens.extensionRequests().length).toBe(before);
  });
});

test.describe('Why Not Me on AI answer sites', () => {
  for (const [site, label, url, expectCitations] of [
    ['chatgpt', 'ChatGPT', U.chatgpt!, 3],
    ['gemini', 'Gemini', U.gemini!, 3],
    ['perplexity', 'Perplexity', U.perplexity!, 2],
    ['copilot', 'Copilot', U.copilot!, 2],
  ] as const) {
    test(`reads the latest answer and its cited links on ${label}`, async ({ lens }) => {
      await lens.trackScenarioBrands();
      const { tabId } = await lens.open(url);
      const panel = await lens.openPanel(tabId);
      // The panel opens on Why Not Me for an AI site.
      await expect(panel.getByTestId('panel-why')).toBeVisible();
      await expect(panel.getByTestId('target-line')).toContainText(label);
      await expect(panel.getByTestId('wnm-presence')).toContainText(label);
      await expect(panel.getByTestId('surface-answer_text')).toContainText('Lakeside Smiles');
      await expect(panel.getByTestId('surface-answer_text')).toContainText(site === 'perplexity' ? 'You and competitors' : 'Competitors, not you');
      await expect(panel.getByTestId('surface-citations')).toBeVisible();
      await expect(panel.getByTestId('wnm-scan')).toContainText(`Read the ${expectCitations} cited`);
      // Reading an answer never sends anything to the AI site.
      expect(lens.extensionRequests()).toEqual([]);
      expect(lens.requests.filter((r) => r.host === new URL(url).host).map((r) => r.resourceType)).toEqual(['document']);
      expect(lens.errors).toEqual([]);
    });
  }

  test('offers "paste the answer" when the markup is not recognised', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { tabId } = await lens.open(U.chatgptUnrecognised!);
    const panel = await lens.openPanel(tabId, 'why');
    await expect(panel.getByTestId('wnm-unrecognised')).toContainText('could not be read automatically');
    await expect(panel.getByTestId('paste-box')).toHaveAttribute('open', '');

    await panel.getByTestId('paste-text').fill(
      'The best dentists in Austin are Lakeside Smiles and Capitol Dental Care.\nSource: https://www.austinhealthguide.example/best-dentists-austin?utm_source=ai',
    );
    await panel.getByTestId('paste-analyze').click();
    await expect(panel.getByTestId('wnm-presence')).toContainText('Pasted answer');
    await expect(panel.getByTestId('surface-answer_text')).toContainText('Competitors, not you');
    await expect(panel.getByTestId('surface-answer_text')).toContainText('Capitol Dental Care');
    await expect(panel.getByTestId('gap-row').first()).toContainText('The Pasted answer answer names Lakeside Smiles and Capitol Dental Care');
    await expect(panel.getByTestId('wnm-scan')).toContainText('Read the 1 cited');
    expect(lens.errors).toEqual([]);
  });

  test('works from pasted text on any page, with no page access at all', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { tabId } = await lens.open(U.plainPage!);
    const panel = await lens.openPanel(tabId, 'why');
    await expect(panel.getByTestId('wnm-empty')).toBeVisible();
    await panel.getByText('Paste an answer instead').click();
    await panel.getByTestId('paste-text').fill('For gentle care in South Austin, BrightPath Dental and Zilker Family Dentistry are both good choices.');
    await panel.getByTestId('paste-analyze').click();
    await expect(panel.getByTestId('surface-answer_text')).toContainText('You and competitors');
    await expect(panel.getByTestId('gap-empty')).toContainText('No gaps found');
  });
});
