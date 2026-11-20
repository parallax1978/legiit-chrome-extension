// @vitest-environment node
/**
 * The runner of the conformance check (scripts/api-check.mjs, "npm run
 * api:check"): its exit codes, its arguments, and that it never prints the
 * token. The backend team takes the exit code and the summary as the proof of
 * "API done", so both are pinned here.
 *
 *   0  no check failed (warnings and skipped checks do not change it)
 *   1  at least one check failed
 *   2  the check could not start
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockState, handleMockRequest, MOCK_OTHER_BUSINESS_ID, MOCK_TOKENS, type MockRequest, type MockResponse } from '@@/mock-server/handlers.mjs';
import { createMockServer } from '@@/mock-server/http.mjs';

const ROOT = resolve(__dirname, '../..');
const RUNNER = resolve(ROOT, 'scripts/api-check.mjs');
/** A token that looks like a real one. The servers of this test accept it; no output may contain it. */
const SECRET = 'lgt_Zq8vN3xK7mT1pR5wY9bD2fH6jL0sC4aE';

interface Outcome {
  code: number | null;
  /** Everything the runner and the check printed. */
  output: string;
}

/** Runs the runner as a user does, with nothing in the environment that this test run put there. */
function runner(args: string[], env: Record<string, string> = {}, nodeOptions: string[] = []): Promise<Outcome> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(VITEST|LEGIIT_API_|npm_config_(read_only|business|other_business)$)/.test(name)));
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, [...nodeOptions, RUNNER, ...args], { cwd: ROOT, env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('error', failed);
    child.on('close', (code) => done({ code, output }));
  });
}

/** A server on a free port. It is the mock, it also accepts the secret token, and `change` can make it wrong. */
async function serve(change: (reply: MockResponse, request: MockRequest) => MockResponse = (reply) => reply): Promise<{ baseUrl: string; received: MockRequest[]; close: () => Promise<void> }> {
  const received: MockRequest[] = [];
  const server = createMockServer({
    state: createMockState(),
    handle: (state, request) => {
      received.push(request);
      const known = request.headers['authorization'] === `Bearer ${SECRET}` ? { ...request, headers: { ...request.headers, authorization: `Bearer ${MOCK_TOKENS.valid}` } } : request;
      return change(handleMockRequest(state, known), request);
    },
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((done) => server.close(() => done()));
    },
  };
}

describe('exit code 2: the check could not start', () => {
  const URL = 'http://127.0.0.1:9';
  const cases: [string, string[], Record<string, string>, RegExp][] = [
    ['no arguments', [], {}, /The check needs the base URL of your API: as the first argument, or in the environment variable LEGIIT_API_BASE_URL\.\nThe check needs a token of a test account: as the second argument, or in the environment variable LEGIIT_API_TOKEN\./],
    ['a base URL without a token', [URL], {}, /The check needs a token of a test account/],
    ['the token before the base URL', [SECRET, URL], {}, /The first argument must be the base URL of your API\. It starts with http:\/\/ or https:\/\/\. It is not shown here, because it could be a token\./],
    ['a base URL without http://', ['127.0.0.1:9', SECRET], {}, /The first argument must be the base URL of your API/],
    ['a base URL with a user name and a password', [`http://admin:${SECRET}@127.0.0.1:9`, 'demo-token'], {}, /The base URL must not contain a user name, a password, a query string or a fragment\./],
    ['an option that the check does not know', [URL, SECRET, '--readonly'], {}, /Argument 3 is not an option of the check\. It is not shown here, because it could be a token\./],
    ['a token that starts with "--"', [URL, `--${SECRET}`], {}, /Argument 2 is not an option of the check\. [^\n]*A token that starts with "-" must come from the environment variable LEGIIT_API_TOKEN\./],
    ['--business without "="', [URL, SECRET, '--business', '42'], {}, /Write --business=<id>, with "=" and without a space\.\nThere are too many arguments\./],
    ['--other-business= without a value', [URL, SECRET, '--other-business='], {}, /An option has no value\. Write --business=<id> and --other-business=<id>\./],
    ['a token with a space', [URL, `${SECRET} x`], {}, /The token must be printable ASCII without spaces, at most 4,096 characters\./],
    ['LEGIIT_API_WRITE with a value that is no yes and no no', [URL, SECRET], { LEGIIT_API_WRITE: 'readonly' }, /LEGIIT_API_WRITE must be 0, false, no or off \(a read-only run\), or 1, true, yes or on \(a full run\)\./],
    ['--business without "=" and without the "--" of npm', [URL, SECRET, '42'], { npm_config_business: 'true' }, /Write --business=<id>, with "=" and without a space, after the "--"\./],
    ['--help', ['--help'], {}, /^Usage:\n {2}npm run api:check -- <base URL> \[<token>\] \[--read-only\] \[--business=<id>\] \[--other-business=<id>\]/],
  ];
  for (const [name, args, env, message] of cases) {
    it(name, async () => {
      const { code, output } = await runner(args, env);
      expect(code).toBe(2);
      expect(output).toMatch(message);
      // Nothing that was typed is printed back: it could be the token.
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain('--readonly');
      // The usage text comes with every refusal. It names the options, the variable for the token and the exit codes.
      expect(output).toContain('npm run api:check -- <base URL> [<token>] [--read-only] [--business=<id>] [--other-business=<id>]');
      expect(output).toMatch(/LEGIIT_API_TOKEN: then npm does not print the token, and it does not stay in the\s+history of your shell/);
      expect(output).toContain(
        '  0  no check failed (warnings and skipped checks do not change it)\n  1  at least one check failed\n  2  the check could not start: wrong arguments, or the project is not prepared (run "npm install").\n     Also for --help, and when a run ends without a result: no check gave a verdict',
      );
    });
  }

  // The script starts the test runner (vitest) and takes its exit code from the result that the check writes. Here
  // a stand-in for the test runner is loaded first, so that a run without a verdict can be tried.
  const withFake = ['--import', pathToFileURL(resolve(ROOT, 'tests/api/fake-test-runner.mjs')).href];

  it('the test runner ended before the check wrote a result', async () => {
    const { code, output } = await runner([URL, SECRET], { FAKE_TEST_RUNNER: 'crash' }, withFake);
    expect(code).toBe(2);
    expect(output).toContain('The check did not run to its end, so there is no result (exit code 2). The output above says why.');
    expect(output).not.toContain(SECRET);
  });

  it('no check failed, but the test runner ended with an error: that is no "passed"', async () => {
    const { code, output } = await runner([URL, SECRET], { FAKE_TEST_RUNNER: 'late-error' }, withFake);
    expect(code).toBe(2);
    expect(output).toContain('No check failed, but the test runner ended with an error (exit code 2). The output above says why. This is a fault of the check, not of your API: please report it.');
  });

  it('the header of the script states the same exit codes and the same variable', () => {
    const source = readFileSync(RUNNER, 'utf8');
    const header = source.slice(0, source.indexOf('*/'));
    expect(header).toContain(
      ' *   0  no check failed (warnings and skipped checks do not change it)\n *   1  at least one check failed\n *   2  the check could not start: wrong arguments, or the project is not prepared (npm install).\n *      Also for --help, and when a run ends without a result: no check gave a verdict',
    );
    expect(header).toContain('LEGIIT_API_TOKEN=your-test-token npm run api:check -- https://your-staging-host');
    expect(header).toContain('never prints the token');
  });
});

describe.concurrent('a run: exit codes 0 and 1, the options, and the token', () => {
  let right: Awaited<ReturnType<typeof serve>>;
  let wrong: Awaited<ReturnType<typeof serve>>;
  let lax: Awaited<ReturnType<typeof serve>>;

  beforeAll(async () => {
    right = await serve();
    // Breaks a rule: an unknown path answers with the code that is reserved for a missing business, and repeats the token.
    wrong = await serve((reply, request) =>
      reply.status === 404 && request.path.includes('no-such-endpoint') ? { ...reply, body: JSON.stringify({ error: { code: 'not_found', message: `No route for the token ${request.headers['authorization'] ?? ''}` } }) } : reply,
    );
    // Breaks no rule, but follows no recommendation about CORS.
    lax = await serve((reply) => ({ ...reply, headers: Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !name.startsWith('access-control-'))) }));
  });

  afterAll(async () => {
    await Promise.all([right.close(), wrong.close(), lax.close()]);
  });

  it('exit code 0: no check failed. The token comes from the environment and is never printed', async () => {
    const { code, output } = await runner([right.baseUrl, `--other-business=${MOCK_OTHER_BUSINESS_ID}`], { LEGIIT_API_TOKEN: SECRET });
    expect(output).toContain('Result:                PASSED: all 34 checks passed, and no check was skipped.');
    expect(code).toBe(0);
    expect(output).not.toContain(SECRET);
    // The summary is the last thing on the screen, and its first line says whether saves were sent.
    expect(output.trimEnd().split('\n').at(-1)).toMatch(/^ {2}Result: /);
    expect(output).toMatch(/Legiit API conformance summary\n {2}Mode: {18}full run: test data was created in the account\n/);
    expect(output).not.toContain('Note:');
    // The token reached the server in the header, and only there.
    expect(right.received.some((request) => request.headers['authorization'] === `Bearer ${SECRET}`)).toBe(true);
  });

  it('exit code 1: a check failed. The token was an argument: it is not printed, and a note says how to keep it out of the command', async () => {
    const { code, output } = await runner([wrong.baseUrl, SECRET]);
    expect(output).toContain('Result:                FAILED: 1 check of 34 failed (A5). 32 passed, 1 skipped.');
    expect(code).toBe(1);
    // The reply of the server repeated the token: the check shows the reply without it.
    expect(output).not.toContain(SECRET);
    expect(output).toContain('the code "not_found" is reserved for a missing business');
    expect(output).toContain('Note: The token was an argument: npm prints the command line, and it stays in the history of the shell. To avoid that, set the environment variable LEGIIT_API_TOKEN and leave the token out of the command.');
    // A failure is one sentence, without a stack trace into the code of the check.
    expect(output).not.toMatch(/suite\.ts:\d+|AssertionError|at .*node_modules/);
  });

  it('exit code 0 with warnings. Options that npm kept for itself (no "--") are still used, and a note says so', async () => {
    const { code, output } = await runner([lax.baseUrl, MOCK_TOKENS.valid], { npm_config_read_only: 'true', npm_config_business: 'biz_oakline' });
    expect(code).toBe(0);
    expect(output).toContain('Mode:                  read-only: no save was sent');
    expect(output).toContain('Business used:         biz_oakline');
    expect(output).toMatch(/Warnings \(recommendations, not failures\):\n {4}- A8: the CORS safety net is not in place/);
    expect(output).toMatch(/Result: {16}no check failed: 17 of 34 passed, 17 skipped\./);
    expect(output).toContain('Note: npm kept --read-only and --business for itself, because the "--" before the arguments was missing. The check still used them. Write: npm run api:check -- <base URL> --read-only --business=<id>');
    // No save reached the server.
    expect(lax.received.filter((request) => request.method === 'POST' && !request.path.startsWith('/v1/ai/'))).toEqual([]);
    // The demo token of the mock is no secret: no note about it.
    expect(output).not.toContain('The token was an argument');
  });

  it('LEGIIT_API_WRITE=false is a read-only run, and an argument wins over the environment', async () => {
    const { code, output } = await runner([right.baseUrl, MOCK_TOKENS.limited, '--business=biz_oakline'], { LEGIIT_API_WRITE: 'false', LEGIIT_API_TOKEN: 'a-token-that-loses', LEGIIT_API_BUSINESS_ID: 'biz_brightpath', LEGIIT_API_BASE_URL: 'http://127.0.0.1:9' });
    expect(code).toBe(0);
    expect(output).toContain('Mode:                  read-only: no save was sent');
    expect(output).toContain('Account:               Sam Rivera (plan: starter)');
    expect(output).toContain('Business used:         biz_oakline');
  });
});
