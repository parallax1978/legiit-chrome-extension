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
import { classifySentences, type NoiseReport } from '@/features/new-or-noise/classify';
import { contentSentences, textSentences } from '@/features/new-or-noise/sentences';
import { buildGapRows, sortGapRows } from '@/features/why-not-me/gap';
import { answerFromPastedText } from '@/answers/read';
import { buildAnswerPresence, buildSerpPresence, summarisePresence } from '@/features/why-not-me/presence';
import { analysePage, pickSerpTargets } from '@/features/why-not-me/scan';
import { extractMainContent } from '@/extract/main-content';
import { competitorPayload, contentEditorPayload, gapPayload, snapshotPayload, workspacePayload } from '@/legiit/payloads';
import { LexicalEngine } from '@/similarity/engine';
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
    id: 'brief_3f9c2a7d41b06e58aa',
    now: EXAMPLE_NOW,
    facts: extractBusinessFacts(site),
    issues: findIssues(site.map((p) => ({ ...p, facts: extractPageFacts(p.doc, p.url) }))),
    competitors: scenario.competitors.map((c) => ({ name: c.name, domain: c.domain, source: 'tracked' as const })),
    search: searchEntries([snapshot], scenario.me.domain, true),
  });
}

const ARTICLE = 'articles/brightpath-how-often-teeth-cleaning.html';
const ARTICLE_URL = manifest.routes.find((r) => r.file === ARTICLE)!.url;

/**
 * The New or Noise comparison of the fixture article with the competing
 * articles. Uses the word-overlap engine, which gives the same result on
 * every machine (the on-device language model is exercised by the end-to-end
 * tests).
 */
export async function buildExampleNoiseReport(pageCount = 5): Promise<{ report: NoiseReport; title: string }> {
  const doc = fixtureDoc(ARTICLE);
  const target = contentSentences(extractMainContent(doc));
  const pages = manifest.routes
    .filter((r) => r.file.startsWith('articles/') && r.file !== ARTICLE)
    .slice(0, pageCount)
    .map((r) => ({ url: r.url, title: r.url, sentences: contentSentences(extractMainContent(fixtureDoc(r.file))) }));
  return { report: await classifySentences(target, pages, new LexicalEngine()), title: doc.title };
}

/** File name → request body, for every POST endpoint. Deterministic. */
export async function buildExampleRequests(): Promise<Record<string, unknown>> {
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
  // A site that gave the extension almost nothing: one page without contact details, services or structured data.
  const sparseDoc = new DOMParser().parseFromString('<!doctype html><html><head><title>Welcome</title></head><body><main><h1>Welcome</h1><p>Our new website is coming soon.</p></main></body></html>', 'text/html');
  const sparsePage: SitePage = { url: 'https://plain-site.example/', kind: 'home', doc: sparseDoc };
  const sparse = composeBrief({ id: 'brief_91d04be27c6a5f3310', now: EXAMPLE_NOW, facts: extractBusinessFacts([sparsePage]), issues: [], competitors: [] });

  const noise = await buildExampleNoiseReport();
  // Text the user pasted, compared with a single page: several values are empty and all of them are valid.
  const pasted = await classifySentences(
    textSentences('We clean teeth with an air-polishing system that most patients find gentler than scraping. Every visit ends with a written plan you can take home.'),
    [{ url: manifest.routes.find((r) => r.file.startsWith('articles/') && r.file !== ARTICLE)!.url, title: '', sentences: contentSentences(extractMainContent(fixtureDoc(manifest.routes.find((r) => r.file.startsWith('articles/') && r.file !== ARTICLE)!.file))) }],
    new LexicalEngine(),
  );

  // A results page whose visible results are all inside other blocks (AI Overview, ads, map pack): no organic
  // result, so several values are null or empty. Saved by a user who tracks one competitor by its domain only.
  const blocksOnly = { ...serp, organic: [], locationText: null };
  const domainOnly = { mine: [], competitors: [{ id: 'c', name: '', domains: ['lakesidesmiles.example'], aliases: [] }] };
  const bare = toSnapshot(blocksOnly, computeClickPotential(blocksOnly, new BrandMatcher(domainOnly)));
  // An answer the user pasted into the extension: there is no question, so the subject is empty.
  const pastedAnswer = buildAnswerPresence(
    answerFromPastedText(
      'For a family dentist in South Austin, Lakeside Smiles and Capitol Dental Care are the names that come up most often.\n\nLakeside Smiles is known for same-week appointments. Sources: https://www.austinfamilyguide.example/best-dentists-south-austin',
      EXAMPLE_NOW,
    ),
    matcher,
  );

  return {
    'saveVisibilitySnapshot.request.json': snapshotPayload(snapshot, scenarioBrands),
    'saveVisibilitySnapshot.no-organic-results.request.json': snapshotPayload(bare, domainOnly),
    'saveGapList.request.json': gapPayload(presence, rows),
    'saveGapList.pasted-answer.request.json': gapPayload(pastedAnswer, buildGapRows(pastedAnswer)),
    'addCompetitor.request.json': competitorPayload({ name: 'Riverbend Dental', domains: ['riverbenddental.example'] }),
    'addCompetitor.name-only.request.json': competitorPayload({ name: 'Dr. Okafor’s Practice', domains: [] }),
    'sendToContentEditor.request.json': contentEditorPayload({ targetKeyword: 'how often should you get your teeth cleaned', source: 'page', pageUrl: ARTICLE_URL, pageTitle: noise.title, capturedAt: EXAMPLE_NOW, report: noise.report }),
    'sendToContentEditor.pasted-text.request.json': contentEditorPayload({ targetKeyword: '', source: 'pasted', pageUrl: null, pageTitle: '', capturedAt: EXAMPLE_NOW, report: pasted }),
    'createWorkspaceFromBrief.request.json': workspacePayload(brief, briefToMarkdown(brief, { name: 'North Star SEO', logoDataUrl: null })),
    'createWorkspaceFromBrief.little-found.request.json': workspacePayload(sparse, briefToMarkdown(sparse, { name: '', logoDataUrl: null })),
    'completeAI.request.json': legiitAiPayload({ task: 'click-potential', instruction: SUMMARY_INSTRUCTIONS['click-potential'], facts: explanation, fallback: explanation }),
    'completeAI.brief.request.json': legiitAiPayload(briefRewriteRequest(brief)),
  };
}

export const toExampleJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
