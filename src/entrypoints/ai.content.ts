/**
 * Static content script for the four AI answer sites (chatgpt.com,
 * gemini.google.com, perplexity.ai, copilot.microsoft.com).
 *
 * It does nothing until the side panel asks, then reads the latest answer
 * and its cited links from the page the user has open. It never types,
 * submits or sends anything to the AI site, and adds nothing to the page.
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { readAnswer } from '@/answers/read';
import { AI_SITE_MATCHES, AI_SITES, aiSiteForHost, type AiSiteId } from '@/config/sites';
import { installAgent } from '@/content/agent';
import { saveFixture } from '@/dev/save-fixture';
import { safeHttpUrl } from '@/lib/sanitize';
import type { ContentConfig } from '@/model/messages';
import chatgpt from '@/selectors/chatgpt.json';
import copilot from '@/selectors/copilot.json';
import gemini from '@/selectors/gemini.json';
import perplexity from '@/selectors/perplexity.json';
import { compareVersions, selectorHealth, validatePack } from '@/selectors/resolve';
import type { SelectorPack } from '@/selectors/types';

const BUNDLED: Readonly<Record<AiSiteId, SelectorPack>> = {
  chatgpt: chatgpt as SelectorPack,
  gemini: gemini as SelectorPack,
  perplexity: perplexity as SelectorPack,
  copilot: copilot as SelectorPack,
};

export default defineContentScript({
  matches: AI_SITE_MATCHES,
  runAt: 'document_idle',
  main() {
    const site = aiSiteForHost(location.hostname);
    if (!site) return;

    let pack = BUNDLED[site];
    // A newer, validated selector pack saved from the health-check page replaces the bundled one.
    chrome.runtime
      .sendMessage({ type: 'lens:get-content-config' })
      .then((config: ContentConfig | undefined) => {
        const override = validatePack(config?.selectorOverrides?.[site], site);
        if (override && compareVersions(override.version, pack.version) > 0) pack = override;
      })
      .catch(() => undefined);

    installAgent({
      kind: 'ai',
      site,
      getAnswer: () => readAnswer(document, pack, site, { url: location.href, now: Date.now(), ownHosts: AI_SITES[site].hosts }),
      selectorHealth: () => ({
        site,
        packVersion: pack.version,
        url: safeHttpUrl(location.href) ?? location.href,
        slots: selectorHealth(document, pack),
      }),
      ...(import.meta.env.DEV ? { devSaveFixture: saveFixture } : {}),
    });
  },
});
