/**
 * In-memory LegiitClient backed by the fixtures in /fixtures/legiit.
 * Used by unit tests and as a reference implementation of the interface.
 * It is not imported by production code, so it is not part of the package.
 */
import businesses from '@@/fixtures/legiit/businesses.json';
import details from '@@/fixtures/legiit/business-details.json';
import pulse from '@@/fixtures/legiit/industry-pulse.json';
import session from '@@/fixtures/legiit/session.json';
import { LegiitError, METHOD_CAPABILITY, type LegiitClient, type LegiitMethod } from './client';
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

export interface MockOptions {
  /** Capabilities this fake account has. Defaults to all of them. */
  capabilities?: Capability[];
  /** Simulate a rejected token. */
  unauthorised?: boolean;
}

export class MockLegiitClient implements LegiitClient {
  readonly calls: { method: LegiitMethod; args: unknown[] }[] = [];
  readonly saved: { kind: string; businessId: string | null; payload: unknown }[] = [];
  private nextId = 1;
  private readonly capabilities: Capability[];

  constructor(private readonly options: MockOptions = {}) {
    this.capabilities = options.capabilities ?? (session.capabilities as Capability[]);
  }

  private enter(method: LegiitMethod, ...args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.options.unauthorised) throw new LegiitError('unauthorised', 'Legiit did not accept the token', 401);
    const needed = METHOD_CAPABILITY[method];
    if (needed && !this.capabilities.includes(needed)) throw new LegiitError('unavailable', 'This Legiit feature is not available', 404);
  }

  private save(kind: string, businessId: string | null, payload: unknown): SaveResult {
    const id = `${kind}_${this.nextId++}`;
    this.saved.push({ kind, businessId, payload });
    return { id, url: `https://app.legiit.example/command-center/${kind}/${id}` };
  }

  async getSession(): Promise<LegiitSession> {
    this.enter('getSession');
    return { ...(session as LegiitSession), capabilities: this.capabilities };
  }

  async listBusinesses(): Promise<LegiitBusiness[]> {
    this.enter('listBusinesses');
    return businesses.businesses;
  }

  async getBusinessDetails(businessId: string): Promise<LegiitBusinessDetails> {
    this.enter('getBusinessDetails', businessId);
    const found = (details as Record<string, LegiitBusinessDetails>)[businessId];
    if (!found) throw new LegiitError('rejected', 'Legiit rejected the request (404): No such business', 404);
    return found;
  }

  async saveVisibilitySnapshot(businessId: string, payload: VisibilitySnapshotPayload): Promise<SaveResult> {
    this.enter('saveVisibilitySnapshot', businessId, payload);
    return this.save('visibility', businessId, payload);
  }

  async saveGapList(businessId: string, payload: GapListPayload): Promise<SaveResult> {
    this.enter('saveGapList', businessId, payload);
    return this.save('gaps', businessId, payload);
  }

  async addCompetitor(businessId: string, payload: CompetitorPayload): Promise<SaveResult> {
    this.enter('addCompetitor', businessId, payload);
    return this.save('competitors', businessId, payload);
  }

  async sendToContentEditor(businessId: string, payload: ContentEditorPayload): Promise<SaveResult> {
    this.enter('sendToContentEditor', businessId, payload);
    return this.save('content', businessId, payload);
  }

  async createWorkspaceFromBrief(payload: WorkspaceFromBriefPayload): Promise<SaveResult> {
    this.enter('createWorkspaceFromBrief', payload);
    return this.save('workspaces', null, payload);
  }

  async getIndustryPulse(): Promise<IndustryPulse> {
    this.enter('getIndustryPulse');
    return pulse as IndustryPulse;
  }

  async completeAI(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    this.enter('completeAI', request);
    return { text: `Summary from Legiit AI (mock):\n- ${request.prompt.split('\n').find((l) => l.trim().startsWith('-'))?.replace(/^-\s*/, '') ?? 'No facts given.'}`, model: 'legiit-mock-1' };
  }
}
