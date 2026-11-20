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
  return {
    session: load('session.json'),
    businesses: load('businesses.json'),
    details: load('business-details.json'),
    pulse: load('industry-pulse.json'),
    /** Everything that was saved, for assertions and for inspection in the server log. */
    saved: { visibilitySnapshots: [], gapLists: [], competitors: [], contentDocuments: [], workspaces: [] },
    aiRequests: [],
    requests: [],
    /** Idempotency-Key → the reply that was given the first time, per token. */
    replies: new Map(),
    nextId: 1,
  };
}

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
const error = (status, code, message) => json(status, { error: { code, message } });

function header(headers, name) {
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return found ? String(headers[found] ?? '') : '';
}

function tokenOf(headers) {
  const match = /^Bearer\s+(.+)$/i.exec(header(headers, 'authorization'));
  return match ? match[1].trim() : null;
}

function capabilitiesFor(state, token) {
  if (token === MOCK_TOKENS.limited) return ['businesses', 'visibilitySnapshots', 'industryPulse'];
  return state.session.capabilities;
}

const normalDomain = (value) => String(value).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

/** The five saves: path → what the body is checked against and where it is kept. */
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
  const path = request.path.split('?')[0].replace(/\/+$/, '') || '/';
  state.requests.push({ method, path, idempotencyKey: header(request.headers, 'idempotency-key') || null });

  if (method === 'OPTIONS') return { status: 204, headers: {}, body: '' };
  if (path === '/' || path === '/health') return json(200, { ok: true, service: 'legiit-mock' });

  // 401 is for the token and nothing else.
  const token = tokenOf(request.headers);
  if (!token) return error(401, 'unauthorised', 'Missing bearer token');
  if (token !== MOCK_TOKENS.valid && token !== MOCK_TOKENS.limited) return error(401, 'unauthorised', 'Token not recognised');
  const capabilities = capabilitiesFor(state, token);
  // A feature that is off answers like an endpoint that does not exist: 404 without the code "not_found".
  const off = (capability) => (capabilities.includes(capability) ? null : error(404, 'not_available', `${capability} is not enabled for this account`));

  let body = null;
  if (method === 'POST') {
    if (Buffer.byteLength(request.body ?? '', 'utf8') > MAX_REQUEST_BYTES) return error(413, 'too_large', 'The request body is larger than 1 MB');
    try {
      body = JSON.parse(request.body || 'null');
    } catch {
      return error(400, 'bad_request', 'The body is not valid JSON');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return error(400, 'bad_request', 'A JSON object is required');
  }

  /** Stores an item once per Idempotency-Key: a repeated key gets the first reply again and nothing new is stored. */
  const save = (bucket, record, page, existingId = null) => {
    const key = header(request.headers, 'idempotency-key');
    const replyKey = key ? `${token} ${method} ${path} ${key}` : null;
    if (replyKey && state.replies.has(replyKey)) return state.replies.get(replyKey);
    const id = existingId ?? `${bucket.slice(0, 3)}_${state.nextId++}`;
    if (!existingId) state.saved[bucket].push({ id, ...record });
    const reply = json(existingId ? 200 : 201, { id, url: `https://app.legiit.example/command-center/${page}/${id}` });
    if (replyKey) state.replies.set(replyKey, reply);
    return reply;
  };

  if (method === 'GET' && path === '/v1/session') return json(200, { ...state.session, capabilities });

  if (method === 'GET' && path === '/v1/businesses') return off('businesses') ?? json(200, state.businesses);

  let match = /^\/v1\/businesses\/([^/]+)$/.exec(path);
  if (method === 'GET' && match) {
    const blocked = off('businesses');
    if (blocked) return blocked;
    const details = state.details[decodeURIComponent(match[1])];
    return details ? json(200, details) : error(404, 'not_found', 'No such business');
  }

  match = /^\/v1\/businesses\/([^/]+)\/(visibility-snapshots|gap-lists|competitors|content-editor\/documents)$/.exec(path);
  if (method === 'POST' && match) {
    const businessId = decodeURIComponent(match[1]);
    const kind = BUSINESS_SAVES[match[2]];
    const blocked = off(kind.capability);
    if (blocked) return blocked;
    const details = state.details[businessId];
    if (!details) return error(404, 'not_found', 'No such business');
    const problem = problemWith(kind.schema, body);
    if (problem) return error(422, 'invalid', problem);

    if (kind.bucket !== 'competitors') return save(kind.bucket, { businessId, payload: body }, kind.page);

    // A competitor the business already has is not added twice; a new one shows up in Business Details.
    const domains = body.domains.map(normalDomain).filter(Boolean);
    const known = state.saved.competitors.find(
      (c) => c.businessId === businessId && (c.payload.name.trim().toLowerCase() === body.name.trim().toLowerCase() || c.payload.domains.map(normalDomain).some((d) => domains.includes(d))),
    );
    if (known) return save('competitors', {}, kind.page, known.id);
    const listed = details.competitors.some((c) => c.name.trim().toLowerCase() === body.name.trim().toLowerCase() || (c.domains ?? []).map(normalDomain).some((d) => domains.includes(d)));
    if (!listed) details.competitors.push({ name: body.name.trim(), domains });
    return save('competitors', { businessId, payload: body }, kind.page);
  }

  if (method === 'POST' && path === '/v1/workspaces/from-brief') {
    const blocked = off('workspaces');
    if (blocked) return blocked;
    const problem = problemWith('WorkspaceFromBrief', body);
    if (problem) return error(422, 'invalid', problem);
    return save('workspaces', { payload: body }, 'workspaces');
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

  return error(404, 'not_available', `No route for ${method} ${path}`);
}

/** A deterministic stand-in for a model: restates the first facts it was given. */
function mockCompletion(request) {
  if (request.responseSchema) {
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
  const facts = String(request.prompt)
    .split('\n')
    .map((line) => line.replace(/^[-•]\s*/, '').trim())
    .filter((line) => line && !/^(<\/?facts>|task:|reply with)/i.test(line))
    .slice(0, 3);
  return ['Summary from Legiit AI (mock):', ...facts.map((f) => `- ${f}`)].join('\n');
}
