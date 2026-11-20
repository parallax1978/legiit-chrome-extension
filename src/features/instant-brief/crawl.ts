/**
 * Instant Brief, step 1: choose up to 8 pages of the site the user is on,
 * taken from its own navigation (home, about, services, contact, pricing,
 * locations). Only same-origin pages are ever chosen.
 */
import { documentBase, resolveHref } from '@/extract/html';
import { cleanText } from '@/lib/sanitize';

export type PageKind = 'home' | 'about' | 'services' | 'contact' | 'pricing' | 'locations' | 'other';

export interface SitePageLink {
  url: string;
  label: string;
  kind: PageKind;
}

export const MAX_SITE_PAGES = 8;

/**
 * The same page, for the brief: same site and same path. Query string and
 * fragment are ignored, exactly as they are when the pages are picked, so an
 * address that arrived with "?gad_source=1" or "?ref=…" is still that page.
 */
export function samePage(a: string, b: string): boolean {
  const key = (value: string): string | null => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}`;
    } catch {
      return null;
    }
  };
  const first = key(a);
  return first !== null && first === key(b);
}

/** The picked links that still have to be read: every one except the open page, which is already in hand. */
export function linksToRead(links: readonly SitePageLink[], openUrl: string): SitePageLink[] {
  return links.filter((link) => !samePage(link.url, openUrl));
}

/**
 * Puts the open page and the pages read from the site into one list, each page
 * once. A page listed twice would be reported as "duplicate titles" and would
 * double every count taken across pages, so:
 * - the open page is never taken from a second read, whatever its query string;
 * - two links that end on one page (a redirect) count once.
 */
export function assembleSitePages<D>(
  open: { url: string; doc: D },
  links: readonly SitePageLink[],
  read: readonly { url: string; ok: boolean; finalUrl: string | null; html: string }[],
  parse: (html: string) => D,
): { pages: { url: string; kind: PageKind; doc: D }[]; unread: string[] } {
  const pages: { url: string; kind: PageKind; doc: D }[] = [];
  const unread: string[] = [];
  for (const link of links) {
    if (samePage(link.url, open.url)) {
      if (!pages.some((p) => samePage(p.url, open.url))) pages.push({ url: open.url, kind: link.kind, doc: open.doc });
      continue;
    }
    const page = read.find((p) => p.url === link.url);
    if (!page?.ok) {
      unread.push(link.url);
      continue;
    }
    const url = page.finalUrl ?? link.url;
    if (samePage(url, open.url) || pages.some((p) => samePage(p.url, url))) continue;
    pages.push({ url, kind: link.kind, doc: parse(page.html) });
  }
  // The open page is always part of the brief, also when no picked link names it.
  if (!pages.some((p) => samePage(p.url, open.url))) {
    pages.unshift({ url: open.url, kind: classifyPage(new URL(open.url).pathname, ''), doc: open.doc });
  }
  return { pages, unread };
}

/** Checked in this order: the more specific labels first ("service areas" is a locations page, not a services page). */
const KIND_PATTERNS: readonly { kind: PageKind; pattern: RegExp }[] = [
  { kind: 'about', pattern: /\b(about|our[- ]story|who[- ]we[- ]are|team|company|meet)\b/i },
  { kind: 'contact', pattern: /\b(contact|get[- ]in[- ]touch|book(ing)?|appointments?|schedule|request|quote)\b/i },
  { kind: 'pricing', pattern: /\b(pricing|prices?|plans?|fees?|rates?|costs?|packages?|membership)\b/i },
  { kind: 'locations', pattern: /\b(locations?|areas?[- ]served|service[- ]areas?|areas[- ]we[- ]serve|find[- ]us|directions|offices?|stores?)\b/i },
  { kind: 'services', pattern: /\b(services?|what[- ]we[- ]do|treatments?|products?|solutions?|offerings?|practice[- ]areas?|menu|shop)\b/i },
];

const KIND_ORDER: readonly PageKind[] = ['home', 'about', 'services', 'contact', 'pricing', 'locations', 'other'];

const SKIP_PATH = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3|ics|xml|json)$|\/(wp-admin|wp-login|login|logout|signin|sign-in|register|cart|checkout|account|search|feed|tag|category|author|privacy|terms|cookie|legal|sitemap|careers?|jobs)(\/|$|\.)/i;

export function classifyPage(path: string, label: string): PageKind {
  if (path === '/' || path === '') return 'home';
  // The last path segment and the link text say most about what a page is.
  const segment = decodeURIComponent(path.replace(/\/+$/, '').split('/').pop() ?? '').replace(/[-_]+/g, ' ');
  for (const { kind, pattern } of KIND_PATTERNS) if (pattern.test(segment)) return kind;
  for (const { kind, pattern } of KIND_PATTERNS) if (pattern.test(label)) return kind;
  return 'other';
}

/**
 * Returns the home page, the current page and the most useful navigation
 * pages, at most `max`, all on the same origin as `pageUrl`.
 */
export function pickSitePages(doc: Document, pageUrl: string, max = MAX_SITE_PAGES): SitePageLink[] {
  const page = new URL(pageUrl);
  const base = documentBase(doc, pageUrl);
  const keyOf = (url: URL): string => `${url.pathname.replace(/\/+$/, '') || '/'}`;

  interface Candidate extends SitePageLink {
    inNav: boolean;
    depth: number;
    order: number;
  }
  const byPath = new Map<string, Candidate>();
  let order = 0;

  const consider = (a: Element, inNav: boolean): void => {
    const href = resolveHref(a.getAttribute('href'), base);
    if (!href) return;
    const url = new URL(href);
    if (url.origin !== page.origin) return;
    if (SKIP_PATH.test(url.pathname)) return;
    url.hash = '';
    url.search = '';
    const key = keyOf(url);
    const label = cleanText(a.textContent ?? '', 80) || cleanText(a.getAttribute('aria-label') ?? a.getAttribute('title') ?? '', 80);
    const existing = byPath.get(key);
    if (existing) {
      existing.inNav ||= inNav;
      if (!existing.label && label) existing.label = label;
      return;
    }
    byPath.set(key, {
      url: url.href,
      label,
      kind: classifyPage(url.pathname, label),
      inNav,
      depth: url.pathname.split('/').filter(Boolean).length,
      order: order++,
    });
  };

  const navLinks = doc.querySelectorAll(
    'nav a[href], header a[href], [role="navigation"] a[href], footer a[href], [class*="menu" i] a[href], [class*="nav" i] a[href]',
  );
  for (const a of navLinks) consider(a, true);
  if (byPath.size < 4) for (const a of doc.querySelectorAll('a[href]')) consider(a, false);

  const home: SitePageLink = { url: `${page.origin}/`, label: 'Home', kind: 'home' };
  const currentUrl = new URL(page.href);
  currentUrl.hash = '';
  currentUrl.search = '';
  const currentKey = keyOf(currentUrl);
  const current = byPath.get(currentKey);

  const ranked = [...byPath.values()]
    .filter((c) => keyOf(new URL(c.url)) !== '/' && keyOf(new URL(c.url)) !== currentKey)
    .sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        Number(b.inNav) - Number(a.inNav) ||
        a.depth - b.depth ||
        a.order - b.order,
    );

  // One page per kind first (the best "about", the best "services", …), then fill with the rest.
  const firstOfKind: Candidate[] = [];
  const rest: Candidate[] = [];
  const seenKinds = new Set<PageKind>();
  for (const c of ranked) {
    if (c.kind !== 'other' && !seenKinds.has(c.kind)) {
      seenKinds.add(c.kind);
      firstOfKind.push(c);
    } else {
      rest.push(c);
    }
  }

  const out: SitePageLink[] = [home];
  if (currentKey !== '/') {
    out.push({ url: currentUrl.href, label: current?.label || cleanText(doc.querySelector('title')?.textContent ?? '', 80) || 'This page', kind: classifyPage(currentUrl.pathname, current?.label ?? '') });
  }
  for (const c of [...firstOfKind, ...rest]) {
    if (out.length >= max) break;
    out.push({ url: c.url, label: c.label || c.url, kind: c.kind });
  }
  return out.slice(0, max);
}
