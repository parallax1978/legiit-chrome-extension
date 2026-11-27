/** Per-keyword snapshots of Click Potential, stored locally in IndexedDB, and their CSV exports. */
import { toCsv, type CsvCell } from '@/lib/csv';
import type { AddressSource, SerpData, Viewport } from '@/model/schemas';
import { BLOCK_LABELS, foldLabel, type BlockShare, type ClickPotential, type FoldStatus, type GradeLetter, type ShareType, type TrackedRow } from './metrics';

export interface SnapshotRecord {
  /** The page-load id: re-measuring the same page updates this record. */
  id: string;
  keyword: string;
  /** Lower-cased, whitespace-normalised keyword used for grouping history. */
  keywordKey: string;
  url: string;
  host: string;
  mode: SerpData['mode'];
  takenAt: number;
  viewport: Viewport;
  locationText: string | null;
  firstOrganicTop: number | null;
  firstOrganicFold: FoldStatus | null;
  organicShare: number;
  gradeLetter: GradeLetter;
  gradeScore: number;
  shares: BlockShare[];
  /**
   * `address` says how `url` is known (see AddressSource). A record without it was stored before Google hid links:
   * 'link'. `guess` is the page address the line under the title spelled out, for a result of which only the site
   * is known: unchecked.
   */
  organic: { position: number; domain: string; url: string; address?: AddressSource; guess?: string | null; title: string; top: number | null; fold: FoldStatus | null }[];
  tracked: TrackedRow[];
  /** Why Not Me summary for the same page, when brands were tracked at the time. Reused by Instant Brief. */
  presence: SnapshotPresence | null;
}

export interface SnapshotPresence {
  surfaces: { id: string; label: string; status: string; competitors: string[] }[];
  /** Labels of surfaces where competitors appear and the user's brand does not. */
  gapSurfaces: string[];
}

export function keywordKey(keyword: string): string {
  return keyword.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function toSnapshot(serp: SerpData, cp: ClickPotential, presence: SnapshotPresence | null = null): SnapshotRecord {
  return {
    id: serp.pageId,
    keyword: serp.keyword,
    keywordKey: keywordKey(serp.keyword),
    url: serp.url,
    host: new URL(serp.url).hostname,
    mode: serp.mode,
    takenAt: serp.capturedAt,
    viewport: serp.viewport,
    locationText: serp.locationText,
    firstOrganicTop: cp.firstOrganicTop,
    firstOrganicFold: cp.firstOrganicFold,
    organicShare: cp.organicShare,
    gradeLetter: cp.grade.letter,
    gradeScore: cp.grade.score,
    shares: cp.shares,
    organic: cp.organic.map((o) => ({ position: o.position, domain: o.domain, url: o.url, address: o.address, ...(o.guess ? { guess: o.guess } : {}), title: o.title, top: o.top, fold: o.fold })),
    tracked: cp.tracked,
    presence,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const pct = (fraction: number): number => Math.round(fraction * 1000) / 10;

/** One row per organic result on the current page. */
export function organicCsv(serp: SerpData, cp: ClickPotential): string {
  const headers = [
    'keyword', 'captured_at', 'viewport', 'location', 'position', 'title', 'url', 'domain',
    'top_px', 'fold', 'tracked_as', 'brand', 'list_style', 'address',
  ];
  const rows: CsvCell[][] = cp.organic.map((o) => [
    serp.keyword,
    iso(serp.capturedAt),
    `${serp.viewport.width}x${serp.viewport.height}`,
    serp.locationText ?? '',
    o.position,
    o.title,
    o.url,
    o.domain,
    o.top,
    foldLabel(o.fold),
    o.owner === 'mine' ? 'my brand' : o.owner === 'competitor' ? 'competitor' : '',
    o.brand ?? '',
    o.listStyle,
    // Google can hide where a link leads: then `url` is the site's home page, or Google's own link.
    o.address === 'link' ? 'page' : o.address === 'site' ? 'site only' : 'hidden by Google',
  ]);
  return toCsv(headers, rows);
}

const SHARE_COLUMNS: ShareType[] = [
  'organic', 'ai_overview', 'ad', 'local_pack', 'featured_snippet', 'paa', 'video', 'image', 'shopping', 'forum', 'top_stories', 'knowledge_panel',
];

/** One row per saved snapshot. */
export function historyCsv(snapshots: readonly SnapshotRecord[]): string {
  const headers = [
    'keyword', 'captured_at', 'google_host', 'viewport', 'location', 'first_organic_px', 'first_organic_fold',
    'grade_estimate', 'score', ...SHARE_COLUMNS.map((t) => `first_screen_pct_${BLOCK_LABELS[t].toLowerCase().replace(/\s+/g, '_')}`),
    'my_best_position', 'my_best_top_px',
  ];
  const rows: CsvCell[][] = snapshots.map((s) => {
    const mine = s.tracked.filter((t) => t.owner === 'mine' && t.position !== null).sort((a, b) => a.position! - b.position!)[0];
    return [
      s.keyword,
      iso(s.takenAt),
      s.host,
      `${s.viewport.width}x${s.viewport.height}`,
      s.locationText ?? '',
      s.firstOrganicTop,
      foldLabel(s.firstOrganicFold),
      s.gradeLetter,
      s.gradeScore,
      ...SHARE_COLUMNS.map((t) => pct(s.shares.find((x) => x.type === t)?.share ?? 0)),
      mine?.position ?? null,
      mine?.top ?? null,
    ];
  });
  return toCsv(headers, rows);
}
