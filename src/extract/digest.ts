/**
 * A compact, text-only digest of a fetched page: what the features need
 * (title, content blocks, opportunity links) without keeping the HTML.
 * This is what gets cached in IndexedDB.
 */
import { cleanText } from '@/lib/sanitize';
import { isListStyleTitle } from '@/serp/parse';
import type { ContentBlock } from './blocks';
import { parseHtml } from './html';
import { findOpportunityLinks, type OpportunityLink } from './links';
import { extractAllText, extractMainContent } from './main-content';

export interface PageDigest {
  /** The URL that was requested. */
  url: string;
  finalUrl: string;
  ok: boolean;
  status: number;
  error: string | null;
  needsPermission: boolean;
  fetchedAt: number;
  title: string;
  /**
   * Every name the page gives itself: its title, the title it offers for sharing, its main headings. Used to tell
   * whether a page loaded from a guessed address is the page that was meant. Missing on digests cached earlier.
   */
  titles?: string[];
  /** Main-content blocks. */
  blocks: ContentBlock[];
  /** Whole-page text (navigation and footer included), for brand mentions outside the article body. */
  fullText: string;
  wordCount: number;
  contacts: OpportunityLink[];
  listStyle: boolean;
}

const MAX_BLOCKS = 800;
const MAX_FULL_TEXT = 120_000;

export function failedDigest(url: string, error: string, status = 0, needsPermission = false, now = Date.now()): PageDigest {
  return {
    url,
    finalUrl: url,
    ok: false,
    status,
    error,
    needsPermission,
    fetchedAt: now,
    title: '',
    blocks: [],
    fullText: '',
    wordCount: 0,
    contacts: [],
    listStyle: false,
  };
}

export function digestHtml(html: string, url: string, finalUrl: string = url, status = 200, now = Date.now()): PageDigest {
  const doc = parseHtml(html);
  const content = extractMainContent(doc);
  const title = content.title || cleanText(doc.querySelector('h1')?.textContent ?? '', 300);
  const named = [
    title,
    doc.querySelector('title')?.textContent ?? '',
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '',
    doc.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ?? '',
    ...Array.from(doc.querySelectorAll('h1'))
      .slice(0, 2)
      .map((h) => h.textContent ?? ''),
  ].map((value) => cleanText(value, 300));
  return {
    url,
    finalUrl,
    ok: true,
    status,
    error: null,
    needsPermission: false,
    fetchedAt: now,
    title,
    titles: [...new Set(named.filter(Boolean))].slice(0, 6),
    blocks: content.blocks.slice(0, MAX_BLOCKS),
    fullText: extractAllText(doc).slice(0, MAX_FULL_TEXT),
    wordCount: content.wordCount,
    contacts: findOpportunityLinks(doc, finalUrl),
    listStyle: isListStyleTitle(title),
  };
}
