/**
 * Reads a rendered Google results page into structured data: which blocks are
 * present (AI Overview, ads, local pack, …), every organic result, and where
 * each of them sits on the page.
 *
 * Pure DOM in, plain data out. Geometry comes from `env.rectOf`, so the same
 * code runs in the content script (real layout) and in unit tests (fixtures
 * stamped with rectangles). The parser only reads; it never changes the page.
 */
import { blockText } from '@/extract/blocks';
import { cleanMultiline, cleanText, domainOf, safeHttpUrl } from '@/lib/sanitize';
import { cleanUrl, isGoogleInfraHost, isGoogleNavHost, isHiddenGoogleRedirect, siteOfAddressLine, unwrapGoogleUrl, urlKey } from '@/lib/url';
import type {
  AddressSource,
  AnswerData,
  BlockType,
  Citation,
  OrganicResult,
  Rect,
  SerpBlock,
  SerpData,
  SerpItem,
  Viewport,
} from '@/model/schemas';
import { describeCandidate, matchCandidate, outermost, resolve } from '@/selectors/resolve';
import type { SelectorPack } from '@/selectors/types';

export interface ParseEnv {
  url: string;
  viewport: Viewport;
  documentHeight: number;
  now: number;
  pageId: string;
  /** Rectangle of an element in document coordinates, or null when it has no layout box. */
  rectOf: (el: Element) => Rect | null;
  /** False for elements that are not rendered. Defaults to "everything is visible". */
  isVisible?: (el: Element) => boolean;
}

/** Slot name → block type, in priority order (earlier wins when two slots claim the same area). */
export const BLOCK_SLOTS: readonly { slot: string; type: BlockType }[] = [
  { slot: 'aiOverview', type: 'ai_overview' },
  { slot: 'ads', type: 'ad' },
  { slot: 'shopping', type: 'shopping' },
  { slot: 'localPack', type: 'local_pack' },
  { slot: 'featuredSnippet', type: 'featured_snippet' },
  { slot: 'peopleAlsoAsk', type: 'paa' },
  { slot: 'video', type: 'video' },
  { slot: 'image', type: 'image' },
  { slot: 'forum', type: 'forum' },
  { slot: 'topStories', type: 'top_stories' },
  { slot: 'knowledgePanel', type: 'knowledge_panel' },
];

const LIST_STYLE =
  /\b(best|top(?:[- ]rated)?|vs\.?|versus|alternatives?|compar(?:e|ed|ison)s?|reviews?|ranked|rankings?)\b|^\s*\d{1,3}\s+\p{L}/iu;

/** "10 Best …", "X vs Y", "Top …", "… alternatives": pages that list or compare providers. */
export function isListStyleTitle(title: string): boolean {
  return LIST_STYLE.test(title);
}

interface FoundBlock {
  type: BlockType;
  el: Element;
  matchedBy: string;
}

function findTitleLinks(doc: Document, pack: SelectorPack, visible: (el: Element) => boolean): Element[] {
  const slot = pack.slots['organicTitleLink'];
  if (!slot) return [];
  for (const candidate of slot.candidates) {
    const links = matchCandidate(doc, candidate).filter((el) => el.hasAttribute('href') && visible(el));
    if (links.length > 0) return links;
  }
  return [];
}

function countInside(container: Element, elements: readonly Element[]): number {
  let n = 0;
  for (const el of elements) if (container.contains(el)) n++;
  return n;
}

function findBlocks(
  doc: Document,
  pack: SelectorPack,
  root: Element | null,
  titleLinks: readonly Element[],
  visible: (el: Element) => boolean,
): FoundBlock[] {
  const accepted: FoundBlock[] = [];
  const tooBroad = (el: Element): boolean => {
    if (el === doc.body || el === doc.documentElement) return true;
    if (root && el.contains(root)) return true;
    const inside = countInside(el, titleLinks);
    // A "block" that swallows most organic results is a wrapper, not a block.
    return inside >= 3 && inside >= titleLinks.length / 2;
  };
  for (const { slot, type } of BLOCK_SLOTS) {
    const spec = pack.slots[slot];
    if (!spec) continue;
    for (const candidate of spec.candidates) {
      const elements = outermost(matchCandidate(doc, candidate)).filter(
        (el) =>
          visible(el) &&
          !tooBroad(el) &&
          // Skip anything overlapping a block already claimed by a higher-priority slot.
          !accepted.some((b) => b.el === el || b.el.contains(el) || el.contains(b.el)),
      );
      if (elements.length > 0) {
        const matchedBy = `${slot}: ${describeCandidate(candidate)}`.slice(0, 240);
        for (const el of elements) accepted.push({ type, el, matchedBy });
        break;
      }
    }
  }
  return accepted;
}

/** The box of one organic result: a known container class, else the largest ancestor holding only this result. */
function containerFor(
  link: Element,
  pack: SelectorPack,
  root: Element | null,
  organicLinks: readonly Element[],
  blocks: readonly FoundBlock[],
): Element {
  const isClean = (el: Element): boolean =>
    countInside(el, organicLinks) === 1 && !blocks.some((b) => el.contains(b.el)) && el !== root && !(root && el.contains(root));
  for (const candidate of pack.slots['organicContainer']?.candidates ?? []) {
    let box: Element | null = null;
    try {
      box = link.closest(candidate.css);
    } catch {
      box = null;
    }
    if (box && isClean(box)) return box;
  }
  let box: Element = link;
  let parent = link.parentElement;
  while (parent && isClean(parent)) {
    box = parent;
    parent = parent.parentElement;
  }
  return box;
}

function snippetOf(container: Element, link: Element, pack: SelectorPack, title: string): string {
  for (const candidate of pack.slots['organicSnippet']?.candidates ?? []) {
    try {
      const el = container.querySelector(candidate.css);
      const text = cleanText(el?.textContent ?? '', 600);
      if (text && text !== title) return text;
    } catch {
      // Invalid selector in a pack: try the next candidate.
    }
  }
  // Fallback: the longest text run in the box that is not part of the title link.
  let best = '';
  for (const el of container.querySelectorAll('div, span, p')) {
    if (el.contains(link) || link.contains(el) || el.children.length > 3) continue;
    const text = cleanText(el.textContent ?? '', 600);
    if (text.length > best.length && text !== title) best = text;
  }
  return best;
}

/** Result links never point back at Google's own navigation or redirect hosts. */
function externalUrl(href: string | null, pageUrl: string, serpHost: string): string | null {
  if (!href) return null;
  const target = unwrapGoogleUrl(href, pageUrl);
  if (!target) return null;
  const host = new URL(target).hostname.toLowerCase();
  if (host === serpHost || isGoogleNavHost(host) || isGoogleInfraHost(host)) return null;
  return target;
}

/** True for a host that is the results page itself or one of Google's own: never the site a result leads to. */
function isGoogleOwn(host: string, serpHost: string): boolean {
  return host === serpHost || isGoogleNavHost(host) || isGoogleInfraHost(host);
}

/** The site (an origin) named by the first address line inside `scope`: "https://www.example.com › blog › post". */
function siteIn(scope: Element, pack: SelectorPack): string | null {
  for (const candidate of pack.slots['organicAddress']?.candidates ?? [{ css: 'cite' }]) {
    let found: Element[];
    try {
      found = Array.from(scope.querySelectorAll(candidate.css)).slice(0, 20);
    } catch {
      continue; // An invalid selector in a pack: try the next candidate.
    }
    for (const el of found) {
      const site = siteOfAddressLine(el.textContent ?? '');
      if (site) return site;
    }
  }
  return null;
}

/** The site named by a "More results from www.example.com" link: a Google search limited with "site:". */
function siteLinkIn(scope: Element, pageUrl: string): string | null {
  for (const a of Array.from(scope.querySelectorAll('a[href*="site:"], a[href*="site%3A"]')).slice(0, 10)) {
    const safe = safeHttpUrl(a.getAttribute('href') ?? '', pageUrl);
    if (!safe) continue;
    const host = /(?:^|\s)site:([^\s/]+)/i.exec(new URL(safe).searchParams.get('q') ?? '')?.[1];
    const site = host ? siteOfAddressLine(host) : null;
    if (site) return site;
  }
  return null;
}

/** A page that the results page's own data names with its exact address: a source of its AI answer. */
interface KnownPage {
  title: string;
  url: string;
  domain: string;
  /** True when `title` is the page's title, not only the name of its site. */
  titled: boolean;
}

/** Titles as compared: lower case, plain quotes, without the "…" that marks a shortened title. */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u2018\u2019\u201b`]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s*(\.\.\.|…)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The same page under two titles: one starts with the other (either can be shortened), and both say enough. */
function sameTitle(a: string, b: string): boolean {
  const x = titleKey(a);
  const y = titleKey(b);
  return Math.min(x.length, y.length) >= 12 && (x.startsWith(y) || y.startsWith(x));
}

interface Destination {
  url: string;
  domain: string;
  address: AddressSource;
  /** For de-duplication. A link whose address Google hides is its own key: two results can lead to one site. */
  key: string;
}

/**
 * Where a result link leads. The link says so itself, unless Google hides it behind its own redirect
 * (google.com/goto?url=<token>). Then, in this order: the page's own data can name the exact address of a page of
 * that site with that title; the line under the title names the site; a "More results from …" link names the site;
 * and when the page says nothing at all, the result keeps Google's link.
 * `scopes` are the places to look for the site, nearest first. null for a link that is no result.
 */
function destinationOf(
  link: Element,
  scopes: readonly Element[],
  pack: SelectorPack,
  pageUrl: string,
  serpHost: string,
  title = '',
  known: () => readonly KnownPage[] = () => [],
): Destination | null {
  const href = link.getAttribute('href');
  const exact = externalUrl(href, pageUrl, serpHost);
  if (exact) return { url: cleanUrl(exact) ?? exact, domain: domainOf(exact), address: 'link', key: urlKey(exact) };
  if (!href || !isHiddenGoogleRedirect(href, pageUrl)) return null;
  const redirect = safeHttpUrl(href, pageUrl);
  if (!redirect) return null;
  const key = `hidden:${redirect}`;
  let site: string | null = null;
  for (const scope of scopes) if ((site = siteIn(scope, pack))) break;
  if (!site) for (const scope of scopes) if ((site = siteLinkIn(scope, pageUrl))) break;
  if (!site) return { url: redirect, domain: '', address: 'hidden', key };
  if (isGoogleOwn(new URL(site).hostname.toLowerCase(), serpHost)) return null;
  const domain = domainOf(site);
  if (title) {
    const pages = known().filter((page) => page.titled && page.domain === domain && sameTitle(page.title, title));
    // One page of that site with that title: its address is the address of this result.
    if (pages.length === 1) return { url: pages[0]!.url, domain, address: 'link', key };
  }
  return { url: `${site}/`, domain, address: 'site', key };
}

function linkTitle(a: Element): string {
  const heading = a.querySelector('[role="heading"], h3, h4');
  return (
    cleanText(heading?.textContent ?? '', 300) ||
    cleanText(a.getAttribute('aria-label') ?? '', 300) ||
    cleanText(a.textContent ?? '', 300) ||
    cleanText(a.getAttribute('title') ?? '', 300)
  );
}

interface LinkEntry {
  item: SerpItem;
  address: AddressSource;
}

/**
 * The links of a block that lead to another site, each once. A link whose page Google hides is told apart by its
 * title: two such links can lead to one site, and one item often has two links (its picture and its title).
 * With `keepHidden`, a link that names no site at all is kept too, with its title and without an address.
 */
function linkEntries(el: Element, pack: SelectorPack, pageUrl: string, serpHost: string, limit = 40, keepHidden = false): LinkEntry[] {
  const entries: LinkEntry[] = [];
  const seen = new Set<string>();
  for (const a of el.querySelectorAll('a[href]')) {
    const destination = destinationOf(a, [a], pack, pageUrl, serpHost);
    if (!destination) continue;
    const { address } = destination;
    const title = linkTitle(a);
    if (address !== 'link' && (!title || (address === 'hidden' && !keepHidden))) continue;
    const key = address === 'link' ? urlKey(destination.url) : `title:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = cleanText(`${a.getAttribute('aria-label') ?? ''} ${a.textContent ?? ''}`, 400);
    entries.push({
      address,
      item: address === 'hidden' ? { title, url: null, domain: null, text } : { title: title || destination.domain, url: destination.url, domain: destination.domain, text },
    });
    if (entries.length >= limit) break;
  }
  return entries;
}

function linkItems(el: Element, pack: SelectorPack, pageUrl: string, serpHost: string, limit = 40, keepHidden = false): SerpItem[] {
  return linkEntries(el, pack, pageUrl, serpHost, limit, keepHidden).map((entry) => entry.item);
}

/** A JSON string literal as it stands in the page's own data. */
const LITERAL = (max: number): string => `"((?:[^"\\\\]|\\\\.){0,${max}})"`;
/** One source of an AI answer in the page's data: its site name, a number, its address. */
const CITED_SOURCE = new RegExp(`${LITERAL(200)},\\s*(?:\\d{1,4}|null),\\s*"(https?:\\/\\/(?:[^"\\\\]|\\\\.){1,2000})"`, 'g');
/** One source card: page title, excerpt, site name, then the site's icon, whose address names the site. */
const SOURCE_CARD = new RegExp(
  `${LITERAL(300)},\\s*${LITERAL(4000)},\\s*${LITERAL(200)},\\s*"https:\\/\\/[a-z0-9-]+\\.gstatic\\.com\\/faviconV2\\?url(?:=|\\\\u003d)(https?:\\/\\/[^&"\\\\]{1,300})`,
  'g',
);
const MAX_EMBEDDED_CHARS = 800_000;

function unquote(literal: string): string {
  try {
    return String(JSON.parse(`"${literal}"`));
  } catch {
    return literal;
  }
}

/**
 * The sources of an AI answer, when Google hides where its links lead. The answer then still carries the address of
 * each cited page in data that the page keeps next to the answer (in comment nodes). That data is Google's own
 * format and can change: when it is not there, the answer simply has no sources. Nothing here is executed; every
 * address is checked like any other link.
 */
function embeddedSources(el: Element, pageUrl: string, serpHost: string, limit = 60): KnownPage[] {
  const walker = el.ownerDocument.createTreeWalker(el, 128 /* NodeFilter.SHOW_COMMENT */);
  const cited: { name: string; url: string }[] = [];
  const titlesByHost = new Map<string, Set<string>>();
  let budget = MAX_EMBEDDED_CHARS;
  while (budget > 0 && walker.nextNode()) {
    const raw = walker.currentNode.nodeValue ?? '';
    if (raw.length > 100_000 || !raw.includes('http')) continue;
    budget -= raw.length;
    // Text inside a comment keeps its HTML escapes.
    const text = raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    for (const match of text.matchAll(CITED_SOURCE)) cited.push({ name: unquote(match[1] ?? ''), url: unquote(match[2] ?? '') });
    for (const match of text.matchAll(SOURCE_CARD)) {
      const site = safeHttpUrl(unquote(match[4] ?? ''));
      const title = cleanText(unquote(match[1] ?? ''), 300);
      if (!site || !title) continue;
      const host = domainOf(site);
      titlesByHost.set(host, (titlesByHost.get(host) ?? new Set()).add(title));
    }
  }
  const pages: KnownPage[] = [];
  const seen = new Set<string>();
  for (const source of cited) {
    const url = externalUrl(source.url, pageUrl, serpHost);
    if (!url) continue;
    const key = urlKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const domain = domainOf(url);
    pages.push({ title: cleanText(source.name, 300) || domain, url: cleanUrl(url) ?? url, domain, titled: false });
    if (pages.length >= limit) break;
  }
  // A page title belongs to a source only when the site has one title and one cited page: otherwise it is a guess.
  for (const page of pages) {
    const titles = titlesByHost.get(page.domain);
    if (titles?.size === 1 && pages.filter((other) => other.domain === page.domain).length === 1) {
      page.title = [...titles][0] ?? page.title;
      page.titled = true;
    }
  }
  return pages;
}

/**
 * The sources of an AI answer: its links, then the sources the page lists for it that no link shows. A source is a
 * page, so only an exact address counts: a link that names just its site is no source.
 */
function answerItems(el: Element, pack: SelectorPack, pageUrl: string, serpHost: string, limit: number): SerpItem[] {
  const items = linkEntries(el, pack, pageUrl, serpHost, limit)
    .filter((entry) => entry.address === 'link')
    .map((entry) => entry.item);
  const seen = new Set(items.map((item) => (item.url ? urlKey(item.url) : '')));
  for (const source of embeddedSources(el, pageUrl, serpHost, limit)) {
    if (items.length >= limit) break;
    if (seen.has(urlKey(source.url))) continue;
    seen.add(urlKey(source.url));
    items.push({ title: source.title, url: source.url, domain: source.domain, text: '' });
  }
  return items;
}

function adItems(el: Element, pack: SelectorPack, pageUrl: string, serpHost: string): SerpItem[] {
  let units = resolve(el, pack, 'adUnit').elements;
  if (units.length === 0) {
    // Fallback when the ad-unit hooks are gone: every link that wraps a heading is one ad.
    units = Array.from(el.querySelectorAll('a[href]')).filter((a) => a.querySelector('[role="heading"], h3') !== null);
  }
  if (units.length === 0) units = [el];
  const items: SerpItem[] = [];
  for (const unit of outermost(units).slice(0, 20)) {
    const link = unit.matches('a[href]') ? unit : unit.querySelector('a[href]');
    const title = cleanText(unit.querySelector('[role="heading"], h3')?.textContent ?? link?.textContent ?? '', 300);
    // Ads go through a click redirect; the landing page or its domain is in data attributes.
    const declared =
      link?.getAttribute('data-pcu')?.split(',')[0] ?? link?.getAttribute('data-rw') ?? link?.getAttribute('href') ?? null;
    let url = externalUrl(declared, pageUrl, serpHost) ?? externalUrl(link?.getAttribute('href') ?? null, pageUrl, serpHost);
    if (!url) {
      const dtld = unit.querySelector('[data-dtld]')?.getAttribute('data-dtld');
      url = dtld ? safeHttpUrl(`https://${dtld}/`) : null;
    }
    if (!title && !url) continue;
    items.push({ title, url, domain: url ? domainOf(url) : null, text: cleanText(unit.textContent ?? '', 400) });
  }
  return items;
}

/**
 * Fallback when the place hooks are gone: every third-level heading in the
 * pack is a business name, and its box is the largest ancestor that holds no
 * other name.
 */
function placesByHeading(el: Element): Element[] {
  const names = Array.from(el.querySelectorAll('[role="heading"][aria-level="3"], h3'));
  return names.map((name) => {
    let box: Element = name;
    let parent = name.parentElement;
    while (parent && parent !== el && countInside(parent, names) === 1) {
      box = parent;
      parent = parent.parentElement;
    }
    return box;
  });
}

function placeItems(el: Element, pack: SelectorPack, pageUrl: string, serpHost: string): SerpItem[] {
  let places = outermost(resolve(el, pack, 'localPlace').elements).slice(0, 20);
  if (places.length === 0) places = placesByHeading(el).slice(0, 20);
  const items: SerpItem[] = [];
  const seen = new Set<string>();
  for (const place of places) {
    const nameEl =
      resolve(place, pack, 'localPlaceName').elements[0] ?? place.querySelector('[role="heading"], h3') ?? undefined;
    const title = cleanText(nameEl?.textContent ?? '', 200);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    let url: string | null = null;
    for (const a of place.querySelectorAll('a[href]')) {
      url = externalUrl(a.getAttribute('href'), pageUrl, serpHost);
      if (url) break;
    }
    items.push({ title, url, domain: url ? domainOf(url) : null, text: cleanText(place.textContent ?? '', 400) });
  }
  return items;
}

function questionItems(el: Element): SerpItem[] {
  const items: SerpItem[] = [];
  for (const q of el.querySelectorAll('[data-q]')) {
    const title = cleanText(q.getAttribute('data-q') ?? '', 300);
    if (title) items.push({ title, url: null, domain: null, text: '' });
    if (items.length >= 12) break;
  }
  return items;
}

function itemsFor(block: FoundBlock, pack: SelectorPack, pageUrl: string, serpHost: string): SerpItem[] {
  switch (block.type) {
    case 'ad':
      return adItems(block.el, pack, pageUrl, serpHost);
    case 'local_pack':
      return placeItems(block.el, pack, pageUrl, serpHost);
    case 'paa': {
      const questions = questionItems(block.el);
      return questions.length > 0 ? questions : linkItems(block.el, pack, pageUrl, serpHost, 12);
    }
    case 'image':
      return [];
    case 'ai_overview':
      return answerItems(block.el, pack, pageUrl, serpHost, 40);
    default:
      // Videos, discussions, news: an item whose address Google hides still counts, with its title.
      return linkItems(block.el, pack, pageUrl, serpHost, 40, true);
  }
}

const ANSWER_CHROME = /^(show (more|less)|learn more|generative ai is experimental\.?.*|ai responses may include mistakes\.?.*|feedback|share|export)$/i;

/** Answer wording only: no label line ("AI Overview"), buttons, source cards or disclaimers. */
function answerText(el: Element, max: number): string {
  const lines = blockText(el, 400, true)
    .split('\n')
    .filter((line) => !ANSWER_CHROME.test(line.trim()));
  // The first line of an AI Overview is its label; a real first sentence is longer than that.
  if (lines.length > 1 && (lines[0] ?? '').length <= 40 && !/[.!?]$/.test(lines[0] ?? '')) lines.shift();
  return cleanMultiline(lines.join('\n'), max);
}

function toCitations(items: readonly SerpItem[]): Citation[] {
  const out: Citation[] = [];
  for (const item of items) {
    if (item.url) out.push({ url: item.url, domain: item.domain ?? domainOf(item.url), title: item.title });
  }
  return out;
}

function readAiMode(doc: Document, pack: SelectorPack, env: ParseEnv, serpHost: string, keyword: string): AnswerData {
  const answers = resolve(doc, pack, 'aiModeAnswer').elements;
  const latest = answers[answers.length - 1] ?? null;
  const questions = resolve(doc, pack, 'aiModeQuestion').elements;
  let question: string | null = keyword || null;
  if (latest) {
    for (const q of questions) {
      // Last question that comes before the latest answer in document order.
      if (q.compareDocumentPosition(latest) & 4 /* DOCUMENT_POSITION_FOLLOWING */) {
        question = cleanText(q.textContent ?? '', 2000) || question;
      }
    }
  }
  return {
    kind: 'answer',
    site: 'google-ai-mode',
    url: safeHttpUrl(env.url),
    question,
    text: latest ? answerText(latest, 40_000) : '',
    citations: latest ? toCitations(answerItems(latest, pack, env.url, serpHost, 100)) : [],
    capturedAt: env.now,
    recognised: latest !== null,
    packVersion: pack.version,
  };
}

export function parseSerp(doc: Document, pack: SelectorPack, env: ParseEnv): SerpData {
  const pageUrl = new URL(env.url);
  const serpHost = pageUrl.hostname.toLowerCase();
  const visible = env.isVisible ?? (() => true);

  const input = resolve(doc, pack, 'searchInput').elements[0] as HTMLInputElement | undefined;
  const keyword = cleanText(pageUrl.searchParams.get('q') ?? input?.value ?? input?.getAttribute('value') ?? '', 500);
  const mode: SerpData['mode'] = pageUrl.searchParams.get('udm') === '50' ? 'ai-mode' : 'web';

  const root = resolve(doc, pack, 'resultsRoot').elements[0] ?? null;
  const titleLinks = findTitleLinks(doc, pack, visible);
  const found = findBlocks(doc, pack, root, titleLinks, visible);

  // Organic results: title links that are not part of any other block. A title link leads to another site, or to
  // Google's own redirect when Google hides where it leads.
  const organicLinks = titleLinks.filter((link) => {
    if (found.some((b) => b.el.contains(link))) return false;
    const href = link.getAttribute('href');
    return externalUrl(href, env.url, serpHost) !== null || (href !== null && isHiddenGoogleRedirect(href, env.url));
  });
  const organic: OrganicResult[] = [];
  const seenUrls = new Set<string>();
  // Pages whose exact address the page's own data names. Read once, and only when a link hides its address.
  let knownPages: KnownPage[] | null = null;
  const known = (): readonly KnownPage[] => (knownPages ??= doc.body ? embeddedSources(doc.body, env.url, serpHost, 200) : []);
  for (const link of organicLinks) {
    const title = cleanText(link.querySelector('h3')?.textContent ?? link.textContent ?? '', 300);
    if (!title) continue;
    const container = containerFor(link, pack, root, organicLinks, found);
    const destination = destinationOf(link, [link, container], pack, env.url, serpHost, title, known);
    if (!destination) continue;
    if (seenUrls.has(destination.key)) continue;
    seenUrls.add(destination.key);
    organic.push({
      position: organic.length + 1,
      title,
      url: destination.url,
      domain: destination.domain,
      address: destination.address,
      snippet: snippetOf(container, link, pack, title),
      rect: env.rectOf(container),
      listStyle: isListStyleTitle(title),
    });
    if (organic.length >= 100) break;
  }

  const blocks: SerpBlock[] = found.map((block) => ({
    type: block.type,
    rect: env.rectOf(block.el),
    items: itemsFor(block, pack, env.url, serpHost),
    text:
      block.type === 'ai_overview'
        ? answerText(block.el, 8000)
        : block.type === 'featured_snippet'
          ? cleanMultiline(blockText(block.el), 8000)
          : cleanText(block.el.textContent ?? '', 600),
    matchedBy: block.matchedBy,
  }));

  let aiAnswer: AnswerData | null = null;
  if (mode === 'ai-mode') {
    aiAnswer = readAiMode(doc, pack, env, serpHost, keyword);
  } else {
    const overview = blocks.find((b) => b.type === 'ai_overview');
    if (overview) {
      aiAnswer = {
        kind: 'answer',
        site: 'google-ai-overview',
        url: safeHttpUrl(env.url),
        question: keyword || null,
        text: overview.text,
        citations: toCitations(overview.items),
        capturedAt: env.now,
        recognised: true,
        packVersion: pack.version,
      };
    }
  }

  const locationEl = resolve(doc, pack, 'location').elements[0];
  const locationText =
    cleanText(locationEl?.getAttribute('data-loc-text') ?? locationEl?.textContent ?? '', 160) || null;

  return {
    kind: 'serp',
    pageId: env.pageId,
    url: safeHttpUrl(env.url) ?? env.url,
    keyword,
    mode,
    capturedAt: env.now,
    viewport: env.viewport,
    documentHeight: env.documentHeight,
    locationText,
    blocks,
    organic,
    aiAnswer,
    recognised: organic.length > 0 || blocks.length > 0 || aiAnswer?.recognised === true,
    packVersion: pack.version,
  };
}
