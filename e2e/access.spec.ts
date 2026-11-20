/**
 * The activeTab pitfall, tested against the real permission model.
 *
 * Chrome grants access to a page only when the user invokes the extension
 * (toolbar icon, keyboard shortcut, context menu). Clicks inside the side
 * panel do not. The toolbar click is reproduced with the DevTools protocol
 * (Extensions.triggerAction), which goes through the same code path.
 */
import type { Page } from '@playwright/test';
import { expect, scenario, test } from './lens';

const SITE = scenario.urls.site!;

test.describe('access to the current tab', () => {
  test('has no access to an ordinary page until the user invokes the extension', async ({ lens }) => {
    const { tabId } = await lens.open(SITE);
    const panel = await lens.openPanel(tabId, 'brief');

    await expect(panel.getByTestId('target-line')).toContainText('No access to this page yet');
    await expect(panel.getByTestId('access-card')).toBeVisible();
    await expect(panel.getByTestId('access-card')).toContainText('Click the Legiit Lens icon');
    await expect(panel.getByTestId('access-card')).toContainText('Alt+Shift+L');
    await expect(panel.getByTestId('access-card')).toContainText('Analyze this page with Legiit Lens');
    await expect(panel.getByTestId('brief-build')).toBeDisabled();

    // Without access the extension cannot even see the page's address or title.
    const seen = await lens.worker.evaluate(async (id) => {
      const tab = await chrome.tabs.get(id);
      return { url: tab.url ?? null, title: tab.title ?? null };
    }, tabId);
    expect(seen).toEqual({ url: null, title: null });
  });

  test('clicks inside the panel do not grant access', async ({ lens }) => {
    const { tabId } = await lens.open(SITE);
    const panel = await lens.openPanel(tabId, 'brief');
    await expect(panel.getByTestId('access-card')).toBeVisible();
    await panel.getByRole('button', { name: 'Check again' }).click();
    await panel.getByTestId('tab-rewind').click();
    await panel.getByTestId('tab-brief').click();
    await panel.getByRole('button', { name: 'Check again' }).click();
    await expect(panel.getByTestId('access-card')).toBeVisible();
    const injected = await lens.worker.evaluate(
      (id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => 1 }).then(() => 'injected', (e: Error) => e.message),
      tabId,
    );
    expect(injected).toContain('Cannot access contents of the page');
  });

  test('invoking the extension grants access, opens the side panel and the panel picks the page up', async ({ lens }) => {
    const { page, tabId } = await lens.open(SITE);
    const panel = await lens.openPanel(tabId, 'brief');
    await expect(panel.getByTestId('access-card')).toBeVisible();
    expect(await lens.realSidePanelOpen()).toBe(false);

    await lens.invoke(page);

    await expect(panel.getByTestId('access-card')).toHaveCount(0);
    await expect(panel.getByTestId('target-line')).toContainText('BrightPath Dental | Gentle Dentistry in South Austin');
    await expect(panel.getByTestId('brief-build')).toBeEnabled();
    await expect.poll(() => lens.realSidePanelOpen()).toBe(true);
    // The grant is temporary and for this site only: nothing was added to the extension's permissions.
    const origins = await lens.worker.evaluate(async () => (await chrome.permissions.getAll()).origins ?? []);
    expect(origins.some((o) => o.includes('brightpathdental'))).toBe(false);
    await expect(panel.getByTestId('keep-access')).toContainText('Access to brightpathdental.example is for this visit only.');
    expect(lens.errors).toEqual([]);
  });

  test('a grant that reaches the page a moment late is still picked up after an invocation', async ({ lens }) => {
    const { page, tabId } = await lens.open(SITE);
    const panel = await lens.openPanel(tabId, 'brief');
    await expect(panel.getByTestId('access-card')).toBeVisible();
    // Reproduce what a busy machine does: the first two attempts to read the page after the invocation are refused.
    await panel.evaluate(() => {
      const original = chrome.scripting.executeScript.bind(chrome.scripting);
      let refusals = 2;
      (window as unknown as { __refused: number }).__refused = 0;
      chrome.scripting.executeScript = ((injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
        if (refusals > 0) {
          refusals--;
          (window as unknown as { __refused: number }).__refused++;
          return Promise.reject(new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.'));
        }
        return original(injection);
      }) as typeof chrome.scripting.executeScript;
    });
    await lens.invoke(page);
    await expect(panel.getByTestId('target-line')).toContainText('BrightPath Dental | Gentle Dentistry in South Austin');
    await expect(panel.getByTestId('access-card')).toHaveCount(0);
    // At least the first attempt was refused, and the panel got there anyway. (The second may not be needed:
    // Chrome's real side panel, opened by the same invocation, can have placed the page reader in the meantime.)
    expect(await panel.evaluate(() => (window as unknown as { __refused: number }).__refused)).toBeGreaterThanOrEqual(1);

    // Without an invocation a refusal is final at once: the panel does not keep trying a page it was never given.
    const other = await lens.open(scenario.urls.plainPage!);
    const elsewhere = await lens.openPanel(other.tabId, 'brief');
    await expect(elsewhere.getByTestId('access-card')).toBeVisible();
    await elsewhere.getByRole('button', { name: 'Check again' }).click();
    await expect(elsewhere.getByTestId('access-card')).toBeVisible();
  });

  test('access survives navigation within the site and ends when the tab leaves it', async ({ lens }) => {
    const { page, tabId } = await lens.open(SITE);
    const panel = await lens.openPanel(tabId, 'rewind');
    await lens.invoke(page);
    await expect(panel.getByTestId('target-line')).toContainText('BrightPath Dental');

    await page.goto(`${SITE}about`);
    await expect(panel.getByTestId('target-line')).toContainText('About Us | BrightPath Dental');

    await page.goto(scenario.urls.plainPage!);
    await expect(panel.getByTestId('target-line')).toContainText('No access to this page yet');

    // Going back does not bring the old grant back: the user has to invoke again.
    await page.goto(SITE);
    await expect(panel.getByTestId('target-line')).toContainText('No access to this page yet');
    await lens.invoke(page);
    await expect(panel.getByTestId('target-line')).toContainText('BrightPath Dental | Gentle Dentistry');
  });

  test('Google results and AI sites need no invocation: their content scripts answer', async ({ lens }) => {
    const serp = await lens.open(scenario.urls.serpPlain!);
    await expect((await lens.openPanel(serp.tabId)).getByTestId('target-line')).toContainText('Google results');
    const chat = await lens.open(scenario.urls.gemini!);
    await expect((await lens.openPanel(chat.tabId)).getByTestId('target-line')).toContainText('Gemini');
  });

  test('the injected page agent is not present on pages the user never invoked the extension on', async ({ lens }) => {
    const { page, tabId } = await lens.open(scenario.urls.plainPage!);
    await lens.openPanel(tabId, 'click');
    await page.waitForTimeout(500);
    const reply = await lens.worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'lens:ping' }).then(() => 'answered', () => 'no agent'), tabId);
    expect(reply).toBe('no agent');
    expect(lens.extensionRequests()).toEqual([]);
  });

  test('the panel opens on the tab that fits the page', async ({ lens }) => {
    const site = await lens.open(SITE);
    const onSite = await lens.openPanel(site.tabId);
    await lens.invoke(site.page);
    await expect(onSite.getByTestId('tab-brief')).toHaveAttribute('aria-selected', 'true');
    const serp = await lens.open(scenario.urls.serpFull!);
    await expect((await lens.openPanel(serp.tabId)).getByTestId('tab-click')).toHaveAttribute('aria-selected', 'true');
    const chat = await lens.open(scenario.urls.gemini!);
    await expect((await lens.openPanel(chat.tabId)).getByTestId('tab-why')).toHaveAttribute('aria-selected', 'true');
  });

  test('opens the onboarding page once, on install', async ({ lens }) => {
    const onboarding = lens.context.pages().find((p) => p.url().includes('onboarding.html'));
    expect(onboarding).toBeDefined();
    await expect(onboarding!.getByTestId('onboarding')).toContainText('Welcome to Legiit Lens');
    await expect(onboarding!.getByTestId('onboarding-reads')).toContainText('Google results pages you open');
    await expect(onboarding!.getByTestId('onboarding-never')).toContainText('No searches to Google and no prompts to AI sites');
    await expect(onboarding!.getByTestId('onboarding-never')).toContainText('You are shown exactly what will be sent first');
    expect(lens.context.pages().filter((p) => p.url().includes('onboarding.html'))).toHaveLength(1);
  });
});

/**
 * Chrome's permission prompt cannot be clicked by automation, so the scans
 * themselves are tested on a build with the fixture sites pre-granted. That
 * leaves one thing only the real build can show: that Chrome accepts the
 * request at all (a pattern the manifest does not allow, or a lost user
 * gesture, is refused on the spot and no prompt ever appears). These tests
 * watch the real chrome.permissions.request call and expect it to be waiting
 * for the user.
 */
test.describe('asking Chrome for a named site (real build, real prompt)', () => {
  interface Call {
    origins: string[];
    state: 'waiting for the user' | 'granted' | 'declined' | 'refused';
    error: string | null;
  }

  /** Records calls to chrome.permissions.request without changing what they do. */
  async function watchRequests(panel: Page): Promise<() => Promise<Call[]>> {
    await panel.evaluate(() => {
      const calls: Call[] = [];
      (window as unknown as { __permissionCalls: Call[] }).__permissionCalls = calls;
      const original = chrome.permissions.request.bind(chrome.permissions);
      chrome.permissions.request = ((permissions: chrome.permissions.Permissions) => {
        const call: Call = { origins: [...(permissions.origins ?? [])], state: 'waiting for the user', error: null };
        calls.push(call);
        const outcome = original(permissions);
        outcome.then(
          (granted) => {
            call.state = granted ? 'granted' : 'declined';
          },
          (error: Error) => {
            call.state = 'refused';
            call.error = error.message;
          },
        );
        return outcome;
      }) as typeof chrome.permissions.request;
    });
    return () => panel.evaluate(() => (window as unknown as { __permissionCalls: Call[] }).__permissionCalls);
  }

  test('"Scan sources" opens Chrome’s prompt for exactly the cited sites', async ({ lens }) => {
    await lens.trackScenarioBrands();
    const { tabId } = await lens.open(scenario.urls.serpFull!);
    const panel = await lens.openPanel(tabId, 'why');
    const calls = await watchRequests(panel);
    await panel.getByTestId('scan-sources').click();
    await panel.waitForTimeout(1500);
    const [call, ...rest] = await calls();
    expect(rest).toEqual([]);
    expect(call).toMatchObject({ state: 'waiting for the user', error: null });
    // The same five sites the line above the button named.
    await expect(panel.getByTestId('permission-line')).toContainText('these 5 sites');
    expect([...call!.origins].sort()).toEqual(['austinhealthguide', 'capitoldentalcare', 'lakesidesmiles', 'smilecompare', 'texaslocalpicks'].map((site) => `*://*.${site}.example/*`));
    await expect(panel.getByTestId('scan-denied')).toHaveCount(0);
    expect(lens.extensionRequests()).toEqual([]);
  });

  test('"Compare" opens Chrome’s prompt for exactly the comparison sites', async ({ lens }) => {
    await lens.open(scenario.urls.serpPlain!);
    const { page, tabId } = await lens.open(scenario.urls.targetArticle!);
    const panel = await lens.openPanel(tabId, 'noise');
    await lens.invoke(page);
    const calls = await watchRequests(panel);
    await panel.getByTestId('noise-run').click();
    await panel.waitForTimeout(1500);
    const [call, ...rest] = await calls();
    expect(rest).toEqual([]);
    expect(call).toMatchObject({ state: 'waiting for the user', error: null });
    expect([...call!.origins].sort()).toEqual(
      ['capitoldentalcare', 'familydentalfacts', 'lakesidesmiles', 'nationaloralhealth', 'smilehealthdaily', 'texasdentalboard', 'zilkerfamilydentistry'].map((site) => `*://*.${site}.example/*`),
    );
    await expect(panel.getByTestId('noise-denied')).toHaveCount(0);
    expect(lens.extensionRequests()).toEqual([]);
  });

  test('"Always allow on this site" opens Chrome’s prompt for that one site', async ({ lens }) => {
    const { page, tabId } = await lens.open(SITE);
    const panel = await lens.openPanel(tabId, 'brief');
    await lens.invoke(page);
    const calls = await watchRequests(panel);
    await panel.getByRole('button', { name: 'Always allow on brightpathdental.example' }).click();
    await panel.waitForTimeout(1500);
    expect(await calls()).toEqual([{ origins: ['*://*.brightpathdental.example/*'], state: 'waiting for the user', error: null }]);
    await expect(panel.getByTestId('keep-access')).not.toContainText('Not granted');
  });

  test('a pattern outside what the manifest allows would be refused at once (the check above can fail)', async ({ lens }) => {
    const options = await lens.openExtensionPage('options.html');
    const calls = await watchRequests(options);
    await options.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'probe';
      button.textContent = 'probe';
      button.addEventListener('click', () => void chrome.permissions.request({ origins: ['ftp://files.example/*'] }).catch(() => undefined));
      document.body.prepend(button);
    });
    await options.locator('#probe').click();
    await options.waitForTimeout(500);
    const [call] = await calls();
    expect(call?.state).toBe('refused');
  });
});

