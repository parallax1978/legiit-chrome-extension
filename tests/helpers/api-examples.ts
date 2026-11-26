/**
 * Builds the example API requests in docs/legiit-api/examples with the
 * extension's own code, from the same fixtures the rest of the test suite
 * uses. An example is therefore a real request, not a hand-written
 * illustration: if the code that builds a payload changes, the example test
 * fails until the example file is updated.
 *
 * It also holds the few example replies that the mock server does not give
 * (integer ids, a session without capabilities, a save without a page, some
 * errors). tests/unit/legiit-api-kit.test.ts writes all of them to files and
 * checks them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMockState, handleMockRequest, MOCK_TOKENS } from '@@/mock-server/handlers.mjs';
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
import { accountPayload, competitorPayload, contentEditorPayload, gapPayload, snapshotPayload, workspacePayload } from '@/legiit/payloads';
import { DenseVectors, EMBEDDING_PASSAGE_THRESHOLD, EMBEDDING_SAME_THRESHOLD, LexicalEngine, type SimilarityEngine, type Vectors } from '@/similarity/engine';
import { getPack } from '@/selectors';
import { parseSerp } from '@/serp/parse';
import { fixtureDoc, fixtureJson, fixtureText, scenario, scenarioBrands, serpEnv } from './fixtures';

/** Fixed clock for the examples, so they are identical on every run. */
export const EXAMPLE_NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
export const EXAMPLE_BUSINESS_ID = 'biz_brightpath';

const manifest = fixtureJson<{ routes: { url: string; file: string }[] }>('manifest.json');
const fileFor = (url: string) => manifest.routes.find((r) => r.url === url)?.file;

/**
 * Two titles as pages on the web really write them, put into the results page before the extension reads it:
 * one with an emoji, which is 4 bytes in UTF-8 (a MySQL "utf8" column cannot store it), and one in a non-Latin
 * script. The payload code must carry both unchanged; the kit test checks the example files for them.
 */
export const WEB_TITLES = {
  emoji: { from: 'About Zilker Family Dentistry', to: 'About Zilker Family Dentistry 🦷' },
  nonLatin: { from: 'Who is the best dentist in Austin?', to: 'オースティンでおすすめの歯医者はどこですか?' },
} as const;

function withWebTitles(doc: Document): Document {
  for (const { from, to } of Object.values(WEB_TITLES)) {
    const found = [...doc.querySelectorAll('h3, [role="heading"]')].filter((el) => el.textContent === from);
    if (found.length !== 1) throw new Error(`The results page fixture has ${found.length} titles "${from}": the examples need exactly one`);
    found[0]!.textContent = to;
  }
  return doc;
}

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

/*
 * The bundled sentence model, replayed.
 *
 * The normal engine of New or Noise is the sentence model that is bundled in the extension. Its runtime does not
 * work inside this test environment (jsdom), and its numbers differ a little from machine to machine. So the
 * model's answers for the sentences of the fixture articles are recorded in a file: every pair of sentences with
 * its cosine similarity. RecordedEmbeddingEngine returns those numbers. Everything after that, the classification
 * and the payload, is the extension's own code, so the example is what the extension sends for these pages.
 *
 * The recording is made by tests/helpers/embed-texts.mjs, which runs the model in a plain Node process with the
 * settings of the extension's worker. "npm run api:examples" makes it again when the sentences or the model have
 * changed; a normal test run never writes it.
 */
const SIMILARITIES_FILE = resolve(__dirname, 'api-example-similarities.json');
const EMBED_SCRIPT = resolve(__dirname, 'embed-texts.mjs');
/** Set by "npm run api:examples": files that are out of date may be written again. */
const MAY_UPDATE = process.env['LEGIIT_API_EXAMPLES_UPDATE'] === '1';

interface SimilarityRecording {
  about: string;
  model: string;
  /** Of the model file, as pinned in models.lock.json: another model needs another recording. */
  modelSha256: string;
  /** The sentences, in the order they were embedded (the model works in batches, so the order matters a little). */
  texts: string[];
  /** similarity[i][j] is the cosine similarity of texts[i] and texts[j], rounded to 6 decimals. */
  similarity: number[][];
}

function pinnedModel(): { id: string; sha256: string } {
  const lock = JSON.parse(readFileSync(resolve(__dirname, '../../models.lock.json'), 'utf8')) as { models: { id: string; files: { path: string; sha256: string }[] }[] };
  const model = lock.models[0]!;
  return { id: model.id, sha256: model.files.find((f) => f.path.endsWith('.onnx'))!.sha256 };
}

function recordSimilarities(texts: string[]): SimilarityRecording {
  const output = execFileSync(process.execPath, [EMBED_SCRIPT], { input: JSON.stringify(texts), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const { dims, data } = JSON.parse(output) as { dims: number; data: string };
  const bytes = Buffer.from(data, 'base64');
  const floats = new Float32Array(bytes.length / 4);
  for (let i = 0; i < floats.length; i++) floats[i] = bytes.readFloatLE(i * 4);
  // The extension's own arithmetic turns the vectors into similarities.
  const vectors = new DenseVectors(floats, dims);
  const similarity = texts.map((_a, i) => texts.map((_b, j) => Number(vectors.similarity(i, vectors, j).toFixed(6))));
  const model = pinnedModel();
  const recording: SimilarityRecording = {
    about:
      'Cosine similarities of the sentences of fixtures/articles, from the sentence model that is bundled in the extension (public/models), embedded as the worker of the extension embeds them: in this order, in batches of 16, with mean pooling, normalised. Recorded by tests/helpers/embed-texts.mjs for tests/helpers/api-examples.ts. Do not edit: run "npm run api:examples".',
    model: model.id,
    modelSha256: model.sha256,
    texts,
    similarity,
  };
  const head = JSON.stringify({ about: recording.about, model: recording.model, modelSha256: recording.modelSha256, texts }, null, 2).replace(/\n\}$/, '');
  writeFileSync(SIMILARITIES_FILE, `${head},\n  "similarity": [\n${similarity.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]\n}\n`);
  return recording;
}

function recordedSimilarities(texts: string[]): SimilarityRecording {
  const stored = existsSync(SIMILARITIES_FILE) ? (JSON.parse(readFileSync(SIMILARITIES_FILE, 'utf8')) as SimilarityRecording) : null;
  if (stored && stored.modelSha256 === pinnedModel().sha256 && JSON.stringify(stored.texts) === JSON.stringify(texts)) return stored;
  if (MAY_UPDATE) return recordSimilarities(texts);
  throw new Error(
    'tests/helpers/api-example-similarities.json is out of date: the sentences of the fixture articles or the bundled model have changed. Run: npm run api:examples. ' +
      'That command records the file again with tests/helpers/embed-texts.mjs. If the file is still out of date after it, the model did not run: start the script by hand to see why (echo \'["a sentence"]\' | node tests/helpers/embed-texts.mjs).',
  );
}

class RecordedVectors implements Vectors {
  constructor(
    private readonly recording: SimilarityRecording,
    private readonly offset: number,
    readonly count: number,
  ) {}

  similarity(i: number, other: Vectors, j: number): number {
    if (!(other instanceof RecordedVectors) || other.recording !== this.recording) return 0;
    return this.recording.similarity[this.offset + i]![other.offset + j]!;
  }
}

/** The extension's embedding engine, with the model's answers read from the recording. */
class RecordedEmbeddingEngine implements SimilarityEngine {
  readonly kind = 'embedding' as const;
  readonly label = 'on-device sentence embeddings (all-MiniLM-L6-v2)';
  readonly sameThreshold = EMBEDDING_SAME_THRESHOLD;
  readonly passageThreshold = EMBEDDING_PASSAGE_THRESHOLD;

  async encodeGroups(groups: readonly (readonly string[])[]): Promise<Vectors[]> {
    // The extension embeds all groups as one list, in this order.
    const recording = recordedSimilarities(groups.flat());
    let offset = 0;
    return groups.map((group) => {
      const vectors = new RecordedVectors(recording, offset, group.length);
      offset += group.length;
      return vectors;
    });
  }
}

const ARTICLE = 'articles/brightpath-how-often-teeth-cleaning.html';
const ARTICLE_URL = manifest.routes.find((r) => r.file === ARTICLE)!.url;

/**
 * The New or Noise comparison of the fixture article with the competing
 * articles. By default with the word-overlap engine, which needs no model
 * (the extension uses it when the model cannot run).
 */
export async function buildExampleNoiseReport(pageCount = 5, engine: SimilarityEngine = new LexicalEngine()): Promise<{ report: NoiseReport; title: string }> {
  const doc = fixtureDoc(ARTICLE);
  const target = contentSentences(extractMainContent(doc));
  const pages = manifest.routes
    .filter((r) => r.file.startsWith('articles/') && r.file !== ARTICLE)
    .slice(0, pageCount)
    .map((r) => ({ url: r.url, title: r.url, sentences: contentSentences(extractMainContent(fixtureDoc(r.file))) }));
  return { report: await classifySentences(target, pages, engine), title: doc.title };
}

/** File name → request body, for every POST endpoint. Deterministic. */
export async function buildExampleRequests(): Promise<Record<string, unknown>> {
  const matcher = new BrandMatcher(scenarioBrands);
  const doc = withWebTitles(fixtureDoc('google/serp-full.html'));
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

  // The normal case: the page was compared with the bundled sentence model (replayed from the recording).
  const noise = await buildExampleNoiseReport(5, new RecordedEmbeddingEngine());
  // Text the user pasted, compared with a single page, on a device where the model could not run: the comparison
  // falls back to shared words. Several values are empty and all of them are valid.
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
    'createAccount.request.json': accountPayload('jordan.lee@example.com'),
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

/**
 * Error replies that the mock server never gives, named "error.<status>-<case>.json". Each message is one sentence
 * that says what is wrong and what the user can do: the extension shows it after "Legiit rejected the request (<status>): ".
 */
const EXAMPLE_ERRORS: Record<string, { code: string; message: string }> = {
  'error.400-unreadable-body.json': { code: 'bad_request', message: 'The request body is not valid JSON.' },
  'error.403-role-may-not-save.json': { code: 'forbidden', message: 'Your role in this business may not add competitors: ask the owner of the business to change your role.' },
  'error.409-save-still-running.json': { code: 'conflict', message: 'This save is still running: wait a few seconds, then send it again.' },
  'error.413-body-too-large.json': { code: 'too_large', message: 'The request body is larger than 1 MB.' },
  'error.429-allowance-used-up.json': { code: 'allowance_used_up', message: 'Your AI allowance for today is used up: try again in 6 hours.' },
  'error.429-too-many-requests.json': { code: 'rate_limited', message: 'Too many requests: try again in 1 minute.' },
};

/** An example reply that is not an answer of the mock server: its status, the schema of the contract it must match, and its body. */
export interface ReplyExample {
  status: number;
  schema: 'Session' | 'BusinessList' | 'BusinessDetails' | 'SaveResult' | 'Error';
  body: unknown;
}

/**
 * Replies for cases that the mock server does not have. A system built on Laravel and MySQL returns integer ids;
 * the smallest launch is a session without capabilities; a save has no page to link to until that page is built.
 * Each of these is a reply of the mock server with that one thing changed, so the rest stays what the mock gives.
 *
 * "anySave" is not an endpoint: these two replies are the same for all five saves.
 */
export function buildExampleReplies(): Record<string, ReplyExample> {
  const state = createMockState();
  const mock = <T>(method: 'GET' | 'POST', path: string, body?: unknown): T =>
    JSON.parse(handleMockRequest(state, { method, path, headers: { authorization: `Bearer ${MOCK_TOKENS.valid}` }, body: body === undefined ? null : JSON.stringify(body) }).body) as T;
  const session = mock<{ user: Record<string, unknown> } & Record<string, unknown>>('GET', '/v1/session');
  const list = mock<{ businesses: Record<string, unknown>[] }>('GET', '/v1/businesses');
  const details = mock<Record<string, unknown>>('GET', `/v1/businesses/${EXAMPLE_BUSINESS_ID}`);
  const saved = mock<{ id: string; url: string }>('POST', `/v1/businesses/${EXAMPLE_BUSINESS_ID}/competitors`, competitorPayload({ name: 'Riverbend Dental', domains: ['riverbenddental.example'] }));
  /** Integer ids as an auto-increment column gives them. The same business has the same id in the list and in its details. */
  const businessId = (index: number): number => 31 + 27 * index;
  return {
    'getSession.integer-ids.response.json': { status: 200, schema: 'Session', body: { ...session, user: { ...session.user, id: 4127 } } },
    'getSession.no-capabilities.response.json': { status: 200, schema: 'Session', body: { ...session, capabilities: [] } },
    'listBusinesses.integer-ids.response.json': { status: 200, schema: 'BusinessList', body: { businesses: list.businesses.map((business, index) => ({ ...business, id: businessId(index) })) } },
    'getBusinessDetails.integer-ids.response.json': { status: 200, schema: 'BusinessDetails', body: { ...details, id: businessId(0) } },
    'anySave.integer-id.response.json': { status: 201, schema: 'SaveResult', body: { id: 9041, url: saved.url.replace(saved.id, '9041') } },
    'anySave.url-null.response.json': { status: 201, schema: 'SaveResult', body: { ...saved, url: null } },
    ...Object.fromEntries(Object.entries(EXAMPLE_ERRORS).map(([name, error]) => [name, { status: Number(name.slice(6, 9)), schema: 'Error' as const, body: { error } }])),
  };
}

export const toExampleJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
