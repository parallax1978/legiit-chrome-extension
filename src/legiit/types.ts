/**
 * Data shapes exchanged with Legiit Command Center.
 *
 * ASSUMPTION: the real API does not exist yet. These types and
 * docs/legiit-api-contract.yaml are a proposal for the Legiit developers;
 * the extension only depends on the LegiitClient interface in ./client.ts.
 */

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

export interface VisibilitySnapshotPayload {
  keyword: string;
  capturedAt: string;
  googleHost: string;
  mode: 'web' | 'ai-mode';
  viewport: { width: number; height: number };
  location: string | null;
  firstOrganicTopPx: number | null;
  firstOrganicFold: string | null;
  organicShare: number;
  grade: { letter: string; score: number; estimate: true };
  firstScreenShares: { type: string; share: number }[];
  organic: { position: number; url: string; domain: string; title: string; topPx: number | null; fold: string | null }[];
  tracked: { owner: 'mine' | 'competitor'; name: string; position: number | null; topPx: number | null; fold: string | null }[];
}

export interface GapListPayload {
  source: string;
  subject: string;
  capturedAt: string;
  rows: {
    surface: string;
    position: number | null;
    title: string;
    url: string | null;
    domain: string | null;
    competitors: string[];
    evidence: string;
    pageType: string;
    actionable: boolean;
    scanned: boolean;
    contacts: { kind: string; label: string; url: string }[];
  }[];
}

export interface CompetitorPayload {
  name: string;
  domain: string | null;
}

export interface ContentEditorPayload {
  targetKeyword: string;
  pageUrl: string | null;
  pageTitle: string;
  method: { engine: string; threshold: number; pagesCompared: number };
  wordShare: { saidByMost: number; saidBySome: number; onlyHere: number };
  onlyHere: string[];
  missingPoints: { text: string; pages: number; urls: string[] }[];
  comparedUrls: string[];
}

export interface WorkspaceFromBriefPayload {
  businessName: string;
  siteUrl: string;
  createdAt: string;
  contact: { phones: string[]; emails: string[]; addresses: string[] };
  serviceAreas: string[];
  services: string[];
  competitors: { name: string; domain: string | null }[];
  focusKeywords: string[];
  avatars: { name: string; description: string; draft: true }[];
  issues: { severity: string; title: string; pages: string[] }[];
  nextSteps: string[];
  /** The full brief as Markdown, so nothing is lost in translation. */
  markdown: string;
}

export interface IndustryPulseEvent {
  date: string;
  title: string;
  type: 'algorithm-update' | 'serp-feature' | 'news';
  url: string | null;
}

export interface IndustryPulse {
  updatedAt: string;
  events: IndustryPulseEvent[];
}

export interface AiCompletionRequest {
  /** What the text is for, so the server can route or meter it. */
  task: 'click-potential' | 'why-not-me' | 'rewind' | 'new-or-noise' | 'brief';
  system: string;
  prompt: string;
  /** When set, the reply must be JSON matching this JSON Schema. */
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface AiCompletionResponse {
  text: string;
  model: string | null;
}
