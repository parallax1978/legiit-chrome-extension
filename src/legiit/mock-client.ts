/**
 * In-memory LegiitClient backed by the fixtures in /fixtures/legiit.
 *
 * A stand-in for unit tests: it answers every method of the interface, checks
 * capabilities and knows the two businesses of the fixtures. It does not
 * validate what is saved and has no idempotency; the reference for the
 * server's behaviour is mock-server/handlers.mjs. It is not imported by
 * production code, so it is not part of the package.
 */
import businesses from '@@/fixtures/legiit/businesses.json';
import details from '@@/fixtures/legiit/business-details.json';
import pulse from '@@/fixtures/legiit/industry-pulse.json';
import session from '@@/fixtures/legiit/session.json';
import { LegiitError, METHOD_CAPABILITY, type LegiitClient, type LegiitMethod, type SaveOptions } from './client';
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
    if (businessId !== null) this.business(businessId);
    const id = `${kind}_${this.nextId++}`;
    this.saved.push({ kind, businessId, payload });
    return { id, url: `https://app.legiit.example/command-center/${kind}/${id}` };
  }

  /** The business with this id, or the error the HTTP client reports for a business that does not exist. */
  private business(businessId: string): LegiitBusinessDetails {
    const all = details as Record<string, LegiitBusinessDetails>;
    if (!Object.hasOwn(all, businessId)) throw new LegiitError('rejected', 'Legiit could not find it (404): No such business', 404);
    return all[businessId]!;
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
    return this.business(businessId);
  }

  async saveVisibilitySnapshot(businessId: string, payload: VisibilitySnapshotPayload, _options?: SaveOptions): Promise<SaveResult> {
    this.enter('saveVisibilitySnapshot', businessId, payload);
    return this.save('visibility', businessId, payload);
  }

  async saveGapList(businessId: string, payload: GapListPayload, _options?: SaveOptions): Promise<SaveResult> {
    this.enter('saveGapList', businessId, payload);
    return this.save('gaps', businessId, payload);
  }

  async addCompetitor(businessId: string, payload: CompetitorPayload, _options?: SaveOptions): Promise<SaveResult> {
    this.enter('addCompetitor', businessId, payload);
    return this.save('competitors', businessId, payload);
  }

  async sendToContentEditor(businessId: string, payload: ContentEditorPayload, _options?: SaveOptions): Promise<SaveResult> {
    this.enter('sendToContentEditor', businessId, payload);
    return this.save('content', businessId, payload);
  }

  async createWorkspaceFromBrief(payload: WorkspaceFromBriefPayload, _options?: SaveOptions): Promise<SaveResult> {
    this.enter('createWorkspaceFromBrief', payload);
    return this.save('workspaces', null, payload);
  }

  async getIndustryPulse(): Promise<IndustryPulse> {
    this.enter('getIndustryPulse');
    return pulse as IndustryPulse;
  }

  async completeAI(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    this.enter('completeAI', request);
    const facts = request.prompt
      .split('\n')
      .filter((l) => l.trim().startsWith('-'))
      .map((l) => l.replace(/^\s*-\s*/, ''));
    if (request.responseSchema) {
      // The same document the mock server answers a brief request with.
      const avatars = [1, 2, 3].map((n) => ({ name: `Mock avatar ${n}`, who: `A customer described by the mock model (${n}).`, wants: 'Clear prices and fast answers.', worries: 'Wasting time.', searches: ['example search'], proof: 'The site shows reviews.' }));
      return { text: JSON.stringify({ avatars, nextSteps: ['Mock step one from Legiit AI.', 'Mock step two from Legiit AI.'] }), model: 'legiit-mock-1' };
    }
    return { text: (facts.length > 0 ? facts.slice(0, 3) : ['No facts given.']).map((fact) => `- ${fact}`).join('\n'), model: 'legiit-mock-1' };
  }
}
