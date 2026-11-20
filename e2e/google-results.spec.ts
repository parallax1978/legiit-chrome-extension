/** Google results pages: the strip, the measurement and Click Potential, on fixtures served for real google URLs. */
import { expect, scenario, test } from './lens';

const U = scenario.urls;

test.describe('summary strip above Google results', () => {
  test('shows the measurement in a closed shadow root, above the results', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { page } = await lens.open(U.serpFull!);
    const host = page.locator('[data-legiit-lens-strip]');
    await expect(host).toBeAttached();

    await expect.poll(() => lens.stripText(page)).toContain('First organic at 1,431 px · below the fold');
    const text = (await lens.stripText(page))!;
    expect(text).toContain('Legiit Lens');
    expect(text).toContain('Organic share 0%');
    expect(text).toContain('Click potential F · estimate');
    expect(text).toContain('You #6 · below the fold');
    expect(text).toContain('Open panel');

    // Closed shadow root: the page cannot reach into it, and nothing of ours is in the light DOM.
    expect(await host.evaluate((el) => el.shadowRoot)).toBeNull();
    expect(await host.evaluate((el) => el.childNodes.length)).toBe(0);
    // One thin row, sitting above the results.
    const box = (await host.boundingBox())!;
    expect(box.height).toBeLessThan(50);
    expect(box.y).toBeLessThan((await page.locator('#rso').boundingBox())!.y);
    expect(lens.errors).toEqual([]);
  });

  test('is purely additive: Google markup, ads and results are untouched', async ({ lens }) => {
    await lens.setSettings({ strip: { enabled: false, collapsed: false } });
    const without = await lens.open(U.serpFull!);
    const snapshot = (page: typeof without.page) =>
      page.evaluate(() => {
        const clone = document.body.cloneNode(true) as HTMLElement;
        clone.querySelector('[data-legiit-lens-strip]')?.remove();
        // The fixture's own stamped rectangles are part of its markup; they must survive unchanged too.
        return clone.innerHTML;
      });
    const before = await snapshot(without.page);
    await expect(without.page.locator('[data-legiit-lens-strip]')).toHaveCount(0);

    await lens.setSettings({ strip: { enabled: true, collapsed: false } });
    const withStrip = await lens.open(U.serpFull!);
    await expect(withStrip.page.locator('[data-legiit-lens-strip]')).toBeAttached();
    expect(await snapshot(withStrip.page)).toBe(before);

    // Ads and results are still rendered and visible; only their vertical position moved by the strip's height.
    const stripHeight = (await withStrip.page.locator('[data-legiit-lens-strip]').boundingBox())!.height;
    for (const selector of ['#tads', '#tadsb', '[data-text-ad]', '.YzCcne', '#Odp5De', '.g']) {
      const a = (await without.page.locator(selector).first().boundingBox())!;
      const b = (await withStrip.page.locator(selector).first().boundingBox())!;
      expect(b.width, selector).toBe(a.width);
      expect(b.height, selector).toBe(a.height);
      expect(b.x, selector).toBe(a.x);
      expect(b.y - a.y, selector).toBeCloseTo(stripHeight, 0);
      expect(await withStrip.page.locator(selector).first().isVisible(), selector).toBe(true);
    }
  });

  test('measures positions as if the strip were not there', async ({ lens }) => {
    const { tabId } = await lens.open(U.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('cp-first-organic')).toContainText('1,431 px');

    await lens.setSettings({ strip: { enabled: false, collapsed: false } });
    const second = await lens.open(U.serpFull!);
    const panel2 = await lens.openPanel(second.tabId, 'click');
    await expect(panel2.getByTestId('cp-first-organic')).toContainText('1,431 px');
  });

  test('collapses, remembers the choice, and can be switched off', async ({ lens }) => {
    const { page } = await lens.open(U.serpPlain!);
    await expect.poll(() => lens.stripText(page)).toContain('Click potential A · estimate');
    await lens.clickStrip(page, 'Hide');
    await expect.poll(() => lens.stripText(page)).toBe('Legiit Lens Show');

    const again = await lens.open(U.serpPlain!);
    await expect.poll(() => lens.stripText(again.page)).toBe('Legiit Lens Show');
    await lens.clickStrip(again.page, 'Show');
    await expect.poll(() => lens.stripText(again.page)).toContain('First organic at 152 px · above the fold');

    await lens.setSettings({ strip: { enabled: false, collapsed: false } });
    const off = await lens.open(U.serpPlain!);
    await off.page.waitForTimeout(500);
    await expect(off.page.locator('[data-legiit-lens-strip]')).toHaveCount(0);
  });

  test('"Open panel" opens the real side panel', async ({ lens }) => {
    const { page } = await lens.open(U.serpFull!);
    await expect.poll(() => lens.stripText(page)).toContain('Open panel');
    expect(await lens.realSidePanelOpen()).toBe(false);
    await lens.clickStrip(page, 'Open panel');
    await expect.poll(() => lens.realSidePanelOpen()).toBe(true);
  });

  test('"Save" stores a snapshot on the device', async ({ lens }) => {
    const { page, tabId } = await lens.open(U.serpLocal!);
    await expect.poll(() => lens.stripText(page)).toContain('Save');
    await lens.clickStrip(page, 'Save');
    await expect.poll(() => lens.stripText(page)).toContain('Saved');
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('history-table').locator('tbody tr')).toHaveCount(1);
  });

  test('re-measures when the window is resized', async ({ lens }) => {
    const { page } = await lens.open(U.serpPlain!);
    await expect.poll(() => lens.stripText(page)).toContain('above the fold');
    // A very short window: the first result (at 152 px) is now cut by, or below, the fold.
    await page.setViewportSize({ width: 1280, height: 140 });
    await expect.poll(() => lens.stripText(page), { timeout: 10_000 }).toContain('First organic at 152 px · below the fold');
  });

  test('works on a Google country domain and survives renamed classes', async ({ lens }) => {
    const { page, tabId } = await lens.open(U.serpChurn!);
    expect(new URL(page.url()).hostname).toBe('www.google.co.uk');
    await expect.poll(() => lens.stripText(page)).toContain('First organic at 1,431 px · below the fold');
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('cp-organic-table').locator('tbody tr')).toHaveCount(9);
    await expect(panel.getByTestId('shares')).toContainText('AI Overview');
    expect(lens.errors).toEqual([]);
  });

  test('stays out of the way on a Google page it does not recognise', async ({ lens }) => {
    const { page, tabId } = await lens.open(U.serpUnrecognised!);
    await page.waitForTimeout(800);
    await expect(page.locator('[data-legiit-lens-strip]')).toHaveCount(0);
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('cp-unrecognised')).toBeVisible();
    expect(lens.errors).toEqual([]);
  });

  test('never sends a request of its own on a results page', async ({ lens }) => {
    const { tabId } = await lens.open(U.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('cp-grade')).toBeVisible();
    await panel.getByTestId('tab-why').click();
    await expect(panel.getByTestId('wnm-presence')).toBeVisible();
    // The only request in the whole session is the user's own navigation to Google.
    expect(lens.extensionRequests()).toEqual([]);
    expect(lens.requests.filter((r) => /google\./.test(r.host)).map((r) => r.resourceType)).toEqual(['document']);
  });
});

test.describe('Click Potential tab', () => {
  test('reports first organic offset, shares, fold status and the grade as an estimate', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { tabId } = await lens.open(U.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');

    await expect(panel.getByTestId('cp-header')).toContainText('“best dentist in austin”');
    await expect(panel.getByTestId('cp-header')).toContainText('1280×800 viewport · Austin, Texas');
    await expect(panel.getByTestId('cp-grade')).toContainText('F');
    await expect(panel.getByTestId('cp-grade')).toContainText('Estimate');
    await expect(panel.getByTestId('cp-first-organic')).toContainText('Below the fold · 1.8 screens down');
    await expect(panel.getByTestId('cp-organic-share')).toContainText('0.0%');
    await expect(panel.getByTestId('shares')).toContainText('AI Overview 26.8%');
    await expect(panel.getByTestId('shares')).toContainText('Ads 12.7%');
    await expect(panel.getByTestId('minimap')).toBeVisible();

    await panel.getByText('How this is calculated').click();
    await expect(panel.getByTestId('cp-method')).toContainText('Score = 100 − position penalty − displacement penalty.');
    await expect(panel.getByTestId('cp-method')).toContainText('not a click-through-rate prediction');

    // Every organic result with pixel position and fold status; tracked domains marked.
    const rows = panel.getByTestId('cp-organic-table').locator('tbody tr');
    await expect(rows).toHaveCount(9);
    await expect(rows.nth(0)).toContainText('1,431 px');
    await expect(rows.nth(5)).toContainText('BrightPath Dental');
    await expect(rows.nth(5)).toContainText('You');
    await expect(rows.nth(5)).toContainText('2,475 px');
    await expect(panel.getByTestId('cp-tracked')).toContainText('Lakeside Smiles');
    await expect(panel.getByTestId('cp-summary')).toContainText('BrightPath Dental is organic result #6');
    await expect(panel.getByTestId('summary-source').first()).toContainText('No AI was used');
    expect(lens.errors).toEqual([]);
  });

  test('saves a snapshot per keyword and shows history', async ({ lens }) => {
    const first = await lens.open(U.serpFull!);
    const panel = await lens.openPanel(first.tabId, 'click');
    await expect(panel.getByTestId('history-table').locator('tbody tr')).toHaveCount(1);
    await expect(panel.getByTestId('history-table')).toContainText('1280×800');
    await expect(panel.getByTestId('history-table')).toContainText('Austin, Texas');

    // The same keyword viewed again in a new page load, at another viewport size: a second snapshot.
    const second = await lens.open(U.serpFull!);
    await second.page.setViewportSize({ width: 1024, height: 700 });
    const panel2 = await lens.openPanel(second.tabId, 'click');
    await expect(panel2.getByTestId('history-table').locator('tbody tr')).toHaveCount(2);
    await expect(panel2.getByTestId('history-table')).toContainText('1024×700');

    // Away from Google, the tab shows history for every keyword.
    await lens.open(U.serpPlain!).then(({ tabId }) => lens.openPanel(tabId, 'click').then((p) => expect(p.getByTestId('cp-grade')).toContainText('A')));
    const plain = await lens.open(U.plainPage!);
    const elsewhere = await lens.openPanel(plain.tabId, 'click');
    await expect(elsewhere.getByTestId('cp-not-serp')).toBeVisible();
    await expect(elsewhere.getByText('best dentist in austin')).toBeVisible();
    await expect(elsewhere.getByText('how often should you get your teeth cleaned')).toBeVisible();
  });

  test('exports organic results and history as CSV', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { tabId } = await lens.open(U.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('cp-organic-table')).toBeVisible();

    const organic = await lens.downloadText(panel, () => panel.getByTestId('cp-export').click());
    expect(organic.name).toBe('click-potential-best-dentist-in-austin.csv');
    const lines = organic.text.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('keyword,captured_at,viewport,location,position,title,url,domain,top_px,fold,tracked_as,brand,list_style');
    expect(lines).toHaveLength(10);
    expect(lines[6]).toContain('brightpathdental.example,2475,Below the fold,my brand,BrightPath Dental,no');

    await expect(panel.getByTestId('history-table')).toBeVisible();
    const history = await lens.downloadText(panel, () => panel.getByTestId('cp-history-export').click());
    expect(history.text).toContain('first_organic_px,first_organic_fold,grade_estimate');
    expect(history.text).toContain(',1431,Below the fold,F,0,');
  });

  test('respects "only when I click Save"', async ({ lens }) => {
    await lens.setSettings({ snapshots: { autoSave: 'manual' } });
    const { tabId } = await lens.open(U.serpFeatured!);
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('cp-grade')).toBeVisible();
    await expect(panel.getByTestId('cp-history')).toContainText('No snapshots saved for this keyword yet.');
    await panel.getByTestId('cp-save-snapshot').click();
    await expect(panel.getByTestId('history-table').locator('tbody tr')).toHaveCount(1);
  });

  test('explains itself on AI Mode and on pages that are not Google results', async ({ lens }) => {
    const aiMode = await lens.open(U.serpAiMode!);
    const panel = await lens.openPanel(aiMode.tabId, 'click');
    await expect(panel.getByTestId('cp-ai-mode')).toBeVisible();

    const chat = await lens.open(U.chatgpt!);
    const panel2 = await lens.openPanel(chat.tabId, 'click');
    await expect(panel2.getByTestId('cp-not-serp')).toBeVisible();
    await expect(panel2.getByTestId('history-empty')).toBeVisible();
    expect(lens.errors).toEqual([]);
  });
});
