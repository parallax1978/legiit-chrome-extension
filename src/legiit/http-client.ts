/** LegiitClient over HTTPS. Base URL and auth come from config; every request goes through the guarded network layer. */
import * as v from 'valibot';
import { errorMessage, timeoutSignal } from '@/lib/async';
import { cleanText, cutText, safeHttpUrl } from '@/lib/sanitize';
import type { AuthProvider } from './auth';
import { LegiitError, type LegiitClient, type SaveOptions } from './client';
import { MAX_REPLY_BYTES, MAX_REQUEST_BYTES, TIMEOUT_MS } from './limits';
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
/**
 * An id goes into the path of later requests. "." and ".." would change that path, and text that is not
 * well-formed Unicode cannot be written into one at all.
 */
const pathSafe = (value: string): boolean => value !== '' && value !== '.' && value !== '..' && value.isWellFormed();
/** An id is never cut: one that is too long, empty, not a whole number or unusable in a path is refused. */
const id = (max: number) =>
  v.pipe(
    v.union([v.string(), v.pipe(v.number(), v.safeInteger())]),
    v.transform((value) => String(value).trim()),
    v.minLength(1),
    v.maxLength(max),
    v.check(pathSafe),
  );
/**
 * The entries of a list. Some JSON encoders write a list whose keys are not 0, 1, 2… (a filtered PHP array) as
 * an object; its values are read as the entries.
 */
const entries = v.pipe(
  v.union([v.array(v.unknown()), v.record(v.string(), v.unknown())]),
  v.transform((value): unknown[] => (Array.isArray(value) ? value : Object.values(value))),
);
/** A list in which an entry that cannot be read is skipped, so one bad row never costs the user the whole list. */
const list = <TItem extends v.GenericSchema>(item: TItem, max: number) =>
  v.pipe(
    entries,
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
/** A list of text. A single text is read as a list of one; an entry that is not text is skipped. */
const textList = (maxLength: number, maxItems: number) =>
  v.fallback(
    v.nullish(
      v.pipe(
        v.union([v.string(), v.array(v.unknown()), v.record(v.string(), v.unknown())]),
        v.transform((value): string[] => {
          const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : Object.values(value);
          const kept: string[] = [];
          for (const entry of raw) {
            if (kept.length >= maxItems) break;
            if (typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry))) kept.push(cutText(String(entry), maxLength));
          }
          return kept;
        }),
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
      entries,
      v.transform((names) => ALL_CAPABILITIES.filter((capability) => names.includes(capability))),
    ),
    [],
  ),
});
const BusinessSchema = v.object({ id: id(120), name: looseText(200), domain: optionalText(255) });
const BusinessListSchema = v.object({ businesses: list(BusinessSchema, 500) });
const DETAILS_KEYS = ['name', 'brandNames', 'domains', 'competitors'] as const;
const BusinessDetailsSchema = v.pipe(
  // Every field below can be missing, so a reply that is something else entirely (an empty object, a wrapper, an
  // error sent with status 200) would read as "a business with nothing in it" and wipe the brands pre-filled
  // before. It has to look like a business: at least one of its main keys must be there.
  v.custom<Record<string, unknown>>((value) => typeof value === 'object' && value !== null && !Array.isArray(value) && DETAILS_KEYS.some((key) => key in value)),
  v.object({
    /** The extension keeps the id it asked for; the one in the reply is not needed. */
    id: v.fallback(id(120), ''),
    name: looseText(200),
    brandNames: textList(160, 30),
    domains: textList(255, 30),
    competitors: optionalList(v.object({ name: looseText(160), domains: textList(255, 30) }), 200),
    focusKeywords: textList(200, 200),
    avatars: optionalList(v.object({ name: text(160), description: looseText(2000) }), 20),
  }),
);
/**
 * A link that cannot be opened is no link: one that is too long to be whole, a relative path, a host without a
 * scheme, another scheme. It reads as absent, so the user sees "Saved" and not a label that looks like a link.
 */
const SaveResultSchema = v.object({
  id: id(200),
  url: v.fallback(
    v.nullish(
      v.pipe(
        v.string(),
        v.maxLength(2048),
        v.check((value) => safeHttpUrl(value) !== null),
      ),
      null,
    ),
    null,
  ),
});
const PulseSchema = v.object({
  updatedAt: optionalText(40),
  events: list(
    v.object({
      /** A calendar day. A full timestamp is accepted and cut to its day; anything that is not a real date drops the event. */
      date: v.pipe(
        v.string(),
        v.regex(/^\d{4}-\d{2}-\d{2}/),
        v.transform((value) => value.slice(0, 10)),
        // 2026-02-30 parses in some engines (as 2 March): the day must survive a round trip.
        v.check((day) => {
          const time = Date.parse(`${day}T00:00:00Z`);
          return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === day;
        }),
      ),
      title: text(300),
      type: v.fallback(v.nullish(text(40), 'news'), 'news'),
      url: optionalText(2048),
    }),
    200,
  ),
});
const CompletionSchema = v.object({ text: text(20_000), model: optionalText(120) });
/**
 * When a JSON document was asked for, the text is that document as a string. A server that returns the document
 * itself (the structured output of a model, not turned into a string) is understood all the same.
 */
const JsonCompletionSchema = v.object({
  text: v.union([
    text(20_000),
    v.pipe(
      v.record(v.string(), v.unknown()),
      v.transform((value) => cutText(JSON.stringify(value), 20_000)),
    ),
  ]),
  model: optionalText(120),
});

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

const TOO_LARGE = 'Legiit sent a reply that is too large to read';

interface RequestOptions {
  body?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
  /** The path names a business: only there does a 404 with the code "not_found" mean "this business is gone". */
  businessScoped?: boolean;
}

/** The body of a reply as text. A reply beyond the size limit is not read. */
async function readText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length') ?? '0') > MAX_REPLY_BYTES) throw new LegiitError('invalid-response', TOO_LARGE, response.status);
  const raw = await response.text();
  // Without a Content-Length the size is only known now. One UTF-16 unit is at most 3 bytes, so short text needs no count.
  if (raw.length * 3 > MAX_REPLY_BYTES && new TextEncoder().encode(raw).length > MAX_REPLY_BYTES) throw new LegiitError('invalid-response', TOO_LARGE, response.status);
  return raw;
}

const NOT_AGREED = { agreed: false, code: '', message: '' } as const;

/**
 * The "error" object of a failed reply. `agreed` says whether the body had the agreed shape at all.
 * A body that stops half-way (the time limit, a dropped connection) is no verdict of the server: that is
 * thrown as a network failure, so a 404 cut short is never taken for "this endpoint does not exist".
 */
async function readError(response: Response, signal: AbortSignal): Promise<{ agreed: boolean; code: string; message: string }> {
  let raw: string;
  try {
    raw = await readText(response);
  } catch (error) {
    if (signal.aborted) throw new LegiitError('network', TIMED_OUT);
    // Too large to be the agreed error body, but a complete reply.
    if (error instanceof LegiitError) return NOT_AGREED;
    throw new LegiitError('network', `Could not reach Legiit: ${errorMessage(error)}`);
  }
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } } | null;
    const error = parsed?.error;
    return {
      // The agreed body has a text code. Other envelopes that happen to use the key "error" (a gateway's
      // {"error":{"code":401,…}}, an empty object, a list) are not the API's own verdict.
      agreed: typeof error === 'object' && error !== null && !Array.isArray(error) && typeof error.code === 'string',
      code: typeof error?.code === 'string' ? error.code : '',
      // Shown to the user as plain text: one line, no control characters.
      message: typeof error?.message === 'string' ? cleanText(error.message, 200) : '',
    };
  } catch {
    return NOT_AGREED;
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
      if (status === 401) {
        // Only a 401 that carries the agreed error body is taken as the API's own verdict on the token.
        const error = await readError(response, timer.signal);
        throw new LegiitError('unauthorised', 'Legiit did not accept the token', status, error.agreed);
      }
      if (status === 404) {
        // "The business you named does not exist" is told apart from "this endpoint does not exist".
        const error = await readError(response, timer.signal);
        if (options.businessScoped && error.code === 'not_found') {
          throw new LegiitError('rejected', `Legiit could not find it (404)${error.message ? `: ${error.message}` : ''}`, status);
        }
        throw new LegiitError('unavailable', 'This Legiit feature is not available', status);
      }
      if (status === 405 || status === 501) throw new LegiitError('unavailable', 'This Legiit feature is not available', status);
      if (status >= 500) throw new LegiitError('server', `Legiit had a problem (${status})`, status);
      if (!response.ok) {
        const error = await readError(response, timer.signal);
        throw new LegiitError('rejected', `Legiit rejected the request (${status})${error.message ? `: ${error.message}` : ''}`, status);
      }

      let json: unknown;
      try {
        json = JSON.parse(await readText(response));
      } catch (error) {
        if (timer.signal.aborted) throw new LegiitError('network', TIMED_OUT);
        if (error instanceof LegiitError) throw error;
        throw new LegiitError('invalid-response', 'Legiit sent a reply that could not be read', status);
      }
      const parsed = v.safeParse(schema, json);
      if (!parsed.success) throw new LegiitError('invalid-response', 'Legiit sent a reply in an unexpected shape', status);
      return parsed.output;
    } finally {
      timer.clear();
    }
  }

  private save(path: string, payload: unknown, options: SaveOptions | undefined, businessScoped: boolean): Promise<SaveResult> {
    return this.request('POST', path, SaveResultSchema, { body: payload, idempotencyKey: options?.idempotencyKey, businessScoped });
  }

  getSession(): Promise<LegiitSession> {
    return this.request('GET', '/v1/session', SessionSchema);
  }

  async listBusinesses(): Promise<LegiitBusiness[]> {
    return (await this.request('GET', '/v1/businesses', BusinessListSchema)).businesses;
  }

  /**
   * The path of a business, or of something under it. An id that cannot be written into a path names no
   * business: nothing is sent. The callers are async, so this is a rejected promise like every other failure.
   */
  private business(businessId: string, rest = ''): string {
    if (!pathSafe(businessId)) throw new LegiitError('rejected', 'Choose a business under Settings → Legiit account first. Nothing was sent.');
    return `/v1/businesses/${encodeURIComponent(businessId)}${rest}`;
  }

  async getBusinessDetails(businessId: string): Promise<LegiitBusinessDetails> {
    return this.request('GET', this.business(businessId), BusinessDetailsSchema, { businessScoped: true });
  }

  async saveVisibilitySnapshot(businessId: string, payload: VisibilitySnapshotPayload, options?: SaveOptions): Promise<SaveResult> {
    return this.save(this.business(businessId, '/visibility-snapshots'), payload, options, true);
  }

  async saveGapList(businessId: string, payload: GapListPayload, options?: SaveOptions): Promise<SaveResult> {
    return this.save(this.business(businessId, '/gap-lists'), payload, options, true);
  }

  async addCompetitor(businessId: string, payload: CompetitorPayload, options?: SaveOptions): Promise<SaveResult> {
    return this.save(this.business(businessId, '/competitors'), payload, options, true);
  }

  async sendToContentEditor(businessId: string, payload: ContentEditorPayload, options?: SaveOptions): Promise<SaveResult> {
    return this.save(this.business(businessId, '/content-editor/documents'), payload, options, true);
  }

  createWorkspaceFromBrief(payload: WorkspaceFromBriefPayload, options?: SaveOptions): Promise<SaveResult> {
    return this.save('/v1/workspaces/from-brief', payload, options, false);
  }

  getIndustryPulse(): Promise<IndustryPulse> {
    return this.request('GET', '/v1/industry-pulse', PulseSchema);
  }

  completeAI(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    return this.request('POST', '/v1/ai/completions', request.responseSchema ? JsonCompletionSchema : CompletionSchema, { body: request, timeoutMs: TIMEOUT_MS.ai });
  }
}
