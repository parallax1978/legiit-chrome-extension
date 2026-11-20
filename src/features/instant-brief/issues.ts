/** Instant Brief: basic on-page issues across the pages that were read. */
import type { PageFacts } from '@/extract/page-facts';
import { pluralize } from '@/lib/text';
import { urlKey } from '@/lib/url';
import type { PageKind } from './crawl';

export type Severity = 'high' | 'medium' | 'low';

/** The finding types. Stable identifiers: they are sent to Legiit with a brief (see the API contract). */
export type IssueCode =
  | 'not-https'
  | 'noindex'
  | 'missing-title'
  | 'duplicate-title'
  | 'short-title'
  | 'long-title'
  | 'missing-description'
  | 'missing-h1'
  | 'multiple-h1'
  | 'canonical-elsewhere'
  | 'missing-canonical'
  | 'missing-viewport'
  | 'missing-alt'
  | 'no-structured-data'
  | 'thin-content';

export interface Issue {
  severity: Severity;
  code: IssueCode;
  title: string;
  detail: string;
  /** URLs of the affected pages. */
  pages: string[];
}

export interface IssueInput {
  url: string;
  kind: PageKind;
  doc: Document;
  facts: PageFacts;
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { high: 0, medium: 1, low: 2 };

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search || '/';
  } catch {
    return url;
  }
}

export function findIssues(pages: readonly IssueInput[]): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Severity, code: IssueCode, title: string, detail: string, affected: readonly IssueInput[]): void => {
    if (affected.length > 0) issues.push({ severity, code, title, detail, pages: affected.map((p) => p.url) });
  };
  const paths = (affected: readonly IssueInput[]): string => affected.map((p) => pathOf(p.url)).join(', ');

  const insecure = pages.filter((p) => p.url.startsWith('http://'));
  add('high', 'not-https', 'Pages served without HTTPS', `Served over plain HTTP: ${paths(insecure)}.`, insecure);

  const noindex = pages.filter((p) => /noindex/.test(p.facts.metaRobots ?? ''));
  add('high', 'noindex', 'Pages blocked from indexing', `A robots meta tag with "noindex" is on: ${paths(noindex)}.`, noindex);

  const noTitle = pages.filter((p) => !p.facts.title);
  add('high', 'missing-title', 'Missing title tag', `No <title> on: ${paths(noTitle)}.`, noTitle);

  const titleGroups = new Map<string, IssueInput[]>();
  for (const p of pages) if (p.facts.title) titleGroups.set(p.facts.title.toLowerCase(), [...(titleGroups.get(p.facts.title.toLowerCase()) ?? []), p]);
  const duplicateTitles = [...titleGroups.values()].filter((group) => group.length > 1).flat();
  add('medium', 'duplicate-title', 'Duplicate title tags', `The same title is used on: ${paths(duplicateTitles)}.`, duplicateTitles);

  const weakTitle = pages.filter((p) => p.facts.title && p.facts.title.length < 15);
  add('medium', 'short-title', 'Titles that say too little', `Titles under 15 characters: ${weakTitle.map((p) => `${pathOf(p.url)} (“${p.facts.title}”)`).join(', ')}.`, weakTitle);

  const longTitle = pages.filter((p) => p.facts.title && p.facts.title.length > 65);
  add('low', 'long-title', 'Titles likely to be cut off', `Titles over 65 characters: ${paths(longTitle)}.`, longTitle);

  const noDescription = pages.filter((p) => !p.facts.metaDescription);
  add('medium', 'missing-description', 'Missing meta description', `No meta description on: ${paths(noDescription)}.`, noDescription);

  const noH1 = pages.filter((p) => p.facts.h1.length === 0);
  add('medium', 'missing-h1', 'Missing H1 heading', `No H1 on: ${paths(noH1)}.`, noH1);

  const manyH1 = pages.filter((p) => p.facts.h1.length > 1);
  add('low', 'multiple-h1', 'More than one H1 heading', `${manyH1.map((p) => `${pathOf(p.url)} has ${p.facts.h1.length}`).join(', ')}.`, manyH1);

  const offCanonical = pages.filter((p) => p.facts.canonical && urlKey(p.facts.canonical) !== urlKey(p.url));
  add(
    'medium',
    'canonical-elsewhere',
    'Canonical points to another page',
    `${offCanonical.map((p) => `${pathOf(p.url)} → ${p.facts.canonical}`).join(', ')}.`,
    offCanonical,
  );

  const noCanonical = pages.filter((p) => !p.facts.canonical);
  add('low', 'missing-canonical', 'No canonical tag', `No rel="canonical" on: ${paths(noCanonical)}.`, noCanonical);

  const noViewport = pages.filter((p) => !p.doc.querySelector('meta[name="viewport" i]'));
  add('medium', 'missing-viewport', 'No mobile viewport tag', `No viewport meta tag on: ${paths(noViewport)}.`, noViewport);

  const altCounts = pages
    .map((p) => ({ p, missing: [...p.doc.querySelectorAll('img')].filter((img) => !(img.getAttribute('alt') ?? '').trim() && img.getAttribute('role') !== 'presentation').length }))
    .filter((x) => x.missing > 0);
  add(
    'low',
    'missing-alt',
    'Images without alt text',
    `${altCounts.map((x) => `${pathOf(x.p.url)}: ${pluralize(x.missing, 'image')}`).join(', ')}.`,
    altCounts.map((x) => x.p),
  );

  const home = pages.find((p) => p.kind === 'home');
  if (home && home.facts.jsonLdTypes.length === 0) {
    add('medium', 'no-structured-data', 'No structured data on the home page', 'The home page has no JSON-LD (for example LocalBusiness or Organization).', [home]);
  }

  const thin = pages.filter((p) => p.kind !== 'contact' && p.facts.wordCount < 100);
  add('low', 'thin-content', 'Pages with very little text', `${thin.map((p) => `${pathOf(p.url)}: ${pluralize(p.facts.wordCount, 'word')}`).join(', ')}.`, thin);

  return issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.pages.length - a.pages.length);
}
