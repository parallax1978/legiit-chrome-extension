/**
 * Request handlers for the mock Legiit Command Center API.
 *
 * A small reference implementation of docs/legiit-api/openapi.yaml: it does
 * what the contract and docs/legiit-api/README.md ask of the real server, with
 * an in-memory store instead of a database. Pure functions over a state
 * object, shared by:
 *   - the local mock server      (npm run mock → mock-server/server.mjs)
 *   - the Playwright test suite  (requests to the Legiit host are intercepted
 *                                 and answered by these handlers)
 *   - the unit tests and the conformance self-test
 *
 * Reading guide for a backend developer. Each numbered rule of the guide has
 * one place here:
 *   1. 401 is for the token and nothing else              → "The token"
 *   2. a feature that is off answers 404, not "not_found"  → off()
 *   3. a missing business answers 404 "not_found"          → businessOf()
 *   4. a body the contract does not allow answers 422      → problemWith()
 *   5. a repeated Idempotency-Key gets the first reply     → save()
 *   6. a competitor is never stored twice                  → addCompetitor()
 *   7. a brief that is sent again updates its workspace    → createWorkspace()
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_REQUEST_BYTES, problemWith } from './contract.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'legiit');
const load = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));

/** The two tokens the mock accepts. Any other token is answered with 401, like an unknown token on the real API. */
export const MOCK_TOKENS = {
  valid: 'demo-token',
  /** An example of a token that is refused. */
  invalid: 'invalid',
  /** An account with only some features switched on (to exercise "hide unavailable UI"). */
  limited: 'limited-token',
};

export function createMockState() {
  const details = load('business-details.json');
  /** Ids of the competitors each business has, in the order Business Details lists them. */
  const competitorIds = {};
  let seeded = 0;
  for (const [businessId, business] of Object.entries(details)) competitorIds[businessId] = business.competitors.map(() => `com_seed_${++seeded}`);
  return {
    session: load('session.json'),
    businesses: load('businesses.json'),
    details,
    competitorIds,
    pulse: load('industry-pulse.json'),
    /** Everything that was saved, for assertions and for inspection in the server log. */
    saved: { visibilitySnapshots: [], gapLists: [], competitors: [], contentDocuments: [], workspaces: [] },
    aiRequests: [],
    requests: [],
    /** Idempotency-Key → the reply that was given the first time. */
    replies: new Map(),
    nextId: 1,
  };
}

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
/** Every error has the same body. The message is one plain sentence of at most 200 characters. */
const error = (status, code, message) => json(status, { error: { code, message: message.length > 200 ? `${message.slice(0, 199)}…` : message } });

function header(headers, name) {
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return found ? String(headers[found] ?? '') : '';
}

function tokenOf(headers) {
  // The scheme is matched without regard to case, as HTTP asks.
  const match = /^Bearer\s+(\S+)$/i.exec(header(headers, 'authorization').trim());
  return match ? match[1] : null;
}

function capabilitiesFor(state, token) {
  if (token === MOCK_TOKENS.limited) return ['businesses', 'visibilitySnapshots', 'industryPulse'];
  return state.session.capabilities;
}

/** A domain as it is compared: lower case, without scheme, "www." and path. A subdomain is a different domain. */
const host = (value) => String(value).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');
/** A name as it is compared: without regard to case and surrounding spaces. */
const nameKey = (value) => String(value).trim().toLowerCase();

/** The four saves into a business: what the body is checked against and where it is kept. */
const BUSINESS_SAVES = {
  'visibility-snapshots': { capability: 'visibilitySnapshots', schema: 'VisibilitySnapshot', bucket: 'visibilitySnapshots', page: 'visibility' },
  'gap-lists': { capability: 'gapLists', schema: 'GapList', bucket: 'gapLists', page: 'gaps' },
  competitors: { capability: 'competitors', schema: 'Competitor', bucket: 'competitors', page: 'competitors' },
  'content-editor/documents': { capability: 'contentEditor', schema: 'ContentEditorDocument', bucket: 'contentDocuments', page: 'content' },
};

/**
 * @param {ReturnType<typeof createMockState>} state
 * @param {{ method: string, path: string, headers: Record<string, string>, body?: string | null }} request
 * @returns {{ status: number, headers: Record<string, string>, body: string }}
 */
export function handleMockRequest(state, request) {
  const { method } = request;
  // The extension never sends a query string or a trailing slash; tolerating them is a convenience of the mock.
  const path = request.path.split('?')[0].replace(/\/+$/, '') || '/';
  const idempotencyKey = header(request.headers, 'idempotency-key');
  state.requests.push({ method, path, idempotencyKey: idempotencyKey || null });

  // Not part of the contract: a preflight answer for browser tools, and a health page.
  if (method === 'OPTIONS') return { status: 204, headers: {}, body: '' };
  if (path === '/' || path === '/health') return json(200, { ok: true, service: 'legiit-mock' });

  // --- The token. 401 is for the token and nothing else, and it always carries the error body.
  const token = tokenOf(request.headers);
  if (!token) return error(401, 'unauthorised', 'Missing bearer token');
  if (token !== MOCK_TOKENS.valid && token !== MOCK_TOKENS.limited) return error(401, 'unauthorised', 'Token not recognised');
  const capabilities = capabilitiesFor(state, token);

  /** A feature that is off answers like an endpoint that does not exist: 404, and never with the code "not_found". */
  const off = (capability) => (capabilities.includes(capability) ? null : error(404, 'not_available', `${capability} is not enabled for this account`));

  /** The business a path names, or null. "not_found" is reserved for this case. An id that cannot exist is simply not found. */
  const businessOf = (encoded) => {
    let id;
    try {
      id = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    return Object.hasOwn(state.details, id) ? { id, details: state.details[id] } : null;
  };
  const noSuchBusiness = () => error(404, 'not_found', 'No such business');

  let body = null;
  if (method === 'POST') {
    // The extension never sends more than 1 MB; a server has to accept that much.
    if (Buffer.byteLength(request.body ?? '', 'utf8') > MAX_REQUEST_BYTES) return error(413, 'too_large', 'The request body is larger than 1 MB');
    try {
      body = JSON.parse(request.body || 'null');
    } catch {
      return error(400, 'bad_request', 'The body is not valid JSON');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return error(400, 'bad_request', 'A JSON object is required');
  }

  /**
   * Stores one item and answers with its id and address.
   *
   * A reply to a successful save is remembered under its Idempotency-Key (per token, method and path). The same
   * key again gets that reply again and nothing is stored. Errors are never remembered: after an error the
   * extension sends the same key with the same body once more, and that attempt must be handled afresh.
   * A save without the header is valid (curl and the conformance check send some).
   */
  const save = (page, store) => {
    const replyKey = idempotencyKey ? `${token} ${method} ${path} ${idempotencyKey}` : null;
    if (replyKey && state.replies.has(replyKey)) return state.replies.get(replyKey);
    const { id, created } = store();
    const reply = json(created ? 201 : 200, { id, url: `https://app.legiit.example/command-center/${page}/${id}` });
    if (replyKey) state.replies.set(replyKey, reply);
    return reply;
  };
  const newId = (bucket) => `${bucket.slice(0, 3)}_${state.nextId++}`;

  if (method === 'GET' && path === '/v1/session') return json(200, { ...state.session, capabilities });

  if (method === 'GET' && path === '/v1/businesses') return off('businesses') ?? json(200, state.businesses);

  let match = /^\/v1\/businesses\/([^/]+)$/.exec(path);
  if (method === 'GET' && match) {
    const blocked = off('businesses');
    if (blocked) return blocked;
    const business = businessOf(match[1]);
    return business ? json(200, business.details) : noSuchBusiness();
  }

  match = /^\/v1\/businesses\/([^/]+)\/(visibility-snapshots|gap-lists|competitors|content-editor\/documents)$/.exec(path);
  if (method === 'POST' && match) {
    const kind = BUSINESS_SAVES[match[2]];
    const blocked = off(kind.capability);
    if (blocked) return blocked;
    const business = businessOf(match[1]);
    if (!business) return noSuchBusiness();
    const problem = problemWith(kind.schema, body);
    if (problem) return error(422, 'invalid', problem);
    if (kind.bucket === 'competitors') return save(kind.page, () => addCompetitor(state, business, body));
    // A snapshot, a gap list or a content analysis that arrives again under a new key is a new item: no de-duplication by content.
    return save(kind.page, () => {
      const id = newId(kind.bucket);
      state.saved[kind.bucket].push({ id, businessId: business.id, payload: body });
      return { id, created: true };
    });
  }

  if (method === 'POST' && path === '/v1/workspaces/from-brief') {
    const blocked = off('workspaces');
    if (blocked) return blocked;
    const problem = problemWith('WorkspaceFromBrief', body);
    if (problem) return error(422, 'invalid', problem);
    return save('workspaces', () => createWorkspace(state, token, body, newId));
  }

  if (method === 'GET' && path === '/v1/industry-pulse') return off('industryPulse') ?? json(200, state.pulse);

  if (method === 'POST' && path === '/v1/ai/completions') {
    const blocked = off('ai');
    if (blocked) return blocked;
    const problem = problemWith('AiCompletionRequest', body);
    if (problem) return error(422, 'invalid', problem);
    state.aiRequests.push(body);
    return json(200, { text: mockCompletion(body), model: 'legiit-mock-1' });
  }

  // An unknown path or a wrong method: 404 (or 405) without the code "not_found".
  return error(404, 'not_available', `No route for ${method} ${path}`);
}

/**
 * Adds a competitor to a business, once. A competitor the business already has (the same name without regard to
 * case, or one of the same domains; a name match wins) keeps its name, gains the domains it did not have, and its
 * id is returned with 200. A new one is listed in Business Details at once.
 */
function addCompetitor(state, business, body) {
  const list = business.details.competitors;
  const ids = state.competitorIds[business.id];
  const domains = [...new Set(body.domains.map(host).filter(Boolean))];
  let index = list.findIndex((c) => nameKey(c.name) === nameKey(body.name));
  if (index < 0) index = list.findIndex((c) => (c.domains ?? []).map(host).some((d) => domains.includes(d)));
  if (index >= 0) {
    const known = list[index];
    known.domains = [...new Set([...(known.domains ?? []), ...domains])].slice(0, 30);
    return { id: ids[index], created: false };
  }
  const id = `com_${state.nextId++}`;
  list.push({ name: body.name.trim(), domains });
  ids.push(id);
  state.saved.competitors.push({ id, businessId: business.id, payload: body });
  return { id, created: true };
}

/**
 * Creates a workspace from a brief. The same briefId from the same account is the same brief sent again (after
 * the user changed its competitors, for example): the workspace is updated and its id is returned with 200.
 * A briefId is only unique on one user's device, so it is looked up per account, never globally.
 */
function createWorkspace(state, token, body, newId) {
  const existing = state.saved.workspaces.find((w) => w.account === token && w.payload.briefId === body.briefId);
  if (existing) {
    existing.payload = body;
    return { id: existing.id, created: false };
  }
  const id = newId('workspaces');
  state.saved.workspaces.push({ id, account: token, payload: body });
  return { id, created: true };
}

/** A deterministic stand-in for a model: restates the first facts it was given, the way a real reply should look. */
function mockCompletion(request) {
  if (request.responseSchema) {
    // One JSON document, as a string, with nothing before or after it.
    return JSON.stringify({
      avatars: [1, 2, 3].map((n) => ({
        name: `Mock avatar ${n}`,
        who: `A customer described by the mock model (${n}).`,
        wants: 'Clear prices and fast answers.',
        worries: 'Wasting time.',
        searches: ['example search'],
        proof: 'The site shows reviews.',
      })),
      nextSteps: ['Mock step one from Legiit AI.', 'Mock step two from Legiit AI.'],
    });
  }
  // Three to six short lines, one point per line, no heading and no introduction.
  const facts = String(request.prompt)
    .split('\n')
    .filter((line) => /^\s*-\s+\S/.test(line))
    .map((line) => line.replace(/^\s*-\s+/, '').trim())
    .slice(0, 4);
  const lines = facts.length >= 3 ? facts : [...facts, 'The mock model has no more facts to restate.', 'A real model would write three to six points here.', 'Each point is one short line.'].slice(0, 3);
  return lines.map((line) => `- ${line}`).join('\n');
}
