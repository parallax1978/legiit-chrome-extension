/**
 * Builds the example API requests in docs/legiit-api/examples with the
 * extension's own code, from the same fixtures the rest of the test suite
 * uses. An example is therefore a real request, not a hand-written
 * illustration: if the code that builds a payload changes, the example test
 * fails until the example file is updated.
 */
import { briefRewriteRequest } from '@/ai/brief-rewrite';
import { SUMMARY_INSTRUCTIONS } from '@/ai/instructions';
import { legiitAiPayload } from '@/ai/provider';
import { BrandMatcher } from '@/brands/matcher';
import { digestHtml, failedDigest } from '@/extract/digest';
import { extractPageFacts } from '@/extract/page-facts';
import { computeClickPotential, explainClickPotential } from '@/features/click-potential/metrics';
import { toSnapshot } from '@/features/click-potential/snapshot';
import { composeBrief, type Brief } from '@/features/instant-brief/compose';
import { pickSitePages } from '@/features/instant-brief/crawl';
import { extractBusinessFacts, type SitePage } from '@/features/instant-brief/extract';
import { findIssues } from '@/features/instant-brief/issues';
import { briefToMarkdown } from '@/features/instant-brief/markdown';
import { searchEntries } from '@/features/instant-brief/search';
import { buildGapRows, sortGapRows } from '@/features/why-not-me/gap';
import { buildSerpPresence, summarisePresence } from '@/features/why-not-me/presence';
import { analysePage, pickSerpTargets } from '@/features/why-not-me/scan';
import { competitorPayload, gapPayload, snapshotPayload, workspacePayload } from '@/legiit/payloads';
import { getPack } from '@/selectors';
import { parseSerp } from '@/serp/parse';
import { fixtureDoc, fixtureJson, fixtureText, scenario, scenarioBrands, serpEnv } from './fixtures';

/** Fixed clock for the examples, so they are identical on every run. */
export const EXAMPLE_NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
export const EXAMPLE_BUSINESS_ID = 'biz_brightpath';

const manifest = fixtureJson<{ routes: { url: string; file: string }[] }>('manifest.json');
const fileFor = (url: string) => manifest.routes.find((r) => r.url === url)?.file;

export function buildExampleBrief(): Brief {
  const origin = new URL(scenario.urls.site!).origin;
  const home = fixtureDoc('site/index.html');
  const site: SitePage[] = pickSitePages(home, `${origin}/`).flatMap((p) => {
    const file = fileFor(p.url);
    return file ? [{ url: p.url, kind: p.kind, doc: fixtureDoc(file) }] : [];
  });
  const matcher = new BrandMatcher(scenarioBrands);
  const doc = fixtureDoc('google/serp-full.html');
  const serp = parseSerp(doc, getPack('google'), serpEnv(doc, scenario.urls.serpFull!));
  const snapshot = toSnapshot(serp, computeClickPotential(serp, matcher), summarisePresence(buildSerpPresence(serp, matcher)));
  return composeBrief({
    id: 'brief-example',
    now: EXAMPLE_NOW,
    facts: extractBusinessFacts(site),
    issues: findIssues(site.map((p) => ({ ...p, facts: extractPageFacts(p.doc, p.url) }))),
    competitors: scenario.competitors.map((c) => ({ name: c.name, domain: c.domain, source: 'tracked' as const })),
    search: searchEntries([snapshot], scenario.me.domain, true),
  });
}

/** File name → request body, for every POST endpoint. Deterministic. */
export function buildExampleRequests(): Record<string, unknown> {
  const matcher = new BrandMatcher(scenarioBrands);
  const doc = fixtureDoc('google/serp-full.html');
  const serp = parseSerp(doc, getPack('google'), serpEnv(doc, scenario.urls.serpFull!));
  const cp = computeClickPotential(serp, matcher);
  const presence = buildSerpPresence(serp, matcher);
  const snapshot = toSnapshot(serp, cp, summarisePresence(presence));

  // The gap list after "Scan sources": cited and list-style pages read from the fixtures; one page has no fixture and fails.
  const scans = pickSerpTargets(serp, { matcher }).map((target) => {
    const file = fileFor(target.url);
    return analysePage(target, file ? digestHtml(fixtureText(file), target.url, target.url, 200, EXAMPLE_NOW) : failedDigest(target.url, 'The site answered 404', 404, false, EXAMPLE_NOW), matcher);
  });
  const rows = sortGapRows(buildGapRows(presence, scans), 'priority', 'desc');

  const brief = buildExampleBrief();
  const explanation = explainClickPotential(cp, matcher);

  return {
    'saveVisibilitySnapshot.request.json': snapshotPayload(snapshot),
    'saveGapList.request.json': gapPayload(presence, rows),
    'addCompetitor.request.json': competitorPayload({ name: 'Riverbend Dental', domains: ['riverbenddental.example'] }),
    'createWorkspaceFromBrief.request.json': workspacePayload(brief, briefToMarkdown(brief, { name: 'North Star SEO', logoDataUrl: null })),
    'completeAI.request.json': legiitAiPayload({ task: 'click-potential', instruction: SUMMARY_INSTRUCTIONS['click-potential'], facts: explanation, fallback: explanation }),
    'completeAI.brief.request.json': legiitAiPayload(briefRewriteRequest(brief)),
  };
}

export const toExampleJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
