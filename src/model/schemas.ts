/**
 * Runtime schemas for everything that crosses a context boundary
 * (content script → service worker / side panel) or comes back from storage.
 *
 * Content scripts import only the *types* from this file, so the validation
 * library is not shipped into web pages. Receivers validate with `parse*`.
 */
import * as v from 'valibot';
import { AI_SITE_IDS } from '@/config/sites';
import { isHttpUrl } from '@/lib/sanitize';

const text = (max: number) => v.pipe(v.string(), v.maxLength(max));
const num = v.pipe(v.number(), v.finite());
const httpUrl = v.pipe(v.string(), v.maxLength(2048), v.check((value: string) => isHttpUrl(value), 'Expected an http(s) URL'));

export const RectSchema = v.object({ x: num, y: num, width: num, height: num });
export const ViewportSchema = v.object({ width: num, height: num, dpr: num });

/** Result-page block types Lens measures. Organic results are listed separately. */
export const BLOCK_TYPES = [
  'ai_overview',
  'ad',
  'local_pack',
  'featured_snippet',
  'paa',
  'video',
  'image',
  'shopping',
  'forum',
  'top_stories',
  'knowledge_panel',
] as const;

export const SerpItemSchema = v.object({
  title: text(400),
  url: v.nullable(httpUrl),
  domain: v.nullable(text(255)),
  text: text(1500),
});

export const SerpBlockSchema = v.object({
  type: v.picklist(BLOCK_TYPES),
  rect: v.nullable(RectSchema),
  items: v.pipe(v.array(SerpItemSchema), v.maxLength(80)),
  text: text(8000),
  matchedBy: text(240),
});

/**
 * How the address of an organic result is known. Google can hide where a link leads; the line under the title then
 * still names the site.
 *   link:   the exact address of the page: read from the link, or from the page's own data about that result.
 *   site:   only the site is known. `url` is the site's home page.
 *   hidden: nothing on the page says where it leads. `url` is Google's own redirect link, `domain` is empty.
 */
export const ADDRESS_SOURCES = ['link', 'site', 'hidden'] as const;
export type AddressSource = (typeof ADDRESS_SOURCES)[number];

export const OrganicResultSchema = v.object({
  position: num,
  title: text(400),
  url: httpUrl,
  domain: text(255),
  address: v.optional(v.picklist(ADDRESS_SOURCES), 'link'),
  snippet: text(1500),
  rect: v.nullable(RectSchema),
  listStyle: v.boolean(),
});

export const ANSWER_SITES = [...AI_SITE_IDS, 'google-ai-mode', 'google-ai-overview', 'pasted'] as const;

export const CitationSchema = v.object({
  url: httpUrl,
  domain: text(255),
  title: text(400),
});

export const AnswerDataSchema = v.object({
  kind: v.literal('answer'),
  site: v.picklist(ANSWER_SITES),
  url: v.nullable(httpUrl),
  question: v.nullable(text(4000)),
  text: text(60_000),
  citations: v.pipe(v.array(CitationSchema), v.maxLength(150)),
  capturedAt: num,
  /** False when the page markup was not recognised (the UI then offers "paste the answer"). */
  recognised: v.boolean(),
  packVersion: v.nullable(text(40)),
});

export const SerpDataSchema = v.object({
  kind: v.literal('serp'),
  /** Unique per page load, so re-measurements update one snapshot instead of adding more. */
  pageId: text(64),
  url: httpUrl,
  keyword: text(500),
  mode: v.picklist(['web', 'ai-mode']),
  capturedAt: num,
  viewport: ViewportSchema,
  documentHeight: num,
  locationText: v.nullable(text(200)),
  blocks: v.pipe(v.array(SerpBlockSchema), v.maxLength(150)),
  organic: v.pipe(v.array(OrganicResultSchema), v.maxLength(150)),
  aiAnswer: v.nullable(AnswerDataSchema),
  recognised: v.boolean(),
  packVersion: text(40),
});

export const PageSnapshotSchema = v.object({
  kind: v.literal('page'),
  url: httpUrl,
  title: text(1000),
  html: text(6_000_000),
  truncated: v.boolean(),
  selection: text(60_000),
  capturedAt: num,
  viewport: ViewportSchema,
});

export const PingReplySchema = v.object({
  ok: v.literal(true),
  /** Which script answered: the Google or AI-site content script, or the on-demand page agent. */
  agent: v.picklist(['google', 'ai', 'page']),
  site: v.nullable(v.picklist(AI_SITE_IDS)),
  url: httpUrl,
  title: text(1000),
  /** Google only: true on a results page that has a query. */
  serp: v.boolean(),
});

export const FetchedPageSchema = v.object({
  url: httpUrl,
  finalUrl: v.nullable(httpUrl),
  ok: v.boolean(),
  status: num,
  html: text(4_000_000),
  error: v.nullable(text(300)),
});

export const SameOriginFetchReplySchema = v.object({
  pages: v.pipe(v.array(FetchedPageSchema), v.maxLength(12)),
});

export const BrandStyleSchema = v.object({
  colors: v.pipe(
    v.array(v.object({ hex: text(9), weight: num, source: text(40) })),
    v.maxLength(24),
  ),
  logoUrl: v.nullable(httpUrl),
  logoDataUrl: v.nullable(text(600_000)),
  fonts: v.pipe(v.array(text(120)), v.maxLength(6)),
});

export const SelectorHealthSchema = v.object({
  site: text(40),
  packVersion: text(40),
  url: httpUrl,
  slots: v.pipe(
    v.array(
      v.object({
        slot: text(80),
        required: v.boolean(),
        matched: num,
        candidate: v.nullable(text(240)),
        candidateIndex: num,
        candidates: num,
      }),
    ),
    v.maxLength(80),
  ),
});

export const HighlightReplySchema = v.object({
  applied: num,
  missed: num,
  method: v.picklist(['css-highlight', 'overlay', 'none']),
});

export type Rect = v.InferOutput<typeof RectSchema>;
export type Viewport = v.InferOutput<typeof ViewportSchema>;
export type BlockType = (typeof BLOCK_TYPES)[number];
export type SerpItem = v.InferOutput<typeof SerpItemSchema>;
export type SerpBlock = v.InferOutput<typeof SerpBlockSchema>;
export type OrganicResult = v.InferOutput<typeof OrganicResultSchema>;
export type AnswerSite = (typeof ANSWER_SITES)[number];
export type Citation = v.InferOutput<typeof CitationSchema>;
export type AnswerData = v.InferOutput<typeof AnswerDataSchema>;
export type SerpData = v.InferOutput<typeof SerpDataSchema>;
export type PageSnapshot = v.InferOutput<typeof PageSnapshotSchema>;
export type PingReply = v.InferOutput<typeof PingReplySchema>;
export type FetchedPage = v.InferOutput<typeof FetchedPageSchema>;
export type SameOriginFetchReply = v.InferOutput<typeof SameOriginFetchReplySchema>;
export type BrandStyle = v.InferOutput<typeof BrandStyleSchema>;
export type SelectorHealth = v.InferOutput<typeof SelectorHealthSchema>;
export type HighlightReply = v.InferOutput<typeof HighlightReplySchema>;

/** Validates untrusted data. Returns null instead of throwing so callers can degrade gracefully. */
export function parseOrNull<TSchema extends v.GenericSchema>(
  schema: TSchema,
  data: unknown,
): v.InferOutput<TSchema> | null {
  const result = v.safeParse(schema, data);
  return result.success ? result.output : null;
}
