/** Pre-fills tracked brands and competitors from Command Center Business Details. */
import { cutText, normalizeDomainInput } from '@/lib/sanitize';
import { hashString } from '@/lib/hash';
import type { Settings, StoredBrand } from '@/storage/settings';
import type { LegiitBusinessDetails } from './types';

/** The limits of the settings store (see BrandEntrySchema): a value beyond them is cut, never an error. */
const MAX = { name: 160, domain: 255, perBrand: 30, myBrands: 50, competitors: 200 } as const;

function domains(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const domain = normalizeDomainInput(value);
    if (domain && domain.length <= MAX.domain && !out.includes(domain) && out.length < MAX.perBrand) out.push(domain);
  }
  return out;
}

const brandName = (value: string): string => cutText(value.trim(), MAX.name).trim();

function sameBrand(a: StoredBrand, name: string, brandDomains: readonly string[]): boolean {
  return a.name.trim().toLowerCase() === name.trim().toLowerCase() || a.domains.some((d) => brandDomains.includes(d));
}

/**
 * Returns settings with the business's brand and competitors added as
 * "legiit" entries. Entries the user typed by hand are never changed or
 * duplicated; entries from a previously selected business are replaced.
 */
export function applyBusinessDetails(settings: Settings, details: LegiitBusinessDetails): Settings {
  const next = structuredClone(settings);
  next.myBrands = next.myBrands.filter((b) => b.source !== 'legiit');
  next.competitors = next.competitors.filter((b) => b.source !== 'legiit');

  const myDomains = domains(details.domains);
  const names = details.brandNames.map(brandName).filter(Boolean);
  const myName = brandName(details.name) || names[0] || myDomains[0] || 'My brand';
  if (next.myBrands.length < MAX.myBrands && !next.myBrands.some((b) => sameBrand(b, myName, myDomains))) {
    next.myBrands.push({
      id: `legiit-${hashString(details.id)}`,
      name: myName,
      domains: myDomains,
      aliases: [...new Set(names.filter((n) => n.toLowerCase() !== myName.toLowerCase()))].slice(0, MAX.perBrand),
      source: 'legiit',
    });
  }
  for (const competitor of details.competitors) {
    if (next.competitors.length >= MAX.competitors) break;
    const competitorDomains = domains(competitor.domains);
    // A competitor known only by its domain is tracked under that domain.
    const name = brandName(competitor.name) || competitorDomains[0] || '';
    if (!name || next.competitors.some((b) => sameBrand(b, name, competitorDomains))) continue;
    next.competitors.push({
      id: `legiit-${hashString(`${details.id}|${name}`)}`,
      name,
      domains: competitorDomains,
      aliases: [],
      source: 'legiit',
    });
  }
  next.legiit = {
    businessId: details.id,
    businessName: details.name,
    focusKeywords: details.focusKeywords.slice(0, 200),
    avatars: details.avatars.slice(0, 20),
  };
  return next;
}

/** Removes everything that came from Command Center (used on disconnect). */
export function clearBusinessDetails(settings: Settings): Settings {
  const next = structuredClone(settings);
  next.myBrands = next.myBrands.filter((b) => b.source !== 'legiit');
  next.competitors = next.competitors.filter((b) => b.source !== 'legiit');
  next.legiit = { businessId: null, businessName: null, focusKeywords: [], avatars: [] };
  return next;
}
