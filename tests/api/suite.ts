/**
 * Conformance check for the Legiit Command Center API.
 *
 * It talks to a running API over HTTP with the same client code the extension
 * ships (src/legiit/http-client.ts), sends the example requests from
 * docs/legiit-api/examples (real payloads built by the extension), and checks
 * every reply twice: against the OpenAPI contract and against what the
 * extension accepts.
 *
 * A failed check means the reply breaks the contract or a rule of the guide
 * (docs/legiit-api/README.md); most failures would show an error to a user of
 * the extension. A warning in the summary is a recommendation.
 *
 * The checks are plain functions. They can run in two ways:
 *   - defineConformanceSuite()  registers every check as a vitest test. Used by
 *       tests/api/conformance.test.ts             (the backend team, against their API: npm run api:check)
 *       tests/unit/legiit-api-conformance.test.ts  (against the bundled mock server)
 *   - runConformance()          runs every check and returns the results. Used by
 *       tests/unit/legiit-api-suite-variants-*.test.ts, which run the check against deliberately wrong servers
 *       (tests/api/wrong-servers.ts) and so prove that each check fails when it should, and only then.
 *
 * The check never prints the token: not in a message, not in the summary.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseBriefRewrite } from '@/ai/brief-rewrite';
import { toLines } from '@/ai/provider';
import { StaticAuthProvider } from '@/legiit/auth';
import { LegiitError } from '@/legiit/client';
import { HttpLegiitClient } from '@/legiit/http-client';
import { MAX_REQUEST_BYTES, TIMEOUT_MS } from '@/legiit/limits';
import { ALL_CAPABILITIES, type Capability, type LegiitSession } from '@/legiit/types';

export const KIT_DIR = resolve(__dirname, '../../docs/legiit-api');
export const EXAMPLES_DIR = resolve(KIT_DIR, 'examples');

export interface ConformanceOptions {
  /** Base URL of the API under test, for example https://staging-api.legiit.com (a path prefix is allowed). */
  baseUrl: () => string;
  /** A valid API token of a test account. */
  token: () => string;
  /** The business to save into. Default: the first business the API lists. */
  businessId?: () => string | undefined;
  /** The id of a business that belongs to ANOTHER user. When given, the check proves that this token cannot reach it. */
  otherBusinessId?: () => string | undefined;
  /** false = read-only run: no save is sent, so nothing is created in the account. */
  writes: boolean;
  /**
   * Time limits in milliseconds. The defaults are the limits of the extension (20 seconds, 60 seconds for the AI
   * endpoint) and 5 seconds for "slow". Only the self-tests of the check change them.
   */
  limits?: { requestMs?: number; aiMs?: number; slowMs?: number };
  /** Called once at the end with the results (used by the self-test of the check). Without it the summary is printed. */
  onFinish?: (result: ConformanceResult) => void;
}

/** How one check ended. */
export interface CheckResult {
  /** "A1", "C14"… */
  id: string;
  title: string;
  outcome: 'passed' | 'failed' | 'skipped';
  /** Why the check failed or was skipped. Empty when it passed. */
  message: string;
  ms: number;
}

/** One item that a save stored in the account. */
export interface CreatedItem {
  /** "visibility snapshot", "gap list", "competitor", "content analysis" or "workspace". */
  kind: string;
  /** null when the reply did not give the id. */
  id: string | null;
  /** Set when the item must not exist: it was stored although the server had to refuse the request. */
  note: string | null;
}

export interface ConformanceResult {
  /** One entry for each check that ran, in the order of the checks. */
  checks: CheckResult[];
  /** Recommendations. Each one starts with the id of its check ("A8: …") or with "Speed:". */
  warnings: string[];
  /** Every request that was sent, as "GET /v1/session". */
  requests: string[];
  /** Every item that the run stored, each one once. */
  created: CreatedItem[];
  /** The text that is printed at the end of a run. */
  summary: string;
}

interface RawReply {
  status: number;
  contentType: string;
  cacheControl: string;
  allowOrigin: string;
  location: string;
  text: string;
  json: unknown;
  ms: number;
}

interface RawInit {
  /** null = no Authorization header. Default: the token of the run. */
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
  /** Headers that differ from what the extension sends: a text sets the header, null removes it. */
  headers?: Record<string, string | null>;
  /** What the summary says about the item when this request stores one although the server had to refuse it. */
  wrongIfStored?: string;
  /** What to say when the connection ends without a reply, in place of "check the base URL". */
  ifNoReply?: string;
}

/** A reply slower than this is reported as a warning: the user is looking at a spinner. */
const SLOW_MS = 5_000;

/**
 * Chrome adds this header to every POST of the extension (the 32 letters are the extension's id, which differs
 * per installation channel). The check sends it too, so that a server which filters by Origin is found out.
 */
export const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

/** Every test item the check creates carries this text where the body has a name, so it can be found and removed. */
export const TEST_DATA_PREFIX = 'Conformance Check';

/** A text that is no business id in any scheme of ids we know. */
export const NO_SUCH_BUSINESS = 'conformance-check-no-such-business';

type Schema = Record<string, unknown>;

export function loadContract(): Record<string, unknown> {
  return parseYaml(readFileSync(resolve(KIT_DIR, 'openapi.yaml'), 'utf8')) as Record<string, unknown>;
}

export function example<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(resolve(EXAMPLES_DIR, file), 'utf8')) as T;
}

/** Every example request of one operation: "saveGapList.request.json", "addCompetitor.name-only.request.json"… */
export function requestExamples(operationId: string): string[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((file) => file.startsWith(`${operationId}.`) && file.endsWith('.request.json'))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** Validators for the contract's schemas, by name ("Session", "SaveResult"…). */
export function contractValidators(contract: Record<string, unknown> = loadContract()): (name: string) => ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateSchema: false });
  addFormats(ajv);
  ajv.addSchema({ ...contract, $id: 'https://legiit.invalid/contract' });
  return (name: string) => {
    const found = ajv.getSchema(`https://legiit.invalid/contract#/components/schemas/${name}`);
    if (!found) throw new Error(`The contract has no schema called ${name}`);
    return found;
  };
}

/** One problem of a reply, in words: where it is and what the contract asks for. */
export function describeError(error: ErrorObject): string {
  const where = error.instancePath || '(body)';
  const params = error.params as { missingProperty?: string; format?: string; pattern?: string; type?: string | string[]; limit?: number; allowedValues?: unknown[]; allowedValue?: unknown };
  const must = (rule: string): string => `${where} must ${rule}`;
  switch (error.keyword) {
    case 'required':
      return `${where} has no key "${params.missingProperty ?? ''}", which is required`;
    case 'type':
      return must(`be ${[params.type ?? []].flat().join(' or ')}`);
    case 'format':
      if (params.format === 'date-time') return must('be a date and time with a time zone, for example 2026-11-18T09:00:00Z (RFC 3339)');
      if (params.format === 'date') return must('be a calendar day written as YYYY-MM-DD');
      break;
    case 'pattern':
      if (params.pattern === '^https?://') return must('be an absolute URL that starts with http:// or https://');
      if (params.pattern === '\\S') return must('have at least one character that is not white space');
      return must(`match the pattern ${params.pattern ?? ''}`);
    case 'minLength':
      return must(params.limit === 1 ? 'not be empty' : `have at least ${params.limit} characters`);
    case 'maxLength':
      return must(`have at most ${params.limit} characters`);
    case 'minItems':
      return must(`have at least ${params.limit} ${params.limit === 1 ? 'item' : 'items'}`);
    case 'maxItems':
      return must(`have at most ${params.limit} items`);
    case 'minimum':
      return must(`be at least ${params.limit}`);
    case 'maximum':
      return must(`be at most ${params.limit}`);
    case 'enum':
      return must(`be one of: ${(params.allowedValues ?? []).map(String).join(', ')}`);
    case 'const':
      return must(`be ${JSON.stringify(params.allowedValue)}`);
  }
  return `${where} ${error.message ?? 'is not valid'}`.trim();
}

function describeErrors(errors: readonly ErrorObject[]): string {
  const texts = [...new Set(errors.map(describeError))];
  return texts.length > 6 ? `${texts.slice(0, 6).join('; ')}; and ${texts.length - 6} more` : texts.join('; ');
}

/**
 * Keys of a reply that the contract does not know but that are a contract key
 * in another spelling ("brand_names" for "brandNames"). The extension ignores
 * unknown keys, so such a key is silently treated as absent: the data is
 * simply missing in the extension, with no error anywhere. A key in another
 * spelling next to the correct key is an extra field, which is allowed.
 */
export function misspeltKeys(contract: Record<string, unknown>, schemaName: string, body: unknown): string[] {
  const schemas = (contract['components'] as { schemas: Record<string, Schema> }).schemas;
  const resolveRef = (schema: Schema | undefined): Schema | undefined => {
    const ref = schema?.['$ref'];
    return typeof ref === 'string' ? { ...schemas[ref.split('/').at(-1)!], ...schema, $ref: undefined } : schema;
  };
  const plain = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');
  const found: string[] = [];
  const walk = (schemaNode: Schema | undefined, value: unknown, path: string): void => {
    const schema = resolveRef(schemaNode);
    if (!schema) return;
    if (Array.isArray(value)) {
      for (const [index, item] of value.slice(0, 20).entries()) walk(schema['items'] as Schema | undefined, item, `${path}[${index}]`);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
    const known = new Map(Object.keys(properties).map((name) => [plain(name), name]));
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) walk(properties[key], child, path ? `${path}.${key}` : key);
      else if (known.has(plain(key)) && !(known.get(plain(key))! in value)) found.push(`"${path ? `${path}.` : ''}${key}" is not read: the extension expects "${known.get(plain(key))}"`);
    }
  };
  walk(schemas[schemaName], body, '');
  return found;
}

const DIGITS = '0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** The letters of a ULID (Crockford base 32): no I, L, O, U. */
const CROCKFORD = 'ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * An id that no business of the account has, in the same form as a real id: a number stays a number with as
 * many digits, a UUID stays a UUID, "biz_brightpath" becomes "biz_" with ten other letters. What stays is the
 * part up to the last character that is not a letter or a digit; in an id without such a character, the first
 * third of a long id. Every other character is replaced by one of its kind (a digit by a digit, a hexadecimal
 * letter by one of a to f). The result is the same on every run. It is never one of `taken`.
 */
export function unknownIdLike(id: string | null, taken: ReadonlySet<string> = new Set()): string {
  if (id === null || !/[A-Za-z0-9]/.test(id)) return NO_SUCH_BUSINESS;
  const tailStart = id.length - (/[A-Za-z0-9]+$/.exec(id)?.[0].length ?? 0);
  // An id that ends with another character, or has none: the whole id is what changes.
  const structured = tailStart > 0 && tailStart < id.length;
  const keep = structured ? tailStart : id.length >= 12 ? Math.floor(id.length / 3) : 0;
  const prefix = id.slice(0, keep);
  const tail = id.slice(keep);
  const hex = /^[0-9a-fA-F-]+$/.test(id) && /[a-fA-F]/.test(id);
  const crockford = /^[0-9A-HJKMNP-TV-Z]+$/.test(tail);
  const number = /^\d+$/.test(id);
  const like = (char: string, random: number, first: boolean): string => {
    // A number does not start with 0.
    if (/\d/.test(char)) return number && first && keep === 0 ? DIGITS[1 + (random % 9)]! : DIGITS[random % 10]!;
    if (/[a-z]/.test(char)) return LOWER[random % (hex ? 6 : 26)]!;
    if (/[A-Z]/.test(char)) return hex ? UPPER[random % 6]! : crockford ? CROCKFORD[random % CROCKFORD.length]! : UPPER[random % 26]!;
    return char;
  };
  for (let attempt = 0; attempt < 60; attempt += 1) {
    // After 20 attempts of the same length (a very small space of ids), the id grows by one character at a time.
    const shape = tail + (tail.at(-1) ?? '0').repeat(Math.floor(attempt / 20));
    const bytes: number[] = [];
    for (let block = 0; bytes.length < shape.length; block += 1) bytes.push(...createHash('sha256').update(`${id}#${attempt}#${block}`).digest());
    const candidate = prefix + [...shape].map((char, index) => like(char, bytes[index]!, index === 0)).join('');
    if (candidate !== id && !taken.has(candidate)) return candidate;
  }
  return NO_SUCH_BUSINESS;
}

/** Between two problems that one check reports, and before the note that there are more. */
const NEXT_PROBLEM = '\n     ';
const MORE_PROBLEMS = '\n     … and ';

class CheckFailed extends Error {}
class CheckSkipped extends Error {}

function fail(message: string): never {
  throw new CheckFailed(message);
}
function skip(note: string): never {
  throw new CheckSkipped(note);
}

const short = (text: string, max = 300): string => (text.length > max ? `${text.slice(0, max)}…` : text);
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
const seconds = (ms: number): string => `${ms % 1000 === 0 ? ms / 1000 : Number((ms / 1000).toFixed(2))} ${ms === 1000 ? 'second' : 'seconds'}`;
const bytesOf = (body: unknown): number => new TextEncoder().encode(JSON.stringify(body)).length;
const kbOf = (body: unknown): string => `${Math.round(bytesOf(body) / 1024).toLocaleString('en-US')} KB`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface Check {
  id: string;
  title: string;
  run: () => Promise<void>;
}

interface Save {
  id: string;
  capability: Capability;
  name: string;
  operationId: string;
  /** The path for a business id; null for the one save that has no business in its path. */
  suffix: string | null;
  /** The server returns the existing item for the same content (the same name, the same briefId). */
  deduplicates: boolean;
}

const SAVES: Save[] = [
  { id: 'C1', capability: 'visibilitySnapshots', name: 'visibility snapshot', operationId: 'saveVisibilitySnapshot', suffix: 'visibility-snapshots', deduplicates: false },
  { id: 'C2', capability: 'gapLists', name: 'gap list', operationId: 'saveGapList', suffix: 'gap-lists', deduplicates: false },
  { id: 'C3', capability: 'competitors', name: 'competitor', operationId: 'addCompetitor', suffix: 'competitors', deduplicates: true },
  { id: 'C4', capability: 'contentEditor', name: 'content analysis', operationId: 'sendToContentEditor', suffix: 'content-editor/documents', deduplicates: false },
  { id: 'C5', capability: 'workspaces', name: 'workspace', operationId: 'createWorkspaceFromBrief', suffix: null, deduplicates: true },
];
const WORKSPACE_PATH = '/v1/workspaces/from-brief';
const AI_PATH = '/v1/ai/completions';

const STORED_WITHOUT_TOKEN = 'STORED ALTHOUGH THE REQUEST HAD NO VALID TOKEN';
const STORED_INVALID = 'STORED ALTHOUGH THE BODY IS NOT VALID';

/** A URL as browsers write it, with characters that strict URL validators refuse. */
const ODD_URL_END = '/a|b?x=[1]';
const EMOJI = '😀';

type Body = Record<string, unknown>;
type Rows = Record<string, unknown>[];

/** One group of unusual values that a server must accept, applied to a copy of an example body. */
interface Unusual {
  what: string;
  rule: string;
  apply: (body: Body) => void;
}

const LATER_RULE = 'Accept a value you do not know where the reference says "Values in this version": store it as text.';
const URL_RULE = 'Check that a URL starts with http:// or https:// and has at most 2,048 characters, and nothing more.';
const EMOJI_RULE = 'All text is valid Unicode and can contain emoji. An emoji is 4 bytes in UTF-8: a MySQL database needs utf8mb4 for it.';

/** Values the guide tells a server to accept, which no example carries. The competitor has none of them. */
function unusualValues(operationId: string): Unusual[] {
  const first = (body: Body, key: string): Record<string, unknown> | undefined => (body[key] as Rows | undefined)?.[0];
  if (operationId === 'saveVisibilitySnapshot') {
    return [
      {
        what: 'values of a later extension version (mode = "a-mode-added-later", firstScreenShares[0].type = "a_block_added_later")',
        rule: LATER_RULE,
        apply: (body) => {
          body['mode'] = 'a-mode-added-later';
          const share = first(body, 'firstScreenShares');
          if (share) share['type'] = 'a_block_added_later';
        },
      },
      {
        what: `a URL with the characters | [ ] (organic[0].url = "https://example.com${ODD_URL_END}")`,
        rule: URL_RULE,
        apply: (body) => {
          const result = first(body, 'organic');
          if (result) Object.assign(result, { url: `https://example.com${ODD_URL_END}`, domain: 'example.com' });
        },
      },
      {
        what: `an emoji in a page title (organic[0].title ends with ${EMOJI})`,
        rule: EMOJI_RULE,
        apply: (body) => {
          const result = first(body, 'organic');
          if (result) result['title'] = `${String(result['title'])} ${EMOJI}`;
          else body['keyword'] = `${String(body['keyword'])} ${EMOJI}`;
        },
      },
    ];
  }
  if (operationId === 'saveGapList') {
    return [
      {
        what: 'values of a later extension version (source = "A Source Added Later", rows[0].surfaceId = "a_surface_added_later", rows[0].pageType = "a-type-added-later", rows[0].contacts[0].kind = "a-kind-added-later")',
        rule: LATER_RULE,
        apply: (body) => {
          body['source'] = 'A Source Added Later';
          const row = first(body, 'rows');
          if (!row) return;
          Object.assign(row, { surfaceId: 'a_surface_added_later', pageType: 'a-type-added-later' });
          const contact = (row['contacts'] as Rows | undefined)?.[0];
          if (contact) contact['kind'] = 'a-kind-added-later';
        },
      },
      {
        what: `a URL with the characters | [ ] (rows[0].url = "https://example.com${ODD_URL_END}")`,
        rule: URL_RULE,
        apply: (body) => {
          const row = first(body, 'rows');
          if (row) Object.assign(row, { url: `https://example.com${ODD_URL_END}`, domain: 'example.com' });
        },
      },
      {
        what: `an emoji in a page title (rows[0].title ends with ${EMOJI})`,
        rule: EMOJI_RULE,
        apply: (body) => {
          const row = first(body, 'rows');
          if (row) row['title'] = `${String(row['title'])} ${EMOJI}`;
        },
      },
    ];
  }
  if (operationId === 'sendToContentEditor') {
    return [
      {
        what: 'values of a later extension version (source = "a-source-added-later", method.engine = "an-engine-added-later")',
        rule: LATER_RULE,
        apply: (body) => {
          body['source'] = 'a-source-added-later';
          (body['method'] as Record<string, unknown>)['engine'] = 'an-engine-added-later';
        },
      },
      {
        what: `a URL with the characters | [ ] (comparedUrls[0] = "https://example.com${ODD_URL_END}")`,
        rule: URL_RULE,
        apply: (body) => {
          // The same page is named in comparedUrls and in missingPoints[].urls: both get the new URL.
          const old = (body['comparedUrls'] as string[])[0];
          const swap = (urls: string[]): string[] => urls.map((url) => (url === old ? `https://example.com${ODD_URL_END}` : url));
          body['comparedUrls'] = swap(body['comparedUrls'] as string[]);
          for (const point of (body['missingPoints'] as Rows | undefined) ?? []) point['urls'] = swap(point['urls'] as string[]);
        },
      },
      {
        what: `an emoji in a page title (pageTitle ends with ${EMOJI})`,
        rule: EMOJI_RULE,
        apply: (body) => {
          body['pageTitle'] = `${String(body['pageTitle'])} ${EMOJI}`;
        },
      },
    ];
  }
  if (operationId === 'createWorkspaceFromBrief') {
    return [
      {
        what: 'a value of a later extension version (issues[0].code = "a-finding-added-later")',
        rule: LATER_RULE,
        apply: (body) => {
          const issue = first(body, 'issues');
          if (issue) issue['code'] = 'a-finding-added-later';
        },
      },
      {
        what: `a URL with the characters | [ ] (issues[0].pages[0] ends with "${ODD_URL_END}")`,
        rule: URL_RULE,
        apply: (body) => {
          const issue = first(body, 'issues');
          if (issue) issue['pages'] = [`${String(body['siteUrl']).replace(/\/+$/, '')}${ODD_URL_END}`, ...(issue['pages'] as string[]).slice(1)];
        },
      },
      {
        what: `an emoji in the Markdown (markdown ends with ${EMOJI})`,
        rule: EMOJI_RULE,
        apply: (body) => {
          body['markdown'] = `${String(body['markdown'])}\n\n${EMOJI}\n`;
        },
      },
    ];
  }
  return [];
}

/**
 * An example body with every value empty that the extension can send empty (null, "", []) and that no example
 * file carries that way. Each of these values is valid: a server must not refuse it as "missing".
 */
function emptyValues(operationId: string, body: Body): { body: Body; values: string } | null {
  if (operationId === 'saveVisibilitySnapshot') {
    // A page on which nothing could be measured, saved by a user who tracks no brand.
    const organic = ((body['organic'] as Rows | undefined) ?? []).map((result) => ({ ...result, topPx: null, fold: null }));
    return {
      body: { ...body, location: null, firstOrganicTopPx: null, firstOrganicFold: null, organicShare: 0, firstScreenShares: [], organic, tracked: [] },
      values: 'tracked = [], firstScreenShares = [], location = null, firstOrganicTopPx = null, firstOrganicFold = null, and topPx = null and fold = null in every organic result',
    };
  }
  if (operationId === 'saveGapList') {
    const rows = clone((body['rows'] as Rows | undefined) ?? []);
    // An ad without a headline that could be read, and a result without a link (the page was not scanned).
    const pages = rows.filter((row) => row['pageType'] !== 'surface');
    const untitled = pages.find((row) => row['surfaceId'] === 'ad') ?? pages.at(-1);
    if (untitled) untitled['title'] = '';
    const unlinked = pages.find((row) => row !== untitled && row['scanned'] === false);
    if (unlinked) Object.assign(unlinked, { url: null, domain: null, ...(unlinked['pageType'] === 'competitor-site' ? { pageType: 'third-party' } : {}) });
    return { body: { ...body, subject: '', rows }, values: `subject = "", title = "" in one row${unlinked ? ', url = null and domain = null in one row' : ''}` };
  }
  if (operationId === 'sendToContentEditor') {
    // A page without a title, where every sentence has a match on another page.
    const most = Number((body['wordShare'] as { saidByMost?: number } | undefined)?.saidByMost ?? 0.5);
    return {
      body: { ...body, targetKeyword: '', pageTitle: '', wordShare: { saidByMost: most, saidBySome: Number((1 - most).toFixed(4)), onlyHere: 0 }, onlyHere: [], missingPoints: [] },
      values: 'targetKeyword = "", pageTitle = "", onlyHere = [], missingPoints = []',
    };
  }
  if (operationId === 'createWorkspaceFromBrief') {
    // A site that gave the extension almost nothing, with one competitor that the user tracks by its name only.
    const competitor = (body['competitors'] as { name?: string }[] | undefined)?.[0]?.name ?? 'Lakeside Smiles';
    return {
      body: {
        ...body,
        briefId: 'conformance-check-empty-values',
        businessName: `${TEST_DATA_PREFIX}: Empty Values`,
        contact: { phones: [], emails: [], addresses: [] },
        serviceAreas: [],
        services: [],
        competitors: [{ name: competitor, domains: [] }],
        focusKeywords: [],
        issues: [],
        nextSteps: [],
      },
      values: 'nextSteps = [], issues = [], services = [], serviceAreas = [], focusKeywords = [], contact.phones = [], contact.emails = [], contact.addresses = [], and competitors[0].domains = []',
    };
  }
  return null;
}

export interface ConformanceRun {
  /** The checks, in the order they run. */
  groups: { title: string; checks: { id: string; title: string }[] }[];
  /** Reads the session and chooses the business. Call it once, before the first check. */
  begin(): Promise<void>;
  /** Runs one check. It never throws: a failure is in the result. */
  runCheck(id: string): Promise<CheckResult>;
  /** The results and the summary of everything that ran. */
  end(): ConformanceResult;
}

export function createConformanceRun(options: ConformanceOptions): ConformanceRun {
  const contract = loadContract();
  const schemas = (contract['components'] as { schemas: Record<string, Schema> }).schemas;
  const validators = contractValidators(contract);
  const limits = { requestMs: options.limits?.requestMs ?? TIMEOUT_MS.default, aiMs: options.limits?.aiMs ?? TIMEOUT_MS.ai, slowMs: options.limits?.slowMs ?? SLOW_MS };

  const warnings: string[] = [];
  const created: CreatedItem[] = [];
  const timings: { what: string; ms: number; status: number | null; large: boolean; validToken: boolean }[] = [];
  /** Every link a save returned (null when it returned none). */
  const links: (string | null)[] = [];
  const largeSaves: { what: string; ms: number }[] = [];
  const results = new Map<string, CheckResult>();
  let session: LegiitSession | null = null;
  /** false when GET /v1/session got no reply (no connection, no answer in time, a redirect): then no other check can say anything. */
  let reachable = true;
  /** Set when the run cannot start: the base URL or the token cannot be used. */
  let setupProblem = '';
  let businessId: string | null = null;
  const listedBusinessIds = new Set<string>();
  let currentCheck = '';

  const url = (path: string): string => `${options.baseUrl().replace(/\/+$/, '')}${path}`;
  /** The token never appears in what the check prints, also when a server repeats it in a reply. */
  const redact = (text: string): string => {
    const token = options.token();
    return token.length >= 8 ? text.split(token).join('<token>') : text;
  };
  const warn = (text: string): void => {
    const line = `${currentCheck}: ${text}`;
    if (!warnings.includes(line)) warnings.push(line);
  };

  const savePath = (save: Save, id: string | null = businessId): string => (save.suffix === null ? WORKSPACE_PATH : `/v1/businesses/${encodeURIComponent(id ?? '')}/${save.suffix}`);
  const businessPath = (id: string | null = businessId): string => `/v1/businesses/${encodeURIComponent(id ?? '')}`;
  const saveAt = (pathname: string): Save | undefined => SAVES.find((save) => (save.suffix === null ? pathname.endsWith(WORKSPACE_PATH) : new RegExp(`/v1/businesses/[^/]+/${save.suffix}$`).test(pathname)));

  /**
   * The one place a request leaves the check, so that every request is counted and timed: the ones the check
   * writes itself and the ones the extension's client makes. A POST carries the Origin header, as from Chrome.
   * A save that the server stored is noted here, whatever the check thinks of the reply.
   */
  async function send(target: string, init: RequestInit = {}, about: { wrongIfStored?: string; validToken?: boolean } = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    if (method === 'POST' && !headers.has('origin')) headers.set('Origin', EXTENSION_ORIGIN);
    let pathname = target;
    try {
      pathname = new URL(target).pathname;
    } catch {
      // A base URL that is no URL: the request below fails, and the check reports that.
    }
    const timing = { what: `${method} ${pathname}`, ms: 0, status: null as number | null, large: false, validToken: about.validToken ?? method !== 'OPTIONS' };
    timings.push(timing);
    const started = Date.now();
    try {
      // A redirect is never followed, as in the extension (src/net/guarded-fetch.ts): the check sees the 3xx reply.
      const response = await fetch(target, { ...init, headers, redirect: 'manual' });
      // The time counts until the whole reply is here, as the extension's time limit does.
      const body = await response.arrayBuffer();
      timing.status = response.status;
      const stored = method === 'POST' && response.status >= 200 && response.status < 300 ? saveAt(pathname) : undefined;
      if (stored) {
        let reply: { id?: unknown; error?: unknown } | null = null;
        try {
          reply = JSON.parse(new TextDecoder().decode(body)) as { id?: unknown; error?: unknown } | null;
        } catch {
          reply = null;
        }
        const id = reply?.id;
        const item: CreatedItem = { kind: stored.name, id: typeof id === 'string' || typeof id === 'number' ? String(id) : null, note: about.wrongIfStored ?? null };
        // An error body that came with a status of success: nothing was stored.
        const isError = item.id === null && reply !== null && typeof reply === 'object' && 'error' in reply;
        if (!isError && (item.id === null || !created.some((c) => c.kind === item.kind && c.id === item.id && c.note === item.note))) created.push(item);
      }
      const empty = [204, 205, 304].includes(response.status);
      return new Response(empty ? null : body, { status: Math.min(Math.max(response.status, 200), 599), statusText: response.statusText, headers: response.headers });
    } finally {
      timing.ms = Date.now() - started;
    }
  }

  /** Why a request got no reply, in words. */
  function noReply(what: string, error: unknown, limitMs: number, advice = 'Check the base URL, and that the server runs and can be reached from this computer.'): string {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return `${what} did not answer within ${seconds(limitMs)}. The extension stops waiting after ${seconds(limitMs)} and tells the user that Legiit did not answer.`;
    }
    const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
    const reason = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
    return `${what}: no reply (${reason}). ${advice}`;
  }

  /** A request exactly as the extension sends it (headers included), without the client's interpretation of the reply. */
  async function raw(method: 'GET' | 'POST', path: string, init: RawInit = {}): Promise<RawReply> {
    const token = init.token === undefined ? options.token() : init.token;
    const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
    const headers = new Headers({ Accept: 'application/json', 'X-Legiit-Client': 'legiit-lens/conformance' });
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (init.idempotencyKey) headers.set('Idempotency-Key', init.idempotencyKey);
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
    const limit = init.timeoutMs ?? limits.requestMs;
    const started = Date.now();
    let response: Response;
    try {
      const about = { wrongIfStored: init.wrongIfStored, validToken: token === options.token() };
      response = await send(url(path), { method, cache: 'no-store', signal: AbortSignal.timeout(limit), headers, ...(body !== undefined ? { body } : {}) }, about);
    } catch (error) {
      fail(noReply(`${method} ${path}`, error, limit, init.ifNoReply));
    }
    const text = await response.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      cacheControl: response.headers.get('cache-control') ?? '',
      allowOrigin: response.headers.get('access-control-allow-origin') ?? '',
      location: response.headers.get('location') ?? '',
      text,
      json,
      ms: Date.now() - started,
    };
  }

  const client = (): HttpLegiitClient =>
    new HttpLegiitClient({
      baseUrl: options.baseUrl(),
      auth: new StaticAuthProvider(options.token()),
      fetch: async (target, init) => {
        const response = await send(target, init);
        // What the network layer of the extension does with a redirect: it is an error, not a reply.
        if (response.status >= 300 && response.status < 400) throw new Error(`the Legiit API answered with a redirect (HTTP ${response.status}) instead of a reply`);
        return response;
      },
      clientVersion: 'conformance',
      ...(options.limits?.requestMs !== undefined ? { timeoutMs: options.limits.requestMs } : {}),
    });

  /** A call through the extension's own client. When the client cannot use the reply, the check says what the user would read. */
  async function asExtension<T>(what: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof LegiitError)) throw error;
      const hint = error.code === 'invalid-response' ? ' The reply must be the JSON object of the reference, at the top level, with its required keys.' : '';
      fail(`${what}: the extension cannot use the reply. It would tell the user: "${error.message}".${hint}`);
    }
  }

  const has = (capability: Capability): boolean => session?.capabilities.includes(capability) ?? false;
  const bodyOf = (reply: RawReply): string => (reply.text ? `Body: ${short(reply.text)}` : 'The body is empty.');
  const errorCode = (reply: RawReply): unknown => (reply.json as { error?: { code?: unknown } } | null | undefined)?.error?.code;
  const stored = (status: number): boolean => status === 200 || status === 201;
  /** The server refused the body itself (or failed on it): only then does it make sense to say which value is the cause. */
  const refusedBody = (status: number): boolean => status === 400 || status === 422 || status >= 500;
  /** What to say about a status of success where the server had to refuse: an error body with a wrong status, or a real success. */
  const wronglyAccepted = (reply: RawReply, ifStored: string): string => {
    if (reply.status < 200 || reply.status >= 300) return '';
    const body = reply.json as { error?: unknown } | null | undefined;
    return body !== null && typeof body === 'object' && 'error' in body ? `The body is an error, but the status is ${reply.status}: send every error with its HTTP status.` : ifStored;
  };

  /** The reply has one of the given statuses, and is never a redirect. */
  function expectStatus(reply: RawReply, allowed: number[], what: string, hint = ''): void {
    if (reply.status >= 300 && reply.status < 400) {
      fail(`${what}: answered with a redirect (HTTP ${reply.status}${reply.location ? ` to ${short(reply.location, 120)}` : ''}). Answer on the URL that was called: the extension never follows a redirect.`);
    }
    const limited = reply.status === 429 ? 'The API limits the requests of the test account. The check sends all its requests within a few seconds (the summary counts them): exempt the test account from the rate limits, or allow for the check.' : '';
    if (!allowed.includes(reply.status)) fail(`${what}: expected HTTP ${allowed.join(' or ')}, got ${reply.status}. ${[hint, limited, bodyOf(reply)].filter(Boolean).join(' ')}`);
  }

  function expectJson(reply: RawReply, what: string): void {
    if (!/application\/json/i.test(reply.contentType)) fail(`${what}: the reply must be sent with "Content-Type: application/json". It came with ${reply.contentType ? `"${reply.contentType}"` : 'no Content-Type'}. ${bodyOf(reply)}`);
    if (reply.json === undefined) fail(`${what}: the body is not JSON. ${bodyOf(reply)}`);
  }

  /** The reply matches the contract schema, and has no contract key in another spelling. */
  function expectContract(name: string, body: unknown, what: string): void {
    const validate = validators(name);
    if (!validate(body)) fail(`${what} does not match the contract schema "${name}": ${describeErrors(validate.errors ?? [])}. ${body === undefined ? 'The body is empty.' : `Body: ${short(JSON.stringify(body), 200)}`}`);
    const misspelt = misspeltKeys(contract, name, body);
    if (misspelt.length > 0) fail(`${what}: keys are camelCase and case-sensitive. ${misspelt.join('; ')}.`);
  }

  function expectErrorBody(reply: RawReply, what: string): void {
    if (!/application\/json/i.test(reply.contentType)) {
      fail(`${what}: an error must be sent with "Content-Type: application/json", also when your framework produces the error by itself. It came with ${reply.contentType ? `"${reply.contentType}"` : 'no Content-Type'}. ${bodyOf(reply)}`);
    }
    if (reply.json === undefined) fail(`${what}: the error body is not JSON. It must be {"error": {"code": "…", "message": "…"}}. ${bodyOf(reply)}`);
    expectContract('Error', reply.json, `${what}: the error body`);
  }

  /** What a successful save returned. Every check that needs the id of a saved item reads it here. */
  function savedItem(reply: RawReply, what: string): { id: string; url: string | null } {
    if (reply.status >= 200 && reply.status < 300 && reply.text === '') {
      fail(`${what}: answered HTTP ${reply.status} without a body. A save must return a JSON body with the "id" of the stored item. The extension treats this reply as a failed save, and the user will probably send the item again.`);
    }
    expectStatus(reply, [200, 201], what);
    expectJson(reply, what);
    const body = reply.json as { id?: unknown; url?: unknown } | null;
    const link = body !== null && typeof body === 'object' ? body.url : undefined;
    if (typeof link === 'string' && !/^https?:\/\/\S+$/.test(link)) {
      fail(`${what}: "url" must be null, or an absolute URL without spaces that the user can open. It starts with https:// (http:// on a local test system). Got "${short(link, 80)}". The extension shows no link for it.`);
    }
    expectContract('SaveResult', body, what);
    return { id: String(body!.id), url: typeof link === 'string' ? link : null };
  }

  /** The ids that the saves of this run returned, by kind of item. */
  const returnedIds = new Map<string, Set<string>>();
  /**
   * A snapshot, a gap list or a content analysis that arrives under a new Idempotency-Key (or without one) is a
   * new item, also when the same content was saved before. So its id is one that no earlier save returned.
   */
  function expectNewItem(save: Save, id: string, what: string): void {
    if (save.deduplicates) return;
    const ids = returnedIds.get(save.name) ?? new Set<string>();
    returnedIds.set(save.name, ids);
    if (ids.has(id)) {
      fail(`${what}: the reply has the id "${short(id, 60)}", which an earlier save of this run returned already. A ${save.name} is never de-duplicated by its content: the same content under a new Idempotency-Key is a new item, with an id of its own.`);
    }
    ids.add(id);
  }

  function needsSession(): void {
    if (session === null) skip('the session could not be read: fix A1 and A2 first');
  }
  function needs(capability: Capability): void {
    needsSession();
    if (!has(capability)) skip(`capability "${capability}" is not enabled for this account`);
  }
  function needsWrites(): void {
    if (!options.writes) skip('read-only run: no save is sent');
  }
  function needsBusiness(): void {
    if (businessId === null) skip('no business to work with: list the "businesses" capability with at least one business, or pass --business=<id>');
  }
  /** The saves this account can make: the capability is listed, and there is a business for a save that needs one. */
  const enabledSaves = (): Save[] => SAVES.filter((save) => has(save.capability) && (save.suffix === null || businessId !== null));
  function needsSaves(): Save[] {
    needsSession();
    needsWrites();
    const list = enabledSaves();
    if (list.length === 0) skip('no save capability is enabled for this account');
    return list;
  }

  /**
   * Runs every step and reports the problems together, so that one run shows what there is to fix. A check names
   * at most five problems (`most`): more of them are mostly the same problem on another endpoint.
   */
  async function each<T>(items: readonly T[], step: (item: T) => Promise<void>, most = 5): Promise<void> {
    const problems: string[] = [];
    for (const item of items) {
      try {
        await step(item);
      } catch (error) {
        if (!(error instanceof CheckFailed)) throw error;
        problems.push(...error.message.split(MORE_PROBLEMS)[0]!.split(NEXT_PROBLEM));
      }
    }
    if (problems.length > 0) fail(`${problems.slice(0, most).join(NEXT_PROBLEM)}${problems.length > most ? `${MORE_PROBLEMS}${problems.length - most} more of this check` : ''}`);
  }

  /** An example body, marked so that the item it creates can be recognised as test data. */
  function testBody(save: Save, file: string): Body {
    const body = example<Body>(file);
    const variant = file.replace(/\.request\.json$/, '');
    if (save.operationId === 'addCompetitor') return { ...body, name: `${TEST_DATA_PREFIX}: ${String(body['name'])}` };
    if (save.operationId === 'createWorkspaceFromBrief') return { ...body, briefId: `conformance-check-${variant}`, businessName: `${TEST_DATA_PREFIX}: ${String(body['businessName'])}` };
    return body;
  }
  const firstExample = (save: Save): string => requestExamples(save.operationId)[0]!;
  const firstBody = (save: Save): Body => testBody(save, firstExample(save));

  const resolveRef = (schema: Schema | undefined): Schema => {
    const ref = schema?.['$ref'];
    return typeof ref === 'string' ? { ...schemas[ref.split('/').at(-1)!], ...schema } : (schema ?? {});
  };
  /** The schema of the request body of an operation. */
  function requestSchema(operationId: string): Schema {
    for (const methods of Object.values(contract['paths'] as Record<string, Record<string, { operationId?: string; requestBody?: { content: { 'application/json': { schema: Schema } } } }>>)) {
      for (const operation of Object.values(methods)) {
        if (operation.operationId === operationId && operation.requestBody) return resolveRef(operation.requestBody.content['application/json'].schema);
      }
    }
    return {};
  }
  /** Bodies that a server must refuse: an empty object, and an example with a text where a list is required. */
  function bodiesToRefuse(save: Save): { what: string; body: unknown }[] {
    const schema = requestSchema(save.operationId);
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
    const list = ((schema['required'] ?? []) as string[]).find((key) => [resolveRef(properties[key])['type']].flat().includes('array'));
    return [
      { what: 'an empty object', body: {} },
      ...(list ? [{ what: `examples/${firstExample(save)} with a text in "${list}", which must be a list`, body: { ...firstBody(save), [list]: 'a text, not a list' } }] : []),
    ];
  }

  /** The ten endpoints, each with a request that is valid except for what a check changes. */
  interface Operation {
    method: 'GET' | 'POST';
    /** null when the request needs a business and there is none. */
    path: () => string | null;
    capability: Capability | null;
    kind: 'read' | 'save' | 'ai';
    body?: () => unknown;
  }
  const operations: Operation[] = [
    { method: 'GET', path: () => '/v1/session', capability: null, kind: 'read' },
    { method: 'GET', path: () => '/v1/businesses', capability: 'businesses', kind: 'read' },
    { method: 'GET', path: () => (businessId === null ? null : businessPath()), capability: 'businesses', kind: 'read' },
    ...SAVES.map((save): Operation => ({ method: 'POST', path: () => (save.suffix !== null && businessId === null ? null : savePath(save)), capability: save.capability, kind: 'save', body: () => firstBody(save) })),
    { method: 'GET', path: () => '/v1/industry-pulse', capability: 'industryPulse', kind: 'read' },
    { method: 'POST', path: () => AI_PATH, capability: 'ai', kind: 'ai', body: () => example('completeAI.request.json') },
  ];

  /** A request without a valid token is answered 401 with the error body, on every endpoint. */
  async function expectTokenIsChecked(token: string | null, tokenIs: string): Promise<void> {
    await each(operations, async (operation) => {
      const path = operation.path();
      // A read-only run sends no save, not even one that a correct server refuses.
      if (path === null || (operation.kind === 'save' && !options.writes)) return;
      const reply = await raw(operation.method, path, {
        token,
        body: operation.body?.(),
        idempotencyKey: operation.kind === 'save' ? randomUUID() : undefined,
        timeoutMs: operation.kind === 'ai' ? limits.aiMs : undefined,
        wrongIfStored: STORED_WITHOUT_TOKEN,
      });
      const what = `${operation.method} ${path} ${tokenIs}`;
      // An endpoint that is not built, or whose capability is off, may say so before it looks at the token.
      const off = operation.capability !== null && !has(operation.capability);
      if (off && [404, 405, 501].includes(reply.status)) return;
      const hint = wronglyAccepted(reply, `The server answered a request that it must refuse: check the token on every endpoint.${operation.kind === 'ai' ? ' Without that check, anyone can use your AI model.' : ''}`);
      expectStatus(reply, [401], what, hint);
      expectErrorBody(reply, what);
    }, operations.length);
  }

  /** Ids that cannot be the id of a business, or that look like one and are none. */
  function otherForms(unknown: string): { id: string; what: string }[] {
    return [
      ...(unknown === NO_SUCH_BUSINESS ? [] : [{ id: NO_SUCH_BUSINESS, what: 'an id of another form than yours' }]),
      ...(businessId !== null && /^\d+$/.test(businessId)
        ? [
            { id: `${businessId}abc`, what: 'an id of yours followed by letters' },
            { id: '9'.repeat(20), what: 'a number that is too large for an id' },
          ]
        : []),
    ];
  }

  const groups: { title: string; checks: Check[] }[] = [];
  const group = (title: string): void => {
    groups.push({ title, checks: [] });
  };
  const check = (id: string, title: string, run: () => Promise<void>): void => {
    groups.at(-1)!.checks.push({ id, title, run });
  };

  // ------------------------------------------------------------------------------------------------------------
  group('A. Token and transport');

  check('A1', 'GET /v1/session with a valid token answers 200 with the session', async () => {
    const reply = await raw('GET', '/v1/session');
    const what = 'GET /v1/session';
    const hint = /\/v1$/.test(options.baseUrl().replace(/\/+$/, ''))
      ? 'The base URL ends with /v1: give it without /v1, the check adds it.'
      : reply.status === 401
        ? 'The token of the run was refused. Is it a token of this API? If it is, something in front of the API answers 401, for example HTTP Basic auth on a staging site.'
        : '';
    expectStatus(reply, [200], what, hint);
    expectJson(reply, what);
    expectContract('Session', reply.json, what);
    const listed = (reply.json as { capabilities: unknown[] }).capabilities;
    const unknown = listed.filter((name) => !ALL_CAPABILITIES.includes(name as Capability));
    if (unknown.length > 0) warn(`the session lists capability names the extension does not know and ignores: ${unknown.map(String).join(', ')}. Check the spelling (names are case-sensitive): ${ALL_CAPABILITIES.join(', ')}.`);
    if (!/no-store/i.test(reply.cacheControl)) warn('the reply has no "Cache-Control: no-store" header. The extension does not cache, but a proxy between the extension and your API might.');
  });

  check('A2', 'the extension accepts that session', async () => {
    const result = await asExtension('GET /v1/session', () => client().getSession());
    if (!result.user.name && !result.user.email) warn('the session has no user name and no e-mail address, so the extension shows "Legiit account" after "Connected".');
    if (result.capabilities.length === 0) warn('the session lists no capabilities, so the extension shows no Legiit feature at all.');
    const inBusiness = (['visibilitySnapshots', 'gapLists', 'competitors', 'contentEditor'] as Capability[]).filter((c) => result.capabilities.includes(c));
    if (inBusiness.length > 0 && !result.capabilities.includes('businesses')) warn(`${inBusiness.join(', ')} listed without "businesses": the user cannot choose a business, so these saves stay disabled.`);
  });

  check('A3', 'a request without an Authorization header answers 401 with the error body, on every endpoint', async () => {
    await expectTokenIsChecked(null, 'without a token');
  });

  check('A4', 'a request with an unknown token answers 401 with the error body, on every endpoint', async () => {
    await expectTokenIsChecked('conformance-check-not-a-real-token', 'with an unknown token');
  });

  check('A5', 'an unknown path, and an endpoint whose capability is off, answer 404, 405 or 501, and not with the code "not_found"', async () => {
    // Without a session the token of the run is not known to be valid, and this check is about a valid token.
    needsSession();
    // "not_found" is reserved for a missing business. Anywhere else it would make the extension show an error
    // where it should quietly hide a feature that is not built, or not part of the plan of the user.
    const reserved = 'the code "not_found" is reserved for a missing business';
    const unknownPath = await raw('GET', '/v1/conformance-check-no-such-endpoint');
    const problems: (() => void)[] = [
      () => {
        expectStatus(unknownPath, [404, 405, 501], 'GET of an unknown path');
        if (errorCode(unknownPath) === 'not_found') fail(`GET of an unknown path: ${reserved}. An unknown path must use another code, or no error body.`);
      },
    ];
    // With every capability on there is nothing more to try. With an account on a smaller plan, each endpoint that
    // the session does not list gets one request. A POST carries an empty object, which no server stores.
    for (const operation of operations) {
      const path = operation.path();
      if (operation.capability === null || has(operation.capability) || path === null || (operation.kind === 'save' && !options.writes)) continue;
      const post = operation.method === 'POST';
      const reply = await raw(operation.method, path, { ...(post ? { body: {} } : {}), timeoutMs: operation.kind === 'ai' ? limits.aiMs : undefined, wrongIfStored: STORED_INVALID });
      const what = `${operation.method} ${path} (the capability "${operation.capability}" is not in the session)`;
      problems.push(() => {
        if (!post && reply.status >= 200 && reply.status < 300) {
          warn(`${what} answered HTTP ${reply.status}. The extension never calls an endpoint whose capability is not listed. List the capability when the endpoint is ready, or answer 404 when the plan of the user does not include it.`);
          return;
        }
        // An empty object is also a body that cannot be accepted: a server that looks at the fields first answers 400 or 422.
        expectStatus(reply, post ? [404, 405, 501, 400, 422] : [404, 405, 501], what, reply.status === 403 ? 'Use 403 only for a feature that the user has. A feature that the user does not have answers 404, like an endpoint that does not exist.' : '');
        if (reply.status === 404 && errorCode(reply) === 'not_found') fail(`${what}: ${reserved}. An endpoint whose capability is off must use another code, or no error body.`);
      });
    }
    await each(problems, async (problem) => problem(), problems.length);
  });

  check('A6', 'a valid token is never answered with 401', async () => {
    needsSession();
    // 401 means "this token is bad": the extension deletes it. A feature that is off answers 404; a refusal for another reason answers 403.
    await each(['/v1/session', '/v1/businesses', '/v1/industry-pulse', businessPath(unknownIdLike(businessId, listedBusinessIds))], async (path) => {
      const reply = await raw('GET', path);
      if (reply.status === 401) fail(`GET ${path} with a valid token: answered 401. Use 401 only for a bad token: the extension then says that Legiit did not accept the token. ${bodyOf(reply)}`);
    });
  });

  check('A7', 'the word "Bearer" is case-insensitive (recommended)', async () => {
    needsSession();
    // The same request as A1; only the letter case of the word differs.
    const reply = await raw('GET', '/v1/session', { headers: { Authorization: `bearer ${options.token()}` } });
    if (reply.status !== 200) warn(`"Authorization: bearer <token>", with the word in lower case, was answered with ${reply.status}. Chrome sends "Bearer", so the extension works, but HTTP says that the word is case-insensitive.`);
  });

  check('A8', 'a preflight (OPTIONS) is answered with the CORS headers (recommended)', async () => {
    // What Chrome sends first, for every request, when the user has switched off the extension's access to the API
    // host: no token, and the names of the headers the real request will carry. Normally there is no preflight.
    const missing: string[] = [];
    for (const [method, path, asked] of [
      ['GET', '/v1/session', 'authorization,x-legiit-client'],
      ['POST', AI_PATH, 'authorization,content-type,idempotency-key,x-legiit-client'],
    ] as const) {
      let response: Response;
      try {
        response = await send(url(path), {
          method: 'OPTIONS',
          signal: AbortSignal.timeout(limits.requestMs),
          headers: { Origin: EXTENSION_ORIGIN, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': asked },
        });
      } catch (error) {
        missing.push(noReply(`OPTIONS ${path} (before a ${method})`, error, limits.requestMs));
        continue;
      }
      const allowOrigin = response.headers.get('access-control-allow-origin') ?? '';
      const allowHeaders = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(/\s*,\s*/);
      // By the Fetch standard "*" stands for every header except Authorization, which must be named. GET and POST
      // need no Access-Control-Allow-Methods.
      const covered = (name: string): boolean => allowHeaders.includes(name) || (name !== 'authorization' && allowHeaders.includes('*'));
      const uncovered = asked.split(',').filter((name) => !covered(name));
      const problems = [
        ...(response.status >= 200 && response.status < 300 ? [] : [`status ${response.status} instead of 204`]),
        ...(allowOrigin === '*' || allowOrigin === EXTENSION_ORIGIN ? [] : ['no Access-Control-Allow-Origin for the extension']),
        ...(uncovered.length === 0 ? [] : [`Access-Control-Allow-Headers does not name ${uncovered.join(', ')}`]),
      ];
      if (problems.length > 0) missing.push(`OPTIONS ${path} (before a ${method}): ${problems.join('; ')}`);
    }
    // The real reply needs the header as well, or Chrome withholds it from the extension. The same request as A1,
    // with the Origin header that Chrome then adds to a GET.
    if (session !== null) {
      const reply = await raw('GET', '/v1/session', { headers: { Origin: EXTENSION_ORIGIN } });
      if (reply.status !== 200) missing.push(`GET /v1/session with an Origin header was answered ${reply.status}: do not allow or block requests by Origin`);
      else if (reply.allowOrigin !== '*' && reply.allowOrigin !== EXTENSION_ORIGIN) missing.push('GET /v1/session with an Origin header: the reply has no Access-Control-Allow-Origin for the extension');
    }
    if (missing.length > 0) {
      warn(`the CORS safety net is not in place. The extension works without it, except for a user who has switched off its access to this host in Chrome: for them nothing works. ${missing.join('. ')}. See the guide, section 3, "CORS".`);
    }
  });

  check('A9', 'a request without the X-Legiit-Client header is accepted', async () => {
    needsSession();
    // The same request as A1 without that header: curl and other clients do not send it.
    const reply = await raw('GET', '/v1/session', { headers: { 'X-Legiit-Client': null } });
    expectStatus(reply, [200], 'GET /v1/session without the X-Legiit-Client header', 'The header is for your logs: do not require it.');
  });

  // ------------------------------------------------------------------------------------------------------------
  group('B. Reading account data');

  check('B1', "GET /v1/businesses lists the account's businesses", async () => {
    needs('businesses');
    const what = 'GET /v1/businesses';
    const reply = await raw('GET', '/v1/businesses');
    expectStatus(reply, [200], what);
    expectJson(reply, what);
    expectContract('BusinessList', reply.json, what);
    const list = await asExtension(what, () => client().listBusinesses());
    if (list.length === 0) fail(`${what}: the list is empty. The test account needs at least one business for the remaining checks.`);
    if (new Set(list.map((b) => b.id)).size !== list.length) fail(`${what}: two businesses have the same id. Business ids must be unique.`);
    const sent = (reply.json as { businesses: unknown[] }).businesses.length;
    if (list.length !== Math.min(sent, 500)) fail(`${what}: the extension could read ${list.length} of the ${sent} businesses. An id is missing, empty or longer than 120 characters.`);
    if (sent > 500) warn(`the reply lists ${sent} businesses; the extension shows the first 500.`);
    if (list.some((b) => !b.name)) warn('a business has an empty name; the extension shows its domain or id in the drop-down instead.');
  });

  check('B2', 'GET /v1/businesses/{id} returns Business Details the extension can pre-fill from', async () => {
    needs('businesses');
    if (businessId === null) fail('There is no business to read: the test account needs at least one.');
    const what = `GET ${businessPath()}`;
    const reply = await raw('GET', businessPath());
    expectStatus(reply, [200], what);
    expectJson(reply, what);
    expectContract('BusinessDetails', reply.json, what);
    const details = await asExtension(what, () => client().getBusinessDetails(businessId!));
    if (String(details.id) !== String(businessId)) fail(`${what}: the reply carries the id "${short(String(details.id), 60)}". Business Details must carry the same id as the list.`);
    if (details.domains.length === 0 && details.brandNames.length === 0) warn('the business has no domains and no brand names, so nothing is pre-filled as "my brand" beyond its name.');
  });

  check('B3', 'an unknown business id answers 404 with error.code "not_found"', async () => {
    needs('businesses');
    const id = unknownIdLike(businessId, listedBusinessIds);
    const what = `GET ${businessPath(id)} (an id that no business of this account has)`;
    const reply = await raw('GET', businessPath(id));
    expectStatus(reply, [404], what);
    expectErrorBody(reply, what);
    if (errorCode(reply) !== 'not_found') fail(`${what}: error.code is ${JSON.stringify(errorCode(reply))}, expected "not_found". Without that code the extension takes a missing business for an endpoint that is not built, and hides the feature.`);
    // Ids that cannot exist in your scheme. The extension only sends ids that you gave it, so this is about
    // robustness: never a server error, never 401, never a success, and best the same answer as above.
    await each(otherForms(id), async (other) => {
      const odd = await raw('GET', businessPath(other.id));
      const where = `GET ${businessPath(other.id)} (${other.what})`;
      if (!(odd.status >= 400 && odd.status < 500 && odd.status !== 401)) {
        fail(`${where}: answered HTTP ${odd.status}. It must be a 4xx other than 401 (best: 404 with the code "not_found"), never a server error and never a success. ${bodyOf(odd)}`);
      }
      if (!(odd.status === 404 && errorCode(odd) === 'not_found')) {
        const code = typeof errorCode(odd) === 'string' ? ` "${String(errorCode(odd))}"` : '';
        warn(`${other.what} ("${other.id}") answered HTTP ${odd.status}${code} instead of 404 "not_found". The extension never sends such an id today. After a change of your id scheme it would, and it would then ${odd.status === 404 ? 'take the feature for "not built" and hide it' : 'show "Legiit rejected the request"'} instead of saying that the business is gone.`);
      }
    });
  });

  check('B4', 'GET /v1/industry-pulse returns dated events', async () => {
    needs('industryPulse');
    const what = 'GET /v1/industry-pulse';
    const reply = await raw('GET', '/v1/industry-pulse');
    expectStatus(reply, [200], what);
    expectJson(reply, what);
    expectContract('IndustryPulse', reply.json, what);
    const pulse = await asExtension(what, () => client().getIndustryPulse());
    const sent = (reply.json as { events: unknown[] }).events.length;
    if (pulse.events.length !== Math.min(sent, 200)) fail(`${what}: the extension could read ${pulse.events.length} of the ${sent} events. A date is not a real day written as YYYY-MM-DD.`);
    if (pulse.events.length === 0) warn('industry pulse has no events, so the Rewind tab shows no date shortcuts.');
    const dates = pulse.events.map((e) => e.date);
    if (dates.join() !== [...dates].sort().reverse().join()) warn('industry pulse events are not newest first. The extension shows the first 8 as they come.');
  });

  check('B5', 'a business of another user answers 404 "not_found", like one that does not exist', async () => {
    const other = options.otherBusinessId?.();
    if (!other) skip('no business of another user was given (option --other-business=<id>)');
    needsSession();
    // A read-only run sends no save, not even one that a correct server refuses.
    const targets = options.writes ? SAVES.filter((save) => save.suffix !== null && has(save.capability)) : [];
    if (!has('businesses') && targets.length === 0) skip(`neither "businesses" nor a save into a business is enabled for this account${options.writes ? '' : ' in a read-only run'}`);
    const wrongOption = 'If this business belongs to the user of the token, the option --other-business is wrong: give the id of a business of ANOTHER user.';
    const requests: { what: string; send: () => Promise<RawReply> }[] = [
      // Each endpoint checks its own capability: the read needs "businesses", a save needs only its own.
      ...(has('businesses') ? [{ what: `GET ${businessPath(other)} (a business of another user)`, send: () => raw('GET', businessPath(other)) }] : []),
      ...targets.map((save) => ({
        what: `POST ${savePath(save, other)} (a save into a business of another user)`,
        send: () => raw('POST', savePath(save, other), { body: firstBody(save), idempotencyKey: randomUUID(), wrongIfStored: `STORED IN THE OTHER USER'S BUSINESS ${other}` }),
      })),
    ];
    await each(requests, async (request) => {
      const reply = await request.send();
      expectStatus(reply, [404], request.what, wronglyAccepted(reply, `The token reached a business that is not its user's. ${wrongOption}`));
      expectErrorBody(reply, request.what);
      if (errorCode(reply) !== 'not_found') fail(`${request.what}: error.code is ${JSON.stringify(errorCode(reply))}, expected "not_found", the same answer as for a business that does not exist.`);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  group('C. Saving (creates test data in the account)');

  for (const save of SAVES) {
    check(save.id, `POST saves a ${save.name} and returns its id`, async () => {
      needs(save.capability);
      needsWrites();
      if (save.suffix !== null) needsBusiness();
      // Every example of this request, and then the first example with every value empty that the extension can
      // send empty (null, "", []) and that no example carries that way. All of these bodies are valid.
      const empty = emptyValues(save.operationId, firstBody(save));
      const bodies = [
        ...requestExamples(save.operationId).map((file) => ({ body: testBody(save, file), with: `examples/${file}`, hint: '' })),
        ...(empty ? [{ body: empty.body, with: `examples/${firstExample(save)} and these empty values: ${empty.values}`, hint: 'The extension sends these values. They are valid: do not refuse them as "missing".' }] : []),
      ];
      let withoutLink = 0;
      let notHttps = '';
      await each(bodies, async (sent) => {
        const what = `POST ${savePath(save)} with ${sent.with}`;
        const reply = await raw('POST', savePath(save), { body: sent.body, idempotencyKey: randomUUID() });
        if (refusedBody(reply.status) && sent.hint) expectStatus(reply, [200, 201], what, sent.hint);
        const item = savedItem(reply, what);
        expectNewItem(save, item.id, what);
        links.push(item.url);
        if (item.url === null) withoutLink += 1;
        else if (!item.url.startsWith('https://')) notHttps = item.url;
      });
      if (withoutLink > 0) warn(`no "url" in the reply to ${withoutLink} of ${plural(bodies.length, 'save')}, so the extension shows "Saved" without an "Open in Command Center" link.`);
      if (notHttps) warn(`"url" is not an https URL (${short(notHttps, 60)}). This is fine on a local test system; use https in production.`);
    });
  }

  check('C6', 'a body the API cannot accept answers 400 or 422 with a message for the user, on every save', async () => {
    await each(needsSaves(), async (save) => {
      await each(bodiesToRefuse(save), async (sent) => {
        const what = `POST ${savePath(save)} with ${sent.what}`;
        const reply = await raw('POST', savePath(save), { body: sent.body, wrongIfStored: STORED_INVALID });
        expectStatus(reply, [400, 422], what, wronglyAccepted(reply, 'The server stored a body that it must refuse: check that the body has the required keys in the right types.'));
        expectErrorBody(reply, what);
      });
    });
  });

  check('C7', 'a body that is not JSON answers 400 or 422, not 500, on every save', async () => {
    await each(needsSaves(), async (save) => {
      const what = `POST ${savePath(save)} with a body that is not JSON`;
      const reply = await raw('POST', savePath(save), { rawBody: '{"cut off": ', wrongIfStored: STORED_INVALID });
      expectStatus(reply, [400, 422], what);
      expectErrorBody(reply, what);
    });
  });

  check('C8', "fields the API does not know are ignored, and a save without Idempotency-Key is accepted: the extension's own client completes every save", async () => {
    const targets = needsSaves();
    const api = client();
    // No Idempotency-Key on purpose: the extension sends one, other clients (curl) do not. Do not require it.
    const calls: Record<string, (body: never) => Promise<{ id: string }>> = {
      saveVisibilitySnapshot: (body) => api.saveVisibilitySnapshot(businessId!, body),
      saveGapList: (body) => api.saveGapList(businessId!, body),
      addCompetitor: (body) => api.addCompetitor(businessId!, body),
      sendToContentEditor: (body) => api.sendToContentEditor(businessId!, body),
      createWorkspaceFromBrief: (body) => api.createWorkspaceFromBrief(body),
    };
    await each(targets, async (save) => {
      const body = { ...firstBody(save), addedByALaterExtensionVersion: { anything: true } };
      const what = `POST ${savePath(save)} with examples/${firstExample(save)}, a field the API does not know ("addedByALaterExtensionVersion") and no Idempotency-Key header, sent by the extension's own client`;
      let saved: { id: string };
      try {
        saved = await calls[save.operationId]!(body as never);
      } catch (error) {
        if (!(error instanceof LegiitError)) throw error;
        let cause =
          error.code === 'invalid-response'
            ? 'The reply must be a JSON object with the "id" of the stored item at the top level.'
            : error.code === 'unavailable'
              ? `The endpoint answered HTTP ${error.status}, which means "not built", although its capability is in the session. The extension then hides the button.`
              : '';
        if (error.code === 'rejected' && refusedBody(error.status)) {
          // Which of the two was refused? The same body once more, this time with the header.
          const withKey = await raw('POST', savePath(save), { body, idempotencyKey: randomUUID() });
          cause = stored(withKey.status)
            ? 'The same body with an Idempotency-Key header was accepted: do not require that header.'
            : `The same body with an Idempotency-Key header was refused too (HTTP ${withKey.status}), so the unknown field is the cause: ignore fields you do not know, a later extension version may add fields.`;
        }
        fail(`${what}: the extension would tell the user: "${error.message}". ${cause}`.trim());
      }
      expectNewItem(save, saved.id, what);
    });
  });

  check('C9', 'saving into an unknown business answers 404 with error.code "not_found"', async () => {
    needsSession();
    needsWrites();
    const targets = SAVES.filter((save) => save.suffix !== null && has(save.capability));
    if (targets.length === 0) skip('no save into a business is enabled for this account');
    const id = unknownIdLike(businessId, listedBusinessIds);
    await each(targets, async (save) => {
      const what = `POST ${savePath(save, id)} (a business that does not exist)`;
      const reply = await raw('POST', savePath(save, id), { body: firstBody(save), idempotencyKey: randomUUID(), wrongIfStored: `STORED FOR A BUSINESS THAT DOES NOT EXIST (${id})` });
      expectStatus(reply, [404], what);
      expectErrorBody(reply, what);
      if (errorCode(reply) !== 'not_found') fail(`${what}: error.code is ${JSON.stringify(errorCode(reply))}, expected "not_found". Without that code the extension takes this for an endpoint that is not built, and hides the button.`);
    });
  });

  check('C10', 'text outside ASCII is stored as sent (UTF-8), and a new competitor is listed in Business Details', async () => {
    needs('competitors');
    needsWrites();
    needsBusiness();
    const marker = `${TEST_DATA_PREFIX}: Zahn`;
    const name = `${marker}ärzte München – “Lächeln” 東京 ${EMOJI}`;
    const what = `POST ${savePath(SAVES[2]!)} with the name "${name}"`;
    const reply = await raw('POST', savePath(SAVES[2]!), { body: { name, domains: ['zahnaerzte-muenchen.example'] }, idempotencyKey: randomUUID() });
    if (reply.status >= 500) expectStatus(reply, [200, 201], what, 'The name has an emoji, which is 4 bytes in UTF-8: a MySQL database needs utf8mb4 for it.');
    savedItem(reply, what);
    if (!has('businesses')) return;
    const read = (await asExtension(`GET ${businessPath()}`, () => client().getBusinessDetails(businessId!))).competitors.map((c) => c.name);
    if (read.includes(name)) return;
    // Not among the first 200 that the extension reads: what does the whole reply list?
    const details = await raw('GET', businessPath());
    const all = ((details.json as { competitors?: { name?: unknown }[] } | undefined)?.competitors ?? []).map((c) => String(c.name));
    const same = (a: string, b: string): boolean => a.normalize('NFKC').trim().toLowerCase() === b.normalize('NFKC').trim().toLowerCase();
    const leftOver = 'If the competitor is left from an earlier run, remove it and run the check again.';
    if (all.includes(name)) {
      warn(`the business has ${all.length} competitors and the new one is not among the first 200, which is all the extension reads. Use a test business with fewer competitors, or list new ones first.`);
      return;
    }
    const changed = all.find((listed) => same(listed, name));
    if (changed !== undefined) {
      warn(`the competitor "${name}" is listed as "${changed}": the letter case or the spaces were changed. The extension shows the name as you return it.`);
      return;
    }
    const damaged = all.find((listed) => listed.toLowerCase().startsWith(marker.toLowerCase()));
    if (damaged !== undefined) {
      fail(`GET ${businessPath()} lists the competitor as "${damaged}", but it was sent as "${name}": the text was damaged. Store and return text as UTF-8. An emoji is 4 bytes in UTF-8: a MySQL database needs utf8mb4 for it. ${leftOver}`);
    }
    if (all.length >= 200) {
      warn(`the competitor "${name}" was saved, but GET ${businessPath()} does not list it among its ${all.length} competitors. The extension reads the first 200: use a test business with fewer competitors, or list new ones first.`);
      return;
    }
    fail(`The competitor "${name}" was saved (HTTP ${reply.status}), but GET ${businessPath()} does not list it (it lists: ${all.slice(-3).join(' | ') || 'no competitor'}). A competitor that was added must appear in Business Details at once.`);
  });

  check('C11', 'the same competitor added twice is one competitor (recommended)', async () => {
    needs('competitors');
    needsWrites();
    needsBusiness();
    const path = savePath(SAVES[2]!);
    const body = { name: `${TEST_DATA_PREFIX}: Twice`, domains: ['conformance-twice.example'] };
    const first = await raw('POST', path, { body, idempotencyKey: randomUUID() });
    // The same name in another letter case, with spaces around it. The prefix stays as it is, so that the item can be found.
    const second = await raw('POST', path, { body: { ...body, name: `  ${TEST_DATA_PREFIX}: TWICE ` }, idempotencyKey: randomUUID() });
    const one = savedItem(first, `POST ${path} (a competitor)`);
    if (second.status === 409) expectStatus(second, [200, 201], `POST ${path} (the same competitor again)`, 'Answer 200 or 201 with the id of the existing competitor, not 409.');
    const two = savedItem(second, `POST ${path} (the same competitor again)`);
    if (one.id !== two.id) warn('adding the same competitor twice (the name in another letter case) returned two different ids. Recommended: return the id of the existing competitor and do not create a second one.');
  });

  check('C12', 'a repeated Idempotency-Key does not store the item twice (recommended)', async () => {
    const enabled = needsSaves();
    // A competitor or a workspace comes back with the same id anyway (the same name, the same briefId), so only a
    // save that is never de-duplicated by its content can show whether the key is used.
    const save = enabled.find((s) => !s.deduplicates);
    if (!save) skip('only saves that are de-duplicated by their content are enabled (competitors, workspaces): for them a repeated Idempotency-Key cannot be told apart from that de-duplication');
    const idempotencyKey = randomUUID();
    const body = firstBody(save);
    const first = await raw('POST', savePath(save), { body, idempotencyKey });
    const second = await raw('POST', savePath(save), { body, idempotencyKey });
    const one = savedItem(first, `POST ${savePath(save)} with an Idempotency-Key`);
    // The same content was saved before, under other keys (C1, C8). It is a new item each time.
    expectNewItem(save, one.id, `POST ${savePath(save)} with examples/${firstExample(save)} and a new Idempotency-Key`);
    const two = savedItem(second, `POST ${savePath(save)} again with the same Idempotency-Key`);
    if (one.id !== two.id) warn(`the same ${save.name} sent twice with the same Idempotency-Key returned two different ids, so the user's second click after a timeout creates a duplicate. Recommended: return the first reply again.`);
  });

  check('C13', 'large bodies are accepted: a brief of 600 KB and a gap list just under 1 MB', async () => {
    needsSession();
    needsWrites();
    const large: { save: Save; body: Body; hint: string }[] = [];
    if (has('gapLists') && businessId !== null) {
      // As many rows with long non-Latin text as fit into the 1,048,576 bytes the extension allows itself.
      const list = example<{ rows: Rows }>('saveGapList.request.json');
      const row = { ...list.rows[0]!, title: '漢'.repeat(1000), evidence: '漢'.repeat(2000) };
      const rows = Math.floor((MAX_REQUEST_BYTES - bytesOf({ ...list, rows: [] })) / (bytesOf(row) + 1));
      large.push({ save: SAVES[1]!, body: { ...list, rows: Array.from({ length: rows }, () => row) }, hint: 'Check the columns that store the rows.' });
    }
    if (has('workspaces')) {
      // Markdown at its 200,000-character limit, in 3-byte characters: about 600 KB of UTF-8.
      const brief = testBody(SAVES[4]!, 'createWorkspaceFromBrief.request.json');
      large.push({
        save: SAVES[4]!,
        body: { ...brief, briefId: 'conformance-check-large-body', businessName: `${TEST_DATA_PREFIX}: Large Body`, markdown: '漢'.repeat(200_000) },
        hint: 'Check the size of the column that stores "markdown": a MySQL TEXT column ends at 64 KB.',
      });
    }
    if (large.length === 0) skip('neither "gapLists" (with a business) nor "workspaces" is enabled for this account');
    await each(large, async ({ save, body, hint }) => {
      if (bytesOf(body) > MAX_REQUEST_BYTES) throw new Error(`The check built a body of ${bytesOf(body)} bytes, which is over the limit of the extension.`);
      const what = `POST ${savePath(save)} with a ${save.operationId === 'createWorkspaceFromBrief' ? 'brief' : save.name} of ${kbOf(body)}`;
      const ifNoReply = `The connection ended while a body of ${kbOf(body)} was sent. Something in front of your API (a proxy, the web server, the framework) probably refuses a body of this size without a reply: accept request bodies of up to 1 MB (1,048,576 bytes).`;
      const reply = await raw('POST', savePath(save), { body, idempotencyKey: randomUUID(), ifNoReply });
      // The summary prints how long these two saves took: this is what validating and storing a large body costs.
      timings.at(-1)!.large = true;
      const item = save.operationId === 'createWorkspaceFromBrief' ? 'brief' : save.name;
      largeSaves.push({ what: `${item} of ${kbOf(body)}`, ms: reply.ms });
      if (reply.ms > limits.slowMs) warn(`the ${item} of ${kbOf(body)} took ${(reply.ms / 1000).toFixed(1)} seconds. The extension stops waiting after ${seconds(limits.requestMs)}, and real bodies arrive over slower connections. Look at how the body is validated and stored.`);
      if (reply.status === 413) fail(`${what}: refused as too large (413). Accept request bodies of up to 1 MB (1,048,576 bytes): raise the limit of your framework or proxy. ${bodyOf(reply)}`);
      if (refusedBody(reply.status)) expectStatus(reply, [200, 201], what, hint);
      expectNewItem(save, savedItem(reply, what).id, what);
    });
  });

  check('C14', 'the same brief sent again is the same workspace (recommended)', async () => {
    needs('workspaces');
    needsWrites();
    const brief = { ...testBody(SAVES[4]!, 'createWorkspaceFromBrief.request.json'), briefId: 'conformance-check-sent-twice', businessName: `${TEST_DATA_PREFIX}: Sent Twice` };
    const first = await raw('POST', WORKSPACE_PATH, { body: brief, idempotencyKey: randomUUID() });
    // The user changed the competitors of the brief and sent it again: a new key, the same briefId.
    const second = await raw('POST', WORKSPACE_PATH, { body: { ...brief, competitors: [] }, idempotencyKey: randomUUID() });
    const one = savedItem(first, `POST ${WORKSPACE_PATH} (a brief)`);
    const two = savedItem(second, `POST ${WORKSPACE_PATH} (the same brief again, with other competitors)`);
    if (one.id !== two.id) warn('the same briefId sent twice created two workspaces. Recommended: update the first one and return its id (unless Legiit decided otherwise).');
  });

  check('C15', 'values that no example has are accepted: a value of a later extension version, a URL with | [ ], an emoji', async () => {
    const targets = needsSaves().filter((save) => unusualValues(save.operationId).length > 0);
    if (targets.length === 0) skip('the only save that is enabled (competitors) has no such values');
    await each(targets, async (save) => {
      const unusual = unusualValues(save.operationId);
      const base = (): Body => {
        const body = clone(firstBody(save));
        return save.operationId === 'createWorkspaceFromBrief' ? { ...body, briefId: 'conformance-check-unusual-values', businessName: `${TEST_DATA_PREFIX}: Unusual Values` } : body;
      };
      const body = base();
      for (const change of unusual) change.apply(body);
      const what = `POST ${savePath(save)} with examples/${firstExample(save)} and values that no example has`;
      const reply = await raw('POST', savePath(save), { body, idempotencyKey: randomUUID() });
      if (!refusedBody(reply.status)) {
        expectNewItem(save, savedItem(reply, what).id, what);
        return;
      }
      // The body was refused. Which of the values is the cause? Each group once more, alone.
      const refused: string[] = [];
      for (const change of unusual) {
        const alone = base();
        change.apply(alone);
        const again = await raw('POST', savePath(save), { body: alone, idempotencyKey: randomUUID() });
        if (refusedBody(again.status)) refused.push(`Sent alone, this part was refused with HTTP ${again.status}: ${change.what}. ${change.rule} ${bodyOf(again)}`);
      }
      fail(`${what}: expected HTTP 200 or 201, got ${reply.status}. ${refused.length > 0 ? refused.join(NEXT_PROBLEM) : `Each part alone was accepted; together they were refused. ${bodyOf(reply)}`}`);
    });
  });

  check('C16', 'an error is not remembered under an Idempotency-Key (recommended)', async () => {
    const enabled = needsSaves();
    const save = enabled.find((s) => !s.deduplicates) ?? enabled[0]!;
    const idempotencyKey = randomUUID();
    const path = savePath(save);
    const refused = await raw('POST', path, { body: {}, idempotencyKey, wrongIfStored: STORED_INVALID });
    if (refused.status !== 400 && refused.status !== 422) fail(`POST ${path} with an empty object: expected HTTP 400 or 422, got ${refused.status} (see C6). So this check cannot say whether an error is remembered.`);
    // The dialog of the extension stays open after an error, and the next click sends the same key again. Here the
    // second request has a valid body, so a server that handles it as a new request stores it.
    const again = await raw('POST', path, { body: firstBody(save), idempotencyKey });
    const what = `POST ${path} with a valid body and the Idempotency-Key of a request that was refused before`;
    if (again.status < 400) {
      expectNewItem(save, savedItem(again, what).id, what);
      return;
    }
    if (again.status >= 500) expectStatus(again, [200, 201], what);
    const how = again.status === refused.status && again.text === refused.text ? `was answered with the same error again (HTTP ${again.status})` : `was refused with HTTP ${again.status}`;
    warn(`a valid ${save.name} ${how}, because its Idempotency-Key came with a request before that was refused (HTTP ${refused.status}). Remember only the reply of a successful save, and do not compare bodies. A user who gets a 429 or a 5xx can otherwise never send again from the same dialog. ${bodyOf(again)}`);
  });

  // ------------------------------------------------------------------------------------------------------------
  group('D. AI rewrite (four calls with the token to the AI endpoint; three of them reach your model)');

  check('D1', 'POST /v1/ai/completions returns text the extension can show as bullet points', async () => {
    needs('ai');
    const what = `POST ${AI_PATH}`;
    const reply = await raw('POST', AI_PATH, { body: example('completeAI.request.json'), timeoutMs: limits.aiMs });
    expectStatus(reply, [200], what);
    expectJson(reply, what);
    expectContract('AiCompletionResponse', reply.json, what);
    const lines = toLines((reply.json as { text: string }).text);
    if (lines.length === 0) fail(`${what}: the reply must contain at least one line of text. ${bodyOf(reply)}`);
    if (lines.length < 3) warn(`the reply has ${plural(lines.length, 'line')}; the prompt asks for 3 to 6 bullet points.`);
  });

  check('D2', 'with responseSchema, the reply text is JSON that the extension can use', async () => {
    needs('ai');
    const what = `POST ${AI_PATH} with responseSchema`;
    const reply = await raw('POST', AI_PATH, { body: example('completeAI.brief.request.json'), timeoutMs: limits.aiMs });
    expectStatus(reply, [200], what);
    expectJson(reply, what);
    expectContract('AiCompletionResponse', reply.json, what);
    const text = (reply.json as { text: string }).text;
    if (parseBriefRewrite(text) === null) {
      fail(`${what}: the extension cannot use this reply. "text" must be a string that holds one JSON object with three avatars (each with name, who, wants, worries) and at least one next step. Got: ${short(text)}`);
    }
  });

  check('D3', 'a request without a prompt answers 400 or 422, not 500', async () => {
    needs('ai');
    const what = `POST ${AI_PATH} without system and prompt`;
    const reply = await raw('POST', AI_PATH, { body: { task: 'rewind' }, timeoutMs: limits.aiMs });
    expectStatus(reply, [400, 422], what);
    expectErrorBody(reply, what);
  });

  check('D4', 'a task name of a later extension version is accepted', async () => {
    needs('ai');
    const what = `POST ${AI_PATH} with task = "a-task-added-later"`;
    const reply = await raw('POST', AI_PATH, { body: { ...example<Body>('completeAI.request.json'), task: 'a-task-added-later' }, timeoutMs: limits.aiMs });
    expectStatus(reply, [200], what, reply.status >= 400 && reply.status < 500 ? `"task" is for your metering and logs. ${LATER_RULE}` : '');
    expectJson(reply, what);
    expectContract('AiCompletionResponse', reply.json, what);
  });

  // ------------------------------------------------------------------------------------------------------------
  const checks = new Map(groups.flatMap((g) => g.checks).map((c) => [c.id, c]));

  /** Why the run cannot start, or an empty text. */
  function problemWithSetup(): string {
    let parsed: URL | null = null;
    try {
      parsed = new URL(options.baseUrl());
    } catch {
      parsed = null;
    }
    if (parsed === null || !/^https?:$/.test(parsed.protocol)) return 'The base URL of the API is not a URL that starts with http:// or https://. Example: npm run api:check -- https://your-staging-host your-test-token';
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return 'The base URL of the API must not contain a user name, a password, a query string or a fragment.';
    if (!/^[\x21-\x7e]{1,4096}$/.test(options.token())) return 'The token is not printable ASCII without spaces of at most 4,096 characters. The extension stores nothing else, so no user can have such a token.';
    return '';
  }

  async function begin(): Promise<void> {
    setupProblem = problemWithSetup();
    if (setupProblem !== '') return;
    // Everything else depends on the session and on a business to work with.
    try {
      session = await client().getSession();
    } catch (error) {
      session = null;
      reachable = !(error instanceof LegiitError && error.code === 'network');
    }
    const chosen = options.businessId?.() || null;
    businessId = chosen;
    if (session?.capabilities.includes('businesses')) {
      try {
        const list = await client().listBusinesses();
        for (const business of list) listedBusinessIds.add(business.id);
        businessId = chosen ?? list[0]?.id ?? null;
      } catch {
        businessId = chosen;
      }
    }
  }

  async function runCheck(id: string): Promise<CheckResult> {
    const found = checks.get(id);
    if (!found) throw new Error(`There is no check called ${id}`);
    const started = Date.now();
    let outcome: CheckResult['outcome'] = 'passed';
    let message = '';
    currentCheck = id;
    try {
      if (setupProblem !== '') {
        if (id === 'A1') fail(setupProblem);
        skip('the check could not start: see A1');
      }
      if (!reachable && id !== 'A1') skip('GET /v1/session got no reply: fix A1 first');
      await found.run();
    } catch (error) {
      if (error instanceof CheckSkipped) {
        outcome = 'skipped';
        message = error.message;
      } else if (error instanceof CheckFailed) {
        outcome = 'failed';
        message = error.message;
      } else {
        outcome = 'failed';
        message = `The check itself stopped with an error. This is a fault of the check, not of your API: please report it. ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
      }
    }
    const result: CheckResult = { id, title: found.title, outcome, message: redact(message), ms: Date.now() - started };
    results.set(id, result);
    return result;
  }

  function end(): ConformanceResult {
    currentCheck = 'Speed';
    // Slow requests, one line for the saves and reads and one for the AI endpoint. The two large saves of C13 have their own line.
    const isAi = (what: string): boolean => what.includes('/v1/ai/');
    for (const ai of [false, true]) {
      // A model needs time: a call to the AI endpoint counts as slow from 20 seconds on.
      const slow = timings.filter((t) => t.status !== null && !t.large && isAi(t.what) === ai && t.ms > (ai ? Math.max(limits.slowMs, 20_000) : limits.slowMs));
      if (slow.length === 0) continue;
      const slowest = slow.reduce((a, b) => (b.ms > a.ms ? b : a));
      const limit = ai ? limits.aiMs : limits.requestMs;
      warn(`${plural(slow.length, 'request')} ${ai ? 'to the AI endpoint ' : ''}took more than ${seconds(ai ? Math.max(limits.slowMs, 20_000) : limits.slowMs)}. The slowest was ${slowest.what} with ${(slowest.ms / 1000).toFixed(1)} seconds. The extension stops waiting after ${seconds(limit)}, and the user looks at "Sending…" all that time.`);
    }

    const ran = groups.flatMap((g) => g.checks).flatMap((c) => results.get(c.id) ?? []);
    const idsOf = (outcome: CheckResult['outcome']): string[] => ran.filter((r) => r.outcome === outcome).map((r) => r.id);
    const [passed, failed, skipped] = [idsOf('passed'), idsOf('failed'), idsOf('skipped')];
    const total = checks.size;
    const notRun = total - ran.length;

    const off = ALL_CAPABILITIES.filter((c) => !has(c));
    const count = (method: string, ai: boolean | null = null): number => timings.filter((t) => t.what.startsWith(`${method} `) && (ai === null || isAi(t.what) === ai)).length;
    const unanswered = timings.filter((t) => t.status === null).length;
    const withoutToken = timings.filter((t) => !t.validToken && !t.what.startsWith('OPTIONS ')).length;
    /** The check cannot open a link: it says where the links point, so that a person can. */
    const linkSummary = (): string => {
      const given = links.filter((link): link is string => link !== null);
      if (given.length === 0) return `none in ${plural(links.length, 'save')}`;
      const hosts = [...new Set(given.map((link) => link.replace(/^(https?:\/\/[^/]+).*$/, '$1')))];
      return `${given.length} of ${plural(links.length, 'save')}, on ${hosts.join(', ')}. The check does not open them: make sure each one leads to a real page, and return null until it does.`;
    };
    const kinds = SAVES.map((save) => ({ name: save.name, items: created.filter((item) => item.kind === save.name) })).filter((kind) => kind.items.length > 0);
    const pluralOf = (name: string): string => (name === 'content analysis' ? 'content analyses' : `${name}s`);
    const describeItem = (item: CreatedItem): string => `${item.kind} ${item.id ?? '(the reply gave no id)'}${item.note ? ` ${item.note}` : ''}`;
    const skipNotes = [...new Set(ran.filter((r) => r.outcome === 'skipped').map((r) => r.message))];
    const result =
      failed.length > 0
        ? `FAILED: ${plural(failed.length, 'check')} of ${total} failed (${failed.join(', ')}). ${passed.length} passed, ${skipped.length} skipped.`
        : skipped.length > 0 || notRun > 0
          ? `no check failed: ${passed.length} of ${total} passed, ${skipped.length} skipped${notRun > 0 ? `, ${notRun} did not run` : ''}. A check that was skipped proves nothing.`
          : `PASSED: all ${total} checks passed, and no check was skipped.`;

    const lines = [
      '',
      'Legiit API conformance summary',
      `  Mode:                  ${options.writes ? 'full run: test data was created in the account' : 'read-only: no save was sent'}`,
      `  API under test:        ${setupProblem === '' ? options.baseUrl() : '(not a URL that can be used)'}`,
      `  Account:               ${session ? `${session.user.name || session.user.email || `user ${session.user.id}`} (plan: ${session.plan ?? 'none'})` : 'NOT CONNECTED: the session could not be read (see A1 and A2)'}`,
      ...(session
        ? [
            `  Capabilities on:       ${session.capabilities.join(', ') || 'none'}`,
            `  Capabilities off:      ${off.join(', ') || 'none'}${off.length ? '  (their checks were skipped, so this run does not prove them)' : ''}`,
          ]
        : ['  Capabilities:          unknown, because the session could not be read']),
      `  Business used:         ${businessId ?? 'none'}`,
      `  Requests sent:         ${timings.length} (${count('GET')} reads, ${count('POST', false)} saves, ${count('POST', true)} to the AI endpoint, ${count('OPTIONS')} preflight), the slowest took ${timings.length ? Math.max(...timings.map((t) => t.ms)) : 0} ms${unanswered > 0 ? `; ${unanswered} got no reply` : ''}`,
      ...(withoutToken > 0 ? [`                         (${withoutToken} of the reads, saves and AI calls carried no valid token: a server refuses them)`] : []),
      ...(largeSaves.length ? [`  Largest saves:         ${largeSaves.map((save) => `${save.what} in ${save.ms.toLocaleString('en-US')} ms`).join(', ')}`] : []),
      `  Created in this run:   ${created.length ? `${plural(created.length, 'item')} (${kinds.map((kind) => plural(kind.items.length, kind.name, pluralOf(kind.name))).join(', ')})` : 'nothing'}`,
      ...kinds.map((kind) => `                         ${kind.items.map(describeItem).join(', ')}`),
      ...(created.length ? [`                         (competitors and workspaces are named "${TEST_DATA_PREFIX}: …")`] : []),
      ...(links.length ? [`  Links returned:        ${linkSummary()}`] : []),
      ...(warnings.length ? ['  Warnings (recommendations, not failures):', ...warnings.map((w) => `    - ${w}`)] : ['  Warnings:              none']),
      ...(skipNotes.length ? ['  Skipped:', ...skipNotes.map((note) => `    - ${ran.filter((r) => r.outcome === 'skipped' && r.message === note).map((r) => r.id).join(', ')}: ${note}`)] : []),
      `  Result:                ${result}`,
      ...(failed.length === 0 && skipped.length > 0 ? ['                         "API done" needs a run in which no check is skipped: all eight capabilities, no --read-only, and --other-business=<id>.'] : []),
      '',
    ];
    return {
      checks: ran,
      warnings: warnings.map(redact),
      requests: timings.map((t) => t.what),
      created: created.map((item) => ({ ...item })),
      summary: redact(lines.join('\n')),
    };
  }

  return { groups: groups.map((g) => ({ title: g.title, checks: g.checks.map((c) => ({ id: c.id, title: c.title })) })), begin, runCheck, end };
}

/** Runs every check and returns the results. Nothing is printed. */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceResult> {
  const run = createConformanceRun(options);
  await run.begin();
  for (const group of run.groups) for (const check of group.checks) await run.runCheck(check.id);
  const result = run.end();
  options.onFinish?.(result);
  return result;
}

/** Registers every check as a vitest test. The summary is printed at the end, or handed to options.onFinish. */
export function defineConformanceSuite(options: ConformanceOptions): void {
  const run = createConformanceRun(options);

  beforeAll(() => run.begin());

  afterAll(() => {
    const result = run.end();
    if (options.onFinish) {
      options.onFinish(result);
      return;
    }
    // The runner (scripts/api-check.mjs) prints the summary after the test results, so it is the last thing on
    // screen, and takes its exit code from the counts. Without the runner the summary goes to the console.
    const summaryFile = process.env['LEGIIT_API_SUMMARY_FILE'];
    const resultFile = process.env['LEGIIT_API_RESULT_FILE'];
    const outcomes = (outcome: CheckResult['outcome']): number => result.checks.filter((c) => c.outcome === outcome).length;
    if (resultFile) writeFileSync(resultFile, JSON.stringify({ passed: outcomes('passed'), failed: outcomes('failed'), skipped: outcomes('skipped'), warnings: result.warnings.length }));
    if (summaryFile) writeFileSync(summaryFile, result.summary);
    else console.log(result.summary);
  });

  for (const group of run.groups) {
    describe(group.title, () => {
      for (const check of group.checks) {
        it(`${check.id.padEnd(3)} ${check.title}`, async (test) => {
          const result = await run.runCheck(check.id);
          if (result.outcome === 'skipped') test.skip(result.message);
          if (result.outcome === 'failed') {
            // Only the message: a stack trace into the code of the check tells a backend developer nothing.
            const failure = new Error(result.message);
            failure.name = 'CheckFailed';
            failure.stack = `CheckFailed: ${result.message}`;
            throw failure;
          }
        });
      }
    });
  }
}
