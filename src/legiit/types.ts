/**
 * Data shapes exchanged with Legiit Command Center.
 *
 * ASSUMPTION: the real API does not exist yet. These types mirror the
 * contract the Legiit developers build from (docs/legiit-api/openapi.yaml);
 * the extension only depends on the LegiitClient interface in ./client.ts.
 */
import type { IssueCode } from '@/features/instant-brief/issues';

/** Feature areas the server can switch on per account. UI for a missing capability is hidden. */
export type Capability =
  | 'businesses'
  | 'visibilitySnapshots'
  | 'gapLists'
  | 'competitors'
  | 'contentEditor'
  | 'workspaces'
  | 'industryPulse'
  | 'ai';

export const ALL_CAPABILITIES: readonly Capability[] = [
  'businesses',
  'visibilitySnapshots',
  'gapLists',
  'competitors',
  'contentEditor',
  'workspaces',
  'industryPulse',
  'ai',
];

export interface LegiitSession {
  user: { id: string; name: string; email: string | null };
  plan: string | null;
  capabilities: Capability[];
}

export interface LegiitBusiness {
  id: string;
  name: string;
  domain: string | null;
}

export interface LegiitBusinessDetails {
  id: string;
  name: string;
  brandNames: string[];
  domains: string[];
  competitors: { name: string; domains: string[] }[];
  focusKeywords: string[];
  avatars: { name: string; description: string }[];
}

/** What a save action returns: an id and, when available, a link to open the saved item. */
export interface SaveResult {
  id: string;
  url: string | null;
}

/** Where a result sits relative to the fold (the bottom edge of the first screen). */
export type FoldCode = 'above' | 'partly' | 'below';

export type ShareTypeCode =
  | 'organic'
  | 'ai_overview'
  | 'ad'
  | 'local_pack'
  | 'featured_snippet'
  | 'paa'
  | 'video'
  | 'image'
  | 'shopping'
  | 'forum'
  | 'top_stories'
  | 'knowledge_panel';

export interface VisibilitySnapshotPayload {
  keyword: string;
  capturedAt: string;
  googleHost: string;
  mode: 'web';
  /** Value of Google's "start" parameter: 0 on the first results page, 10 on the second… */
  resultsOffset: number;
  viewport: { width: number; height: number };
  location: string | null;
  firstOrganicTopPx: number | null;
  firstOrganicFold: FoldCode | null;
  organicShare: number;
  grade: { letter: 'A' | 'B' | 'C' | 'D' | 'F'; score: number; estimate: true };
  firstScreenShares: { type: ShareTypeCode; share: number }[];
  organic: { position: number; url: string; domain: string; title: string; topPx: number | null; fold: FoldCode | null }[];
  /** Every tracked brand. position is null when the brand has no organic result on this page. */
  tracked: { owner: 'mine' | 'competitor'; name: string; position: number | null; topPx: number | null; fold: FoldCode | null }[];
}

export type GapSurfaceCode =
  | 'ai_overview'
  | 'organic'
  | 'local_pack'
  | 'forum'
  | 'video'
  | 'ad'
  | 'featured_snippet'
  | 'top_stories'
  | 'shopping'
  | 'answer_text'
  | 'citations'
  | 'scanned_page';

export type GapPageTypeCode = 'competitor-site' | 'list' | 'forum' | 'video' | 'third-party' | 'surface';
export type ContactKindCode = 'contact' | 'author' | 'submission';

export interface GapListPayload {
  source: string;
  subject: string;
  capturedAt: string;
  rows: {
    surfaceId: GapSurfaceCode;
    surface: string;
    position: number | null;
    title: string;
    url: string | null;
    domain: string | null;
    competitors: string[];
    evidence: string;
    pageType: GapPageTypeCode;
    actionable: boolean;
    scanned: boolean;
    contacts: { kind: ContactKindCode; label: string; url: string }[];
  }[];
}

/** A competitor: the same shape when it is added to a business, listed in a brief, or read from Business Details. */
export interface CompetitorPayload {
  name: string;
  /** Lower case, without "www." and without a path. Empty when the competitor is tracked by name only. */
  domains: string[];
}

export interface ContentEditorPayload {
  targetKeyword: string;
  /** What was checked: the whole page, the text the user selected on it, or text the user pasted. */
  source: 'page' | 'selection' | 'pasted';
  /** null when the text was pasted. */
  pageUrl: string | null;
  /** Empty when the text was pasted or the page has no title. */
  pageTitle: string;
  capturedAt: string;
  method: { engine: 'embedding' | 'lexical'; threshold: number; pagesCompared: number };
  wordShare: { saidByMost: number; saidBySome: number; onlyHere: number };
  onlyHere: string[];
  missingPoints: { text: string; pages: number; urls: string[] }[];
  comparedUrls: string[];
}

export interface WorkspaceFromBriefPayload {
  /** The extension's own id of the brief. The same brief sent again carries the same id. */
  briefId: string;
  businessName: string;
  siteUrl: string;
  createdAt: string;
  contact: { phones: string[]; emails: string[]; addresses: string[] };
  serviceAreas: string[];
  services: string[];
  competitors: CompetitorPayload[];
  focusKeywords: string[];
  avatars: { name: string; description: string; draft: true }[];
  issues: { code: IssueCode; severity: 'high' | 'medium' | 'low'; title: string; detail: string; pages: string[] }[];
  nextSteps: string[];
  /** The full brief as Markdown, so nothing is lost in translation. */
  markdown: string;
}

export interface IndustryPulseEvent {
  /** A calendar day, YYYY-MM-DD. */
  date: string;
  title: string;
  /** "algorithm-update", "serp-feature", "news", or a kind added later. Not used for logic. */
  type: string;
  url: string | null;
}

export interface IndustryPulse {
  updatedAt: string | null;
  events: IndustryPulseEvent[];
}

export interface AiCompletionRequest {
  /** What the text is for, so the server can route or meter it. */
  task: 'click-potential' | 'why-not-me' | 'rewind' | 'new-or-noise' | 'brief';
  system: string;
  prompt: string;
  /** When set, the reply must be JSON matching this JSON Schema. */
  responseSchema?: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface AiCompletionResponse {
  text: string;
  model: string | null;
}
