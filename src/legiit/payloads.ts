/**
 * Builds the exact JSON a save action sends to Legiit Command Center.
 *
 * The UI shows the object these functions return, verbatim, before the user
 * confirms, and then sends that same object: what you see is what is sent.
 */
import type { TrackedBrands } from '@/brands/matcher';
import type { SnapshotRecord } from '@/features/click-potential/snapshot';
import type { Brief } from '@/features/instant-brief/compose';
import type { NoiseReport } from '@/features/new-or-noise/classify';
import type { GapRow } from '@/features/why-not-me/gap';
import type { Presence } from '@/features/why-not-me/presence';
import { cleanText, cutText, wellFormedDeep } from '@/lib/sanitize';
import { clip, clipDomain, clipUrl, LIMITS } from './limits';
import type { CompetitorPayload, ContentEditorPayload, GapListPayload, VisibilitySnapshotPayload, WorkspaceFromBriefPayload } from './types';

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

/** Google's "start" parameter: how many results precede this page (0 on the first page). */
function resultsOffset(pageUrl: string): number {
  try {
    const start = Number(new URL(pageUrl).searchParams.get('start') ?? '0');
    return Number.isInteger(start) && start > 0 ? Math.min(start, 1000) : 0;
  } catch {
    return 0;
  }
}

/**
 * @param brands Everything the user tracks. Brands with no organic result on
 *   the page are listed with position null, so "not ranking" is said out loud
 *   rather than left to be inferred from a missing entry.
 */
export function snapshotPayload(snapshot: SnapshotRecord, brands: TrackedBrands = { mine: [], competitors: [] }): VisibilitySnapshotPayload {
  // A brand counts as found only when its result is among the results that are sent.
  const sent = snapshot.tracked.filter((t) => t.position !== null && t.position <= LIMITS.snapshot.organic);
  const found = sent.map((t) => ({ owner: t.owner, name: clip(t.name, LIMITS.brandName), position: t.position, topPx: t.top, fold: t.fold }));
  const foundIds = new Set(sent.map((t) => t.brandId));
  const absent = [
    ...brands.mine.map((b) => ({ owner: 'mine' as const, brand: b })),
    ...brands.competitors.map((b) => ({ owner: 'competitor' as const, brand: b })),
  ]
    .filter(({ brand }) => !foundIds.has(brand.id))
    .map(({ owner, brand }) => ({ owner, name: clip(brand.name, LIMITS.brandName), position: null, topPx: null, fold: null }));

  return wellFormedDeep({
    keyword: clip(snapshot.keyword, LIMITS.snapshot.keyword),
    capturedAt: new Date(snapshot.takenAt).toISOString(),
    googleHost: snapshot.host,
    mode: 'web' as const,
    resultsOffset: resultsOffset(snapshot.url),
    viewport: { width: Math.round(snapshot.viewport.width), height: Math.round(snapshot.viewport.height) },
    location: snapshot.locationText === null ? null : clip(snapshot.locationText, LIMITS.snapshot.location),
    firstOrganicTopPx: snapshot.firstOrganicTop,
    firstOrganicFold: snapshot.firstOrganicFold,
    organicShare: round(snapshot.organicShare),
    grade: { letter: snapshot.gradeLetter, score: snapshot.gradeScore, estimate: true as const },
    firstScreenShares: snapshot.shares.slice(0, LIMITS.snapshot.firstScreenShares).map((s) => ({ type: s.type, share: round(s.share) })),
    organic: snapshot.organic.slice(0, LIMITS.snapshot.organic).map((o) => ({
      position: o.position,
      url: clipUrl(o.url),
      domain: clipDomain(o.domain),
      title: clip(o.title, LIMITS.snapshot.title),
      topPx: o.top,
      fold: o.fold,
    })),
    tracked: [...found, ...absent].slice(0, LIMITS.snapshot.tracked),
  });
}

export function gapPayload(presence: Presence, rows: readonly GapRow[]): GapListPayload {
  return wellFormedDeep({
    source: clip(presence.sourceLabel, LIMITS.gapList.source),
    subject: clip(presence.subject, LIMITS.gapList.subject),
    capturedAt: new Date(presence.capturedAt).toISOString(),
    rows: rows.slice(0, LIMITS.gapList.rows).map((r) => ({
      surfaceId: r.surfaceId,
      surface: clip(r.surface, LIMITS.gapList.surface),
      position: r.position,
      title: clip(r.title, LIMITS.gapList.title),
      url: r.url === null ? null : clipUrl(r.url),
      domain: r.domain === null ? null : clipDomain(r.domain),
      competitors: r.competitors.slice(0, LIMITS.gapList.competitors).map((name) => clip(name, LIMITS.brandName)),
      evidence: clip(r.evidence, LIMITS.gapList.evidence),
      pageType: r.pageType,
      actionable: r.actionable,
      scanned: r.scanned,
      contacts: r.contacts
        .filter((c) => c.url.length <= LIMITS.url)
        .slice(0, LIMITS.gapList.contacts)
        .map((c) => ({ kind: c.kind, label: clip(c.label, LIMITS.gapList.contactLabel), url: c.url })),
    })),
  });
}

export function contentEditorPayload(input: {
  targetKeyword: string;
  source: ContentEditorPayload['source'];
  pageUrl: string | null;
  pageTitle: string;
  /** When the comparison was made (ms). */
  capturedAt: number;
  report: NoiseReport;
}): ContentEditorPayload {
  const { report } = input;
  const limits = LIMITS.contentEditor;
  // Selected and pasted text has not been through the page reader: clean it like page text before it leaves.
  const sentence = (text: string): string => cleanText(text, limits.sentence);
  return wellFormedDeep({
    targetKeyword: cleanText(input.targetKeyword, limits.keyword),
    source: input.source,
    pageUrl: input.pageUrl === null ? null : clipUrl(input.pageUrl),
    pageTitle: cleanText(input.pageTitle, limits.title),
    capturedAt: new Date(input.capturedAt).toISOString(),
    method: { engine: report.engine, threshold: round(report.threshold), pagesCompared: report.comparedUrls.length },
    wordShare: { saidByMost: round(report.share.most), saidBySome: round(report.share.some), onlyHere: round(report.share.only) },
    onlyHere: report.sentences
      .filter((s) => s.cls === 'only')
      .map((s) => sentence(s.text))
      .filter(Boolean)
      .slice(0, limits.onlyHere),
    missingPoints: report.missing.slice(0, limits.missingPoints).map((m) => ({ text: sentence(m.text), pages: m.pages, urls: m.urls.slice(0, limits.urls).map(clipUrl) })),
    comparedUrls: report.comparedUrls.slice(0, limits.urls).map(clipUrl),
  });
}

const competitorDomains = (domains: readonly (string | null)[]): string[] =>
  [...new Set(domains.filter((d): d is string => typeof d === 'string' && d !== '' && d.length <= LIMITS.domain))].slice(0, LIMITS.brandDomains);

/** A competitor as it is sent to Legiit: when added to a business, and inside a brief. */
export function competitorPayload(brand: { name: string; domains: readonly (string | null)[] }): CompetitorPayload {
  return wellFormedDeep({ name: clip(brand.name.trim(), LIMITS.brandName), domains: competitorDomains(brand.domains) });
}

export function workspacePayload(brief: Brief, markdown: string): WorkspaceFromBriefPayload {
  const limits = LIMITS.workspace;
  const texts = (values: readonly string[], maxItems: number, maxLength: number): string[] =>
    values
      .filter((value) => value !== '')
      .slice(0, maxItems)
      .map((value) => clip(value, maxLength));
  // A competitor without a name is listed under its domain; one with neither, or one that is already listed, is left out.
  const competitors: CompetitorPayload[] = [];
  for (const candidate of brief.competitors) {
    const entry = competitorPayload({ name: candidate.name.trim() || (candidate.domain ?? ''), domains: [candidate.domain] });
    const known = competitors.some((c) => c.name.toLowerCase() === entry.name.toLowerCase() || c.domains.some((d) => entry.domains.includes(d)));
    if (entry.name !== '' && !known && competitors.length < limits.competitors) competitors.push(entry);
  }
  return wellFormedDeep({
    briefId: cutText(brief.id, limits.briefId),
    businessName: clip(brief.businessName, limits.businessName),
    siteUrl: clipUrl(brief.siteUrl),
    createdAt: new Date(brief.createdAt).toISOString(),
    contact: {
      phones: texts(brief.facts.phones, limits.phones, limits.phone),
      emails: texts(brief.facts.emails, limits.emails, limits.email),
      addresses: texts(brief.facts.addresses, limits.addresses, limits.address),
    },
    serviceAreas: texts(brief.facts.serviceAreas, limits.serviceAreas, limits.serviceArea),
    services: texts(brief.facts.services, limits.services, limits.service),
    competitors,
    focusKeywords: texts(brief.facts.keywordCandidates.map((k) => k.phrase), limits.focusKeywords, limits.focusKeyword),
    avatars: brief.avatars.slice(0, limits.avatars).map((a) => ({
      name: clip(a.name, limits.avatarName),
      description: clip(`${a.who} Wants: ${a.wants} Worries about: ${a.worries}`, limits.avatarDescription),
      draft: true as const,
    })),
    issues: brief.issues.slice(0, limits.issues).map((i) => ({
      code: i.code,
      severity: i.severity,
      title: clip(i.title, limits.issueTitle),
      detail: clip(i.detail, limits.issueDetail),
      pages: [...new Set(i.pages)].slice(0, limits.issuePages).map(clipUrl),
    })),
    nextSteps: texts(brief.nextSteps, limits.nextSteps, limits.nextStep),
    markdown: clip(markdown, limits.markdown),
  });
}
