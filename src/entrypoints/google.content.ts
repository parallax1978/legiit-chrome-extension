/**
 * Static content script for Google Search results pages (every country
 * domain in src/config/google-domains.ts, path /search).
 *
 * It measures the page the user opened and shows a small summary strip above
 * the results. It never sends a query, never changes Google's results or ads,
 * and sends nothing off the device.
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { BrandMatcher } from '@/brands/matcher';
import { GOOGLE_SEARCH_MATCHES } from '@/config/sites';
import { installAgent } from '@/content/agent';
import { Strip, STRIP_ATTRIBUTE } from '@/content/strip';
import { saveFixture } from '@/dev/save-fixture';
import { computeClickPotential, type ClickPotential } from '@/features/click-potential/metrics';
import { randomId } from '@/lib/hash';
import { safeHttpUrl } from '@/lib/sanitize';
import type { ContentConfig, ContentEvent } from '@/model/messages';
import type { AnswerData, SerpData } from '@/model/schemas';
import bundledPack from '@/selectors/google.json';
import { compareVersions, resolve, selectorHealth, validatePack } from '@/selectors/resolve';
import type { SelectorPack } from '@/selectors/types';
import { parseSerp, type ParseEnv } from '@/serp/parse';

const DEFAULT_CONFIG: ContentConfig = {
  brands: { mine: [], competitors: [] },
  strip: { enabled: true, collapsed: false },
  autoSaveSnapshots: false,
  selectorOverrides: {},
};

function send(event: ContentEvent): Promise<unknown> {
  // The service worker may be asleep or the extension may have been reloaded: never let that surface in the page.
  return chrome.runtime.sendMessage(event).catch(() => undefined);
}

async function start(): Promise<void> {
  if (!location.pathname.startsWith('/search')) return;

  const received = (await send({ type: 'lens:get-content-config' })) as ContentConfig | undefined;
  const config: ContentConfig = received && typeof received === 'object' && 'strip' in received ? received : DEFAULT_CONFIG;

  const override = validatePack(config.selectorOverrides['google'], 'google');
  const pack: SelectorPack =
    override && compareVersions(override.version, bundledPack.version) > 0 ? override : (bundledPack as SelectorPack);
  let matcher = new BrandMatcher(config.brands);

  const identity = (): string => {
    const params = new URLSearchParams(location.search);
    return `${params.get('q') ?? ''}|${params.get('udm') ?? ''}|${params.get('start') ?? ''}|${params.get('tbm') ?? ''}`;
  };

  let pageKey = identity();
  let pageId = randomId('serp');
  let saved = false;
  let strip: Strip | null = null;
  let lastSignature = '';
  let latest: { serp: SerpData; cp: ClickPotential } | null = null;

  const env = (): ParseEnv => {
    const stripHeight = strip?.isAttached() ? strip.height : 0;
    const stripHost = strip?.host ?? null;
    const stripParent = stripHost?.parentElement ?? null;
    return {
      url: location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      documentHeight: Math.max(0, Math.round(document.documentElement.scrollHeight - stripHeight)),
      now: Date.now(),
      pageId,
      rectOf(el) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        // The strip pushes everything after it in its column down by exactly its own height.
        // Positions are reported as if the strip were not there, so Lens never changes what it measures.
        const below =
          stripHeight > 0 &&
          stripHost !== null &&
          stripParent !== null &&
          stripParent.contains(el) &&
          (stripHost.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        return {
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top + window.scrollY - (below ? stripHeight : 0)),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      },
      isVisible: (el) => el.getClientRects().length > 0,
    };
  };

  const measure = (): { serp: SerpData; cp: ClickPotential } => {
    const serp = parseSerp(document, pack, env());
    latest = { serp, cp: computeClickPotential(serp, matcher) };
    return latest;
  };

  const save = async (): Promise<void> => {
    if (!latest || !latest.serp.recognised) return;
    const reply = (await send({ type: 'lens:save-snapshot', serp: latest.serp })) as { ok?: boolean } | undefined;
    if (reply?.ok) {
      saved = true;
      strip?.markSaved();
    }
  };

  const ensureStrip = (serp: SerpData): boolean => {
    const wanted = config.strip.enabled && serp.recognised && serp.mode === 'web' && (serp.organic.length > 0 || serp.blocks.length > 0);
    if (!wanted) {
      strip?.remove();
      strip = null;
      return false;
    }
    if (strip?.isAttached()) {
      strip.align();
      return false;
    }
    const anchor = resolve(document, pack, 'stripBefore').elements[0];
    if (!anchor) return false;
    strip?.remove();
    strip = new Strip(anchor, resolve(document, pack, 'stripAlign').elements[0] ?? null, config.strip.collapsed, {
      onOpenPanel: () => void send({ type: 'lens:open-panel' }),
      onToggle: (collapsed) => {
        config.strip.collapsed = collapsed;
        void send({ type: 'lens:set-strip-collapsed', collapsed });
      },
      onSave: () => void save(),
    });
    return true;
  };

  const refresh = (): void => {
    try {
      if (identity() !== pageKey) {
        // Google moved to another query without a full page load.
        pageKey = identity();
        pageId = randomId('serp');
        saved = false;
      }
      let result = measure();
      // Inserting the strip shifts the results; measure again so the compensation applies.
      if (ensureStrip(result.serp)) result = measure();
      strip?.update(result.cp, { saved, showSave: !config.autoSaveSnapshots });

      const signature = JSON.stringify([
        pageId,
        result.cp.firstOrganicTop,
        result.serp.organic.length,
        result.serp.blocks.map((b) => [b.type, b.rect?.y, b.rect?.height]),
        result.serp.viewport.width,
        result.serp.viewport.height,
        result.serp.aiAnswer?.text.length ?? 0,
      ]);
      if (signature !== lastSignature) {
        lastSignature = signature;
        if (config.autoSaveSnapshots && result.serp.recognised && result.serp.mode === 'web') void save();
        void send({ type: 'lens:page-changed', agent: 'google' });
      }
    } catch {
      // A parsing problem must never break the results page. The panel shows "not recognised".
    }
  };

  /** The user changed tracked brands or strip settings: apply them to this open page without a reload. */
  const applyNewConfig = async (): Promise<void> => {
    const next = (await send({ type: 'lens:get-content-config' })) as ContentConfig | undefined;
    if (!next || typeof next !== 'object' || !('strip' in next)) return;
    const collapsedChanged = next.strip.collapsed !== config.strip.collapsed;
    config.brands = next.brands;
    config.strip = next.strip;
    config.autoSaveSnapshots = next.autoSaveSnapshots;
    matcher = new BrandMatcher(config.brands);
    if (collapsedChanged) {
      // Rebuilt in its new state by the refresh below.
      strip?.remove();
      strip = null;
    }
    refresh();
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay: number): void => {
    clearTimeout(timer);
    timer = setTimeout(refresh, delay);
  };

  const isOwnNode = (node: Node): boolean => node.nodeType === 1 && (node as Element).hasAttribute(STRIP_ATTRIBUTE);
  const observer = new MutationObserver((records) => {
    // Ignore the mutation caused by inserting our own strip.
    const foreign = records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) => !isOwnNode(node)));
    if (foreign) schedule(700);
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', () => schedule(300), { passive: true });

  installAgent({
    kind: 'google',
    isSerp: () => new URLSearchParams(location.search).has('q'),
    getSerp: () => measure().serp,
    getAnswer: (): AnswerData =>
      measure().serp.aiAnswer ?? {
        kind: 'answer',
        site: 'google-ai-overview',
        url: safeHttpUrl(location.href),
        question: null,
        text: '',
        citations: [],
        capturedAt: Date.now(),
        recognised: false,
        packVersion: pack.version,
      },
    selectorHealth: () => ({
      site: 'google',
      packVersion: pack.version,
      url: safeHttpUrl(location.href) ?? location.href,
      slots: selectorHealth(document, pack),
    }),
    onConfigChanged: () => void applyNewConfig(),
    ...(import.meta.env.DEV ? { devSaveFixture: saveFixture } : {}),
  });

  refresh();
}

export default defineContentScript({
  matches: GOOGLE_SEARCH_MATCHES,
  runAt: 'document_idle',
  main() {
    void start().catch(() => undefined);
  },
});
