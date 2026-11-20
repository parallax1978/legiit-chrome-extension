/**
 * The one interface the extension uses to talk to Legiit Command Center.
 * HttpLegiitClient (real HTTP) and MockLegiitClient (fixtures) implement it.
 */
import type {
  AiCompletionRequest,
  AiCompletionResponse,
  Capability,
  CompetitorPayload,
  ContentEditorPayload,
  GapListPayload,
  IndustryPulse,
  LegiitBusiness,
  LegiitBusinessDetails,
  LegiitSession,
  SaveResult,
  VisibilitySnapshotPayload,
  WorkspaceFromBriefPayload,
} from './types';

export interface SaveOptions {
  /**
   * Identifies one confirmed save. A retry of the same save carries the same
   * key, so the server can answer it without storing the item twice.
   */
  idempotencyKey?: string;
}

export interface LegiitClient {
  getSession(): Promise<LegiitSession>;
  listBusinesses(): Promise<LegiitBusiness[]>;
  getBusinessDetails(businessId: string): Promise<LegiitBusinessDetails>;
  saveVisibilitySnapshot(businessId: string, payload: VisibilitySnapshotPayload, options?: SaveOptions): Promise<SaveResult>;
  saveGapList(businessId: string, payload: GapListPayload, options?: SaveOptions): Promise<SaveResult>;
  addCompetitor(businessId: string, payload: CompetitorPayload, options?: SaveOptions): Promise<SaveResult>;
  sendToContentEditor(businessId: string, payload: ContentEditorPayload, options?: SaveOptions): Promise<SaveResult>;
  createWorkspaceFromBrief(payload: WorkspaceFromBriefPayload, options?: SaveOptions): Promise<SaveResult>;
  getIndustryPulse(): Promise<IndustryPulse>;
  completeAI(request: AiCompletionRequest): Promise<AiCompletionResponse>;
}

export type LegiitMethod = keyof LegiitClient;

/** Which capability each method needs. UI for a method is shown only when its capability is available. */
export const METHOD_CAPABILITY: Readonly<Record<LegiitMethod, Capability | null>> = {
  getSession: null,
  listBusinesses: 'businesses',
  getBusinessDetails: 'businesses',
  saveVisibilitySnapshot: 'visibilitySnapshots',
  saveGapList: 'gapLists',
  addCompetitor: 'competitors',
  sendToContentEditor: 'contentEditor',
  createWorkspaceFromBrief: 'workspaces',
  getIndustryPulse: 'industryPulse',
  completeAI: 'ai',
};

export type LegiitErrorCode = 'unauthorised' | 'unavailable' | 'rejected' | 'server' | 'network' | 'invalid-response';

export class LegiitError extends Error {
  constructor(
    readonly code: LegiitErrorCode,
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'LegiitError';
  }
}

/** True when the error means "this endpoint does not exist (yet)", so its UI should be hidden. */
export function isUnavailable(error: unknown): boolean {
  return error instanceof LegiitError && error.code === 'unavailable';
}
