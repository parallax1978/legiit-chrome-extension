/**
 * Reads the latest answer and its cited links from an AI answer page
 * (ChatGPT, Gemini, Perplexity, Copilot). Only what is already rendered in
 * the tab the user opened is read; nothing is sent to the AI site.
 */
import { blockText } from '@/extract/blocks';
import { cleanMultiline, cleanText, domainOf, safeHttpUrl, stripWww } from '@/lib/sanitize';
import { cleanUrl, urlKey } from '@/lib/url';
import type { AnswerData, AnswerSite, Citation } from '@/model/schemas';
import { resolve } from '@/selectors/resolve';
import type { SelectorPack } from '@/selectors/types';

export interface ReadAnswerEnv {
  url: string;
  now: number;
  /** Hosts that belong to the AI site itself; links to them are not citations. */
  ownHosts: readonly string[];
}

/** Hosts that appear as UI chrome on AI sites rather than as sources. */
const NON_SOURCE_HOSTS = /(^|\.)(openai\.com|oaiusercontent\.com|gstatic\.com|googleusercontent\.com|bing\.net|msftstatic\.com)$/i;

function isOwnHost(host: string, ownHosts: readonly string[]): boolean {
  const h = stripWww(host);
  return ownHosts.some((own) => {
    const o = stripWww(own);
    return h === o || h.endsWith(`.${o}`);
  });
}

export function collectCitations(scopes: readonly Element[], env: ReadAnswerEnv, limit = 100): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    for (const a of scope.querySelectorAll('a[href]')) {
      const resolved = safeHttpUrl(a.getAttribute('href') ?? '', env.url);
      if (!resolved) continue;
      const url = cleanUrl(resolved) ?? resolved;
      const host = new URL(url).hostname;
      if (isOwnHost(host, env.ownHosts) || NON_SOURCE_HOSTS.test(host)) continue;
      const key = urlKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      const domain = domainOf(url);
      const title =
        cleanText(a.getAttribute('title') ?? '', 300) ||
        cleanText(a.getAttribute('aria-label') ?? '', 300) ||
        cleanText(a.textContent ?? '', 300) ||
        domain;
      citations.push({ url, domain, title });
      if (citations.length >= limit) return citations;
    }
  }
  return citations;
}

function closestOfSlot(el: Element, pack: SelectorPack, slotName: string): Element | null {
  for (const candidate of pack.slots[slotName]?.candidates ?? []) {
    try {
      const up = el.closest(candidate.css);
      if (up && up !== el.ownerDocument.body && up !== el.ownerDocument.documentElement) return up;
    } catch {
      // Invalid selector in a pack: try the next candidate.
    }
  }
  return null;
}

export function readAnswer(doc: Document, pack: SelectorPack, site: AnswerSite, env: ReadAnswerEnv): AnswerData {
  const base: AnswerData = {
    kind: 'answer',
    site,
    url: safeHttpUrl(env.url),
    question: null,
    text: '',
    citations: [],
    capturedAt: env.now,
    recognised: false,
    packVersion: pack.version,
  };

  const answers = resolve(doc, pack, 'answer').elements;
  const latest = answers[answers.length - 1];
  if (!latest) return base;

  const text = cleanMultiline(blockText(latest, 600, true), 40_000);
  if (!text) return base;

  // Citations: links in the answer, in the turn around it (source pills, footnotes), and in any sources panel.
  const turn = closestOfSlot(latest, pack, 'turn');
  const scopes: Element[] = [latest];
  if (turn && turn !== latest) scopes.push(turn);
  for (const panel of resolve(doc, pack, 'sources').elements) scopes.push(panel);

  let question: string | null = null;
  for (const q of resolve(doc, pack, 'question').elements) {
    // Keep the last question that precedes the latest answer.
    if (q.compareDocumentPosition(latest) & 4 /* DOCUMENT_POSITION_FOLLOWING */ && !q.contains(latest)) {
      question = cleanText(q.textContent ?? '', 2000) || question;
    }
  }

  return {
    ...base,
    question,
    text,
    citations: collectCitations(scopes, env),
    recognised: true,
  };
}

/**
 * Builds answer data from text the user pasted (the fallback when a site's
 * markup is not recognised). Links are any http(s) URLs found in the text.
 */
export function answerFromPastedText(pasted: string, now: number): AnswerData {
  const text = cleanMultiline(pasted, 40_000);
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const url = cleanUrl(match[0].replace(/[.,;:!?]+$/, ''));
    if (!url) continue;
    const key = urlKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ url, domain: domainOf(url), title: domainOf(url) });
    if (citations.length >= 100) break;
  }
  return {
    kind: 'answer',
    site: 'pasted',
    url: null,
    question: null,
    text,
    citations,
    capturedAt: now,
    recognised: text.length > 0,
    packVersion: null,
  };
}
