/** LegiitClient over HTTPS. Base URL and auth come from config; every request goes through the guarded network layer. */
import * as v from 'valibot';
import { errorMessage, timeoutSignal } from '@/lib/async';
import { cleanText, cutText } from '@/lib/sanitize';
import type { AuthProvider } from './auth';
import { LegiitError, type LegiitClient, type SaveOptions } from './client';
import { MAX_REQUEST_BYTES, TIMEOUT_MS } from './limits';
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

/*
 * Replies are read tolerantly, so the server can grow, and can have an odd row
 * in its data, without breaking an extension that is already installed:
 *   - unknown fields are ignored;
 *   - an optional field may be absent or null, and one of the wrong type is
 *     treated as absent;
 *   - text may arrive as a JSON number (some encoders turn "365" into 365);
 *   - text longer than its limit is cut, a list longer than its limit is cut;
 *   - an id may be a string or an integer (it is used as a string);
 *   - a list entry that cannot be read is skipped, the rest of the list is used.
 * What a reply cannot do without (the id of the user, the list of businesses,
 * the id of a saved item, the text of an AI reply) is required: a reply
 * without it is rejected as a whole ("invalid-response"). The contract in
 * docs/legiit-api is stricter than this on purpose.
 */
const text = (max: number) =>
  v.pipe(
    v.union([v.string(), v.pipe(v.number(), v.finite())]),
    v.transform((value) => cutText(String(value), max)),
  );
/** Text the extension can do without: absent, null or unreadable reads as null. */
const optionalText = (max: number) => v.fallback(v.nullish(text(max), null), null);
/** The same, read as an empty string. */
const looseText = (max: number) => v.fallback(v.nullish(text(max), ''), '');
/** An id is never cut: one that is too long, empty or not a whole number is refused. */
const id = (max: number) =>
  v.pipe(
    v.union([v.string(), v.pipe(v.number(), v.safeInteger())]),
    v.transform((value) => String(value).trim()),
    v.minLength(1),
    v.maxLength(max),
  );
/** A list in which an entry that cannot be read is skipped, so one bad row never costs the user the whole list. */
const list = <TItem extends v.GenericSchema>(item: TItem, max: number) =>
  v.pipe(
    v.array(v.unknown()),
    v.transform((entries) => {
      const kept: v.InferOutput<TItem>[] = [];
      for (const entry of entries) {
        if (kept.length >= max) break;
        const parsed = v.safeParse(item, entry);
        if (parsed.success) kept.push(parsed.output);
      }
      return kept;
    }),
  );
const optionalList = <TItem extends v.GenericSchema>(item: TItem, max: number) => v.fallback(v.nullish(list(item, max), []), []);
/** A list of text. A single text is read as a list of one. */
const textList = (maxLength: number, maxItems: number) =>
  v.fallback(
    v.nullish(
      v.pipe(
        v.union([v.array(v.unknown()), v.string()]),
        v.transform((value) => (typeof value === 'string' ? [value] : value)),
        list(text(maxLength), maxItems),
      ),
      [],
    ),
    [],
  );

const SessionSchema = v.object({
  user: v.object({ id: id(120), name: looseText(200), email: optionalText(320) }),
  plan: optionalText(80),
  /** Names this version does not know are ignored, so new capabilities can be added on the server at any time. */
  capabilities: v.nullish(
    v.pipe(
      v.array(v.unknown()),
      v.transform((names) => ALL_CAPABILITIES.filter((capability) => names.includes(capability))),
    ),
    [],
  ),
});
const BusinessSchema = v.object({ id: id(120), name: looseText(200), domain: optionalText(255) });
const BusinessListSchema = v.object({ businesses: list(BusinessSchema, 500) });
const BusinessDetailsSchema = v.object({
  /** The extension keeps the id it asked for; the one in the reply is not needed. */
  id: v.fallback(id(120), ''),
  name: looseText(200),
  brandNames: textList(160, 30),
  domains: textList(255, 30),
  competitors: optionalList(v.object({ name: looseText(160), domains: textList(255, 30) }), 200),
  focusKeywords: textList(200, 200),
  avatars: optionalList(v.object({ name: text(160), description: looseText(2000) }), 20),
});
const SaveResultSchema = v.object({ id: id(200), url: optionalText(2048) });
const PulseSchema = v.object({
  updatedAt: optionalText(40),
  events: list(
    v.object({
      /** A calendar day. A full timestamp is accepted and cut to its day; anything that is not a real date drops the event. */
      date: v.pipe(
        v.string(),
        v.regex(/^\d{4}-\d{2}-\d{2}/),
        v.transform((value) => value.slice(0, 10)),
        v.check((day) => !Number.isNaN(Date.parse(`${day}T00:00:00Z`))),
      ),
      title: text(300),
      type: v.fallback(v.nullish(text(40), 'news'), 'news'),
      url: optionalText(2048),
    }),
    200,
  ),
});
const CompletionSchema = v.object({ text: text(20_000), model: optionalText(120) });

export interface HttpClientOptions {
  baseUrl: string;
  auth: AuthProvider;
  /** The network primitive: guardedFetch bound to the "legiit" purpose in production. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  clientVersion?: string;
  /** Overrides both time limits (tests). */
  timeoutMs?: number;
}

const TIMED_OUT = 'Legiit did not answer in time';

interface RequestOptions {
  body?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
}

/** The "error" object of a failed reply, when the server sent one in the agreed shape. */
async function readError(response: Response): Promise<{ code: string; message: string }> {
  try {
    const parsed = (await response.json()) as { error?: { code?: unknown; message?: unknown } } | null;
    const error = parsed?.error;
    return {
      code: typeof error?.code === 'string' ? error.code : '',
      // Shown to the user as plain text: one line, no control characters.
      message: typeof error?.message === 'string' ? cleanText(error.message, 200) : '',
    };
  } catch {
    return { code: '', message: '' };
  }
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
    options: RequestOptions = {},
  ): Promise<v.InferOutput<TSchema>> {
    const auth = await this.options.auth.headers();
    if (!auth) throw new LegiitError('unauthorised', 'Not connected to Legiit');

    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) {
      const bytes = new TextEncoder().encode(body).length;
      if (bytes > MAX_REQUEST_BYTES) {
        throw new LegiitError('rejected', `This is too large to send to Legiit (${Math.ceil(bytes / 1024).toLocaleString('en-US')} KB; the limit is ${MAX_REQUEST_BYTES / 1024} KB). Nothing was sent.`);
      }
    }

    const timer = timeoutSignal(this.options.timeoutMs ?? options.timeoutMs ?? TIMEOUT_MS.default);
    try {
      let response: Response;
      try {
        response = await this.options.fetch(`${this.base}${path}`, {
          method,
          signal: timer.signal,
          // Never answered from the browser's cache: a session or a business is always read fresh.
          cache: 'no-store',
          headers: {
            ...auth,
            Accept: 'application/json',
            'X-Legiit-Client': `legiit-lens/${this.options.clientVersion ?? '0'}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
          },
          ...(body !== undefined ? { body } : {}),
        });
      } catch (error) {
        throw new LegiitError('network', timer.signal.aborted ? TIMED_OUT : `Could not reach Legiit: ${errorMessage(error)}`);
      }

      const { status } = response;
      if (status === 401) throw new LegiitError('unauthorised', 'Legiit did not accept the token', status);
      if (status === 404) {
        // "The thing you named does not exist" (a deleted business) is told apart from "this endpoint does not exist".
        const error = await readError(response);
        if (error.code === 'not_found') throw new LegiitError('rejected', `Legiit could not find it (404)${error.message ? `: ${error.message}` : ''}`, status);
        throw new LegiitError('unavailable', 'This Legiit feature is not available', status);
      }
      if (status === 405 || status === 501) throw new LegiitError('unavailable', 'This Legiit feature is not available', status);
      if (status >= 500) throw new LegiitError('server', `Legiit had a problem (${status})`, status);
      if (!response.ok) {
        const error = await readError(response);
        throw new LegiitError('rejected', `Legiit rejected the request (${status})${error.message ? `: ${error.message}` : ''}`, status);
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        if (timer.signal.aborted) throw new LegiitError('network', TIMED_OUT);
        throw new LegiitError('invalid-response', 'Legiit sent a reply that could not be read', status);
      }
      const parsed = v.safeParse(schema, json);
      if (!parsed.success) throw new LegiitError('invalid-response', 'Legiit sent a reply in an unexpected shape', status);
      return parsed.output;
    } finally {
      timer.clear();
    }
  }

  private save(path: string, payload: unknown, options?: SaveOptions): Promise<SaveResult> {
    return this.request('POST', path, SaveResultSchema, { body: payload, idempotencyKey: options?.idempotencyKey });
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

  saveVisibilitySnapshot(businessId: string, payload: VisibilitySnapshotPayload, options?: SaveOptions): Promise<SaveResult> {
    return this.save(`/v1/businesses/${encodeURIComponent(businessId)}/visibility-snapshots`, payload, options);
  }

  saveGapList(businessId: string, payload: GapListPayload, options?: SaveOptions): Promise<SaveResult> {
    return this.save(`/v1/businesses/${encodeURIComponent(businessId)}/gap-lists`, payload, options);
  }

  addCompetitor(businessId: string, payload: CompetitorPayload, options?: SaveOptions): Promise<SaveResult> {
    return this.save(`/v1/businesses/${encodeURIComponent(businessId)}/competitors`, payload, options);
  }

  sendToContentEditor(businessId: string, payload: ContentEditorPayload, options?: SaveOptions): Promise<SaveResult> {
    return this.save(`/v1/businesses/${encodeURIComponent(businessId)}/content-editor/documents`, payload, options);
  }

  createWorkspaceFromBrief(payload: WorkspaceFromBriefPayload, options?: SaveOptions): Promise<SaveResult> {
    return this.save('/v1/workspaces/from-brief', payload, options);
  }

  getIndustryPulse(): Promise<IndustryPulse> {
    return this.request('GET', '/v1/industry-pulse', PulseSchema);
  }

  completeAI(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    return this.request('POST', '/v1/ai/completions', CompletionSchema, { body: request, timeoutMs: TIMEOUT_MS.ai });
  }
}
