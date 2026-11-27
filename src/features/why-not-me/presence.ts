/**
 * Why Not Me, step 1: where do tracked brands and competitors appear?
 * For Google: AI Overview, organic results, local pack, forums and videos
 * (plus ads and the featured snippet when present). For AI answers: the
 * answer text and its cited pages.
 */
import { splitHits, type BrandMatcher } from '@/brands/matcher';
import { AI_SITES, type AiSiteId } from '@/config/sites';
import type { AnswerData, AnswerSite, BlockType, SerpData, SerpItem } from '@/model/schemas';

export type SurfaceId =
  | 'ai_overview'
  | 'organic'
  | 'local_pack'
  | 'forum'
  | 'video'
  | 'ad'
  | 'featured_snippet'
  | 'top_stories'
  | 'shopping'
  | 'answer_text'
  | 'citations';

export const SURFACE_LABELS: Readonly<Record<SurfaceId, string>> = {
  ai_overview: 'AI Overview',
  organic: 'Organic results',
  local_pack: 'Local pack',
  forum: 'Forums',
  video: 'Videos',
  ad: 'Ads',
  featured_snippet: 'Featured snippet',
  top_stories: 'Top stories',
  shopping: 'Shopping',
  answer_text: 'Answer text',
  citations: 'Cited pages',
};

export interface PresenceItem {
  title: string;
  url: string | null;
  domain: string | null;
  position: number | null;
  /** Names of the user's brands found on this item. */
  mine: string[];
  /** Names of competitors found on this item. */
  competitors: string[];
  /** The item is a tracked brand's own website. */
  ownSite: 'mine' | 'competitor' | null;
  listStyle: boolean;
}

export type SurfaceStatus = 'both' | 'only-you' | 'only-competitors' | 'neither' | 'absent';

export interface SurfacePresence {
  id: SurfaceId;
  label: string;
  /** False when the page has no such surface (for example, no AI Overview for this query). */
  present: boolean;
  items: PresenceItem[];
  /** Brands named in the surface's own text (AI Overview body, answer wording). */
  textMine: string[];
  textCompetitors: string[];
  minePresent: boolean;
  /** Distinct competitor names anywhere on this surface. */
  competitorNames: string[];
  status: SurfaceStatus;
}

export interface Presence {
  kind: 'google' | 'answer';
  /** Keyword or question. */
  subject: string;
  /** "Google results", "Google AI Mode", "ChatGPT", … */
  sourceLabel: string;
  site: 'google' | AnswerSite;
  capturedAt: number;
  surfaces: SurfacePresence[];
}

export function answerSiteLabel(site: AnswerSite): string {
  if (site === 'google-ai-mode') return 'Google AI Mode';
  if (site === 'google-ai-overview') return 'Google AI Overview';
  if (site === 'pasted') return 'Pasted answer';
  return AI_SITES[site as AiSiteId].label;
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function toItem(matcher: BrandMatcher, item: SerpItem, position: number | null, listStyle = false): PresenceItem {
  const hits = matcher.matchItem(item);
  const { mine, competitors } = splitHits(hits);
  const domainHit = hits.find((h) => h.via === 'domain');
  return {
    title: item.title,
    url: item.url,
    domain: item.domain,
    position,
    mine: unique(mine.map((h) => h.name)),
    competitors: unique(competitors.map((h) => h.name)),
    ownSite: domainHit ? domainHit.owner : null,
    listStyle,
  };
}

function finish(id: SurfaceId, present: boolean, items: PresenceItem[], text: string, matcher: BrandMatcher): SurfacePresence {
  const textHits = splitHits(matcher.matchText(text));
  const textMine = unique(textHits.mine.map((h) => h.name));
  const textCompetitors = unique(textHits.competitors.map((h) => h.name));
  const minePresent = textMine.length > 0 || items.some((i) => i.mine.length > 0);
  const competitorNames = unique([...textCompetitors, ...items.flatMap((i) => i.competitors)]);
  const status: SurfaceStatus = !present
    ? 'absent'
    : minePresent && competitorNames.length > 0
      ? 'both'
      : minePresent
        ? 'only-you'
        : competitorNames.length > 0
          ? 'only-competitors'
          : 'neither';
  return { id, label: SURFACE_LABELS[id], present, items, textMine, textCompetitors, minePresent, competitorNames, status };
}

const BLOCK_SURFACES: readonly { type: BlockType; id: SurfaceId; always: boolean }[] = [
  { type: 'local_pack', id: 'local_pack', always: true },
  { type: 'forum', id: 'forum', always: true },
  { type: 'video', id: 'video', always: true },
  { type: 'ad', id: 'ad', always: false },
  { type: 'featured_snippet', id: 'featured_snippet', always: false },
  { type: 'top_stories', id: 'top_stories', always: false },
  { type: 'shopping', id: 'shopping', always: false },
];

export function buildSerpPresence(serp: SerpData, matcher: BrandMatcher): Presence {
  const surfaces: SurfacePresence[] = [];

  // AI Overview (or the AI Mode answer): citations plus the brands its text names.
  const overview = serp.blocks.find((b) => b.type === 'ai_overview');
  const answer = serp.aiAnswer;
  if (answer?.recognised) {
    const items = answer.citations.map((c, i) => toItem(matcher, { title: c.title, url: c.url, domain: c.domain, text: '' }, i + 1));
    surfaces.push(finish('ai_overview', true, items, answer.text, matcher));
  } else {
    surfaces.push(finish('ai_overview', overview !== undefined, [], overview?.text ?? '', matcher));
  }

  if (serp.mode === 'web') {
    surfaces.push(
      finish(
        'organic',
        serp.organic.length > 0,
        // A result whose address Google hides and whose site the page does not name has no address to show.
        serp.organic.map((o) => toItem(matcher, { title: o.title, url: o.address === 'hidden' ? null : o.url, domain: o.address === 'hidden' ? null : o.domain, text: o.snippet }, o.position, o.listStyle)),
        '',
        matcher,
      ),
    );
    for (const { type, id, always } of BLOCK_SURFACES) {
      const blocks = serp.blocks.filter((b) => b.type === type);
      if (blocks.length === 0 && !always) continue;
      const items = blocks.flatMap((b) => b.items).map((item, i) => toItem(matcher, item, i + 1));
      // When a block's items could not be itemised (markup changed), fall back to the block's text.
      const text = items.length === 0 ? blocks.map((b) => b.text).join('\n') : '';
      surfaces.push(finish(id, blocks.length > 0, items, text, matcher));
    }
  }

  return {
    kind: 'google',
    subject: serp.keyword,
    sourceLabel: serp.mode === 'ai-mode' ? 'Google AI Mode' : 'Google results',
    site: 'google',
    capturedAt: serp.capturedAt,
    surfaces,
  };
}

export function buildAnswerPresence(answer: AnswerData, matcher: BrandMatcher): Presence {
  const items = answer.citations.map((c, i) => toItem(matcher, { title: c.title, url: c.url, domain: c.domain, text: '' }, i + 1));
  return {
    kind: 'answer',
    subject: answer.question ?? '',
    sourceLabel: answerSiteLabel(answer.site),
    site: answer.site,
    capturedAt: answer.capturedAt,
    surfaces: [
      finish('answer_text', answer.text.length > 0, [], answer.text, matcher),
      finish('citations', items.length > 0, items, '', matcher),
    ],
  };
}

/** A compact summary stored with a Click Potential snapshot, so Instant Brief can reuse it later. */
export function summarisePresence(presence: Presence): {
  surfaces: { id: string; label: string; status: string; competitors: string[] }[];
  gapSurfaces: string[];
} {
  const present = presence.surfaces.filter((s) => s.present);
  return {
    surfaces: present.map((s) => ({ id: s.id, label: s.label, status: s.status, competitors: s.competitorNames })),
    gapSurfaces: present.filter((s) => s.status === 'only-competitors').map((s) => s.label),
  };
}

/** Deterministic plain-language summary (the no-AI provider). */
export function explainPresence(presence: Presence, matcher: BrandMatcher): string[] {
  if (matcher.isEmpty) return ['Add your brand and at least one competitor in Settings to see where each appears.'];
  const present = presence.surfaces.filter((s) => s.present);
  if (present.length === 0) return ['Nothing on this page could be read.'];
  const lines: string[] = [];
  const mineIn = present.filter((s) => s.minePresent);
  if (matcher.hasMine) {
    lines.push(
      mineIn.length === 0
        ? `Your brand does not appear on any of the ${present.length} surfaces read from ${presence.sourceLabel}.`
        : `Your brand appears on ${mineIn.length} of ${present.length} surfaces: ${mineIn.map((s) => s.label.toLowerCase()).join(', ')}.`,
    );
  }
  const tally = new Map<string, string[]>();
  for (const surface of present) for (const name of surface.competitorNames) tally.set(name, [...(tally.get(name) ?? []), surface.label.toLowerCase()]);
  if (tally.size > 0) {
    const ranked = [...tally].sort((a, b) => b[1].length - a[1].length);
    lines.push(`Competitors: ${ranked.map(([name, where]) => `${name} (${where.join(', ')})`).join('; ')}.`);
  } else if (matcher.hasCompetitors) {
    lines.push('None of your tracked competitors appear here.');
  }
  const gaps = present.filter((s) => s.status === 'only-competitors');
  if (gaps.length > 0) lines.push(`Competitors are present and you are not on: ${gaps.map((s) => s.label.toLowerCase()).join(', ')}.`);
  const absent = presence.surfaces.filter((s) => !s.present).map((s) => s.label.toLowerCase());
  if (absent.length > 0) lines.push(`Not shown for this ${presence.kind === 'google' ? 'query' : 'answer'}: ${absent.join(', ')}.`);
  return lines;
}
