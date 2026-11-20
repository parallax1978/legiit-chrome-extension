/**
 * The activeTab pitfall, tested against the real permission model.
 *
 * Chrome grants access to a page only when the user invokes the extension
 * (toolbar icon, keyboard shortcut, context menu). Clicks inside the side
 * panel do not. The toolbar click is reproduced with the DevTools protocol
 * (Extensions.triggerAction), which goes through the same code path.
 */
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
