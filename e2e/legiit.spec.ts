/**
 * The optional Legiit connection. Requests to the Legiit API host are
 * answered by the same handlers as the local mock server (npm run mock), so
 * these tests also check the extension against docs/legiit-api/openapi.yaml.
 */
import type { Page } from '@playwright/test';
import { MOCK_SIGNUP_CODE } from '../mock-server/handlers.mjs';
import { expect, LEGIIT_ORIGIN, scenario, test, type Lens } from './lens';

const legiitRequests = (lens: Lens) => lens.requests.filter((r) => r.url.startsWith(LEGIIT_ORIGIN));

/** The token field sits behind "I have a Legiit token": everyone else only sees the email box. */
async function tokenField(page: Page) {
  const link = page.getByTestId('legiit-have-token');
  const field = page.getByTestId('legiit-token');
  // Wait until the account card has rendered one or the other, then open the field if it is folded away.
  await expect(link.or(field).first()).toBeVisible();
  if (await link.isVisible()) await link.click();
  return field;
}

/** Connects on the options page the way a user does: paste a token, press Connect. */
async function connect(lens: Lens, token: string, business: string | null = 'biz_brightpath'): Promise<Page> {
  const options = await lens.openExtensionPage('options.html');
  await (await tokenField(options)).fill(token);
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
  // Every save carries a key of its own, so Legiit can recognise a repeated send.
  expect(lens.legiit.requests.at(-1)!.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return shown;
}

test.describe('the first screen: an email opens the tools, its code connects the account', () => {
  /** The feature tests switch the first screen off; these tests switch it back on. */
  const withFirstScreen = (lens: Lens) => lens.worker.evaluate(() => chrome.storage.local.remove('testing.noAccountGate'));

  test('asks for an email, opens the tools at once, and connects a new account with the code', async ({ lens }) => {
    await withFirstScreen(lens);
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('gate')).toContainText('Enter your email to start');
    await expect(panel.getByTestId('cp-organic')).toHaveCount(0);
    // Nothing is sent before the user clicks Start.
    expect(legiitRequests(lens)).toHaveLength(0);

    await panel.getByTestId('signup-email').fill('  jordan.lee@example.com ');
    await panel.getByTestId('signup-start').click();
    // The tools open as soon as Legiit has the address. No account exists yet.
    await expect(panel.getByTestId('cp-organic')).toBeVisible();
    await expect(panel.getByTestId('verify-email')).toHaveText('jordan.lee@example.com');
    await expect(panel.getByTestId('connection-chip')).toHaveCount(0);
    expect(lens.legiit.accounts.size).toBe(0);
    const started = legiitRequests(lens).filter((r) => r.url.endsWith('/v1/signups'));
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ method: 'POST', authorization: false });
    expect(JSON.parse(started[0]!.body ?? 'null')).toEqual({ email: 'jordan.lee@example.com' });

    // A wrong code is refused with Legiit's message, and changes nothing.
    await panel.getByTestId('verify-code').fill('000000');
    await panel.getByTestId('verify-submit').click();
    await expect(panel.getByTestId('verify-error')).toContainText('code is not right');
    expect(lens.legiit.accounts.size).toBe(0);

    // The code from the email creates the account and connects it.
    await panel.getByTestId('verify-code').fill(MOCK_SIGNUP_CODE);
    await panel.getByTestId('verify-submit').click();
    await expect(panel.getByTestId('connection-chip')).toBeVisible();
    await expect(panel.getByTestId('verify-card')).toHaveCount(0);
    expect(lens.legiit.accounts.size).toBe(1);
    const verified = legiitRequests(lens).filter((r) => r.url.endsWith('/v1/signups/verify'));
    expect(verified.every((r) => !r.authorization)).toBe(true);
    // The new account's token is used from then on.
    expect(legiitRequests(lens).filter((r) => r.url.endsWith('/v1/session')).every((r) => r.authorization)).toBe(true);
  });

  test('the code of an address that already has an account connects that account', async ({ lens }) => {
    await withFirstScreen(lens);
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    await panel.getByTestId('signup-email').fill('dana@northstarseo.example');
    await panel.getByTestId('signup-start').click();
    await expect(panel.getByTestId('verify-code')).toBeVisible();
    await panel.getByTestId('verify-code').fill(MOCK_SIGNUP_CODE);
    await panel.getByTestId('verify-submit').click();
    await expect(panel.getByTestId('connection-chip')).toBeVisible();
    // No new account: the existing one is connected, with its features.
    expect(lens.legiit.accounts.size).toBe(0);
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toBeVisible();
    await panel.getByTestId('tab-settings').click();
    await expect(panel.getByTestId('legiit-connected')).toContainText('Dana Whitfield');
  });

  test('"Use another email" goes back to the first screen', async ({ lens }) => {
    await withFirstScreen(lens);
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    await panel.getByTestId('signup-email').fill('jordan.lee@example.com');
    await panel.getByTestId('signup-start').click();
    await expect(panel.getByTestId('cp-organic')).toBeVisible();
    await panel.getByTestId('verify-change-email').click();
    await expect(panel.getByTestId('gate')).toContainText('Enter your email to start');
  });
});

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
    await expect(panel.getByTestId('signup-email')).toBeVisible();
    await expect(panel.getByTestId('ai-provider')).toContainText('Built-in templates');
    expect(legiitRequests(lens)).toEqual([]);
    expect(lens.legiit.requests).toEqual([]);
  });

  test('a wrong token is reported and nothing is stored', async ({ lens }) => {
    const options = await lens.openExtensionPage('options.html');
    await (await tokenField(options)).fill('invalid');
    await options.getByTestId('legiit-connect').click();
    await expect(options.getByTestId('legiit-error')).toContainText('Legiit did not accept the token');
    await expect(options.getByTestId('legiit-connected')).toHaveCount(0);
    expect(await lens.worker.evaluate(async () => Object.keys(await chrome.storage.local.get('legiitAuth')))).toEqual([]);
    expect(legiitRequests(lens).map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /v1/session']);
  });

  test('a token that Legiit stops accepting is removed, and the reason stays on screen', async ({ lens }) => {
    // A token that was stored earlier and has since been revoked in Command Center.
    await lens.worker.evaluate(async () => chrome.storage.local.set({ legiitAuth: { token: 'revoked-token', savedAt: 1 } }));
    const options = await lens.openExtensionPage('options.html');
    await expect(options.getByTestId('legiit-error')).toHaveText('Your Legiit token was not accepted. Paste a new one to reconnect.');
    await expect.poll(async () => lens.worker.evaluate(async () => Object.keys(await chrome.storage.local.get('legiitAuth')))).toEqual([]);
    // Removing the token must not wipe the explanation.
    await options.waitForTimeout(500);
    await expect(options.getByTestId('legiit-error')).toHaveText('Your Legiit token was not accepted. Paste a new one to reconnect.');
    expect(legiitRequests(lens).map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /v1/session']);
    // Connecting again clears it.
    await (await tokenField(options)).fill('demo-token');
    await options.getByTestId('legiit-connect').click();
    await expect(options.getByTestId('legiit-connected')).toBeVisible();
    await expect(options.getByTestId('legiit-error')).toHaveCount(0);
  });

  test('a session check that fails for another reason keeps the token, says so in the panel, and can be tried again', async ({ lens }) => {
    await lens.worker.evaluate(async () => chrome.storage.local.set({ legiitAuth: { token: 'demo-token', savedAt: 1 } }));
    // Legiit is down when the panel opens.
    let down = true;
    await lens.context.route('**/v1/session', (route) => (down ? route.fulfill({ status: 503, contentType: 'text/html', body: 'Service Unavailable' }) : route.fallback()));
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    await expect(panel.getByTestId('connection-problem')).toHaveText('Legiit not connected');
    await expect(panel.getByTestId('connection-chip')).toHaveCount(0);
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toHaveCount(0);
    // The chip leads to Settings, which shows the reason and offers to try again without pasting the token.
    await panel.getByTestId('connection-problem').click();
    await expect(panel.getByTestId('legiit-error')).toHaveText('Legiit had a problem (503)');
    expect(await lens.worker.evaluate(async () => Object.keys(await chrome.storage.local.get('legiitAuth')))).toEqual(['legiitAuth']);
    down = false;
    await panel.getByTestId('legiit-retry').click();
    await expect(panel.getByTestId('legiit-connected')).toBeVisible();
    await expect(panel.getByTestId('connection-chip')).toBeVisible();
    await expect(panel.getByTestId('connection-problem')).toHaveCount(0);
  });

  test('a 401 that does not come from the API itself does not delete the token', async ({ lens }) => {
    await lens.worker.evaluate(async () => chrome.storage.local.set({ legiitAuth: { token: 'demo-token', savedAt: 1 } }));
    // A gateway in front of the API answers 401 with its own page during an outage.
    await lens.context.route('**/v1/session', (route) => route.fulfill({ status: 401, contentType: 'text/html', body: '<h1>401 Authorization Required</h1>' }));
    const options = await lens.openExtensionPage('options.html');
    await expect(options.getByTestId('legiit-error')).toHaveText('Legiit answered 401 without saying why, so your token was kept. Try again, or paste a new token.');
    await expect(options.getByTestId('legiit-retry')).toBeVisible();
    expect(await lens.worker.evaluate(async () => Object.keys(await chrome.storage.local.get('legiitAuth')))).toEqual(['legiitAuth']);
    // The user can still take the token off the device, although Legiit cannot be reached to "disconnect".
    await options.getByTestId('legiit-forget').click();
    await expect(options.getByTestId('legiit-error')).toHaveCount(0);
    await expect(options.getByTestId('legiit-retry')).toHaveCount(0);
    await expect.poll(async () => lens.worker.evaluate(async () => Object.keys(await chrome.storage.local.get('legiitAuth')))).toEqual([]);
  });

  test('pasting the stored token again while Legiit is failing does not delete it', async ({ lens }) => {
    await lens.worker.evaluate(async () => chrome.storage.local.set({ legiitAuth: { token: 'demo-token', savedAt: 1 } }));
    let down = true;
    await lens.context.route('**/v1/session', (route) => (down ? route.fulfill({ status: 503, contentType: 'text/html', body: 'Service Unavailable' }) : route.fallback()));
    const options = await lens.openExtensionPage('options.html');
    await expect(options.getByTestId('legiit-error')).toHaveText('Legiit had a problem (503)');
    await (await tokenField(options)).fill('demo-token');
    await options.getByTestId('legiit-connect').click();
    await expect(options.getByTestId('legiit-connect')).toHaveText('Connect');
    await expect(options.getByTestId('legiit-error')).toHaveText('Legiit had a problem (503)');
    expect(await lens.worker.evaluate(async () => ((await chrome.storage.local.get('legiitAuth'))['legiitAuth'] as { token: string }).token)).toBe('demo-token');
    // "Try again" tries what is in the field, and works once Legiit is back.
    await expect(options.getByTestId('legiit-kept')).toHaveText('The token stored before is still on this device.');
    down = false;
    await options.getByTestId('legiit-retry').click();
    await expect(options.getByTestId('legiit-connected')).toBeVisible();
  });

  test('connecting as another Legiit user forgets the business that was chosen', async ({ lens }) => {
    const options = await connect(lens, 'demo-token');
    await expect(options.getByTestId('brand-mine')).toHaveCount(1);
    // The token is revoked; the same person then connects with a token of another account.
    await lens.worker.evaluate(async () => chrome.storage.local.set({ legiitAuth: { token: 'revoked-token', savedAt: 1 } }));
    // The open page notices the new token by itself, checks it and shows the refusal.
    await expect(options.getByTestId('legiit-error')).toContainText('was not accepted');
    // What was pre-filled is still there for now: the user did not disconnect.
    await expect(options.getByTestId('brand-mine')).toHaveCount(1);
    (lens.legiit.session as unknown as { user: { id: string } }).user.id = 'usr_another_account';
    await (await tokenField(options)).fill('demo-token');
    await options.getByTestId('legiit-connect').click();
    await expect(options.getByTestId('legiit-connected')).toBeVisible();
    await expect(options.getByTestId('legiit-business')).toHaveValue('');
    await expect(options.getByTestId('brand-mine')).toHaveCount(0);
    await expect
      .poll(async () => (await lens.worker.evaluate(async () => (await chrome.storage.local.get('settings'))['settings'] as { legiit: { userId: string; businessId: string | null } })).legiit)
      .toMatchObject({ userId: 'usr_another_account', businessId: null });
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
    await panel.getByTestId('save-cancel').click();
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
    expect(competitor).toEqual({ name: 'Riverbend Dental', domains: ['riverbenddental.example'] });
    expect(lens.legiit.saved.competitors[0]).toMatchObject({ businessId: 'biz_brightpath', payload: competitor });
    // Sending the same competitor again does not create a second one.
    await reviewAndSend(lens, options, 'addCompetitor');
    expect(lens.legiit.saved.competitors).toHaveLength(1);
    expect(new Set(lens.legiit.requests.filter((r) => r.method === 'POST').map((r) => r.idempotencyKey)).size).toBe(2);

    const { page, tabId } = await lens.open(scenario.urls.site!);
    const panel = await lens.openPanel(tabId, 'brief');
    await lens.invoke(page);
    await panel.getByTestId('brief-build').click();
    await expect(panel.getByTestId('brief-result')).toBeVisible();
    const workspace = (await reviewAndSend(lens, panel, 'createWorkspaceFromBrief')) as { briefId: string; businessName: string; siteUrl: string; markdown: string; avatars: { draft: boolean }[]; competitors: { name: string; domains: string[] }[]; issues: { code: string; detail: string }[] };
    expect(workspace.briefId).toMatch(/^brief/);
    expect(workspace.siteUrl).toBe(new URL(scenario.urls.site!).origin + '/');
    expect(workspace.issues.length).toBeGreaterThan(0);
    expect(workspace.issues.every((i) => /^[a-z0-9-]+$/.test(i.code) && i.detail.length > 0)).toBe(true);
    expect(workspace.competitors.find((c) => c.name === 'Riverbend Dental')).toEqual({ name: 'Riverbend Dental', domains: ['riverbenddental.example'] });
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
    await expect(summary).toContainText('Estimated organic click potential');
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
    // The mock model restates the first four facts: its text replaced the built-in summary, and "#6" kept its "#".
    await expect(summary).toContainText('BrightPath Dental is organic result #6');
    await expect(summary).not.toContainText('Estimated organic click potential');
    expect(lens.legiit.aiRequests).toEqual([shown]);
    expect((shown as unknown as { maxOutputTokens: number }).maxOutputTokens).toBe(700);
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
    await expect(options.getByTestId('signup-email')).toBeVisible();
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
    // The user is told what happened; the dialog does not just vanish.
    await expect(panel.getByTestId('save-error')).toHaveText('Legiit cannot receive this yet. Nothing was saved.');
    await expect(panel.getByTestId('save-confirm')).toBeDisabled();
    await panel.getByTestId('save-cancel').click();
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toHaveCount(0);
    expect(lens.legiit.saved.visibilitySnapshots).toEqual([]);
    // The rest of the tab is unaffected.
    await expect(panel.getByTestId('cp-organic')).toBeVisible();
  });

  test('a feature that was hidden comes back when the user connects again on another page', async ({ lens }) => {
    const options = await connect(lens, 'demo-token');
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    const all = [...lens.legiit.session.capabilities];
    // The endpoint is not there when the user tries it: the button goes away in the panel.
    lens.legiit.session.capabilities = all.filter((c) => c !== 'visibilitySnapshots');
    await panel.getByTestId('save-saveVisibilitySnapshot').click();
    await panel.getByTestId('save-confirm').click();
    await expect(panel.getByTestId('save-error')).toHaveText('Legiit cannot receive this yet. Nothing was saved.');
    await panel.getByTestId('save-cancel').click();
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toHaveCount(0);
    // The backend team fixes it, and the user connects again on the settings page. The open panel follows.
    lens.legiit.session.capabilities = all;
    await options.getByTestId('legiit-disconnect').click();
    await expect(panel.getByTestId('connection-chip')).toHaveCount(0);
    await (await tokenField(options)).fill('demo-token');
    await options.getByTestId('legiit-connect').click();
    await expect(options.getByTestId('legiit-connected')).toBeVisible();
    await options.getByTestId('legiit-business').selectOption('biz_brightpath');
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toBeVisible();
    await reviewAndSend(lens, panel, 'saveVisibilitySnapshot');
  });

  test('when an endpoint is missing, every button for it goes away, not only the one that was clicked', async ({ lens }) => {
    const options = await connect(lens, 'demo-token');
    for (const name of ['Riverbend Dental', 'Hilltop Smiles']) {
      await options.getByTestId('add-competitor').click();
      const row = options.getByTestId('brand-competitor').last();
      await row.getByTestId('brand-name').fill(name);
      await row.getByTestId('brand-name').blur();
    }
    await expect(options.getByTestId('save-addCompetitor')).toHaveCount(2);
    // The session lists "competitors", but the endpoint is not built.
    await lens.context.route('**/v1/businesses/*/competitors', (route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not Found</h1>' }));
    await options.getByTestId('save-addCompetitor').first().click();
    await options.getByTestId('save-confirm').click();
    await expect(options.getByTestId('save-error')).toHaveText('Legiit cannot receive this yet. Nothing was saved.');
    await options.getByTestId('save-cancel').click();
    // No button is left that would open a dialog which cannot send.
    await expect(options.getByTestId('save-addCompetitor')).toHaveCount(0);
    await expect(options.getByTestId('save-dialog')).toHaveCount(0);
  });

  test('the outcome of a save is always seen: the dialog cannot be closed while it is sending', async ({ lens }) => {
    await connect(lens, 'demo-token');
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await lens.context.route('**/v1/businesses/*/visibility-snapshots', async (route) => {
      await held;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    });
    await panel.getByTestId('save-saveVisibilitySnapshot').click();
    await panel.getByTestId('save-confirm').click();
    await expect(panel.getByTestId('save-confirm')).toHaveText('Sending…');
    await expect(panel.getByTestId('save-cancel')).toBeDisabled();
    await panel.keyboard.press('Escape');
    await expect(panel.getByTestId('save-dialog')).toBeVisible();
    release();
    await expect(panel.getByTestId('save-error')).toHaveText('Legiit had a problem (503)');
    await expect(panel.getByTestId('save-cancel')).toBeEnabled();
    await panel.getByTestId('save-cancel').click();
    await expect(panel.getByTestId('save-dialog')).toHaveCount(0);
  });

  test('a save that is under way stays on screen when the page behind it changes, and "Saved" belongs to what was saved', async ({ lens }) => {
    await connect(lens, 'demo-token');
    const { page, tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    let release: () => void = () => undefined;
    let held = new Promise<void>((resolve) => (release = resolve));
    let answer: 'fail' | 'pass' = 'fail';
    const keys: (string | undefined)[] = [];
    await lens.context.route('**/v1/businesses/*/visibility-snapshots', async (route) => {
      keys.push(route.request().headers()['idempotency-key']);
      await held;
      if (answer === 'fail') await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      else await route.fallback();
    });
    await panel.getByTestId('save-saveVisibilitySnapshot').click();
    // While a dialog is open the page behind it cannot be used, by mouse or by keyboard.
    await expect(panel.locator('#root')).toHaveAttribute('inert', '');
    await panel.getByTestId('save-confirm').click();
    await expect(panel.getByTestId('save-confirm')).toHaveText('Sending…');
    // The browser tab moves on to a page that is not a results page: the save button goes, the dialog stays.
    await page.goto(scenario.urls.site!);
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toHaveCount(0);
    await expect(panel.getByTestId('save-dialog')).toBeVisible();
    release();
    await expect(panel.getByTestId('save-error')).toHaveText('Legiit had a problem (503)');
    // Sending again from the same dialog repeats the one-time key, and this time it goes through.
    held = Promise.resolve();
    answer = 'pass';
    await panel.getByTestId('save-confirm').click();
    await expect(panel.getByTestId('save-dialog')).toHaveCount(0);
    await expect(panel.locator('#root')).not.toHaveAttribute('inert', '');
    expect(lens.legiit.saved.visibilitySnapshots).toHaveLength(1);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);

    // Back on a results page for another search: nothing claims that this one was saved.
    await page.goto(scenario.urls.serpPlain!);
    // Access to a page is given per site, by the user: invoking the extension on the new page gives it again.
    await lens.invoke(page);
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toBeVisible();
    await expect(panel.getByTestId('save-result')).toHaveCount(0);
    await reviewAndSend(lens, panel, 'saveVisibilitySnapshot');
    await expect(panel.getByTestId('save-result')).toContainText('Saved');
  });

  test('a business list that Legiit does not offer hides the drop-down instead of showing an empty one', async ({ lens }) => {
    // The session lists "businesses", but the endpoint is not built: any 404 without the code "not_found".
    await lens.context.route('**/v1/businesses', (route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not Found</h1>' }));
    const options = await lens.openExtensionPage('options.html');
    await (await tokenField(options)).fill('demo-token');
    await options.getByTestId('legiit-connect').click();
    await expect(options.getByTestId('legiit-connected')).toBeVisible();
    await expect(options.getByTestId('legiit-business')).toHaveCount(0);
    await expect(options.getByTestId('legiit-no-businesses')).toHaveCount(0);
    await expect(options.getByTestId('legiit-businesses-error')).toHaveCount(0);
  });

  test('a business list that fails says so', async ({ lens }) => {
    await lens.context.route('**/v1/businesses', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    const options = await lens.openExtensionPage('options.html');
    await (await tokenField(options)).fill('demo-token');
    await options.getByTestId('legiit-connect').click();
    await expect(options.getByTestId('legiit-businesses-error')).toHaveText('Could not load your businesses: Legiit had a problem (500)');
    await expect(options.getByTestId('legiit-no-businesses')).toHaveCount(0);
  });

  test('a list that fails later keeps showing the chosen business; an emptied account says the business is gone', async ({ lens }) => {
    const options = await connect(lens, 'demo-token');
    await expect(options.getByTestId('legiit-business')).toHaveValue('biz_brightpath');
    // The list cannot be read: the chosen business is still shown as chosen, and nothing claims it is gone.
    await lens.context.route('**/v1/businesses', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await options.reload();
    await expect(options.getByTestId('legiit-businesses-error')).toBeVisible();
    await expect(options.getByTestId('legiit-business')).toHaveValue('biz_brightpath');
    await expect(options.getByTestId('legiit-business').locator('option:checked')).toHaveText('BrightPath Dental');
    await expect(options.getByTestId('legiit-business-gone')).toHaveCount(0);
    // The account's last business was deleted: the list is read, and it is empty.
    await lens.context.unroute('**/v1/businesses');
    await lens.context.route('**/v1/businesses', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"businesses":[]}' }));
    await options.reload();
    await expect(options.getByTestId('legiit-business-gone')).toHaveText('BrightPath Dental is no longer in this Legiit account. Saves cannot reach it any more.');
    await expect(options.getByTestId('legiit-no-businesses')).toBeVisible();
    await expect(options.getByTestId('legiit-business')).toHaveValue('');
  });

  test('an AI endpoint that turns out to be missing is reported once, then no longer offered', async ({ lens }) => {
    await connect(lens, 'demo-token');
    await lens.context.route('**/v1/ai/completions', (route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not Found</h1>' }));
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    const summary = panel.getByTestId('cp-summary');
    await summary.getByTestId('ai-rewrite').click();
    await panel.getByTestId('ai-confirm-send').click();
    await expect(summary).toContainText('Legiit AI is not available yet. Showing the built-in summary.');
    await expect(summary.getByTestId('summary-source')).toHaveText('Built from the measured facts. No AI was used.');
    await expect(summary).toContainText('Estimated organic click potential');
    await expect(summary.getByTestId('ai-rewrite')).toHaveCount(0);
  });

  test('a redirect is never followed: the save fails with a clear reason', async ({ lens }) => {
    await connect(lens, 'demo-token');
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    // A framework that "helpfully" redirects to a trailing slash. Chrome would repeat the POST as a GET without its body.
    let redirected = 0;
    await lens.context.route('**/v1/businesses/*/visibility-snapshots', (route) => {
      redirected += 1;
      return route.fulfill({ status: 302, headers: { location: `${LEGIIT_ORIGIN}/v1/session` } });
    });
    // A request that follows a redirect is not routed, so it is watched for where it does show: as an event.
    const hops: string[] = [];
    lens.context.on('request', (request) => {
      if (request.redirectedFrom()) hops.push(request.url());
    });
    await panel.getByTestId('save-saveVisibilitySnapshot').click();
    await panel.getByTestId('save-confirm').click();
    await expect(panel.getByTestId('save-error')).toHaveText('Could not reach Legiit: The Legiit API answered with a redirect instead of a reply');
    expect(redirected).toBe(1);
    expect(lens.legiit.saved.visibilitySnapshots).toEqual([]);
    // The address the redirect pointed to was never requested.
    expect(hops).toEqual([]);
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toBeVisible();
  });

  test('a business that no longer exists is reported, and the save action stays', async ({ lens }) => {
    const options = await connect(lens, 'demo-token');
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'click');
    // The business is deleted in Command Center after it was chosen in the extension.
    delete lens.legiit.details['biz_brightpath'];
    (lens.legiit.businesses as { businesses: { id: string }[] }).businesses.shift();
    await panel.getByTestId('save-saveVisibilitySnapshot').click();
    await panel.getByTestId('save-confirm').click();
    await expect(panel.getByTestId('save-error')).toHaveText('Legiit could not find it (404): No such business');
    await panel.getByTestId('save-cancel').click();
    await expect(panel.getByTestId('save-saveVisibilitySnapshot')).toBeVisible();
    // Settings says which business is gone, so the user can choose again.
    await options.reload();
    await expect(options.getByTestId('legiit-business-gone')).toContainText('BrightPath Dental is no longer in this Legiit account');
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
