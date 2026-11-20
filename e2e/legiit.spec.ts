/**
 * The optional Legiit connection. Requests to the Legiit API host are
 * answered by the same handlers as the local mock server (npm run mock), so
 * these tests also check the extension against docs/legiit-api-contract.yaml.
 */
import type { Page } from '@playwright/test';
import { expect, LEGIIT_ORIGIN, scenario, test, type Lens } from './lens';

const legiitRequests = (lens: Lens) => lens.requests.filter((r) => r.url.startsWith(LEGIIT_ORIGIN));

/** Connects on the options page the way a user does: paste a token, press Connect. */
async function connect(lens: Lens, token: string, business: string | null = 'biz_brightpath'): Promise<Page> {
  const options = await lens.openExtensionPage('options.html');
  await options.getByTestId('legiit-token').fill(token);
  await options.getByTestId('legiit-connect').click();
  await expect(options.getByTestId('legiit-connected')).toBeVisible();
  if (business) {
    await options.getByTestId('legiit-business').selectOption(business);
    await expect(options.getByText(/were pre-filled from/)).toBeVisible();
  }
  return options;
}

/** Opens a save dialog, checks nothing is sent before confirming, and returns the payload shown to the user. */
async function reviewAndSend(lens: Lens, panel: Page, method: string): Promise<unknown> {
  const postsBefore = legiitRequests(lens).filter((r) => r.method === 'POST').length;
  await panel.getByTestId(`save-${method}`).click();
  const dialog = panel.getByTestId('save-dialog');
  await expect(dialog).toContainText('This is exactly what will be sent to Legiit Command Center');
  await expect(dialog).toContainText('Nothing else leaves your device.');
  const shown = JSON.parse(await panel.getByTestId('save-payload').innerText()) as unknown;
  // Looking at the payload sends nothing.
  expect(legiitRequests(lens).filter((r) => r.method === 'POST')).toHaveLength(postsBefore);
  await panel.getByTestId('save-confirm').click();
  await expect(panel.getByTestId('save-result')).toContainText('Saved');
  const posts = legiitRequests(lens).filter((r) => r.method === 'POST');
  expect(posts).toHaveLength(postsBefore + 1);
  // The bytes on the wire are the object that was on screen.
  expect(JSON.parse(posts.at(-1)!.body ?? 'null')).toEqual(shown);
  return shown;
}

test.describe('without a Legiit account', () => {
  test('never contacts Legiit and shows no save actions', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('cp-organic')).toBeVisible();
    await expect(panel.getByTestId('connection-chip')).toHaveCount(0);
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toHaveCount(0);
    await expect(panel.getByTestId('ai-rewrite')).toHaveCount(0);
    await expect(panel.getByTestId('summary-source').first()).toHaveText('Built from the measured facts. No AI was used.');
    await panel.getByTestId('tab-why').click();
    await expect(panel.getByTestId('wnm-gaps')).toBeVisible();
    await expect(panel.getByTestId('save-saveGapList')).toHaveCount(0);
    await panel.getByTestId('tab-settings').click();
    await expect(panel.getByTestId('legiit-token')).toBeVisible();
    await expect(panel.getByTestId('ai-provider')).toContainText('Built-in templates');
    expect(legiitRequests(lens)).toEqual([]);
    expect(lens.legiit.requests).toEqual([]);
  });

  test('a wrong token is reported and nothing is stored', async ({ lens }) => {
    const options = await lens.openExtensionPage('options.html');
    await options.getByTestId('legiit-token').fill('invalid');
    await options.getByTestId('legiit-connect').click();
    await expect(options.getByTestId('legiit-error')).toContainText('Legiit did not accept the token');
    await expect(options.getByTestId('legiit-connected')).toHaveCount(0);
    expect(await lens.worker.evaluate(async () => Object.keys(await chrome.storage.local.get('legiitAuth')))).toEqual([]);
    expect(legiitRequests(lens).map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /v1/session']);
  });
});

test.describe('connected to Legiit', () => {
  test('connecting pre-fills tracked brands and competitors from Business Details', async ({ lens }) => {
    const options = await connect(lens, 'demo-token');
    await expect(options.getByTestId('legiit-connected')).toContainText('Dana Whitfield · agency');
    await expect(options.getByText('Tracked brands and 3 competitors were pre-filled from BrightPath Dental.')).toBeVisible();
    await expect(options.getByText('Focus keywords: best dentist in austin · emergency dentist austin · teeth whitening austin')).toBeVisible();

    const mine = options.getByTestId('brand-mine');
    await expect(mine).toHaveCount(1);
    await expect(mine.getByTestId('brand-name')).toHaveValue('BrightPath Dental');
    await expect(mine.getByTestId('brand-domains')).toHaveValue('brightpathdental.example');
    await expect(mine.getByTestId('brand-aliases')).toHaveValue('Bright Path Dental, BrightPath');
    await expect(mine).toContainText('From Command Center');
    await expect(options.getByTestId('brand-competitor')).toHaveCount(3);
    await expect(options.getByTestId('brand-competitor').first().getByTestId('brand-name')).toHaveValue('Lakeside Smiles');

    // Only these three reads happened, each with the token, each to the Legiit host.
    expect(legiitRequests(lens).map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /v1/session', 'GET /v1/businesses', 'GET /v1/businesses/biz_brightpath']);
    expect(legiitRequests(lens).every((r) => r.authorization)).toBe(true);
    // The token goes nowhere else, and it is not in synced storage or readable by content scripts.
    expect(lens.requests.filter((r) => r.authorization && !r.url.startsWith(LEGIIT_ORIGIN))).toEqual([]);
    const stored = await lens.worker.evaluate(async () => ({
      local: Object.keys(await chrome.storage.local.get(null)),
      sync: JSON.stringify(await chrome.storage.sync.get(null)),
    }));
    expect(stored.local).toContain('legiitAuth');
    expect(stored.sync).not.toContain('demo-token');

    // The pre-filled brands drive the features straight away.
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('connection-chip')).toHaveText('Legiit connected');
    await expect(panel.getByTestId('cp-tracked')).toContainText('BrightPath Dental');
    expect(lens.errors).toEqual([]);
  });

  test('saves a visibility snapshot only after showing exactly what is sent', async ({ lens }) => {
    await connect(lens, 'demo-token');
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('history-table')).toBeVisible();

    // Opening and cancelling the dialog sends nothing.
    await panel.getByTestId('save-saveVisibilitySnapshot').click();
    await expect(panel.getByTestId('save-dialog')).toContainText('for BrightPath Dental');
    await panel.getByTestId('save-dialog').getByRole('button', { name: 'Cancel' }).click();
    expect(lens.legiit.saved.visibilitySnapshots).toEqual([]);

    const shown = (await reviewAndSend(lens, panel, 'saveVisibilitySnapshot')) as { keyword: string; grade: { letter: string; estimate: boolean }; organic: unknown[]; tracked: { name: string }[] };
    expect(shown.keyword).toBe('best dentist in austin');
    expect(shown.grade).toMatchObject({ letter: 'F', estimate: true });
    expect(shown.organic).toHaveLength(9);
    expect(shown.tracked.map((t) => t.name)).toContain('BrightPath Dental');
    expect(lens.legiit.saved.visibilitySnapshots).toHaveLength(1);
    expect(lens.legiit.saved.visibilitySnapshots[0]).toMatchObject({ businessId: 'biz_brightpath', payload: shown });
    await expect(panel.getByTestId('save-result').getByRole('link', { name: 'Open in Command Center' })).toHaveAttribute('href', /^https:\/\/app\.legiit\.example\/command-center\/visibility\//);
    expect(lens.errors).toEqual([]);
  });

  test('saves the gap list from Why Not Me', async ({ lens }) => {
    await connect(lens, 'demo-token');
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'why');
    await expect(panel.getByTestId('wnm-gaps')).toBeVisible();
    const shown = (await reviewAndSend(lens, panel, 'saveGapList')) as { subject: string; rows: { surface: string; competitors: string[] }[] };
    expect(shown.subject).toBe('best dentist in austin');
    expect(shown.rows.length).toBeGreaterThan(3);
    expect(shown.rows.every((r) => r.competitors.length > 0)).toBe(true);
    expect(lens.legiit.saved.gapLists[0]).toMatchObject({ businessId: 'biz_brightpath', payload: shown });
  });

  test('sends a brief to Command Center and adds a competitor', async ({ lens }) => {
    const options = await connect(lens, 'demo-token');
    // A competitor the user typed (not from Command Center) can be added to the business.
    await options.getByTestId('add-competitor').click();
    await expect(options.getByTestId('brand-competitor')).toHaveCount(4);
    const added = options.getByTestId('brand-competitor').last();
    await added.getByTestId('brand-name').fill('Riverbend Dental');
    await added.getByTestId('brand-domains').fill('riverbenddental.example');
    await added.getByTestId('brand-domains').blur();
    const competitor = await reviewAndSend(lens, options, 'addCompetitor');
    expect(competitor).toEqual({ name: 'Riverbend Dental', domain: 'riverbenddental.example' });
    expect(lens.legiit.saved.competitors[0]).toMatchObject({ businessId: 'biz_brightpath', payload: competitor });

    const { page, tabId } = await lens.open(scenario.urls.site!);
    const panel = await lens.openPanel(tabId, 'brief');
    await lens.invoke(page);
    await panel.getByTestId('brief-build').click();
    await expect(panel.getByTestId('brief-result')).toBeVisible();
    const workspace = (await reviewAndSend(lens, panel, 'createWorkspaceFromBrief')) as { businessName: string; markdown: string; avatars: { draft: boolean }[]; competitors: { name: string }[] };
    expect(workspace.businessName).toBe('BrightPath Dental');
    expect(workspace.markdown).toContain('# Client brief: BrightPath Dental');
    expect(workspace.avatars).toHaveLength(3);
    expect(workspace.avatars.every((a) => a.draft)).toBe(true);
    expect(workspace.competitors.map((c) => c.name)).toContain('Riverbend Dental');
    expect(lens.legiit.saved.workspaces[0]!.payload).toEqual(workspace);
  });

  test('uses Legiit AI only after a click that shows the request', async ({ lens }) => {
    await connect(lens, 'demo-token');
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    const summary = panel.getByTestId('cp-summary');
    await expect(summary.getByTestId('summary-source')).toHaveText('Built from the measured facts. No AI was used.');
    // Being connected is not enough: nothing was sent to the AI endpoint yet.
    expect(lens.legiit.aiRequests).toEqual([]);

    await summary.getByTestId('ai-rewrite').click();
    const dialog = panel.getByTestId('ai-confirm');
    await expect(dialog).toContainText('This is exactly what will be sent to Legiit. Nothing else leaves your device.');
    const shown = JSON.parse(await dialog.locator('pre').innerText()) as { prompt: string };
    expect(shown.prompt).toContain('The first organic result starts 1,431 px from the top of the page');
    expect(shown.prompt).toContain('BrightPath Dental is organic result #6');
    expect(lens.legiit.aiRequests).toEqual([]);
    await panel.getByTestId('ai-confirm-send').click();

    await expect(summary.getByTestId('summary-source')).toContainText('Rewritten by Legiit AI');
    await expect(summary).toContainText('Summary from Legiit AI (mock):');
    expect(lens.legiit.aiRequests).toEqual([shown]);
    expect(lens.errors).toEqual([]);
  });

  test('offers Industry Pulse dates in Rewind', async ({ lens }) => {
    await connect(lens, 'demo-token');
    const { page, tabId } = await lens.open(scenario.urls.rewindPage!);
    const panel = await lens.openPanel(tabId, 'rewind');
    await lens.invoke(page);
    await panel.getByTestId('rewind-load').click();
    await expect(panel.getByTestId('rewind-timeline')).toBeVisible();
    await expect(panel.getByTestId('pulse-presets')).toContainText('2025-03-13');
    await panel.getByTestId('pulse-presets').getByRole('button', { name: '2025-03-13' }).click();
    await expect(panel.getByTestId('filter-date')).toHaveValue('2025-03-13');
  });

  test('disconnecting removes the token and stops all contact with Legiit', async ({ lens }) => {
    const options = await connect(lens, 'demo-token');
    await options.getByTestId('legiit-disconnect').click();
    await expect(options.getByTestId('legiit-token')).toBeVisible();
    expect(await lens.worker.evaluate(async () => Object.keys(await chrome.storage.local.get('legiitAuth')))).toEqual([]);
    // Brands that came from Command Center are removed with the connection.
    await expect(options.getByTestId('brand-mine')).toHaveCount(0);

    const before = legiitRequests(lens).length;
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('cp-organic')).toBeVisible();
    await expect(panel.getByTestId('connection-chip')).toHaveCount(0);
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toHaveCount(0);
    expect(legiitRequests(lens)).toHaveLength(before);
  });
});

test.describe('an account with some endpoints switched off', () => {
  test('hides every action whose endpoint is unavailable', async ({ lens }) => {
    const options = await connect(lens, 'limited-token');
    // No "competitors" capability: the add-to-Command-Center action is not offered.
    await options.getByTestId('add-competitor').click();
    await expect(options.getByTestId('brand-competitor')).toHaveCount(4);
    await options.getByTestId('brand-competitor').last().getByTestId('brand-name').fill('Riverbend Dental');
    await options.getByTestId('brand-competitor').last().getByTestId('brand-name').blur();
    await expect(options.getByTestId('brand-competitor').last().getByTestId('brand-name')).toHaveValue('Riverbend Dental');
    await expect(options.getByTestId('save-addCompetitor')).toHaveCount(0);
    // No "ai" capability: summaries stay on templates.
    await expect(options.getByTestId('ai-provider')).toContainText('Built-in templates');

    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toBeVisible();
    await expect(panel.getByTestId('ai-rewrite')).toHaveCount(0);
    await panel.getByTestId('tab-why').click();
    await expect(panel.getByTestId('wnm-gaps')).toBeVisible();
    await expect(panel.getByTestId('save-saveGapList')).toHaveCount(0);

    const site = await lens.open(scenario.urls.site!);
    const brief = await lens.openPanel(site.tabId, 'brief');
    await lens.invoke(site.page);
    await brief.getByTestId('brief-build').click();
    await expect(brief.getByTestId('brief-result')).toBeVisible();
    await expect(brief.getByTestId('save-createWorkspaceFromBrief')).toHaveCount(0);
    await expect(brief.getByTestId('brief-ai')).toHaveCount(0);
    // Nothing was posted to endpoints the account does not have.
    expect(legiitRequests(lens).filter((r) => r.method === 'POST')).toEqual([]);
  });

  test('an endpoint that turns out to be missing is reported, then hidden', async ({ lens }) => {
    await connect(lens, 'demo-token');
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toBeVisible();
    // The server stops offering the endpoint after the session was read.
    lens.legiit.session.capabilities = lens.legiit.session.capabilities.filter((c) => c !== 'visibilitySnapshots');
    await panel.getByTestId('save-saveVisibilitySnapshot').click();
    await panel.getByTestId('save-confirm').click();
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toHaveCount(0);
    expect(lens.legiit.saved.visibilitySnapshots).toEqual([]);
    // The rest of the tab is unaffected.
    await expect(panel.getByTestId('cp-organic')).toBeVisible();
  });
});

test.describe('connected, with fixture sites granted', () => {
  test.use({ grantFixtureSites: true });

  test('sends New or Noise results to the content editor', async ({ lens }) => {
    await connect(lens, 'demo-token');
    await lens.open(scenario.urls.serpPlain!);
    const { page, tabId } = await lens.open(scenario.urls.targetArticle!);
    const panel = await lens.openPanel(tabId, 'noise');
    await lens.invoke(page);
    await panel.getByTestId('noise-run').click();
    await expect(panel.getByTestId('noise-result')).toBeVisible({ timeout: 60_000 });
    const shown = (await reviewAndSend(lens, panel, 'sendToContentEditor')) as { targetKeyword: string; onlyHere: string[]; missingPoints: unknown[]; comparedUrls: string[]; method: { engine: string } };
    expect(shown.targetKeyword).toBe('How Often Should You Get Your Teeth Cleaned');
    expect(shown.method.engine).toBe('embedding');
    expect(shown.onlyHere).toHaveLength(4);
    expect(shown.comparedUrls).toHaveLength(5);
    expect(shown.missingPoints.length).toBeGreaterThan(0);
    expect(lens.legiit.saved.contentDocuments[0]).toMatchObject({ businessId: 'biz_brightpath', payload: shown });
  });
});
