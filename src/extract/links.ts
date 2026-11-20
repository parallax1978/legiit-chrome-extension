/**
 * Finds the links on a page that tell you who to talk to: contact pages,
 * author pages and "submit / suggest / write for us" pages.
 */
import { cleanText, stripWww } from '@/lib/sanitize';
import { cleanUrl, urlKey } from '@/lib/url';
import { documentBase, resolveHref } from './html';

export type OpportunityKind = 'contact' | 'author' | 'submission';

export interface OpportunityLink {
  kind: OpportunityKind;
  label: string;
  /** http(s) URL, or a mailto: address for contact e-mail links. */
  url: string;
}

const SUBMISSION_TEXT =
  /\b(write for us|guest post|submit (?:a |an |your )?\w+|suggest (?:a |an )?\w+|add (?:a |your )\w+|get listed|list your \w+|contribute|become a contributor|pitch us|editorial guidelines|advertis\w*|sponsor\w*|partner with us|request (?:a )?review|nominate|corrections?|report an error|tip line)\b/i;
const SUBMISSION_PATH =
  /\/(write-for-us|guest-post\w*|submit[\w-]*|suggest[\w-]*|contribute\w*|get-listed|add-(?:your-)?[\w-]+|advertis\w*|sponsor\w*|partners?|editorial-(?:guidelines|policy)|corrections?|pitch)(\/|$|\.)/i;
const CONTACT_TEXT = /\b(contact( us)?|get in touch|reach us|about( us)?|our team|press|media (?:enquiries|inquiries)|support)\b/i;
const CONTACT_PATH = /\/(contact[\w-]*|about[\w-]*|team|press|imprint|impressum|kontakt)(\/|$|\.)/i;
const AUTHOR_PATH = /\/(authors?|writers?|contributors?|staff|profile|people|team\/[\w-]+|bio)\//i;

function isEmail(value: string): boolean {
  return /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,24}$/i.test(value);
}

export function findOpportunityLinks(doc: Document, pageUrl: string, perKind = 6): OpportunityLink[] {
  const base = documentBase(doc, pageUrl);
  let pageHost = '';
  try {
    pageHost = stripWww(new URL(pageUrl).hostname);
  } catch {
    pageHost = '';
  }
  const found: OpportunityLink[] = [];
  const seen = new Set<string>();
  const counts: Record<OpportunityKind, number> = { contact: 0, author: 0, submission: 0 };

  const add = (kind: OpportunityKind, label: string, url: string): void => {
    const key = `${kind}:${url.startsWith('mailto:') ? url.toLowerCase() : urlKey(url)}`;
    if (seen.has(key) || counts[kind] >= perKind) return;
    seen.add(key);
    counts[kind]++;
    found.push({ kind, label: label || url.replace(/^mailto:/, ''), url });
  };

  for (const a of doc.querySelectorAll('a[href]')) {
    const rawHref = (a.getAttribute('href') ?? '').trim();
    const label = cleanText(a.textContent ?? '', 120) || cleanText(a.getAttribute('aria-label') ?? '', 120);

    if (/^mailto:/i.test(rawHref)) {
      const address = decodeURIComponent(rawHref.slice(7).split('?')[0] ?? '').trim();
      if (isEmail(address)) add('contact', label && !isEmail(label) ? `${label} (${address})` : address, `mailto:${address}`);
      continue;
    }

    const resolved = resolveHref(rawHref, base);
    if (!resolved) continue;
    const href = cleanUrl(resolved) ?? resolved;
    const url = new URL(href);
    const sameSite = stripWww(url.hostname) === pageHost;
    const rel = (a.getAttribute('rel') ?? '').toLowerCase();
    const path = url.pathname;

    if (rel.split(/\s+/).includes('author') || (sameSite && AUTHOR_PATH.test(path))) {
      add('author', label, href);
    } else if (SUBMISSION_TEXT.test(label) || (sameSite && SUBMISSION_PATH.test(path))) {
      add('submission', label, href);
    } else if (sameSite && (CONTACT_PATH.test(path) || (label.length <= 40 && CONTACT_TEXT.test(label)))) {
      add('contact', label, href);
    }
  }

  // A byline without a link is still worth showing.
  if (counts.author === 0) {
    const byline =
      doc.querySelector('meta[name="author" i]')?.getAttribute('content') ??
      doc.querySelector('[itemprop="author"], .byline, .author-name, [class*="byline"]')?.textContent ??
      '';
    const name = cleanText(byline, 80).replace(/^by\s+/i, '');
    if (name && name.length >= 3 && !/^https?:/i.test(name)) add('author', `Author: ${name}`, pageUrl);
  }

  return found;
}
