/** LegiitClient over HTTPS. Base URL and auth come from config; every request goes through the guarded network layer. */
import * as v from 'valibot';
import { errorMessage, timeoutSignal } from '@/lib/async';
import type { AuthProvider } from './auth';
import { LegiitError, type LegiitClient } from './client';
import { ALL_CAPABILITIES } from './types';
import type {
  AiCompletionRequest,
  AiCompletionResponse,
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

const text = (max: number) => v.pipe(v.string(), v.maxLength(max));

/** Responses are validated: the server is trusted, but a malformed reply must not break the UI. */
const SessionSchema = v.object({
  user: v.object({ id: text(120), name: text(200), email: v.optional(v.nullable(text(320)), null) }),
  plan: v.optional(v.nullable(text(80)), null),
  capabilities: v.optional(v.array(v.picklist(ALL_CAPABILITIES)), []),
});
const BusinessSchema = v.object({ id: text(120), name: text(200), domain: v.optional(v.nullable(text(255)), null) });
const BusinessListSchema = v.object({ businesses: v.pipe(v.array(BusinessSchema), v.maxLength(500)) });
const BusinessDetailsSchema = v.object({
  id: text(120),
  name: text(200),
  brandNames: v.optional(v.pipe(v.array(text(160)), v.maxLength(30)), []),
  domains: v.optional(v.pipe(v.array(text(255)), v.maxLength(30)), []),
  competitors: v.optional(
    v.pipe(v.array(v.object({ name: text(160), domains: v.optional(v.pipe(v.array(text(255)), v.maxLength(30)), []) })), v.maxLength(200)),
    [],
  ),
  focusKeywords: v.optional(v.pipe(v.array(text(200)), v.maxLength(200)), []),
  avatars: v.optional(v.pipe(v.array(v.object({ name: text(160), description: text(2000) })), v.maxLength(20)), []),
});
const SaveResultSchema = v.object({ id: text(200), url: v.optional(v.nullable(text(2048)), null) });
const PulseSchema = v.object({
  updatedAt: text(40),
  events: v.pipe(
    v.array(
      v.object({
        date: text(40),
        title: text(300),
        type: v.picklist(['algorithm-update', 'serp-feature', 'news']),
        url: v.optional(v.nullable(text(2048)), null),
      }),
    ),
    v.maxLength(200),
  ),
});
const CompletionSchema = v.object({ text: text(20_000), model: v.optional(v.nullable(text(120)), null) });

export interface HttpClientOptions {
  baseUrl: string;
  auth: AuthProvider;
  /** The network primitive: guardedFetch bound to the "legiit" purpose in production. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  clientVersion?: string;
  timeoutMs?: number;
}

export class HttpLegiitClient implements LegiitClient {
  private readonly base: string;

  constructor(private readonly options: HttpClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
  }

  private async request<TSchema extends v.GenericSchema>(
    method: 'GET' | 'POST',
    path: string,
    schema: TSchema,
    body?: unknown,
  ): Promise<v.InferOutput<TSchema>> {
    const auth = await this.options.auth.headers();
    if (!auth) throw new LegiitError('unauthorised', 'Not connected to Legiit');
    const timer = timeoutSignal(this.options.timeoutMs ?? 20_000);
    let response: Response;
    try {
      response = await this.options.fetch(`${this.base}${path}`, {
        method,
        signal: timer.signal,
        headers: {
          ...auth,
          Accept: 'application/json',
          'X-Legiit-Client': `legiit-lens/${this.options.clientVersion ?? '0'}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new LegiitError('network', `Could not reach Legiit: ${errorMessage(error)}`);
    } finally {
      timer.clear();
    }

    if (response.status === 401 || response.status === 403) {
      throw new LegiitError('unauthorised', 'Legiit did not accept the token', response.status);
    }
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      throw new LegiitError('unavailable', 'This Legiit feature is not available', response.status);
    }
    if (response.status >= 500) throw new LegiitError('server', `Legiit had a problem (${response.status})`, response.status);
    if (!response.ok) {
      let detail = '';
      try {
        const parsed = (await response.json()) as { error?: { message?: unknown } };
        if (typeof parsed.error?.message === 'string') detail = `: ${parsed.error.message.slice(0, 200)}`;
      } catch {
        detail = '';
      }
      throw new LegiitError('rejected', `Legiit rejected the request (${response.status})${detail}`, response.status);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new LegiitError('invalid-response', 'Legiit sent a reply that could not be read', response.status);
    }
    const parsed = v.safeParse(schema, json);
    if (!parsed.success) throw new LegiitError('invalid-response', 'Legiit sent a reply in an unexpected shape', response.status);
    return parsed.output;
  }

  getSession(): Promise<LegiitSession> {
    return this.request('GET', '/v1/session', SessionSchema);
  }

  async listBusinesses(): Promise<LegiitBusiness[]> {
    return (await this.request('GET', '/v1/businesses', BusinessListSchema)).businesses;
  }

  getBusinessDetails(businessId: string): Promise<LegiitBusinessDetails> {
    return this.request('GET', `/v1/businesses/${encodeURIComponent(businessId)}`, BusinessDetailsSchema);
  }

  saveVisibilitySnapshot(businessId: string, payload: VisibilitySnapshotPayload): Promise<SaveResult> {
    return this.request('POST', `/v1/businesses/${encodeURIComponent(businessId)}/visibility-snapshots`, SaveResultSchema, payload);
  }

  saveGapList(businessId: string, payload: GapListPayload): Promise<SaveResult> {
    return this.request('POST', `/v1/businesses/${encodeURIComponent(businessId)}/gap-lists`, SaveResultSchema, payload);
  }

  addCompetitor(businessId: string, payload: CompetitorPayload): Promise<SaveResult> {
    return this.request('POST', `/v1/businesses/${encodeURIComponent(businessId)}/competitors`, SaveResultSchema, payload);
  }

  sendToContentEditor(businessId: string, payload: ContentEditorPayload): Promise<SaveResult> {
    return this.request('POST', `/v1/businesses/${encodeURIComponent(businessId)}/content-editor/documents`, SaveResultSchema, payload);
  }

  createWorkspaceFromBrief(payload: WorkspaceFromBriefPayload): Promise<SaveResult> {
    return this.request('POST', '/v1/workspaces/from-brief', SaveResultSchema, payload);
  }

  getIndustryPulse(): Promise<IndustryPulse> {
    return this.request('GET', '/v1/industry-pulse', PulseSchema);
  }

  completeAI(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    return this.request('POST', '/v1/ai/completions', CompletionSchema, request);
  }
}
