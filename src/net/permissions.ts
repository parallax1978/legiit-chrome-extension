/**
 * Optional host permissions. Nothing beyond web.archive.org and the Legiit
 * API host is granted at install; a site is requested by name, from a user
 * gesture, at the moment a feature needs to read it.
 */
import { stripWww } from '@/lib/sanitize';
import { originPatternFor, siteOfPattern } from '@/lib/url';

/** Unique host-permission patterns covering the given URLs. */
export function patternsFor(urls: readonly string[]): string[] {
  const patterns = new Set<string>();
  for (const url of urls) {
    const pattern = originPatternFor(url);
    if (pattern) patterns.add(pattern);
  }
  return [...patterns];
}

export async function hasAccess(url: string): Promise<boolean> {
  const pattern = originPatternFor(url);
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/** Patterns for the given URLs that are not granted yet. */
export async function missingAccess(urls: readonly string[]): Promise<string[]> {
  const patterns = patternsFor(urls);
  // Checked together, so the click that started this is still "recent" when Chrome is asked to prompt.
  const granted = await Promise.all(patterns.map((pattern) => chrome.permissions.contains({ origins: [pattern] }).catch(() => false)));
  return patterns.filter((_, index) => !granted[index]);
}

/**
 * Asks Chrome for access to the sites behind `urls`. Must be called from a
 * click handler: Chrome shows its own prompt naming every site. Resolves
 * false if the user declines.
 */
export async function requestAccess(urls: readonly string[]): Promise<boolean> {
  const missing = await missingAccess(urls);
  if (missing.length === 0) return true;
  try {
    return await chrome.permissions.request({ origins: missing });
  } catch {
    return false;
  }
}

function hostOfPattern(pattern: string): string {
  return stripWww(siteOfPattern(pattern).split('/')[0] ?? '');
}

/** Sites the user granted at run time (required hosts and content-script sites are excluded). */
export async function grantedSites(): Promise<string[]> {
  const manifest = chrome.runtime.getManifest();
  const builtIn = new Set<string>();
  for (const pattern of manifest.host_permissions ?? []) builtIn.add(hostOfPattern(pattern));
  for (const script of manifest.content_scripts ?? []) {
    for (const pattern of script.matches ?? []) builtIn.add(hostOfPattern(pattern));
  }
  const all = await chrome.permissions.getAll();
  return (all.origins ?? []).filter((pattern) => !builtIn.has(hostOfPattern(pattern))).sort();
}

export async function revokeSites(patterns: readonly string[]): Promise<void> {
  if (patterns.length === 0) return;
  await chrome.permissions.remove({ origins: [...patterns] });
}

export function describeSites(urls: readonly string[]): string[] {
  return patternsFor(urls).map(siteOfPattern).sort();
}
