/**
 * Request handlers for the mock Legiit Command Center API.
 *
 * Pure functions over an in-memory state, shared by:
 *   - the local mock server      (npm run mock → mock-server/server.mjs)
 *   - the Playwright test suite  (requests to the Legiit host are intercepted
 *                                 and answered by these handlers)
 * so both behave exactly like docs/legiit-api-contract.yaml.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'legiit');
const load = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));

/** Tokens the mock understands. Anything else that is non-empty is accepted as a full-access account. */
export const MOCK_TOKENS = {
  valid: 'demo-token',
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
    nextId: 1,
  };
}

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
const error = (status, code, message) => json(status, { error: { code, message } });

function tokenOf(headers) {
  const value = headers.authorization ?? headers.Authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : null;
}

function capabilitiesFor(state, token) {
  if (token === MOCK_TOKENS.limited) return ['businesses', 'visibilitySnapshots', 'industryPulse'];
  return state.session.capabilities;
}

/**
 * @param {ReturnType<typeof createMockState>} state
 * @param {{ method: string, path: string, headers: Record<string, string>, body?: string | null }} request
 * @returns {{ status: number, headers: Record<string, string>, body: string }}
 */
export function handleMockRequest(state, request) {
  const { method } = request;
  const path = request.path.split('?')[0].replace(/\/+$/, '') || '/';
  state.requests.push({ method, path });

  if (method === 'OPTIONS') return { status: 204, headers: {}, body: '' };
  if (path === '/' || path === '/health') return json(200, { ok: true, service: 'legiit-mock' });

  const token = tokenOf(request.headers);
  if (!token) return error(401, 'unauthorised', 'Missing bearer token');
  if (token === MOCK_TOKENS.invalid) return error(401, 'unauthorised', 'Token not recognised');
  const capabilities = capabilitiesFor(state, token);
  const requires = (capability) => (capabilities.includes(capability) ? null : error(404, 'unavailable', `${capability} is not enabled for this account`));

  let body = null;
  if (method === 'POST') {
    try {
      body = JSON.parse(request.body || 'null');
    } catch {
      return error(400, 'bad_request', 'Body is not valid JSON');
    }
    if (body === null || typeof body !== 'object') return error(400, 'bad_request', 'A JSON object is required');
  }
  const save = (bucket, record, urlPath) => {
    const id = `${bucket.slice(0, 3)}_${state.nextId++}`;
    state.saved[bucket].push({ id, ...record });
    return json(201, { id, url: `https://app.legiit.example/command-center/${urlPath}/${id}` });
  };

  if (method === 'GET' && path === '/v1/session') return json(200, { ...state.session, capabilities });

  if (method === 'GET' && path === '/v1/businesses') return requires('businesses') ?? json(200, state.businesses);

  let match = /^\/v1\/businesses\/([^/]+)$/.exec(path);
  if (method === 'GET' && match) {
    const blocked = requires('businesses');
    if (blocked) return blocked;
    const details = state.details[decodeURIComponent(match[1])];
    return details ? json(200, details) : error(404, 'not_found', 'No such business');
  }

  match = /^\/v1\/businesses\/([^/]+)\/(visibility-snapshots|gap-lists|competitors|content-editor\/documents)$/.exec(path);
  if (method === 'POST' && match) {
    const businessId = decodeURIComponent(match[1]);
    if (!state.details[businessId]) return error(404, 'not_found', 'No such business');
    switch (match[2]) {
      case 'visibility-snapshots':
        if (typeof body.keyword !== 'string' || !body.keyword) return error(422, 'invalid', 'keyword is required');
        return requires('visibilitySnapshots') ?? save('visibilitySnapshots', { businessId, payload: body }, 'visibility');
      case 'gap-lists':
        if (!Array.isArray(body.rows)) return error(422, 'invalid', 'rows is required');
        return requires('gapLists') ?? save('gapLists', { businessId, payload: body }, 'gaps');
      case 'competitors':
        if (typeof body.name !== 'string' || !body.name) return error(422, 'invalid', 'name is required');
        return requires('competitors') ?? save('competitors', { businessId, payload: body }, 'competitors');
      default:
        if (typeof body.targetKeyword !== 'string') return error(422, 'invalid', 'targetKeyword is required');
        return requires('contentEditor') ?? save('contentDocuments', { businessId, payload: body }, 'content');
    }
  }

  if (method === 'POST' && path === '/v1/workspaces/from-brief') {
    if (typeof body.businessName !== 'string' || !body.businessName) return error(422, 'invalid', 'businessName is required');
    return requires('workspaces') ?? save('workspaces', { payload: body }, 'workspaces');
  }

  if (method === 'GET' && path === '/v1/industry-pulse') return requires('industryPulse') ?? json(200, state.pulse);

  if (method === 'POST' && path === '/v1/ai/completions') {
    const blocked = requires('ai');
    if (blocked) return blocked;
    if (typeof body.prompt !== 'string' || !body.prompt) return error(422, 'invalid', 'prompt is required');
    state.aiRequests.push(body);
    return json(200, { text: mockCompletion(body), model: 'legiit-mock-1' });
  }

  return error(404, 'not_found', `No route for ${method} ${path}`);
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
    .filter((line) => line && !/^(facts|task|write)\b/i.test(line))
    .slice(0, 3);
  return ['Summary from Legiit AI (mock):', ...facts.map((f) => `- ${f}`)].join('\n');
}
