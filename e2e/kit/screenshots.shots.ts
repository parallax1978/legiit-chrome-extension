/**
 * Screenshots for the developer guide of the Legiit API kit (docs/legiit-api/images/*.png).
 *
 * Every image is the real user interface of the built extension (dist/), connected to the mock API
 * (mock-server/handlers.mjs, which answers inside the test harness). Each one is a single capture of one
 * extension page, or of a part of it: nothing is retouched, drawn or put together from several captures.
 * Everything on screen is fixture data: invented people and businesses on the reserved .example domain.
 *
 * The images come out the same on every run: the data is fixed, the size of every window is fixed or follows
 * from that data, nothing moves while a capture is taken, and no image shows a date or a time. A snapshot carries
 * the time of its measurement, on the Click Potential tab and in its JSON. So the save in these images is the one
 * without a time: a competitor. (The same machine gives the same files. Other fonts or another Chromium version
 * give other pixels.)
 *
 * Run with `npm run screenshots:kit`. It uses the extension as it is built in dist/, and stops when that build
 * is older than src/.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chromium, type Locator, type Page } from '@playwright/test';
import { MOCK_TOKENS } from '../../mock-server/handlers.mjs';
import { DIST, expect, ROOT, scenario, test, type Lens } from '../lens';

const KIT = join(ROOT, 'docs', 'legiit-api');
const OUT = join(KIT, 'images');

/** Device pixels for each CSS pixel: the images stay sharp when a browser shows them smaller. */
const SCALE = 2;
/** The largest file that the guide should carry. A capture above it fails: crop it, or show less. */
const MAX_BYTES = 400_000;
/** The settings page is a column of at most 860 CSS px. */
const SETTINGS_WINDOW = { width: 860, height: 900 };
/** The side panel: as wide as in the other tests, and the distance that its cards keep from each other. */
const PANEL = { width: 420, gap: 12 };
/**
 * Free space around a captured card, in CSS px. A card has a soft shadow of up to 6 px, and two cards are 12 px
 * or more apart: with 7 px the shadow of the card is whole and the shadow of the next card stays out.
 */
const MARGIN = 7;

/** The competitor that the user types: the request body of the kit's own example for this save. */
const COMPETITOR = JSON.parse(readFileSync(join(KIT, 'examples', 'addCompetitor.request.json'), 'utf8')) as { name: string; domains: string[] };

/**
 * The `error.message` of the 422 in save-rejected.png. The mock accepts this competitor, so the test gives this
 * one reply itself, in the error body of the contract. The case is one that the guide names: a server may limit
 * the competitors of a business, and then answers 422 with a message.
 */
const REFUSAL = 'This business cannot have more competitors: remove one in Command Center, then send this again.';

// The harness (e2e/lens.ts) starts Chromium with a device scale factor of 1 and has no option for another one.
// These images need 2, so this file adds it to the call that starts the browser.
const launch = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = (userDataDir, options) => launch(userDataDir, { ...options, deviceScaleFactor: SCALE });

test.beforeAll(() => {
  // The images show the extension as it was built. With an old build they would be out of date, and nothing would say so.
  const manifest = join(DIST, 'manifest.json');
  if (!existsSync(manifest)) throw new Error('dist/ is missing. Run "npm run build" first.');
  const built = statSync(manifest).mtimeMs;
  const newer = readdirSync(join(ROOT, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => statSync(file).mtimeMs > built);
  if (newer.length > 0) {
    throw new Error(`dist/ is older than ${newer.length} file(s) in src/, for example ${relative(ROOT, newer[0]!)}. Run "npm run build", then run this again.`);
  }
});

/** Connects on the settings page the way a user does: paste the token, click Connect, choose the business. */
async function connect(lens: Lens): Promise<Page> {
  const settings = await lens.openExtensionPage('options.html');
  await settings.setViewportSize(SETTINGS_WINDOW);
  await settings.getByTestId('legiit-token').fill(MOCK_TOKENS.valid);
  await settings.getByTestId('legiit-connect').click();
  await expect(settings.getByTestId('legiit-connected')).toContainText('Dana Whitfield · agency');
  await settings.getByTestId('legiit-business').selectOption({ label: scenario.me.name });
  await expect(settings.getByTestId('legiit-business-note')).toHaveText(`Tracked brands and 3 competitors were pre-filled from ${scenario.me.name}.`);
  return settings;
}

/** Types a competitor that Command Center does not have yet, and returns its row. */
async function typeCompetitor(settings: Page): Promise<Locator> {
  const rows = settings.getByTestId('brand-competitor');
  await settings.getByTestId('add-competitor').click();
  await expect(rows).toHaveCount(4);
  const row = rows.last();
  await row.getByTestId('brand-name').fill(COMPETITOR.name);
  await row.getByTestId('brand-domains').fill(COMPETITOR.domains.join(', '));
  await row.getByTestId('brand-domains').blur();
  await expect(row.getByTestId('save-addCompetitor')).toHaveText('Add to Command Center');
  return row;
}

/** Opens the dialog of the save and checks that it shows the body of the example, and that nothing was sent. */
async function openSaveDialog(lens: Lens, settings: Page, row: Locator): Promise<Locator> {
  await row.getByTestId('save-addCompetitor').click();
  const dialog = settings.getByTestId('save-dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Add to Command Center');
  expect(JSON.parse(await dialog.getByTestId('save-payload').innerText())).toEqual(COMPETITOR);
  await expect(dialog.getByTestId('save-confirm')).toHaveText('Send to Legiit');
  expect(lens.legiit.requests.filter((request) => request.method === 'POST')).toEqual([]);
  return dialog;
}

/** Takes the pointer and the keyboard focus away, so that nothing is drawn in its hover or focus state. */
async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await expect.poll(() => page.evaluate(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
}

/** Checks a capture and writes it. `css` is the size of the captured area in CSS px. */
function write(name: string, png: Buffer, css: { width: number; height: number }): void {
  expect(css.width, `${name}: at most 1280 CSS px wide`).toBeLessThanOrEqual(1280);
  expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, `${name}: ${SCALE} device pixels for each CSS pixel`).toEqual({ width: css.width * SCALE, height: css.height * SCALE });
  expect(png.length, `${name}: at most ${MAX_BYTES} bytes`).toBeLessThanOrEqual(MAX_BYTES);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), png);
}

/** Captures a column of cards, from the card `first` to the card `last`, with a small margin around it. */
async function captureCards(page: Page, name: string, first: Locator, last: Locator): Promise<void> {
  await settle(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const from = (await first.boundingBox())!;
  const to = (await last.boundingBox())!;
  const [x, y] = [Math.floor(from.x) - MARGIN, Math.floor(from.y) - MARGIN];
  const css = { width: Math.ceil(to.x + to.width) + MARGIN - x, height: Math.ceil(to.y + to.height) + MARGIN - y };
  write(name, await page.screenshot({ type: 'png', fullPage: true, clip: { x, y, ...css }, animations: 'disabled' }), css);
}

/** Captures one element that is in view, for example a dialog, and nothing around it. */
async function captureElement(page: Page, name: string, element: Locator): Promise<void> {
  await settle(page);
  const box = (await element.boundingBox())!;
  // A centred box can start between two pixels. The browser draws its edges on the nearest ones.
  const [x, y] = [Math.round(box.x), Math.round(box.y)];
  const css = { width: Math.round(box.x + box.width) - x, height: Math.round(box.y + box.height) - y };
  write(name, await page.screenshot({ type: 'png', clip: { x, y, ...css }, animations: 'disabled' }), css);
}

test('settings-connected.png · the settings page after Connect', async ({ lens }) => {
  const settings = await connect(lens);
  await typeCompetitor(settings);
  // What the image is for: the brand and the competitors of the business, marked as coming from Command Center.
  await expect(settings.getByTestId('brand-mine').getByTestId('brand-name')).toHaveValue(scenario.me.name);
  await expect(settings.getByTestId('brands-mine').getByText('From Command Center')).toHaveCount(1);
  await expect(settings.getByTestId('brands-competitor').getByText('From Command Center')).toHaveCount(3);
  await expect(settings.getByTestId('legiit-business').locator('option:checked')).toHaveText(scenario.me.name);
  await captureCards(settings, 'settings-connected.png', settings.getByTestId('brands-mine'), settings.getByTestId('settings-legiit'));
});

test('save-dialog.png · the dialog shows the exact JSON before anything is sent', async ({ lens }) => {
  const settings = await connect(lens);
  const dialog = await openSaveDialog(lens, settings, await typeCompetitor(settings));
  await captureElement(settings, 'save-dialog.png', dialog);
});

test('saved-with-link.png · after the save, "Saved" and the link to the item', async ({ lens }) => {
  const settings = await connect(lens);
  const row = await typeCompetitor(settings);
  const dialog = await openSaveDialog(lens, settings, row);
  await dialog.getByTestId('save-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByTestId('save-result')).toHaveText('Saved Open in Command Center');
  // The link is the `url` of the reply.
  await expect(row.getByRole('link', { name: 'Open in Command Center' })).toHaveAttribute('href', `https://app.legiit.example/command-center/competitors/${lens.legiit.saved.competitors[0]!.id}`);
  const card = settings.getByTestId('brands-competitor');
  await captureCards(settings, 'saved-with-link.png', card, card);
});

test('save-rejected.png · the API answers 422 with a message', async ({ lens }) => {
  const settings = await connect(lens);
  const row = await typeCompetitor(settings);
  // This reply takes the place of the mock's own answer to the save.
  await lens.context.route('**/v1/businesses/*/competitors', (route) =>
    route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid', message: REFUSAL } }) }),
  );
  const dialog = await openSaveDialog(lens, settings, row);
  await dialog.getByTestId('save-confirm').click();
  await expect(dialog.getByTestId('save-error')).toHaveText(`Legiit rejected the request (422): ${REFUSAL}`);
  // The dialog stays open, and the user can send again.
  await expect(dialog.getByTestId('save-confirm')).toHaveText('Send to Legiit');
  await expect(dialog.getByTestId('save-confirm')).toBeEnabled();
  await captureElement(settings, 'save-rejected.png', dialog);
});

test('side-panel-tabs.png · the side panel on a Google results page', async ({ lens }) => {
  await connect(lens);
  const { tabId } = await lens.open(scenario.urls.serpFull!);
  const panel = await lens.openPanel(tabId, 'click');
  await expect(panel.getByTestId('connection-chip')).toHaveText('Legiit connected');
  const card = panel.getByTestId('cp-organic');
  await expect(card.getByTestId('save-saveVisibilitySnapshot')).toHaveText('Save to Command Center');
  // The snapshot is stored on the device by now, so the page below the card has its final height.
  await expect(panel.getByTestId('history-table')).toBeVisible();

  // The card with the save button goes right below the tabs, and the window ends right below the card. The two
  // cards that show the time of the measurement (the first one and the history) are then out of sight.
  const top = (await panel.locator('.topbar').boundingBox())!.height + PANEL.gap;
  const css = { width: PANEL.width, height: Math.ceil(top + (await card.boundingBox())!.height + MARGIN) };
  await panel.setViewportSize(css);
  await card.evaluate((element, offset) => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - offset, behavior: 'instant' }), top);
  await expect(card).toBeInViewport({ ratio: 1 });
  await expect(panel.getByTestId('cp-header')).not.toBeInViewport();
  await expect(panel.getByTestId('cp-history')).not.toBeInViewport();
  for (const tab of ['Click Potential', 'Why Not Me', 'Rewind', 'New or Noise', 'Instant Brief', 'Settings']) {
    await expect(panel.getByRole('tab', { name: tab, exact: true })).toBeInViewport({ ratio: 1 });
  }
  await settle(panel);
  write('side-panel-tabs.png', await panel.screenshot({ type: 'png', animations: 'disabled' }), css);
});
