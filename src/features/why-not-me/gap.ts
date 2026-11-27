/**
 * Why Not Me, step 3: the gap list. One row per place where a competitor is
 * present and the user's brand is not. Sortable, exportable as CSV.
 */
import type { OpportunityLink } from '@/extract/links';
import { toCsv, type CsvCell } from '@/lib/csv';
import { hashString } from '@/lib/hash';
import { urlKey } from '@/lib/url';
import type { Presence, SurfaceId } from './presence';
import type { PageScan } from './scan';

export type GapPageType = 'competitor-site' | 'list' | 'forum' | 'video' | 'third-party' | 'surface';

/** Machine-readable id of where a gap was found. "scanned_page": found only by reading a cited or list-style page. */
export type GapSurfaceId = SurfaceId | 'scanned_page';

export interface GapRow {
  id: string;
  surfaceId: GapSurfaceId;
  /**
   * Display label: "AI Overview citation", "Organic #3", "Local pack",
   * "Answer text", "Forums text"… Rows found only by a scan carry the label of
   * where the page was linked from ("AI Mode citation", "Cited by ChatGPT").
   */
  surface: string;
  position: number | null;
  title: string;
  url: string | null;
  domain: string | null;
  /** True when Google hides the page's address and `url` is only the home page of the site. Shown as text, not as a link. */
  siteOnly: boolean;
  competitors: string[];
  /** Why this row is a gap, in words. */
  evidence: string;
  pageType: GapPageType;
  /** True for third-party pages where the user could plausibly get included. */
  actionable: boolean;
  scanned: boolean;
  contacts: OpportunityLink[];
  /** Higher sorts first by default. */
  priority: number;
}

export type GapSortKey = 'priority' | 'surface' | 'position' | 'competitors' | 'domain' | 'title';

const SURFACE_WEIGHT: Readonly<Record<GapSurfaceId, number>> = {
  ai_overview: 100,
  answer_text: 100,
  citations: 95,
  scanned_page: 90,
  local_pack: 80,
  featured_snippet: 75,
  organic: 70,
  forum: 50,
  video: 40,
  top_stories: 35,
  ad: 20,
  shopping: 20,
};

const SURFACE_ITEM_LABEL: Partial<Record<SurfaceId, string>> = {
  ai_overview: 'AI Overview citation',
  organic: 'Organic',
  local_pack: 'Local pack',
  forum: 'Forum result',
  video: 'Video result',
  ad: 'Ad',
  featured_snippet: 'Featured snippet',
  top_stories: 'Top story',
  shopping: 'Shopping',
  citations: 'Cited page',
};

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function priority(surfaceId: GapSurfaceId, position: number | null, competitors: number, actionable: boolean, contacts: number): number {
  return SURFACE_WEIGHT[surfaceId] - Math.min(position ?? 0, 30) + competitors * 10 + (actionable ? 15 : 0) + (contacts > 0 ? 5 : 0);
}

/**
 * Builds the gap list from surface presence and, when available, page scans.
 * A scanned page replaces the unscanned row for the same URL (it knows more).
 */
export function buildGapRows(presence: Presence, scans: readonly PageScan[] = []): GapRow[] {
  const rows: GapRow[] = [];
  const scanByUrl = new Map(scans.filter((s) => s.ok).map((s) => [urlKey(s.target.url), s]));

  for (const surface of presence.surfaces) {
    if (!surface.present) continue;

    // The surface's own wording names competitors and not the user.
    if (surface.textCompetitors.length > 0 && surface.textMine.length === 0) {
      const what = surface.id !== 'answer_text' ? `The ${surface.label} text` : presence.site === 'pasted' ? 'The pasted answer' : `The ${presence.sourceLabel} answer`;
      rows.push({
        id: hashString(`${presence.subject}|${surface.id}|text`),
        surfaceId: surface.id,
        surface: surface.id === 'answer_text' ? 'Answer text' : `${surface.label} text`,
        position: null,
        title: `${what} names ${list(surface.textCompetitors)}`,
        url: null,
        domain: null,
        siteOnly: false,
        competitors: surface.textCompetitors,
        evidence: `${what} names ${list(surface.textCompetitors)} and does not mention you.`,
        pageType: 'surface',
        actionable: false,
        scanned: false,
        contacts: [],
        priority: priority(surface.id, null, surface.textCompetitors.length, false, 0),
      });
    }

    for (const item of surface.items) {
      // An item of which only the site is known is not the page at the site's home address. A scan belongs to it
      // only through the address under its title, which the scan has then checked against the item's title.
      const scan = item.siteOnly ? (item.guess ? scanByUrl.get(urlKey(item.guess)) : undefined) : item.url ? scanByUrl.get(urlKey(item.url)) : undefined;
      const found = item.siteOnly && scan && item.guess ? item.guess : null;
      // A scan overrides what the title alone suggested.
      const competitors = scan ? [...new Set([...item.competitors, ...scan.competitors.map((c) => c.name)])] : item.competitors;
      const minePresent = item.mine.length > 0 || (scan?.myBrandPresent ?? false);
      if (competitors.length === 0 || minePresent) continue;

      const label = SURFACE_ITEM_LABEL[surface.id] ?? surface.label;
      const where = surface.id === 'organic' && item.position ? `${label} #${item.position}` : label;
      const ownSite = item.ownSite === 'competitor';
      const pageType: GapPageType = ownSite
        ? 'competitor-site'
        : surface.id === 'forum'
          ? 'forum'
          : surface.id === 'video'
            ? 'video'
            : item.listStyle || scan?.listStyle
              ? 'list'
              : 'third-party';
      const actionable = !ownSite && surface.id !== 'ad' && surface.id !== 'local_pack';
      const evidence = ownSite
        ? `${list(competitors)}'s own page appears here; yours does not.`
        : scan && scan.competitors.length > 0
          ? `This page names ${list(scan.competitors.map((c) => `${c.name} (${c.mentions}×)`))} and never mentions you.`
          : surface.id === 'local_pack'
            ? `${list(competitors)} is listed in the local pack; you are not.`
            : `Names ${list(competitors)}, not you.`;
      rows.push({
        // Two items of one site share the site's home address: they are told apart by their title and place.
        id: hashString(`${presence.subject}|${surface.id}|${item.siteOnly ? `${item.title}|${item.position}` : (item.url ?? item.title)}`),
        surfaceId: surface.id,
        surface: where,
        position: item.position,
        title: scan?.title || item.title,
        url: found ?? item.url,
        domain: item.domain,
        siteOnly: item.siteOnly && !found,
        competitors,
        evidence,
        pageType,
        actionable,
        scanned: scan !== undefined,
        contacts: scan?.contacts ?? [],
        priority: priority(surface.id, item.position, competitors.length, actionable, scan?.contacts.length ?? 0),
      });
    }
  }

  // Scanned pages that were not items of a surface with competitor hits (e.g. a neutral-looking listicle).
  const covered = new Set(rows.filter((r) => r.url && !r.siteOnly).map((r) => urlKey(r.url!)));
  for (const scan of scans) {
    if (!scan.ok || !scan.isGap || covered.has(urlKey(scan.target.url))) continue;
    const names = scan.competitors.map((c) => c.name);
    rows.push({
      id: hashString(`${presence.subject}|scan|${scan.target.url}`),
      surfaceId: 'scanned_page',
      surface: scan.target.foundIn,
      position: scan.target.position,
      title: scan.title,
      url: scan.target.url,
      domain: scan.target.domain,
      siteOnly: false,
      competitors: names,
      evidence: `This page names ${list(scan.competitors.map((c) => `${c.name} (${c.mentions}×)`))} and never mentions you.`,
      pageType: scan.listStyle ? 'list' : 'third-party',
      actionable: true,
      scanned: true,
      contacts: scan.contacts,
      priority: priority('scanned_page', scan.target.position, names.length, true, scan.contacts.length),
    });
  }

  return sortGapRows(rows, 'priority', 'desc');
}

export function sortGapRows(rows: readonly GapRow[], key: GapSortKey, direction: 'asc' | 'desc'): GapRow[] {
  const sign = direction === 'asc' ? 1 : -1;
  const value = (row: GapRow): string | number => {
    switch (key) {
      case 'priority':
        return row.priority;
      case 'surface':
        return row.surface.toLowerCase();
      case 'position':
        return row.position ?? Number.MAX_SAFE_INTEGER;
      case 'competitors':
        return row.competitors.length;
      case 'domain':
        return (row.domain ?? '').toLowerCase();
      case 'title':
        return row.title.toLowerCase();
    }
  };
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return cmp !== 0 ? cmp * sign : b.priority - a.priority || a.id.localeCompare(b.id);
  });
}

export function gapCsv(presence: Presence, rows: readonly GapRow[]): string {
  const headers = [
    'source', 'query_or_question', 'surface', 'position', 'title', 'url', 'domain', 'competitors_present',
    'your_brand_present', 'evidence', 'page_type', 'actionable', 'scanned', 'contact_links', 'address',
  ];
  const data: CsvCell[][] = rows.map((r) => [
    presence.sourceLabel,
    presence.subject,
    r.surface,
    r.position,
    r.title,
    r.url ?? '',
    r.domain ?? '',
    r.competitors.join('; '),
    false,
    r.evidence,
    r.pageType,
    r.actionable,
    r.scanned,
    r.contacts.map((c) => `${c.kind}: ${c.url}`).join(' | '),
    // Google can hide where a result leads: then `url` is the home page of its site.
    r.url === null ? '' : r.siteOnly ? 'site only' : 'page',
  ]);
  return toCsv(headers, data);
}
