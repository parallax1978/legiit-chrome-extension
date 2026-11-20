/** Pre-fills tracked brands and competitors from Command Center Business Details. */
import { normalizeDomainInput } from '@/lib/sanitize';
import { hashString } from '@/lib/hash';
import type { Settings, StoredBrand } from '@/storage/settings';
import type { LegiitBusinessDetails } from './types';

function domains(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const domain = normalizeDomainInput(value);
    if (domain && !out.includes(domain)) out.push(domain);
  }
  return out;
}

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
  const myName = details.name || details.brandNames[0] || myDomains[0] || 'My brand';
  if (!next.myBrands.some((b) => sameBrand(b, myName, myDomains))) {
    next.myBrands.push({
      id: `legiit-${hashString(details.id)}`,
      name: myName,
      domains: myDomains,
      aliases: [...new Set(details.brandNames.filter((n) => n.trim().toLowerCase() !== myName.trim().toLowerCase()))].slice(0, 30),
      source: 'legiit',
    });
  }
  for (const competitor of details.competitors) {
    const competitorDomains = domains(competitor.domains);
    if (!competitor.name.trim() || next.competitors.some((b) => sameBrand(b, competitor.name, competitorDomains))) continue;
    next.competitors.push({
      id: `legiit-${hashString(`${details.id}|${competitor.name}`)}`,
      name: competitor.name.trim(),
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
