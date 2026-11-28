/**
 * Click Potential: how much room organic results get on a Google results page.
 *
 * Everything here is arithmetic on rectangles measured by the content script.
 * The grade is a transparent estimate, not a click-through prediction; its
 * formula is spelled out in GRADE_METHOD and docs/ARCHITECTURE.md.
 */
import { CROWDING_LABELS, crowdingOf, howFarDown } from '@/features/overview/words';
import type { BrandMatcher, Owner } from '@/brands/matcher';
import { intersect, unionArea, type Rect } from '@/lib/rect';
import { formatInt, formatPercent } from '@/lib/text';
import type { AddressSource, BlockType, SerpData, Viewport } from '@/model/schemas';

export type FoldStatus = 'above' | 'partly' | 'below';
export type ShareType = BlockType | 'organic';
export type GradeLetter = 'A' | 'B' | 'C' | 'D' | 'F';

export const BLOCK_LABELS: Readonly<Record<ShareType, string>> = {
  organic: 'Organic results',
  ai_overview: 'AI Overview',
  ad: 'Ads',
  local_pack: 'Local pack',
  featured_snippet: 'Featured snippet',
  paa: 'People also ask',
  video: 'Videos',
  image: 'Images',
  shopping: 'Shopping',
  forum: 'Discussions and forums',
  top_stories: 'Top stories',
  knowledge_panel: 'Knowledge panel',
};

export interface BlockShare {
  type: ShareType;
  label: string;
  /** Fraction of the first screen's area (0-1). */
  share: number;
  /** Visible pixels of this type on the first screen. */
  pixels: number;
  /** How many blocks of this type the page has in total. */
  count: number;
}

export interface OrganicRow {
  position: number;
  title: string;
  url: string;
  domain: string;
  /** "link": `url` is the page. "site": Google hid the link and only the site is known. "hidden": not even that. */
  address: AddressSource;
  /** For address 'site': the page address the line under the title spells out. A guess, null when there is none. */
  guess: string | null;
  /** Pixels from the top of the page to the top of the result. Null when not measured. */
  top: number | null;
  fold: FoldStatus | null;
  owner: Owner | null;
  brand: string | null;
  listStyle: boolean;
}

export interface TrackedRow {
  owner: Owner;
  brandId: string;
  name: string;
  /** First organic result for this brand on the page, if any. */
  position: number | null;
  top: number | null;
  fold: FoldStatus | null;
}

export interface Grade {
  letter: GradeLetter;
  /** 0-100. */
  score: number;
  /** Points lost because the first organic result starts lower on the first screen (0-60). */
  positionPenalty: number;
  /** Points lost because other blocks take first-screen space from organic results (0-40). */
  displacementPenalty: number;
  /** Always true: the grade is an estimate, never a measured click-through rate. */
  estimate: true;
}

export interface ClickPotential {
  keyword: string;
  viewport: Viewport;
  /** False when the page carried no geometry (nothing could be measured). */
  measured: boolean;
  firstOrganicTop: number | null;
  firstOrganicFold: FoldStatus | null;
  /** firstOrganicTop divided by the viewport height: 1.0 means "exactly one screen down". */
  screensToFirstOrganic: number | null;
  /** First-screen share per block type, largest first. Types with no visible pixels are omitted. */
  shares: BlockShare[];
  organicShare: number;
  /** Share of the first screen that is neither a measured block nor an organic result. */
  remainderShare: number;
  /** Blocks that start above the first organic result, in page order. */
  aboveFirstOrganic: { type: BlockType; label: string }[];
  organic: OrganicRow[];
  tracked: TrackedRow[];
  grade: Grade;
  explanation: string[];
}

export const GRADE_METHOD = [
  'How crowded a search is, is an estimate of how much room the regular (organic) results get on the first screen. It is not a prediction of clicks.',
  'Room for regular results = 100 − position penalty − displacement penalty.',
  'Position penalty (0–60): how far down the first screen the first organic result starts, measured from the top of the results area to the bottom of the viewport. At the very top: 0. At or below the fold: 60.',
  'Displacement penalty (0–40): of the first-screen pixels covered by results, the fraction that is not organic (ads, AI Overview, local pack, featured snippet, People also ask, videos, images, shopping, forums, top stories). Knowledge panels sit beside the results and are not counted.',
  'Open: 70 to 100. Crowded: 30 to 69. Very crowded: below 30. (Exports keep the letter grade this is built on: A 85–100, B 70–84, C 50–69, D 30–49, F below 30.)',
  'The measurement depends on your viewport size, zoom, location and the moment the page was read. Compare snapshots taken with the same viewport.',
];

const POSITION_WEIGHT = 60;
const DISPLACEMENT_WEIGHT = 40;

export function gradeLetter(score: number): GradeLetter {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 50) return 'C';
  if (score >= 30) return 'D';
  return 'F';
}

export function foldStatus(rect: Rect | null, viewportHeight: number): FoldStatus | null {
  if (!rect) return null;
  if (rect.y >= viewportHeight) return 'below';
  if (rect.y + rect.height <= viewportHeight) return 'above';
  return 'partly';
}

export function foldLabel(status: FoldStatus | null): string {
  if (status === 'above') return 'Above the fold';
  if (status === 'partly') return 'Cut by the fold';
  if (status === 'below') return 'Below the fold';
  return 'Not measured';
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function computeClickPotential(serp: SerpData, matcher: BrandMatcher): ClickPotential {
  const { viewport } = serp;
  const firstScreen: Rect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const screenArea = Math.max(1, viewport.width * viewport.height);

  const visible = (rects: readonly (Rect | null)[]): Rect[] => {
    const out: Rect[] = [];
    for (const rect of rects) {
      const clipped = rect ? intersect(rect, firstScreen) : null;
      if (clipped) out.push(clipped);
    }
    return out;
  };

  // First-screen share per type.
  const byType = new Map<ShareType, (Rect | null)[]>();
  for (const block of serp.blocks) byType.set(block.type, [...(byType.get(block.type) ?? []), block.rect]);
  byType.set('organic', serp.organic.map((o) => o.rect));

  const shares: BlockShare[] = [];
  for (const [type, rects] of byType) {
    const pixels = unionArea(visible(rects));
    if (pixels > 0) shares.push({ type, label: BLOCK_LABELS[type], share: pixels / screenArea, pixels: Math.round(pixels), count: rects.length });
  }
  shares.sort((a, b) => b.share - a.share);
  const organicPixels = shares.find((s) => s.type === 'organic')?.pixels ?? 0;
  const organicShare = organicPixels / screenArea;
  const remainderShare = clamp01(1 - shares.reduce((sum, s) => sum + s.share, 0));

  // Organic rows.
  const organic: OrganicRow[] = serp.organic.map((result) => {
    const hit = matcher.matchDomain(result.domain)[0] ?? null;
    return {
      position: result.position,
      title: result.title,
      url: result.url,
      domain: result.domain,
      address: result.address ?? 'link',
      guess: result.guess ?? null,
      top: result.rect ? Math.round(result.rect.y) : null,
      fold: foldStatus(result.rect, viewport.height),
      owner: hit?.owner ?? null,
      brand: hit?.name ?? null,
      listStyle: result.listStyle,
    };
  });

  const measuredOrganic = serp.organic.filter((o) => o.rect !== null);
  const first = [...measuredOrganic].sort((a, b) => a.rect!.y - b.rect!.y)[0] ?? null;
  const firstOrganicTop = first ? Math.round(first.rect!.y) : null;
  const measured = measuredOrganic.length > 0 || serp.blocks.some((b) => b.rect !== null);

  const aboveFirstOrganic = serp.blocks
    .filter((b) => b.rect !== null && b.type !== 'knowledge_panel' && (firstOrganicTop === null || b.rect.y < firstOrganicTop))
    .sort((a, b) => a.rect!.y - b.rect!.y)
    .map((b) => ({ type: b.type, label: BLOCK_LABELS[b.type] }));

  // Tracked brands: first organic appearance of each.
  const tracked: TrackedRow[] = [];
  const seenBrands = new Set<string>();
  for (const result of serp.organic) {
    for (const hit of matcher.matchDomain(result.domain)) {
      if (seenBrands.has(hit.brandId)) continue;
      seenBrands.add(hit.brandId);
      tracked.push({
        owner: hit.owner,
        brandId: hit.brandId,
        name: hit.name,
        position: result.position,
        top: result.rect ? Math.round(result.rect.y) : null,
        fold: foldStatus(result.rect, viewport.height),
      });
    }
  }

  // Grade.
  const mainColumnRects = [
    ...serp.blocks.filter((b) => b.type !== 'knowledge_panel').map((b) => b.rect),
    ...serp.organic.map((o) => o.rect),
  ].filter((r): r is Rect => r !== null);
  const resultsTop = mainColumnRects.length > 0 ? Math.min(...mainColumnRects.map((r) => r.y)) : 0;
  const usable = Math.max(1, viewport.height - resultsTop);
  const position = firstOrganicTop === null ? 1 : clamp01((firstOrganicTop - resultsTop) / usable);
  const otherPixels = shares
    .filter((s) => s.type !== 'organic' && s.type !== 'knowledge_panel')
    .reduce((sum, s) => sum + s.pixels, 0);
  const displacement = organicPixels + otherPixels > 0 ? otherPixels / (organicPixels + otherPixels) : 0;
  const positionPenalty = Math.round(POSITION_WEIGHT * position);
  const displacementPenalty = Math.round(DISPLACEMENT_WEIGHT * displacement);
  const score = Math.max(0, Math.min(100, 100 - positionPenalty - displacementPenalty));
  const grade: Grade = { letter: gradeLetter(score), score, positionPenalty, displacementPenalty, estimate: true };

  const result: ClickPotential = {
    keyword: serp.keyword,
    viewport,
    measured,
    firstOrganicTop,
    firstOrganicFold: first ? foldStatus(first.rect, viewport.height) : null,
    screensToFirstOrganic: firstOrganicTop === null ? null : firstOrganicTop / Math.max(1, viewport.height),
    shares,
    organicShare,
    remainderShare,
    aboveFirstOrganic,
    organic,
    tracked,
    grade,
    explanation: [],
  };
  result.explanation = explainClickPotential(result, matcher);
  return result;
}

function countLabels(blocks: readonly { label: string }[]): string {
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(b.label, (counts.get(b.label) ?? 0) + 1);
  return [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(', ');
}

/** Plain-language reading of the numbers. Deterministic: this is the no-AI summary. */
export function explainClickPotential(cp: ClickPotential, matcher: BrandMatcher): string[] {
  if (!cp.measured) return ['This page could not be measured. Reload it with the side panel open and try again.'];
  const lines: string[] = [];
  if (cp.firstOrganicTop === null) {
    lines.push('No organic results were found on this page.');
  } else {
    const px = `${formatInt(cp.firstOrganicTop)} px from the top`;
    const far = howFarDown(cp.firstOrganicTop, cp.viewport.height);
    lines.push(
      far !== 'on the first screen'
        ? `The first result starts ${far} (${px}): people scroll before they see it.`
        : cp.firstOrganicFold === 'partly'
          ? `The first result is cut off by the bottom of the first screen (${px}).`
          : `The first result is on the first screen (${px}).`,
    );
  }
  if (cp.aboveFirstOrganic.length > 0) {
    lines.push(`Above it: ${countLabels(cp.aboveFirstOrganic)}.`);
  } else if (cp.firstOrganicTop !== null) {
    lines.push('Nothing sits above the first result.');
  }
  const other = cp.shares.filter((s) => s.type !== 'organic');
  lines.push(
    `Regular results fill ${formatPercent(cp.organicShare)} of the first screen${
      other.length > 0 ? `; ${other.map((s) => `${s.label.toLowerCase()} ${formatPercent(s.share)}`).join(', ')}` : ''
    }.`,
  );
  if (matcher.hasMine) {
    const mine = cp.tracked.filter((t) => t.owner === 'mine');
    if (mine.length === 0) {
      lines.push('Your site has no result on this page.');
    } else {
      for (const t of mine) {
        const where = howFarDown(t.top, cp.viewport.height);
        lines.push(`${t.name} is result #${t.position}${where ? `, ${where}` : ''}.`);
      }
    }
  }
  const rivals = cp.tracked.filter((t) => t.owner === 'competitor' && t.fold === 'above');
  if (rivals.length > 0) lines.push(`Competitors visible without scrolling: ${rivals.map((t) => `${t.name} (#${t.position})`).join(', ')}.`);
  lines.push(`This search is ${CROWDING_LABELS[crowdingOf(cp.grade.letter)].toLowerCase()}: room for regular results is ${cp.grade.score} out of 100 (an estimate).`);
  return lines;
}
