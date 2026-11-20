/**
 * Instant Brief, step 2: read business facts out of the site's own pages.
 * Everything comes from markup the business published (JSON-LD, links, text);
 * nothing is inferred from outside sources.
 */
import { blockText } from '@/extract/blocks';
import { documentBase, listProp, readJsonLd, resolveHref, stringProp, typesOf, type JsonLdNode } from '@/extract/html';
import { extractAllText, extractMainContent } from '@/extract/main-content';
import { extractPageFacts, type PageFacts } from '@/extract/page-facts';
import { cleanText, cutText, safeHttpUrl, stripWww } from '@/lib/sanitize';
import { countWords, splitSentences, STOPWORDS, tokenize, uniqueBy } from '@/lib/text';
import type { BrandStyle } from '@/model/schemas';
import type { PageKind } from './crawl';

export interface SitePage {
  url: string;
  kind: PageKind;
  doc: Document;
}

export interface Testimonial {
  quote: string;
  author: string | null;
}

export interface BusinessFacts {
  siteUrl: string;
  name: string | null;
  /** Where the name came from, so a reader can judge it. */
  nameSource: 'structured data' | 'site name tag' | 'page titles' | 'domain';
  description: string | null;
  phones: string[];
  emails: string[];
  addresses: string[];
  serviceAreas: string[];
  services: string[];
  socialProfiles: { network: string; url: string }[];
  organisation: {
    types: string[];
    priceRange: string | null;
    openingHours: string[];
    rating: { value: string; count: string | null } | null;
    founded: string | null;
  } | null;
  logoUrl: string | null;
  /** The logo as a data URL when it could be read from the open tab. */
  logoDataUrl: string | null;
  brandColors: { hex: string; source: string }[];
  fonts: string[];
  tone: { sample: string; traits: string[] } | null;
  testimonials: Testimonial[];
  keywordCandidates: { phrase: string; pages: number }[];
  pages: { url: string; kind: PageKind; title: string | null; facts: PageFacts }[];
}

const ORG_TYPE = /Organization|LocalBusiness|Corporation|Store|Dentist|Physician|Restaurant|Attorney|LegalService|ProfessionalService|MedicalBusiness|HomeAndConstructionBusiness|AutomotiveBusiness|HealthAndBeautyBusiness|FinancialService|RealEstateAgent|LodgingBusiness|Plumber|Electrician|RoofingContractor|Clinic|Hospital|Salon|Agency|Contractor|Service$/;

const SOCIAL_NETWORKS: readonly { network: string; label: RegExp }[] = [
  { network: 'Facebook', label: /^(facebook|fb)$/ },
  { network: 'Instagram', label: /^instagram$/ },
  { network: 'X (Twitter)', label: /^(twitter|x)$/ },
  { network: 'LinkedIn', label: /^linkedin$/ },
  { network: 'YouTube', label: /^(youtube|youtu)$/ },
  { network: 'TikTok', label: /^tiktok$/ },
  { network: 'Pinterest', label: /^pinterest$/ },
  { network: 'Yelp', label: /^yelp$/ },
  { network: 'Threads', label: /^threads$/ },
  { network: 'Nextdoor', label: /^nextdoor$/ },
];

function socialNetworkOf(url: string): string | null {
  let host: string;
  try {
    host = stripWww(new URL(url).hostname);
  } catch {
    return null;
  }
  // The label left of the public suffix: "facebook" in facebook.com, m.facebook.com or facebook.co.uk.
  const labels = host.split('.');
  for (const label of labels.slice(0, -1)) {
    const match = SOCIAL_NETWORKS.find((n) => n.label.test(label));
    if (match) return match.network;
  }
  return null;
}

function isOrganisation(node: JsonLdNode): boolean {
  return typesOf(node).some((t) => ORG_TYPE.test(t)) || ('telephone' in node && 'address' in node);
}

function formatAddress(value: unknown): string | null {
  if (typeof value === 'string') return cleanText(value, 240) || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const node = value as JsonLdNode;
  const street = stringProp(node, 'streetAddress');
  const locality = stringProp(node, 'addressLocality');
  const region = stringProp(node, 'addressRegion');
  const postal = stringProp(node, 'postalCode');
  const country = stringProp(node, 'addressCountry');
  const cityLine = [locality, [region, postal].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const parts = [street, cityLine, country].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(', ') : null;
}

const PHONE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}\b/g;
const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;

function phoneKey(phone: string): string {
  return phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
}

/** Two renderings of one address share their numbers (street number, suite, postcode). */
function addressKey(address: string): string {
  return (address.match(/\d+/g) ?? []).join('-') || address.toLowerCase();
}

function pushUnique(list: string[], value: string | null | undefined, key: (v: string) => string = (v) => v.toLowerCase(), max = 12): void {
  const cleaned = cleanText(value ?? '', 240);
  if (!cleaned || list.length >= max) return;
  if (!list.some((existing) => key(existing) === key(cleaned))) list.push(cleaned);
}

function isUsableColor(hex: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = Number.parseInt(m[1]!, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  // Skip near-white, near-black and greys: they are not brand colours.
  return max - min >= 28 && max > 40 && min < 235;
}

export function normaliseHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  if (long) return `#${long[1]}`;
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(v);
  if (rgb) {
    const hex = [rgb[1], rgb[2], rgb[3]].map((c) => Math.min(255, Number(c)).toString(16).padStart(2, '0')).join('');
    return `#${hex}`;
  }
  return null;
}

function colorsFromMarkup(doc: Document): { hex: string; source: string }[] {
  const out: { hex: string; source: string }[] = [];
  const theme = doc.querySelector('meta[name="theme-color" i]')?.getAttribute('content');
  const themeHex = theme ? normaliseHex(theme) : null;
  if (themeHex) out.push({ hex: themeHex, source: 'theme-color' });
  for (const style of doc.querySelectorAll('style')) {
    const css = (style.textContent ?? '').slice(0, 200_000);
    for (const m of css.matchAll(/--([\w-]*(?:brand|primary|accent|main|theme|secondary)[\w-]*)\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\))/gi)) {
      const hex = normaliseHex(m[2]!);
      if (hex) out.push({ hex, source: `--${m[1]}` });
    }
  }
  return out;
}

function findLogo(doc: Document, base: string, org: JsonLdNode | undefined): string | null {
  const fromOrg = org?.['logo'];
  const orgLogo = typeof fromOrg === 'string' ? fromOrg : fromOrg && typeof fromOrg === 'object' ? stringProp(fromOrg as JsonLdNode, 'url') : null;
  if (orgLogo) {
    const url = safeHttpUrl(orgLogo, base);
    if (url) return url;
  }
  const img = doc.querySelector(
    'header img[class*="logo" i], header img[alt*="logo" i], header img[src*="logo" i], a[class*="logo" i] img, img[class*="logo" i], img[id*="logo" i], img[alt*="logo" i]',
  );
  const fromImg = resolveHref(img?.getAttribute('src'), base);
  if (fromImg) return fromImg;
  const icon = doc.querySelector('link[rel~="apple-touch-icon" i], link[rel~="icon" i]');
  return resolveHref(icon?.getAttribute('href'), base);
}

function describeTone(text: string): { sample: string; traits: string[] } | null {
  const sentences = splitSentences(text).filter((s) => countWords(s) >= 6);
  if (sentences.length < 2) return null;
  const sample = sentences.slice(0, 3).join(' ');
  const body = sentences.slice(0, 40).join(' ');
  const tokens = tokenize(body);
  const total = Math.max(1, tokens.length);
  const count = (words: string[]) => tokens.filter((t) => words.includes(t)).length;
  const you = count(['you', 'your', "you're", 'yours']);
  const we = count(['we', 'our', 'us', "we're", 'ours']);
  const avg = total / Math.min(40, sentences.length);
  const traits: string[] = [];
  if (you / total >= 0.02) traits.push('Speaks directly to the reader (“you”)');
  if (we / total >= 0.02) traits.push('First person plural (“we”, “our”)');
  if (you === 0 && we === 0) traits.push('Third person, impersonal');
  traits.push(avg <= 14 ? `Short sentences (about ${Math.round(avg)} words)` : avg >= 24 ? `Long sentences (about ${Math.round(avg)} words)` : `Medium-length sentences (about ${Math.round(avg)} words)`);
  if ((body.match(/!/g)?.length ?? 0) >= 2) traits.push('Energetic (uses exclamation marks)');
  if (/\b\w+['’](?:s|re|ll|ve|d|t)\b/i.test(body)) traits.push('Conversational (uses contractions)');
  return { sample: sample.length > 420 ? `${cutText(sample, 419)}…` : sample, traits };
}

function findTestimonials(doc: Document, nodes: readonly JsonLdNode[]): Testimonial[] {
  const out: Testimonial[] = [];
  const add = (quote: string, author: string | null): void => {
    const q = cleanText(quote, 600).replace(/^["“”']+|["“”']+$/g, '');
    if (q.length < 20) return;
    out.push({ quote: q, author: author ? cleanText(author, 80).replace(/^[—–\-\s]+/, '') || null : null });
  };
  for (const el of doc.querySelectorAll('blockquote, [class*="testimonial" i], [itemprop="reviewBody"], [class*="review-text" i], [class*="review_text" i]')) {
    // Skip wrappers that merely contain other testimonials.
    if (el.querySelector('blockquote, [class*="testimonial" i]') && el.tagName !== 'BLOCKQUOTE') continue;
    const authorEl = el.querySelector('cite, footer, figcaption, [class*="author" i], [itemprop="author"]') ?? el.parentElement?.querySelector('figcaption, cite');
    const author = authorEl?.textContent ?? null;
    let text = '';
    const paragraphs = el.querySelectorAll('p');
    if (paragraphs.length > 0) text = [...paragraphs].filter((p) => !authorEl || !authorEl.contains(p)).map((p) => p.textContent ?? '').join(' ');
    else text = (el.textContent ?? '').replace(author ?? '', '');
    add(text, author);
  }
  for (const node of nodes) {
    if (!typesOf(node).includes('Review')) continue;
    const body = stringProp(node, 'reviewBody', 600);
    if (body) add(body, stringProp(node, 'author', 80));
  }
  return uniqueBy(out, (t) => t.quote.toLowerCase().slice(0, 60)).slice(0, 6);
}

const AREA_PATTERN = /\b(?:serving|serve[sd]?|service areas? (?:include|includes|are)|areas? (?:we )?serve[sd]?(?: include)?|patients from|customers (?:in|from|across)|clients (?:in|from|across))\s+([^.!?]{4,160})/gi;

function areasFromText(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(AREA_PATTERN)) {
    const phrase = match[1]!.split(/\b(?:since|for (?:over|more)|with|who|that|every)\b/i)[0] ?? '';
    for (const part of phrase.split(/,|\band\b|&|\//)) {
      const name = cleanText(part.replace(/\b(?:the|areas?|surrounding|communities|neighbou?rhoods?|of|in)\b/gi, ' '), 60);
      // Place names start with a capital letter and are short.
      if (/^\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){0,3}$/u.test(name)) out.push(name);
    }
  }
  return out;
}

function titleParts(title: string): string[] {
  return title
    .split(/\s[|–—·:]\s|\s-\s/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The piece of the title that repeats on most pages is the site (business) name. */
function nameFromTitles(titles: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const title of titles) for (const part of new Set(titleParts(title))) counts.set(part, (counts.get(part) ?? 0) + 1);
  const best = [...counts].filter(([part, n]) => n >= 2 && part.length <= 60).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
  return best ? best[0] : null;
}

const GENERIC_PAGE_WORDS = new Set(
  'about contact pricing price prices location locations home blog us our book visit welcome page news faq team careers privacy terms menu shop cart login services'.split(' '),
);

const QUESTION_WORDS = new Set(['how', 'what', 'when', 'where', 'why', 'who', 'which', 'can', 'do', 'does', 'is', 'are', 'should']);

function trimStopwords(tokens: string[]): string[] {
  let start = 0;
  let end = tokens.length;
  // "How often should you…" is a keyword in its own right: keep leading question words.
  while (start < end && STOPWORDS.has(tokens[start]!) && !QUESTION_WORDS.has(tokens[start]!)) start++;
  while (end > start && STOPWORDS.has(tokens[end - 1]!)) end--;
  return tokens.slice(start, end);
}

/**
 * Focus-keyword candidates: the phrases the site itself chose for its titles
 * and H1s (minus the business name and page labels like "Contact us"), plus
 * any two- or three-word phrase repeated across several pages.
 */
function keywordCandidates(pages: readonly { title: string | null; h1: string[] }[], businessName: string | null): { phrase: string; pages: number }[] {
  const brand = (businessName ?? '').toLowerCase().trim();
  const stripBrand = (text: string): string => (brand ? text.toLowerCase().split(brand).join(' ') : text.toLowerCase());
  const isGeneric = (tokens: string[]): boolean => tokens.every((t) => GENERIC_PAGE_WORDS.has(t) || STOPWORDS.has(t));

  const phrasePages = new Map<string, Set<number>>();
  const gramPages = new Map<string, Set<number>>();
  const order: string[] = [];

  pages.forEach((page, index) => {
    const sources = [...(page.title ? titleParts(page.title) : []), ...page.h1];
    for (const source of sources) {
      const tokens = trimStopwords(tokenize(stripBrand(source)));
      if (tokens.length >= 2 && tokens.length <= 9 && !isGeneric(tokens)) {
        const phrase = tokens.join(' ');
        if (!phrasePages.has(phrase)) order.push(phrase);
        phrasePages.set(phrase, (phrasePages.get(phrase) ?? new Set()).add(index));
      }
      for (const n of [2, 3]) {
        for (let i = 0; i + n <= tokens.length; i++) {
          const gram = tokens.slice(i, i + n);
          if (STOPWORDS.has(gram[0]!) || STOPWORDS.has(gram[n - 1]!) || isGeneric(gram)) continue;
          const key = gram.join(' ');
          gramPages.set(key, (gramPages.get(key) ?? new Set()).add(index));
        }
      }
    }
  });

  const out: { phrase: string; pages: number }[] = [];
  // Phrases repeated on several pages are the strongest signal of what the site is about.
  const repeated = [...gramPages].filter(([, set]) => set.size >= 2).sort((a, b) => b[1].size - a[1].size || b[0].length - a[0].length);
  for (const [phrase, set] of repeated) {
    if (!out.some((o) => o.phrase.includes(phrase) && o.pages >= set.size)) out.push({ phrase, pages: set.size });
  }
  for (const phrase of order) {
    if (!out.some((o) => o.phrase === phrase)) out.push({ phrase, pages: phrasePages.get(phrase)!.size });
  }
  return out.slice(0, 12);
}

export function extractBusinessFacts(pages: readonly SitePage[], style: BrandStyle | null = null): BusinessFacts {
  const first = pages[0];
  const siteUrl = first ? `${new URL(first.url).origin}/` : '';
  const phones: string[] = [];
  const emails: string[] = [];
  const addresses: string[] = [];
  const serviceAreas: string[] = [];
  const services: string[] = [];
  const social: { network: string; url: string }[] = [];
  const colors: { hex: string; source: string }[] = [];
  const testimonials: Testimonial[] = [];
  const pageFacts: BusinessFacts['pages'] = [];
  let org: JsonLdNode | undefined;
  let siteName: string | null = null;
  let description: string | null = null;
  let logoUrl: string | null = null;
  let toneText = '';

  // Home and about pages first: they describe the business best.
  const ordered = [...pages].sort((a, b) => Number(b.kind === 'home') - Number(a.kind === 'home') || Number(b.kind === 'about') - Number(a.kind === 'about'));

  for (const page of ordered) {
    const { doc, url } = page;
    const base = documentBase(doc, url);
    const nodes = readJsonLd(doc);
    const facts = extractPageFacts(doc, url);
    pageFacts.push({ url, kind: page.kind, title: facts.title, facts });
    const pageOrg = nodes.find(isOrganisation);
    org ??= pageOrg;

    siteName ??= cleanText(doc.querySelector('meta[property="og:site_name" i]')?.getAttribute('content') ?? '', 120) || null;
    siteName ??= cleanText(doc.querySelector('meta[name="application-name" i]')?.getAttribute('content') ?? '', 120) || null;
    if (page.kind === 'home') description ??= facts.metaDescription;

    // Contact details: explicit links first, then structured data, then visible text.
    for (const a of doc.querySelectorAll('a[href^="tel:" i]')) pushUnique(phones, cleanText(a.textContent ?? '', 40) || (a.getAttribute('href') ?? '').slice(4), phoneKey);
    for (const a of doc.querySelectorAll('a[href^="mailto:" i]')) pushUnique(emails, decodeURIComponent((a.getAttribute('href') ?? '').slice(7).split('?')[0] ?? ''));
    for (const node of nodes.filter(isOrganisation)) {
      pushUnique(phones, stringProp(node, 'telephone', 40), phoneKey);
      pushUnique(emails, stringProp(node, 'email', 120));
      pushUnique(addresses, formatAddress(node['address']), addressKey);
      for (const area of listProp(node, 'areaServed', 80)) pushUnique(serviceAreas, area);
      for (const offer of [node['makesOffer'], (node['hasOfferCatalog'] as JsonLdNode | undefined)?.['itemListElement']]) {
        const items = Array.isArray(offer) ? offer : offer ? [offer] : [];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const inner = (item as JsonLdNode)['itemOffered'] ?? item;
          pushUnique(services, stringProp(inner as JsonLdNode, 'name', 100), undefined, 24);
        }
      }
      for (const link of listProp(node, 'sameAs', 300)) {
        const safe = safeHttpUrl(link);
        const network = safe ? socialNetworkOf(safe) : null;
        if (safe && network && !social.some((s) => s.network === network)) social.push({ network, url: safe });
      }
    }

    const content = extractMainContent(doc);
    // Visible text only: scripts and styles are skipped by the block walker.
    const bodyText = extractAllText(doc);
    for (const match of bodyText.match(PHONE) ?? []) if (phoneKey(match).length >= 10) pushUnique(phones, match, phoneKey);
    for (const match of bodyText.match(EMAIL) ?? []) if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(match)) pushUnique(emails, match);
    for (const el of doc.querySelectorAll('address, [itemprop="address"]')) {
      const lines = cleanText(blockText(el).split('\n').join(', '), 240);
      if (/\d/.test(lines)) pushUnique(addresses, lines, addressKey);
    }
    for (const area of areasFromText(content.text)) pushUnique(serviceAreas, area);

    // Services: headings on the services page, and links into a services section.
    if (page.kind === 'services') {
      for (const h of doc.querySelectorAll('main h2, main h3, article h2, article h3')) pushUnique(services, cleanText(h.textContent ?? '', 80), undefined, 24);
    }
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = resolveHref(a.getAttribute('href'), base);
      if (!href) continue;
      const network = socialNetworkOf(href);
      if (network && new URL(href).origin !== new URL(url).origin && !social.some((s) => s.network === network)) social.push({ network, url: href });
    }

    for (const c of colorsFromMarkup(doc)) colors.push(c);
    logoUrl ??= findLogo(doc, base, pageOrg);
    for (const t of findTestimonials(doc, nodes)) testimonials.push(t);
    if ((page.kind === 'home' || page.kind === 'about') && toneText.length < 6000) {
      // Running prose only: paragraphs, not menus, buttons, list items or quoted customers.
      toneText += `${content.blocks.filter((b) => b.kind === 'paragraph' && countWords(b.text) >= 8).map((b) => b.text).join(' ')} `;
    }
  }

  // Service pages linked from the navigation ("/services/teeth-whitening") name services too.
  if (services.length < 3) {
    for (const page of ordered) {
      for (const a of page.doc.querySelectorAll('a[href*="/services/" i], a[href*="/service/" i], a[href*="/treatments/" i], a[href*="#"]')) {
        const href = a.getAttribute('href') ?? '';
        if (href.startsWith('#') || (href.includes('#') && !/services|treatments/i.test(href))) continue;
        const label = cleanText(a.textContent ?? '', 80);
        if (label && countWords(label) <= 6 && !/^(learn|read|see|view|book|contact)\b/i.test(label)) pushUnique(services, label, undefined, 24);
      }
    }
  }

  const orgName = stringProp(org, 'name', 120);
  const titleName = nameFromTitles(pageFacts.map((p) => p.title).filter((t): t is string => Boolean(t)));
  let name: string | null;
  let nameSource: BusinessFacts['nameSource'];
  if (orgName) [name, nameSource] = [orgName, 'structured data'];
  else if (siteName) [name, nameSource] = [siteName, 'site name tag'];
  else if (titleName) [name, nameSource] = [titleName, 'page titles'];
  else [name, nameSource] = [siteUrl ? stripWww(new URL(siteUrl).hostname) : null, 'domain'];

  // Colours measured on the live page win over colours declared in markup.
  const brandColors = uniqueBy(
    [...(style?.colors ?? []).map((c) => ({ hex: normaliseHex(c.hex) ?? '', source: c.source })), ...colors].filter((c) => isUsableColor(c.hex)),
    (c) => c.hex,
  ).slice(0, 6);

  const rating = org?.['aggregateRating'] as JsonLdNode | undefined;
  const hours = org ? [...listProp(org, 'openingHours', 80)] : [];

  return {
    siteUrl,
    name,
    nameSource,
    description: description ?? stringProp(org, 'description', 400),
    phones: phones.slice(0, 6),
    emails: uniqueBy(emails, (e) => e.toLowerCase()).slice(0, 6),
    addresses: addresses.slice(0, 4),
    serviceAreas: serviceAreas.slice(0, 16),
    services: services.slice(0, 20),
    socialProfiles: social.slice(0, 10),
    organisation: org
      ? {
          types: typesOf(org),
          priceRange: stringProp(org, 'priceRange', 20),
          openingHours: hours,
          rating: rating && typeof rating === 'object' ? { value: stringProp(rating, 'ratingValue', 10) ?? '', count: stringProp(rating, 'reviewCount', 12) ?? stringProp(rating, 'ratingCount', 12) } : null,
          founded: stringProp(org, 'foundingDate', 20),
        }
      : null,
    logoUrl: style?.logoUrl ?? logoUrl,
    logoDataUrl: style?.logoDataUrl ?? null,
    brandColors,
    fonts: style?.fonts ?? [],
    tone: describeTone(toneText),
    testimonials: uniqueBy(testimonials, (t) => t.quote.toLowerCase().slice(0, 60)).slice(0, 6),
    keywordCandidates: keywordCandidates(pageFacts.map((p) => ({ title: p.title, h1: p.facts.h1 })), name),
    pages: pageFacts,
  };
}
