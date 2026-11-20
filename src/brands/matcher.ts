/**
 * Finds tracked brands (the user's and competitors') in domains and text.
 * Domains match exactly or as a parent domain; names and aliases match as
 * whole words, case-insensitively, in any script.
 */
import { domainOf, stripWww } from '@/lib/sanitize';
import { escapeRegExp } from '@/lib/text';
import { hostMatchesDomain } from '@/lib/url';

export interface BrandEntry {
  id: string;
  name: string;
  domains: string[];
  aliases: string[];
}

export interface TrackedBrands {
  mine: BrandEntry[];
  competitors: BrandEntry[];
}

export type Owner = 'mine' | 'competitor';

export interface BrandHit {
  owner: Owner;
  brandId: string;
  name: string;
  /** How the brand was recognised. */
  via: 'domain' | 'name';
}

interface Compiled {
  owner: Owner;
  entry: BrandEntry;
  domains: string[];
  pattern: RegExp | null;
}

/** What a brand is called on screen and in saved results: its name, or its first domain when it has no name. */
export function displayName(entry: Pick<BrandEntry, 'name' | 'domains'>): string {
  return entry.name.trim() || entry.domains[0] || '';
}

function normaliseQuotes(text: string): string {
  return text.replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"');
}

function compile(owner: Owner, entry: BrandEntry): Compiled {
  const domains = entry.domains.map((d) => stripWww(d.trim())).filter(Boolean);
  const terms = [entry.name, ...entry.aliases, ...domains]
    .map((t) => normaliseQuotes(t).trim())
    .filter((t) => t.length >= 2);
  const unique = [...new Set(terms.map((t) => t.toLowerCase()))].sort((a, b) => b.length - a.length);
  const pattern = unique.length
    ? new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${unique.map((t) => escapeRegExp(t).replace(/\s+/g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`,
        'giu',
      )
    : null;
  return { owner, entry, domains, pattern };
}

export class BrandMatcher {
  private readonly compiled: Compiled[];

  constructor(brands: TrackedBrands) {
    this.compiled = [
      ...brands.mine.map((b) => compile('mine', b)),
      ...brands.competitors.map((b) => compile('competitor', b)),
    ];
  }

  get hasMine(): boolean {
    return this.compiled.some((c) => c.owner === 'mine');
  }

  get hasCompetitors(): boolean {
    return this.compiled.some((c) => c.owner === 'competitor');
  }

  get isEmpty(): boolean {
    return this.compiled.length === 0;
  }

  /** Brands whose tracked domain equals, or is a parent of, the given host or URL. */
  matchDomain(hostOrUrl: string | null | undefined): BrandHit[] {
    if (!hostOrUrl) return [];
    const host = /^https?:\/\//i.test(hostOrUrl) ? domainOf(hostOrUrl) : stripWww(hostOrUrl);
    if (!host) return [];
    const hits: BrandHit[] = [];
    for (const c of this.compiled) {
      if (c.domains.some((d) => hostMatchesDomain(host, d))) {
        hits.push({ owner: c.owner, brandId: c.entry.id, name: displayName(c.entry), via: 'domain' });
      }
    }
    return hits;
  }

  /** Brands named in the text (name, alias or bare domain), once per brand. */
  matchText(text: string | null | undefined): BrandHit[] {
    if (!text) return [];
    const haystack = normaliseQuotes(text);
    const hits: BrandHit[] = [];
    for (const c of this.compiled) {
      if (!c.pattern) continue;
      c.pattern.lastIndex = 0;
      if (c.pattern.test(haystack)) {
        hits.push({ owner: c.owner, brandId: c.entry.id, name: displayName(c.entry), via: 'name' });
      }
    }
    return hits;
  }

  /** How many times each brand is named in the text. */
  countMentions(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    const haystack = normaliseQuotes(text);
    for (const c of this.compiled) {
      if (!c.pattern) continue;
      c.pattern.lastIndex = 0;
      const n = haystack.match(c.pattern)?.length ?? 0;
      if (n > 0) counts.set(c.entry.id, n);
    }
    return counts;
  }

  /** Domain and text hits for a result-like item, de-duplicated per brand (domain wins). */
  matchItem(item: { url?: string | null; domain?: string | null; title?: string; text?: string }): BrandHit[] {
    const byBrand = new Map<string, BrandHit>();
    for (const hit of this.matchDomain(item.domain ?? item.url ?? null)) byBrand.set(hit.brandId, hit);
    for (const hit of this.matchText(`${item.title ?? ''}\n${item.text ?? ''}`)) {
      if (!byBrand.has(hit.brandId)) byBrand.set(hit.brandId, hit);
    }
    return [...byBrand.values()];
  }

  nameOf(brandId: string): string {
    return this.compiled.find((c) => c.entry.id === brandId)?.entry.name ?? brandId;
  }

  ownerOf(brandId: string): Owner | null {
    return this.compiled.find((c) => c.entry.id === brandId)?.owner ?? null;
  }
}

export function splitHits(hits: readonly BrandHit[]): { mine: BrandHit[]; competitors: BrandHit[] } {
  return {
    mine: hits.filter((h) => h.owner === 'mine'),
    competitors: hits.filter((h) => h.owner === 'competitor'),
  };
}
