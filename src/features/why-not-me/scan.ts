/**
 * Why Not Me, step 2: "Scan sources". After the user grants access to the
 * sites involved, the cited pages and the list-style results (best / top /
 * vs / alternatives) are fetched and read: which competitors each page names,
 * whether it names the user's brand, and who to contact about it.
 */
import type { BrandMatcher } from '@/brands/matcher';
import type { PageDigest } from '@/extract/digest';
import type { OpportunityLink } from '@/extract/links';
import { urlKey } from '@/lib/url';
import type { AnswerData, SerpData } from '@/model/schemas';
import type { Passage } from './passages';

export type ScanReason = 'cited' | 'list';

export interface ScanTarget {
  url: string;
  title: string;
  domain: string;
  reason: ScanReason;
  /** Where the page was found: "AI Overview citation", "Organic #3", "Cited by ChatGPT"… */
  foundIn: string;
  position: number | null;
}

export interface BrandCount {
  name: string;
  mentions: number;
}

export interface PageScan {
  target: ScanTarget;
  ok: boolean;
  error: string | null;
  needsPermission: boolean;
  title: string;
  wordCount: number;
  /** Competitors the page names, most mentioned first. */
  competitors: BrandCount[];
  /** The user's brands the page names. */
  mine: BrandCount[];
  myBrandPresent: boolean;
  /** Competitors are named and the user's brand is not. */
  isGap: boolean;
  contacts: OpportunityLink[];
  /** For AI answers: passages most similar to the answer text. */
  passages: Passage[];
  listStyle: boolean;
}

export const MAX_SCAN_TARGETS = 12;

interface PickOptions {
  max?: number;
  /** Pages on the user's own domains are skipped: there is nothing to win there. */
  matcher?: BrandMatcher;
}

function isMine(url: string, matcher?: BrandMatcher): boolean {
  return matcher?.matchDomain(url).some((h) => h.owner === 'mine') ?? false;
}

/** Cited pages first, then list-style organic results, without duplicates. */
export function pickSerpTargets(serp: SerpData, options: PickOptions = {}): ScanTarget[] {
  const targets: ScanTarget[] = [];
  const seen = new Set<string>();
  const add = (target: ScanTarget): void => {
    const key = urlKey(target.url);
    if (seen.has(key) || isMine(target.url, options.matcher)) return;
    seen.add(key);
    targets.push(target);
  };
  const citedIn = serp.mode === 'ai-mode' ? 'AI Mode citation' : 'AI Overview citation';
  for (const [i, c] of (serp.aiAnswer?.citations ?? []).entries()) {
    add({ url: c.url, title: c.title, domain: c.domain, reason: 'cited', foundIn: citedIn, position: i + 1 });
  }
  for (const o of serp.organic) {
    // Only a page whose address is known can be read: the home page of its site is another page.
    if (o.listStyle && (o.address ?? 'link') === 'link') add({ url: o.url, title: o.title, domain: o.domain, reason: 'list', foundIn: `Organic #${o.position}`, position: o.position });
  }
  return targets.slice(0, options.max ?? MAX_SCAN_TARGETS);
}

export function pickAnswerTargets(answer: AnswerData, siteLabel: string, options: PickOptions = {}): ScanTarget[] {
  const targets: ScanTarget[] = [];
  const seen = new Set<string>();
  for (const [i, c] of answer.citations.entries()) {
    const key = urlKey(c.url);
    if (seen.has(key) || isMine(c.url, options.matcher)) continue;
    seen.add(key);
    targets.push({ url: c.url, title: c.title, domain: c.domain, reason: 'cited', foundIn: `Cited by ${siteLabel}`, position: i + 1 });
  }
  return targets.slice(0, options.max ?? MAX_SCAN_TARGETS);
}

function counts(matcher: BrandMatcher, text: string, owner: 'mine' | 'competitor'): BrandCount[] {
  const out: BrandCount[] = [];
  for (const [brandId, mentions] of matcher.countMentions(text)) {
    if (matcher.ownerOf(brandId) === owner) out.push({ name: matcher.nameOf(brandId), mentions });
  }
  return out.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name));
}

/** Reads one digested page against the tracked brands. Pure. */
export function analysePage(target: ScanTarget, digest: PageDigest, matcher: BrandMatcher, passages: Passage[] = []): PageScan {
  if (!digest.ok) {
    return {
      target,
      ok: false,
      error: digest.error ?? 'Could not read the page',
      needsPermission: digest.needsPermission,
      title: target.title,
      wordCount: 0,
      competitors: [],
      mine: [],
      myBrandPresent: false,
      isGap: false,
      contacts: [],
      passages: [],
      listStyle: false,
    };
  }
  // Brand names can sit outside the article body (sidebars, "also featured" boxes), so the whole page is read.
  const text = `${digest.title}\n${digest.fullText || digest.blocks.map((b) => b.text).join('\n')}`;
  const competitors = counts(matcher, text, 'competitor');
  const mine = counts(matcher, text, 'mine');
  return {
    target,
    ok: true,
    error: null,
    needsPermission: false,
    title: digest.title || target.title,
    wordCount: digest.wordCount,
    competitors,
    mine,
    myBrandPresent: mine.length > 0,
    isGap: competitors.length > 0 && mine.length === 0,
    contacts: digest.contacts,
    passages,
    listStyle: digest.listStyle || target.reason === 'list',
  };
}
