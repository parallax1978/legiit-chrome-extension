// @vitest-environment node
/**
 * Rules of the mock server (the reference implementation of the guide) that
 * the conformance check does not exercise: the exact form of the
 * Authorization header, the rule for a competitor whose domains belong to
 * different competitors, a body of any size over 1 MB, and how the server
 * program starts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockState, handleMockRequest, MOCK_TOKENS } from '@@/mock-server/handlers.mjs';
import { createMockServer } from '@@/mock-server/http.mjs';

const ROOT = resolve(__dirname, '../..');
const BUSINESS = 'biz_brightpath';

describe('the Authorization header: the word Bearer, exactly one space, the token', () => {
  const session = (authorization: string | undefined) => handleMockRequest(createMockState(), { method: 'GET', path: '/v1/session', headers: authorization === undefined ? {} : { Authorization: authorization } });

  it('accepts the word in any letter case', () => {
    for (const value of ['Bearer demo-token', 'bearer demo-token', 'BEARER demo-token', 'bEaReR demo-token', 'Bearer limited-token']) expect(session(value).status, value).toBe(200);
  });

  it('answers 401 with the error body to anything else', () => {
    const refused: (string | undefined)[] = [
      undefined,
      '',
      'demo-token',
      'Bearer',
      'Bearer ',
      'Bearer  demo-token',
      'Bearer\tdemo-token',
      ' Bearer demo-token',
      'Bearer demo-token ',
      'Bearer demo token',
      'Bearerdemo-token',
      'Basic demo-token',
      'Token demo-token',
      'Bearer invalid',
      'Bearer DEMO-TOKEN',
    ];
    for (const value of refused) {
      const reply = session(value);
      expect(reply.status, JSON.stringify(value)).toBe(401);
      expect(reply.headers['content-type']).toContain('application/json');
      expect(JSON.parse(reply.body)).toEqual({ error: { code: 'unauthorised', message: expect.stringMatching(/^(Missing bearer token|Token not recognised)$/) } });
    }
  });
});

describe('adding a competitor: which competitor is returned', () => {
  const setup = () => {
    const state = createMockState();
    const add = (body: { name: string; domains: string[] }) => {
      const reply = handleMockRequest(state, { method: 'POST', path: `/v1/businesses/${BUSINESS}/competitors`, headers: { authorization: `Bearer ${MOCK_TOKENS.valid}` }, body: JSON.stringify(body) });
      return { status: reply.status, id: (JSON.parse(reply.body) as { id: string }).id };
    };
    const competitors = (): { name: string; domains: string[] }[] => state.details[BUSINESS]!.competitors as { name: string; domains: string[] }[];
    return { state, add, competitors };
  };
  // The business has, in this order: Lakeside Smiles (com_seed_1), Capitol Dental Care (com_seed_2), Zilker Family Dentistry (com_seed_3).
  const LAKESIDE = 'lakesidesmiles.example';
  const CAPITOL = 'capitoldentalcare.example';
  const ZILKER = 'zilkerfamilydentistry.example';

  it('no name matches and the domains belong to different competitors: the first domain of the request that a competitor has decides', () => {
    const { add, competitors } = setup();
    // Capitol Dental Care is the second competitor of the business, but its domain comes first in the request.
    expect(add({ name: 'A New Name', domains: [CAPITOL, LAKESIDE] })).toEqual({ status: 200, id: 'com_seed_2' });
    // The other order gives the other competitor.
    expect(add({ name: 'Another New Name', domains: [LAKESIDE, CAPITOL] })).toEqual({ status: 200, id: 'com_seed_1' });
    // A domain that nobody has does not decide: the first domain that a competitor already has does.
    expect(add({ name: 'A Third Name', domains: ['new-site.example', ZILKER, LAKESIDE] })).toEqual({ status: 200, id: 'com_seed_3' });
    // Nothing was added, no name changed, and no domain moved to another competitor.
    expect(competitors().map((c) => c.name)).toEqual(['Lakeside Smiles', 'Capitol Dental Care', 'Zilker Family Dentistry']);
    expect(competitors().map((c) => c.domains)).toEqual([[LAKESIDE], [CAPITOL], [ZILKER, 'new-site.example']]);
  });

  it('the domains are compared as hosts, in the order of the request', () => {
    const { add } = setup();
    expect(add({ name: 'Spelt Otherwise', domains: [`https://www.${ZILKER.toUpperCase()}/about`, CAPITOL] })).toEqual({ status: 200, id: 'com_seed_3' });
    // A subdomain is another domain: it belongs to nobody, so the second domain decides.
    expect(add({ name: 'With A Subdomain', domains: [`blog.${LAKESIDE}`, CAPITOL] })).toEqual({ status: 200, id: 'com_seed_2' });
  });

  it('the other rules stay: a name match wins over a domain match, and a domain stays with the competitor that has it', () => {
    const { add, competitors, state } = setup();
    // The name is the one of the third competitor; the domains are the ones of the first and the second.
    expect(add({ name: '  ZILKER family dentistry ', domains: [LAKESIDE, CAPITOL, 'zilker-second.example'] })).toEqual({ status: 200, id: 'com_seed_3' });
    expect(competitors().map((c) => c.domains)).toEqual([[LAKESIDE], [CAPITOL], [ZILKER, 'zilker-second.example']]);
    // No name and no domain matches: a new competitor, listed at once.
    const added = add({ name: 'Riverbend Dental', domains: ['riverbenddental.example'] });
    expect(added.status).toBe(201);
    expect(competitors().at(-1)).toEqual({ name: 'Riverbend Dental', domains: ['riverbenddental.example'] });
    // By name alone, and then by a domain of the new competitor.
    expect(add({ name: 'RIVERBEND DENTAL', domains: [] })).toEqual({ status: 200, id: added.id });
    expect(add({ name: 'Riverbend', domains: ['riverbenddental.example', LAKESIDE] })).toEqual({ status: 200, id: added.id });
    expect(state.saved.competitors).toHaveLength(1);
    // No two competitors of the business share a domain.
    const all = competitors().flatMap((c) => c.domains);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('the HTTP server of the mock', () => {
  it('answers a body of any size over 1 MB with 413, and checks the token first', async () => {
    const server = createMockServer({ state: createMockState() });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/workspaces/from-brief`;
    try {
      const post = (bytes: number, token: string | null) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ markdown: 'x'.repeat(bytes) }) });
      // 6 MB is more than the server keeps in memory: the reply is still 413 with the error body, not a closed connection.
      for (const bytes of [1_048_577, 2_000_000, 6_000_000]) {
        const reply = await post(bytes, MOCK_TOKENS.valid);
        expect(reply.status, `${bytes} bytes`).toBe(413);
        expect(await reply.json()).toEqual({ error: { code: 'too_large', message: 'The request body is larger than 1 MB' } });
      }
      expect((await post(6_000_000, null)).status).toBe(401);
      // A body at the limit is read whole: this one is refused for its fields, not for its size.
      const atLimit = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${MOCK_TOKENS.valid}` }, body: JSON.stringify({ markdown: 'x'.repeat(1_048_576 - 15) }) });
      expect(atLimit.status).toBe(422);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('the server program (npm run mock)', () => {
  const started: ChildProcess[] = [];
  afterEach(() => {
    for (const child of started.splice(0)) child.kill();
  });

  /** Starts mock-server/server.mjs and waits until it prints `until`, or ends. */
  function start(port: string, until: RegExp): Promise<{ output: string; code: number | null }> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
    const child = spawn(process.execPath, [resolve(ROOT, 'mock-server/server.mjs')], { cwd: ROOT, env: { ...env, PORT: port }, stdio: ['ignore', 'pipe', 'pipe'] });
    started.push(child);
    return new Promise((done) => {
      let output = '';
      const more = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        if (until.test(output)) done({ output, code: null });
      };
      child.stdout!.on('data', more);
      child.stderr!.on('data', more);
      child.on('close', (code) => done({ output, code }));
    });
  }

  it('PORT=0 takes a free port and prints it; a second server on that port ends with a hint, not with a stack trace', async () => {
    const first = await start('0', /listening on http:\/\/localhost:\d+\n[^\n]+\n[^\n]+\n/);
    const port = /listening on http:\/\/localhost:(\d+)/.exec(first.output)![1]!;
    expect(Number(port)).toBeGreaterThan(0);
    expect(first.output).toContain('Tokens: "demo-token" (a user with every feature), "limited-token" (a second user with three features). Any other token is refused with 401.');
    expect(first.output).toContain('The business "biz_harborview" belongs to the second user alone');
    expect(await (await fetch(`http://127.0.0.1:${port}/v1/session`, { headers: { Authorization: 'Bearer demo-token' } })).json()).toMatchObject({ user: { id: 'usr_demo_1' } });

    const second = await start(port, /never printed/);
    expect(second.code).toBe(1);
    expect(second.output).toBe(
      `Port ${port} is in use: another program, or a second mock server, listens there.\nTry another port: PORT=${Number(port) + 1} npm run mock   (in PowerShell: $env:PORT=${Number(port) + 1}; npm run mock)\n`,
    );
  });

  it('a PORT that is no port number ends with a sentence', async () => {
    for (const port of ['abc', '70000', '-1', '80.5']) {
      const { code, output } = await start(port, /never printed/);
      expect(code, port).toBe(1);
      expect(output).toBe('PORT must be a whole number from 0 to 65535 (0 means: any free port). Example: PORT=8788 npm run mock\n');
    }
  });
});
