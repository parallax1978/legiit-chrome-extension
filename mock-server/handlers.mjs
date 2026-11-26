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
 * Reading guide for a backend developer: the main rules of the guide
 * (docs/legiit-api/README.md), and where each one is implemented here.
 *   401 is for the token and nothing else (section 3)             → "The token"
 *   a feature that is off answers 404, not "not_found" (4, 5)      → off()
 *   a missing business answers 404 "not_found" (5)                 → businessOf()
 *   a business of another user gets the same answer (5)            → businessOf(), MOCK_OTHER_BUSINESS_ID
 *   a body over 1 MB answers 413, one that is not JSON 400 (3, 5)  → "The body"
 *   a body the contract does not allow answers 422 (3)             → problemWith()
 *   a repeated Idempotency-Key gets the first reply (3)            → remembered(), save()
 *   a competitor is never stored twice (reference, endpoint 6)     → addCompetitor()
 *   a brief that is sent again replaces its workspace (endpoint 8) → createWorkspace()
 *   every reply carries the CORS headers (3)                       → CORS_HEADERS
 *   an email is kept and gets a code; the code gets a token (11, 12) → startSignup(), verifySignup()
 * The order of the checks is the one section 5 gives: token, body size, JSON syntax, endpoint and capability,
 * business, remembered reply, fields.
 * Everything that is "per user" (capabilities, remembered replies, briefs) is looked up by the user the token
 * belongs to, never by the token: a user can have several tokens.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_REQUEST_BYTES, problemWith } from './contract.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'legiit');
const load = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));

/** The two tokens the mock accepts. Any other token is answered with 401, like an unknown token on the real API. */
export const MOCK_TOKENS = {
  /** The first user: every feature switched on. */
  valid: 'demo-token',
  /** An example of a token that is refused. */
  invalid: 'invalid',
  /** A second user, on a plan with only some features (to exercise "hide unavailable UI"). */
  limited: 'limited-token',
};

/**
 * A business of the second user alone. The token of the first user cannot reach it: the mock answers 404
 * "not_found", exactly as for a business that does not exist. Every other business of the mock is shared by both
 * users. Use this id to try the option --other-business of the conformance check against the mock.
 */
export const MOCK_OTHER_BUSINESS_ID = 'biz_harborview';

/**
 * Sent with every reply, errors and the answer to a preflight included (guide, section 3, "CORS"). The extension
 * normally needs none of them, because the API host is one of its host permissions. They are a safety net: a user
 * can switch that access off in Chrome, and then every request is preflighted like a web page's. Allowing any
 * origin is safe, because no cookies are used: the token is the only credential.
 */
export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, x-legiit-client, idempotency-key',
  'access-control-max-age': '600',
};

export function createMockState() {
  const details = load('business-details.json');
  /** Ids of the competitors each business has, in the order Business Details lists them. */
  const competitorIds = {};
  let seeded = 0;
  for (const [businessId, business] of Object.entries(details)) competitorIds[businessId] = business.competitors.map(() => `com_seed_${++seeded}`);
  competitorIds[MOCK_OTHER_BUSINESS_ID] = [];
  return {
    /** The user of "demo-token". */
    session: load('session.json'),
    /** The user of "limited-token": a colleague in the same agency. Both can save into the shared businesses; this user also has one alone. */
    limitedSession: { user: { id: 'usr_demo_2', name: 'Sam Rivera', email: 'sam@northstarseo.example' }, plan: 'starter', capabilities: ['businesses', 'visibilitySnapshots', 'industryPulse'] },
    /** The businesses that both users can read and save into. */
    businesses: load('businesses.json'),
    details,
    /** Business Details of the businesses that belong to one user alone, by user id. */
    ownDetails: {
      usr_demo_2: {
        [MOCK_OTHER_BUSINESS_ID]: { id: MOCK_OTHER_BUSINESS_ID, name: 'Harborview Physio', brandNames: ['Harborview Physio'], domains: ['harborviewphysio.example'], competitors: [], focusKeywords: [], avatars: [] },
      },
    },
    competitorIds,
    pulse: load('industry-pulse.json'),
    /** Everything that was saved, for assertions and for inspection in the server log. */
    saved: { visibilitySnapshots: [], gapLists: [], competitors: [], contentDocuments: [], workspaces: [] },
    aiRequests: [],
    requests: [],
    /** Idempotency-Key → the reply that was given the first time. */
    replies: new Map(),
    nextId: 1,
    /** Accounts created from the extension's first screen: token → session. */
    accounts: new Map(),
    /** Email addresses from the first screen (the leads), with their latest code: lower-case address → sign-up. */
    signups: new Map(),
  };
}

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
/** Every error has the same body. The message is one plain sentence of at most 200 characters. */
const error = (status, code, message) => json(status, { error: { code, message: message.length > 200 ? `${message.slice(0, 199)}…` : message } });

function header(headers, name) {
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return found ? String(headers[found] ?? '') : '';
}

/**
 * The token of a request, or null. The header is "Authorization: Bearer <token>": the word Bearer (case-insensitive,
 * as HTTP asks), exactly one space, the token. Anything else is no token, and is answered with 401.
 */
function tokenOf(headers) {
  const match = /^Bearer (\S+)$/i.exec(header(headers, 'authorization'));
  return match ? match[1] : null;
}

/** The session of the user a token belongs to, or null for a token that is not known. */
function sessionFor(state, token) {
  if (token === MOCK_TOKENS.valid) return state.session;
  if (token === MOCK_TOKENS.limited) return state.limitedSession;
  return state.accounts.get(token) ?? null;
}

/** What a new free account of the mock gets: it has no business yet, so no feature that saves into one. */
export const MOCK_NEW_ACCOUNT_CAPABILITIES = ['workspaces', 'industryPulse', 'ai'];

/** The code the mock "emails". A real server sends a random 6-digit code, valid for 30 minutes. */
export const MOCK_SIGNUP_CODE = '246810';

/**
 * POST /v1/signups: keeps the address as a lead and "emails" a code. No account is created here, and the reply is
 * the same whether or not the address has an account.
 */
function startSignup(state, body) {
  const problem = problemWith('SignupRequest', body);
  if (problem) return error(422, 'invalid', problem);
  const email = body.email.trim();
  state.signups.set(email.toLowerCase(), { email, code: MOCK_SIGNUP_CODE, wrong: 0 });
  return json(202, { status: 'code_sent' });
}

/** The session of the account that an address already has, with its token, or null. */
function accountOf(state, email) {
  const key = email.toLowerCase();
  if ((state.session.user.email ?? '').toLowerCase() === key) return MOCK_TOKENS.valid;
  if ((state.limitedSession.user.email ?? '').toLowerCase() === key) return MOCK_TOKENS.limited;
  for (const [token, session] of state.accounts) if ((session.user.email ?? '').toLowerCase() === key) return token;
  return null;
}

/**
 * POST /v1/signups/verify: the code proves the inbox. A new address gets a new free account (201), an address with
 * an account gets a token for it (200). Five wrong codes end the sign-up.
 */
function verifySignup(state, body) {
  const problem = problemWith('SignupVerification', body);
  if (problem) return error(422, 'invalid', problem);
  const key = body.email.trim().toLowerCase();
  const signup = state.signups.get(key);
  if (!signup || signup.wrong >= 5) return error(422, 'no_code', 'This code no longer works: ask for a new code.');
  if (body.code !== signup.code) {
    signup.wrong += 1;
    return error(422, 'wrong_code', 'That code is not right: check the email and try again.');
  }
  state.signups.delete(key);
  const existing = accountOf(state, key);
  if (existing) return json(200, { token: existing });
  // Counted apart from the saved items, so that a new account does not change the ids of the examples.
  const n = state.accounts.size + 1;
  const token = `lgt_mock_${String(n).padStart(4, '0')}_${key.replace(/[^a-z0-9]/g, '').slice(0, 24)}`;
  state.accounts.set(token, { user: { id: `usr_new_${n}`, name: '', email: signup.email }, plan: 'free', capabilities: [...MOCK_NEW_ACCOUNT_CAPABILITIES] });
  return json(201, { token });
}

/** A domain as it is compared: lower case, without scheme, "www." and path. A subdomain is a different domain. */
const host = (value) => String(value).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');
/** A name as it is compared: case-insensitive, without surrounding spaces. */
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
  const reply = answer(state, request);
  return { ...reply, headers: { ...reply.headers, ...CORS_HEADERS } };
}

function answer(state, request) {
  const { method } = request;
  // The extension never sends a query string or a trailing slash; tolerating them is a convenience of the mock.
  const path = request.path.split('?')[0].replace(/\/+$/, '') || '/';
  const idempotencyKey = header(request.headers, 'idempotency-key');
  state.requests.push({ method, path, idempotencyKey: idempotencyKey || null });

  // A preflight is answered on every path, without asking for a token. The health page is not part of the contract.
  if (method === 'OPTIONS') return { status: 204, headers: {}, body: '' };
  if (path === '/' || path === '/health') return json(200, { ok: true, service: 'legiit-mock' });

  // --- Signing up. The two calls without a token: the email address and the code are all there is.
  if (method === 'POST' && (path === '/v1/signups' || path === '/v1/signups/verify')) {
    if (Buffer.byteLength(request.body ?? '', 'utf8') > MAX_REQUEST_BYTES) return error(413, 'too_large', 'The request body is larger than 1 MB');
    let signup;
    try {
      signup = JSON.parse(request.body || 'null');
    } catch {
      return error(400, 'bad_request', 'The body is not valid JSON');
    }
    if (signup === null || typeof signup !== 'object' || Array.isArray(signup)) return error(400, 'bad_request', 'A JSON object is required');
    return path === '/v1/signups' ? startSignup(state, signup) : verifySignup(state, signup);
  }

  // --- The token. 401 is for the token and nothing else, and it always carries the error body.
  const token = tokenOf(request.headers);
  if (!token) return error(401, 'unauthorised', 'Missing bearer token');
  const session = sessionFor(state, token);
  if (!session) return error(401, 'unauthorised', 'Token not recognised');
  const { capabilities } = session;
  const userId = session.user.id;

  /** A feature that is off answers like an endpoint that does not exist: 404, and never with the code "not_found". */
  const off = (capability) => (capabilities.includes(capability) ? null : error(404, 'not_available', `${capability} is not enabled for this account`));

  /** The businesses of this user alone. They come after the shared ones in the list. */
  const own = state.ownDetails[userId] ?? {};
  /**
   * The business a path names, or null. "not_found" is reserved for this case. An id that cannot exist is simply
   * not found, and so is a business of another user: the reply does not reveal that it exists.
   */
  const businessOf = (encoded) => {
    let id;
    try {
      id = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (Object.hasOwn(state.details, id)) return { id, details: state.details[id] };
    return Object.hasOwn(own, id) ? { id, details: own[id] } : null;
  };
  const noSuchBusiness = () => error(404, 'not_found', 'No such business');

  // --- The body.
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
   * A reply to a successful save is remembered under its Idempotency-Key (per user, method and path). The same
   * key again gets that reply again: it takes the place of validating and storing the body, so it is looked up
   * after the token, the capability and the business were checked and before the fields are. Errors are never
   * remembered: after an error the extension sends the same key with the same body once more, and that attempt
   * must be handled afresh. A save without the header is valid (curl and the conformance check send some).
   */
  const replyKey = idempotencyKey ? `${userId} ${method} ${path} ${idempotencyKey}` : null;
  const remembered = () => (replyKey ? (state.replies.get(replyKey) ?? null) : null);
  /** Stores one item and answers with its id and its URL. */
  const save = (page, store) => {
    const { id, created } = store();
    const reply = json(created ? 201 : 200, { id, url: `https://app.legiit.example/command-center/${page}/${id}` });
    if (replyKey) state.replies.set(replyKey, reply);
    return reply;
  };
  const newId = (bucket) => `${bucket.slice(0, 3)}_${state.nextId++}`;

  if (method === 'GET' && path === '/v1/session') return json(200, session);

  if (method === 'GET' && path === '/v1/businesses') {
    const mine = Object.values(own).map((b) => ({ id: b.id, name: b.name, domain: b.domains[0] ?? null }));
    return off('businesses') ?? json(200, mine.length > 0 ? { ...state.businesses, businesses: [...state.businesses.businesses, ...mine] } : state.businesses);
  }

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
    const again = remembered();
    if (again) return again;
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
    const again = remembered();
    if (again) return again;
    const problem = problemWith('WorkspaceFromBrief', body);
    if (problem) return error(422, 'invalid', problem);
    return save('workspaces', () => createWorkspace(state, userId, body, newId));
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
 * Adds a competitor to a business, once. A competitor the business already has keeps its name, gains the domains
 * it did not have, and its id is returned with 200. "Already has" means: the same name (case-insensitive), or else
 * one of the same domains. A name match wins over a domain match. When no name matches and the domains of the
 * request belong to different competitors, the first domain of the request that a competitor already has decides.
 * A domain that another competitor of the business already has stays with that one: no two competitors of a
 * business share a domain. A new competitor is listed in Business Details at once.
 */
function addCompetitor(state, business, body) {
  const list = business.details.competitors;
  const ids = state.competitorIds[business.id];
  const domains = [...new Set(body.domains.map(host).filter(Boolean))];
  const ownerOf = (domain) => list.findIndex((c) => (c.domains ?? []).map(host).includes(domain));
  let index = list.findIndex((c) => nameKey(c.name) === nameKey(body.name));
  // The domains are tried in the order of the request, not in the order of the stored competitors.
  for (let i = 0; index < 0 && i < domains.length; i += 1) index = ownerOf(domains[i]);
  if (index >= 0) {
    const known = list[index];
    const taken = new Set(list.flatMap((c, i) => (i === index ? [] : (c.domains ?? []).map(host))));
    known.domains = [...new Set([...(known.domains ?? []), ...domains.filter((d) => !taken.has(d))])].slice(0, 30);
    return { id: ids[index], created: false };
  }
  const id = `com_${state.nextId++}`;
  list.push({ name: body.name.trim(), domains });
  ids.push(id);
  state.saved.competitors.push({ id, businessId: business.id, payload: body });
  return { id, created: true };
}

/**
 * Creates a workspace from a brief. The same briefId from the same user is the same brief sent again (after the
 * user changed its competitors, for example): the stored brief is replaced by the new one and the id of the
 * workspace is returned with 200. A briefId is only unique on one user's device, so it is looked up per user,
 * never globally.
 */
function createWorkspace(state, userId, body, newId) {
  const existing = state.saved.workspaces.find((w) => w.userId === userId && w.payload.briefId === body.briefId);
  if (existing) {
    existing.payload = body;
    return { id: existing.id, created: false };
  }
  const id = newId('workspaces');
  state.saved.workspaces.push({ id, userId, payload: body });
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
