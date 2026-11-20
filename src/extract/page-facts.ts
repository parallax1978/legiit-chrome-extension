/**
 * On-page SEO facts for one HTML document. Used by Rewind (per Wayback
 * capture), Instant Brief (per site page) and the live page.
 */
import { cleanText, stripWww } from '@/lib/sanitize';
import { collectJsonLdTypes, documentBase, metaContent, resolveHref } from './html';
import { extractMainContent } from './main-content';

export interface PageFacts {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  metaRobots: string | null;
  h1: string[];
  h2: string[];
  h3: string[];
  /** Words in the main content (navigation, header and footer excluded). */
  wordCount: number;
  internalLinks: number;
  externalLinks: number;
  jsonLdTypes: string[];
  hreflangCount: number;
}

function headings(doc: Document, tag: string): string[] {
  const out: string[] = [];
  for (const el of doc.querySelectorAll(tag)) {
    const text = cleanText(el.textContent ?? '', 300);
    if (text) out.push(text);
    if (out.length >= 150) break;
  }
  return out;
}

export function countLinks(doc: Document, pageUrl: string): { internal: number; external: number } {
  const base = documentBase(doc, pageUrl);
  let pageHost = '';
  try {
    pageHost = stripWww(new URL(pageUrl).hostname);
  } catch {
    pageHost = '';
  }
  let internal = 0;
  let external = 0;
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = resolveHref(a.getAttribute('href'), base);
    if (!href) continue;
    if (stripWww(new URL(href).hostname) === pageHost) internal++;
    else external++;
  }
  return { internal, external };
}

export function extractPageFacts(doc: Document, pageUrl: string): PageFacts {
  const base = documentBase(doc, pageUrl);
  const robots = metaContent(doc, 'meta[name="robots" i]', 200);
  const links = countLinks(doc, pageUrl);
  return {
    title: cleanText(doc.querySelector('title')?.textContent ?? '', 500) || null,
    metaDescription: metaContent(doc, 'meta[name="description" i]', 1000),
    canonical: resolveHref(doc.querySelector('link[rel~="canonical" i]')?.getAttribute('href'), base),
    metaRobots: robots
      ? robots
          .toLowerCase()
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          .join(', ')
      : null,
    h1: headings(doc, 'h1'),
    h2: headings(doc, 'h2'),
    h3: headings(doc, 'h3'),
    wordCount: extractMainContent(doc).wordCount,
    internalLinks: links.internal,
    externalLinks: links.external,
    jsonLdTypes: collectJsonLdTypes(doc),
    hreflangCount: doc.querySelectorAll('link[rel~="alternate" i][hreflang]').length,
  };
}
