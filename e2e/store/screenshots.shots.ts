/**
 * Chrome Web Store screenshots, 1280×800, generated from fixture states.
 *
 * Each image shows what a person sees in Chrome: the page they opened on the
 * left and the Legiit Lens side panel on the right. The two are rendered
 * separately by the built extension (the side panel is not a tab, so it
 * cannot be captured in one shot) and placed side by side without any other
 * retouching. Everything on screen is fixture data: invented businesses on
 * the reserved .example domain.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, ROOT, scenario, test, type Lens } from '../lens';

const OUT = join(ROOT, 'store', 'screenshots');
const WIDTH = 1280;
const HEIGHT = 800;
const PANEL_WIDTH = 420;
const PAGE_WIDTH = WIDTH - PANEL_WIDTH - 1;
const U = scenario.urls;

test.use({ grantFixtureSites: true, windowSize: { width: PAGE_WIDTH, height: HEIGHT } });

async function panelFor(lens: Lens, tabId: number, view: string): Promise<Page> {
  const panel = await lens.openPanel(tabId, view);
  await panel.setViewportSize({ width: PANEL_WIDTH, height: HEIGHT });
  return panel;
}

/** Scrolls the panel so that a card starts right under the panel's fixed header. */
async function showCard(panel: Page, testId: string): Promise<void> {
  await panel.getByTestId(testId).first().evaluate((card) => {
    const header = document.querySelector('.topbar');
    const top = card.getBoundingClientRect().top + window.scrollY - (header?.getBoundingClientRect().height ?? 0) - 12;
    window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
  });
}

/** Places the page and the panel side by side, as Chrome shows them, and saves a 1280×800 PNG. */
async function save(lens: Lens, name: string, page: Page, panel: Page): Promise<void> {
  await page.bringToFront();
  const left = await page.screenshot({ type: 'png' });
  await panel.bringToFront();
  const right = await panel.screenshot({ type: 'png' });

  const canvas = await lens.context.newPage();
  await canvas.setViewportSize({ width: WIDTH, height: HEIGHT });
  await canvas.setContent(
    `<!doctype html><style>html,body{margin:0;background:#dadce0}body{display:flex;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}img{display:block;height:${HEIGHT}px}#l{width:${PAGE_WIDTH}px}#r{width:${PANEL_WIDTH}px;margin-left:1px}</style>` +
      `<img id="l" src="data:image/png;base64,${left.toString('base64')}"><img id="r" src="data:image/png;base64,${right.toString('base64')}">`,
  );
  await canvas.waitForFunction(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0));
  const shot = await canvas.screenshot({ type: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  await canvas.close();

  expect([shot.readUInt32BE(16), shot.readUInt32BE(20)], `${name} size`).toEqual([WIDTH, HEIGHT]);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), shot);
}

test.describe.configure({ mode: 'serial' });

test('1 · The Overview on a Google results page', async ({ lens }) => {
  await lens.trackScenarioBrands();
  const { page, tabId } = await lens.open(U.serpFull!);
  await expect.poll(() => lens.stripText(page)).toContain('This search:');
  // The first screen of the panel: where the user stands, in a sentence, and what to do next.
  const panel = await panelFor(lens, tabId, 'overview');
  await expect(panel.getByTestId('overview-headline')).toBeVisible();
  await expect(panel.getByTestId('keyword-row')).toBeVisible();
  await save(lens, '1-click-potential.png', page, panel);
});

test('2 · Why Not Me on an AI answer', async ({ lens }) => {
  await lens.trackScenarioBrands();
  const { page, tabId } = await lens.open(U.chatgpt!);
  const panel = await panelFor(lens, tabId, 'why');
  await expect(panel.getByTestId('wnm-gaps')).toBeVisible();
  await panel.getByTestId('scan-sources').click();
  await expect(panel.getByTestId('scan-result').first()).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByRole('button', { name: 'Scan again' })).toBeVisible({ timeout: 60_000 });
  // The answer being read, and what the scan found on the pages it cites.
  await page.locator('[data-testid="conversation-turn-3"]').evaluate((turn) => window.scrollTo({ top: turn.getBoundingClientRect().top + window.scrollY - 24, behavior: 'instant' }));
  await showCard(panel, 'scan-results');
  await save(lens, '2-why-not-me.png', page, panel);
});

test('3 · Rewind: how a page changed over time', async ({ lens }) => {
  const { page, tabId } = await lens.open(U.rewindPage!);
  const panel = await panelFor(lens, tabId, 'rewind');
  await lens.invoke(page);
  await panel.getByTestId('rewind-load').click();
  await expect(panel.getByTestId('timeline-entry').first()).toBeVisible();
  await showCard(panel, 'rewind-captures');
  await save(lens, '3-rewind.png', page, panel);
});

test('4 · New or Noise: what only this page says', async ({ lens }) => {
  await lens.open(U.serpPlain!);
  const { page, tabId } = await lens.open(U.targetArticle!);
  const panel = await panelFor(lens, tabId, 'noise');
  await lens.invoke(page);
  await panel.getByTestId('noise-run').click();
  await expect(panel.getByTestId('noise-result')).toBeVisible({ timeout: 90_000 });
  await panel.getByTestId('noise-highlight').click();
  await expect(panel.getByTestId('noise-highlight-status')).toBeVisible();
  await showCard(panel, 'noise-result');
  await save(lens, '4-new-or-noise.png', page, panel);
});

test('5 · Instant Brief from a business website', async ({ lens }) => {
  await lens.setSettings({
    myBrands: [],
    competitors: scenario.competitors.map((c, i) => ({ id: `c${i}`, name: c.name, domains: [c.domain], aliases: c.aliases, source: 'manual' })),
    agency: { name: 'North Star SEO', logoDataUrl: null },
  });
  const { page, tabId } = await lens.open(U.site!);
  const panel = await panelFor(lens, tabId, 'brief');
  await lens.invoke(page);
  await panel.getByTestId('brief-build').click();
  await expect(panel.getByTestId('brief-result')).toBeVisible();
  await showCard(panel, 'brief-result');
  await save(lens, '5-instant-brief.png', page, panel);
});
