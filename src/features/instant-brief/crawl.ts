/**
 * Instant Brief, step 1: choose up to 8 pages of the site the user is on,
 * taken from its own navigation (home, about, services, contact, pricing,
 * locations). Only same-origin pages are ever chosen.
 */
import { documentBase, resolveHref } from '@/extract/html';
import { cleanText } from '@/lib/sanitize';
import { urlKey } from '@/lib/url';

export type PageKind = 'home' | 'about' | 'services' | 'contact' | 'pricing' | 'locations' | 'other';

export interface SitePageLink {
  url: string;
  label: string;
  kind: PageKind;
}

export const MAX_SITE_PAGES = 8;

/**
 * The same path on the same site. Query string and fragment are ignored, exactly as they are when the pages are
 * picked. Two addresses with the same path are usually one page ("/?ref=newsletter" is the home page), but not
 * always: a site can route its pages by query string ("/?page_id=2").
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

/** Certainly the same page: the same address once known tracking parameters are removed. */
const sameAddress = (a: string, b: string): boolean => urlKey(a) === urlKey(b);

/** Two readings of one page: the same title and the same main heading. */
export function sameDocument(a: Document, b: Document): boolean {
  const mark = (doc: Document): string => `${cleanText(doc.querySelector('title')?.textContent ?? '', 300)}|${cleanText(doc.querySelector('h1')?.textContent ?? '', 300)}`.toLowerCase();
  return mark(a) === mark(b);
}

/**
 * The picked links that still have to be read: every one except the open page, which is already in hand. A link to
 * the path of the open page is read as well when the open address carries a query string that is not known
 * tracking: only its content can tell whether it is the same page.
 */
export function linksToRead(links: readonly SitePageLink[], openUrl: string): SitePageLink[] {
  return links.filter((link) => !sameAddress(link.url, openUrl));
}

/**
 * Puts the open page and the pages read from the site into one list, each page once. A page listed twice would be
 * reported as "duplicate titles" and would double every count taken across pages, so:
 * - the open page is never listed from a second read. A read of its path is that page when the address is the same
 *   or when it reads the same (`sameContent`); otherwise the site has another page at that path, and both are kept;
 * - two links that end on one page (a redirect) count once, under the more telling kind: a home link that
 *   redirects to the open page makes that page the home page.
 * The list never holds more pages than `MAX_SITE_PAGES`.
 */
export function assembleSitePages<D>(
  open: { url: string; doc: D },
  links: readonly SitePageLink[],
  read: readonly { url: string; ok: boolean; finalUrl: string | null; html: string }[],
  parse: (html: string) => D,
  sameContent: (a: D, b: D) => boolean = () => true,
): { pages: { url: string; kind: PageKind; doc: D }[]; unread: string[] } {
  type Entry = { url: string; kind: PageKind; doc: D };
  const pages: Entry[] = [];
  const unread: string[] = [];
  const found: { open: Entry | null } = { open: null };
  /** "home" says most about a page, "other" least. */
  const better = (now: PageKind, offered: PageKind): PageKind => (offered === 'home' || now === 'other' ? offered : now);
  const isOpenPage = (kind: PageKind): void => {
    if (found.open) found.open.kind = better(found.open.kind, kind);
    else pages.push((found.open = { url: open.url, kind, doc: open.doc }));
  };

  for (const link of links) {
    if (sameAddress(link.url, open.url)) {
      isOpenPage(link.kind);
      continue;
    }
    const page = read.find((p) => p.url === link.url);
    if (!page?.ok) {
      // The plain address of the open page could not be read again. The page itself is in hand: nothing is missing.
      if (samePage(link.url, open.url)) isOpenPage(link.kind);
      else unread.push(link.url);
      continue;
    }
    const url = page.finalUrl ?? link.url;
    const doc = parse(page.html);
    if (sameAddress(url, open.url) || (samePage(url, open.url) && sameContent(doc, open.doc))) {
      isOpenPage(link.kind);
      continue;
    }
    const listed = pages.find((p) => p !== found.open && samePage(p.url, url));
    if (listed) listed.kind = better(listed.kind, link.kind);
    else pages.push({ url, kind: link.kind, doc });
  }
  if (!found.open) {
    // No link leads to the open page: it is still part of the brief. When another page lives at its path (a site
    // that routes by query string), the path says nothing about what kind of page it is.
    const elsewhere = pages.some((p) => samePage(p.url, open.url));
    pages.unshift((found.open = { url: open.url, kind: elsewhere ? 'other' : classifyPage(new URL(open.url).pathname, ''), doc: open.doc }));
  }
  for (let i = pages.length - 1; i >= 0 && pages.length > MAX_SITE_PAGES; i--) {
    if (pages[i] !== found.open) pages.splice(i, 1);
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
  const last = path.replace(/\/+$/, '').split('/').pop() ?? '';
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // A stray "%" or a legacy escape ("/sale-50%-off", "/caf%E9"): the raw segment is good enough.
  }
  const segment = decoded.replace(/[-_]+/g, ' ');
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
