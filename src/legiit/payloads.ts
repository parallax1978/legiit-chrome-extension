/**
 * Builds the exact JSON a save action sends to Legiit Command Center.
 *
 * The UI shows the object these functions return, verbatim, before the user
 * confirms, and then sends that same object: what you see is what is sent.
 */
import { foldLabel } from '@/features/click-potential/metrics';
import type { SnapshotRecord } from '@/features/click-potential/snapshot';
import type { Brief } from '@/features/instant-brief/compose';
import type { NoiseReport } from '@/features/new-or-noise/classify';
import type { GapRow } from '@/features/why-not-me/gap';
import type { Presence } from '@/features/why-not-me/presence';
import type { CompetitorPayload, ContentEditorPayload, GapListPayload, VisibilitySnapshotPayload, WorkspaceFromBriefPayload } from './types';

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

export function snapshotPayload(snapshot: SnapshotRecord): VisibilitySnapshotPayload {
  return {
    keyword: snapshot.keyword,
    capturedAt: new Date(snapshot.takenAt).toISOString(),
    googleHost: snapshot.host,
    mode: snapshot.mode,
    viewport: { width: snapshot.viewport.width, height: snapshot.viewport.height },
    location: snapshot.locationText,
    firstOrganicTopPx: snapshot.firstOrganicTop,
    firstOrganicFold: snapshot.firstOrganicFold ? foldLabel(snapshot.firstOrganicFold) : null,
    organicShare: round(snapshot.organicShare),
    grade: { letter: snapshot.gradeLetter, score: snapshot.gradeScore, estimate: true },
    firstScreenShares: snapshot.shares.map((s) => ({ type: s.type, share: round(s.share) })),
    organic: snapshot.organic.map((o) => ({
      position: o.position,
      url: o.url,
      domain: o.domain,
      title: o.title,
      topPx: o.top,
      fold: o.fold ? foldLabel(o.fold) : null,
    })),
    tracked: snapshot.tracked.map((t) => ({ owner: t.owner, name: t.name, position: t.position, topPx: t.top, fold: t.fold ? foldLabel(t.fold) : null })),
  };
}

export function gapPayload(presence: Presence, rows: readonly GapRow[]): GapListPayload {
  return {
    source: presence.sourceLabel,
    subject: presence.subject,
    capturedAt: new Date(presence.capturedAt).toISOString(),
    rows: rows.map((r) => ({
      surface: r.surface,
      position: r.position,
      title: r.title,
      url: r.url,
      domain: r.domain,
      competitors: r.competitors,
      evidence: r.evidence,
      pageType: r.pageType,
      actionable: r.actionable,
      scanned: r.scanned,
      contacts: r.contacts.map((c) => ({ kind: c.kind, label: c.label, url: c.url })),
    })),
  };
}

export function contentEditorPayload(input: {
  targetKeyword: string;
  pageUrl: string | null;
  pageTitle: string;
  report: NoiseReport;
  comparedUrls: readonly string[];
}): ContentEditorPayload {
  const { report } = input;
  return {
    targetKeyword: input.targetKeyword,
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    method: { engine: report.engine, threshold: report.threshold, pagesCompared: report.pagesCompared },
    wordShare: { saidByMost: round(report.share.most), saidBySome: round(report.share.some), onlyHere: round(report.share.only) },
    onlyHere: report.sentences.filter((s) => s.cls === 'only').map((s) => s.text),
    missingPoints: report.missing.map((m) => ({ text: m.text, pages: m.pages, urls: m.urls })),
    comparedUrls: [...input.comparedUrls],
  };
}

export function workspacePayload(brief: Brief, markdown: string): WorkspaceFromBriefPayload {
  return {
    businessName: brief.businessName,
    siteUrl: brief.siteUrl,
    createdAt: new Date(brief.createdAt).toISOString(),
    contact: { phones: brief.facts.phones, emails: brief.facts.emails, addresses: brief.facts.addresses },
    serviceAreas: brief.facts.serviceAreas,
    services: brief.facts.services,
    competitors: brief.competitors.map((c) => ({ name: c.name, domain: c.domain })),
    focusKeywords: brief.facts.keywordCandidates.map((k) => k.phrase),
    avatars: brief.avatars.map((a) => ({ name: a.name, description: `${a.who} Wants: ${a.wants} Worries about: ${a.worries}`, draft: true as const })),
    issues: brief.issues.map((i) => ({ severity: i.severity, title: i.title, pages: i.pages })),
    nextSteps: brief.nextSteps,
    markdown,
  };
}

/** A competitor the user typed in Settings, as it is added to a business in Command Center. */
export function competitorPayload(brand: { name: string; domains: readonly string[] }): CompetitorPayload {
  return { name: brand.name, domain: brand.domains[0] ?? null };
}
