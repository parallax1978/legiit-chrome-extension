/**
 * Service worker. Deliberately small:
 *
 *  - turns a user invocation (toolbar icon, keyboard shortcut, context menu)
 *    into "open the side panel and look at this tab". Those gestures are what
 *    grant activeTab; clicks inside the side panel do not.
 *  - hands content scripts the configuration they need (they cannot read
 *    extension storage) and stores snapshots they ask to save.
 *
 * It makes no network requests and holds no page data in memory.
 */
import { defineBackground } from 'wxt/utils/define-background';
import { BrandMatcher } from '@/brands/matcher';
import { PRODUCT_NAME } from '@/config/constants';
import { aiSiteForHost, isGoogleSearchHost } from '@/config/sites';
import { computeClickPotential } from '@/features/click-potential/metrics';
import { toSnapshot } from '@/features/click-potential/snapshot';
import { buildSerpPresence, summarisePresence } from '@/features/why-not-me/presence';
import { CONTENT_EVENT_TYPES, isRecord, type ContentConfig, type InvokeIntent, type InvokeSource, type PanelEvent, type TabRequest } from '@/model/messages';
import { parseOrNull, SerpDataSchema } from '@/model/schemas';
import { saveSnapshot } from '@/storage/db';
import { getSelectorOverrides, getSettings, onSettingsChanged, restrictStorageToTrustedContexts, trackedBrands, updateSettings } from '@/storage/settings';

const MENU_ANALYZE = 'lens-analyze-page';
const MENU_SELECTION = 'lens-check-selection';

function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ANALYZE, title: `Analyze this page with ${PRODUCT_NAME}`, contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU_SELECTION, title: 'Check if the selected text says anything new', contexts: ['selection'] });
  });
}

/**
 * Runs inside the user gesture. Opening the panel must happen synchronously
 * here; the gesture has also just granted activeTab for this tab, which the
 * side panel then uses to read the page.
 */
function invoke(tab: chrome.tabs.Tab | undefined, source: InvokeSource, intent: InvokeIntent): void {
  if (!tab || tab.id === undefined) return;
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  const event: PanelEvent = { type: 'lens:invoked', tabId: tab.id, source, intent };
  // A panel that is still opening reads this; one that is already open gets the message.
  void chrome.storage.session.set({ lastInvoke: { ...event, at: Date.now() } }).catch(() => undefined);
  void chrome.runtime.sendMessage(event).catch(() => undefined);
}

async function contentConfig(): Promise<ContentConfig> {
  const settings = await getSettings();
  return {
    brands: trackedBrands(settings),
    strip: { enabled: settings.strip.enabled, collapsed: settings.strip.collapsed },
    autoSaveSnapshots: settings.snapshots.autoSave === 'always',
    selectorOverrides: await getSelectorOverrides(),
  };
}

/**
 * Tells open Google results pages that settings changed, so the strip shows
 * newly tracked brands without a reload. Without the "tabs" permission the
 * tab list carries no URLs or titles; the message only reaches tabs that run
 * one of this extension's content scripts, and it carries no data.
 */
async function broadcastConfigChanged(): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  const message: TabRequest = { type: 'lens:config-changed' };
  for (const tab of tabs) {
    if (tab.id !== undefined) void chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
  }
}

async function storeSnapshot(raw: unknown): Promise<{ ok: boolean }> {
  const serp = parseOrNull(SerpDataSchema, raw);
  if (!serp || !serp.recognised) return { ok: false };
  const matcher = new BrandMatcher(trackedBrands(await getSettings()));
  const presence = matcher.isEmpty ? null : summarisePresence(buildSerpPresence(serp, matcher));
  await saveSnapshot(toSnapshot(serp, computeClickPotential(serp, matcher), presence));
  return { ok: true };
}

function senderHost(sender: chrome.runtime.MessageSender): string {
  try {
    return new URL(sender.url ?? '').hostname.toLowerCase();
  } catch {
    return '';
  }
}

export default defineBackground(() => {
  void restrictStorageToTrustedContexts();

  chrome.runtime.onInstalled.addListener((details) => {
    createMenus();
    if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  });

  // Toolbar icon and the keyboard shortcut (_execute_action) both arrive here.
  chrome.action.onClicked.addListener((tab) => invoke(tab, 'action', 'analyze'));

  // Tracked brands or strip settings changed in the panel or options page.
  onSettingsChanged(() => void broadcastConfigChanged());

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_ANALYZE) invoke(tab, 'context-menu', 'analyze');
    else if (info.menuItemId === MENU_SELECTION) invoke(tab, 'context-menu', 'selection');
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // Messages from our own content scripts only; everything is validated before use.
    if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return undefined;
    if (!isRecord(message) || typeof message.type !== 'string') return undefined;
    if (!(CONTENT_EVENT_TYPES as readonly string[]).includes(message.type)) return undefined;
    const host = senderHost(sender);
    const fromGoogle = isGoogleSearchHost(host);
    const fromAiSite = aiSiteForHost(host) !== null;
    if (!fromGoogle && !fromAiSite) return undefined;
    const tab = sender.tab;

    switch (message.type) {
      case 'lens:open-panel': {
        if (!fromGoogle || tab.id === undefined) return undefined;
        // A click on the strip's button is a user gesture; it does not grant activeTab,
        // and none is needed on Google results, where the content script already reads the page.
        void chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
        const event: PanelEvent = { type: 'lens:invoked', tabId: tab.id, source: 'strip', intent: 'analyze' };
        void chrome.storage.session.set({ lastInvoke: { ...event, at: Date.now() } }).catch(() => undefined);
        void chrome.runtime.sendMessage(event).catch(() => undefined);
        sendResponse({ ok: true });
        return undefined;
      }
      case 'lens:get-content-config':
        contentConfig().then(sendResponse, () => sendResponse(undefined));
        return true;
      case 'lens:set-strip-collapsed':
        if (!fromGoogle || typeof message.collapsed !== 'boolean') return undefined;
        void updateSettings((draft) => {
          draft.strip.collapsed = message.collapsed === true;
        }).catch(() => undefined);
        return undefined;
      case 'lens:save-snapshot':
        if (!fromGoogle) return undefined;
        storeSnapshot(message.serp).then(sendResponse, () => sendResponse({ ok: false }));
        return true;
      default:
        return undefined;
    }
  });

  if (import.meta.env.DEV) {
    // DEV ONLY (lens-dev-save-fixture): Alt+Shift+F saves the current page as a test fixture.
    chrome.commands.onCommand.addListener((command, tab) => {
      if (command !== 'dev-save-fixture' || tab?.id === undefined) return;
      const tabId = tab.id;
      void chrome.tabs
        .sendMessage(tabId, { type: 'lens:ping' })
        .catch(() => chrome.scripting.executeScript({ target: { tabId }, files: ['/page-agent.js'] }))
        .then(() => chrome.tabs.sendMessage(tabId, { type: 'lens:dev-save-fixture' }))
        .catch(() => undefined);
    });
  }
});
