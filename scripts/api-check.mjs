#!/usr/bin/env node
/**
 * Runs the conformance check against a Legiit API. The command is the same in
 * every shell (bash, PowerShell, cmd), because everything is a plain argument:
 *
 *   npm run api:check -- <base URL> [<token>] [--read-only] [--business=<id>] [--other-business=<id>]
 *
 *   npm run api:check -- http://localhost:8787 demo-token
 *
 * The token can come from the environment variable LEGIIT_API_TOKEN instead.
 * Then it is not on the command line, which npm prints and which stays in the
 * history of the shell:
 *
 *   LEGIIT_API_TOKEN=your-test-token npm run api:check -- https://your-staging-host
 *
 * Every value can come from the environment: LEGIIT_API_BASE_URL,
 * LEGIIT_API_TOKEN, LEGIIT_API_WRITE=0 (a read-only run),
 * LEGIIT_API_BUSINESS_ID, LEGIIT_API_OTHER_BUSINESS_ID. An argument wins over
 * the environment.
 *
 * Exit codes:
 *   0  no check failed (warnings and skipped checks do not change it)
 *   1  at least one check failed
 *   2  the check could not start: wrong arguments, or the project is not prepared (npm install).
 *      Also for --help, and when a run ends without a result: no check gave a verdict
 *
 * This script never prints the token, and it never prints an argument that it
 * does not know, because that argument could be the token.
 * See docs/legiit-api/README.md, "How to test".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage:
  npm run api:check -- <base URL> [<token>] [--read-only] [--business=<id>] [--other-business=<id>]

  <base URL>             where your API answers. It starts with http:// or https://
  <token>                a token of a test account. You can leave it out and set the environment variable
                         LEGIIT_API_TOKEN: then npm does not print the token, and it does not stay in the
                         history of your shell
  --read-only            send no save: nothing is created in the account
  --business=<id>        save into this business (default: the first business that the API lists)
  --other-business=<id>  the id of a business of ANOTHER user: the check proves that the token cannot reach it

Examples:
  npm run api:check -- http://localhost:8787 demo-token
  LEGIIT_API_TOKEN=your-test-token npm run api:check -- https://your-staging-host --other-business=<id>
  PowerShell: $env:LEGIIT_API_TOKEN='your-test-token'; npm run api:check -- https://your-staging-host

Write the "--" before the arguments. Without it npm keeps the options for itself.

Exit codes:
  0  no check failed (warnings and skipped checks do not change it)
  1  at least one check failed
  2  the check could not start: wrong arguments, or the project is not prepared (run "npm install").
     Also for --help, and when a run ends without a result: no check gave a verdict`;

/** Ends without a run. Nothing that came from the command line is printed: it could be the token. */
function stop(...problems) {
  console.error(`${problems.join('\n')}\n\n${USAGE}`);
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  // No check ran, so this is not exit code 0: that code means "no check failed".
  process.exit(2);
}

const positional = [];
const given = { readOnly: false, business: undefined, otherBusiness: undefined };
const problems = [];
args.forEach((arg, index) => {
  if (arg === '--read-only') given.readOnly = true;
  else if (arg.startsWith('--business=')) given.business = arg.slice('--business='.length);
  else if (arg.startsWith('--other-business=')) given.otherBusiness = arg.slice('--other-business='.length);
  else if (arg === '--business' || arg === '--other-business') problems.push(`Write ${arg}=<id>, with "=" and without a space.`);
  else if (arg.startsWith('-')) problems.push(`Argument ${index + 1} is not an option of the check. It is not shown here, because it could be a token. A token that starts with "-" must come from the environment variable LEGIIT_API_TOKEN.`);
  else positional.push(arg);
});
if (positional.length > 2) problems.push('There are too many arguments. The check takes the base URL and, after it, the token. They are not shown here, because one of them could be a token.');
if (given.business === '' || given.otherBusiness === '') problems.push('An option has no value. Write --business=<id> and --other-business=<id>.');

// Without the "--" npm keeps the options for itself and passes them on in its own variables. The check uses them
// anyway: an option that was typed must not be lost, least of all --read-only.
const keptByNpm = [];
if (!given.readOnly && process.env.npm_config_read_only === 'true') {
  given.readOnly = true;
  keptByNpm.push('--read-only');
}
for (const [key, option, variable] of [
  ['business', '--business', 'npm_config_business'],
  ['otherBusiness', '--other-business', 'npm_config_other_business'],
]) {
  const value = process.env[variable];
  if (given[key] !== undefined || !value) continue;
  if (value === 'true') problems.push(`Write ${option}=<id>, with "=" and without a space, after the "--".`);
  else {
    given[key] = value;
    keptByNpm.push(option);
  }
}

// The words that switch saves off or on. Anything else is refused: a typing mistake must not turn a read-only run into a full run.
const write = (process.env.LEGIIT_API_WRITE ?? '').trim().toLowerCase();
const readOnlyWords = ['0', 'false', 'no', 'off'];
if (![...readOnlyWords, '', '1', 'true', 'yes', 'on'].includes(write)) problems.push('LEGIIT_API_WRITE must be 0, false, no or off (a read-only run), or 1, true, yes or on (a full run).');
const readOnly = given.readOnly || readOnlyWords.includes(write);

const baseUrl = positional[0] ?? process.env.LEGIIT_API_BASE_URL;
const token = positional[1] ?? process.env.LEGIIT_API_TOKEN;
if (!baseUrl) {
  problems.push('The check needs the base URL of your API: as the first argument, or in the environment variable LEGIIT_API_BASE_URL.');
} else {
  let parsed = null;
  try {
    parsed = new URL(baseUrl);
  } catch {
    parsed = null;
  }
  if (parsed === null || !/^https?:$/.test(parsed.protocol)) problems.push('The first argument must be the base URL of your API. It starts with http:// or https://. It is not shown here, because it could be a token.');
  else if (parsed.username || parsed.password || parsed.search || parsed.hash) problems.push('The base URL must not contain a user name, a password, a query string or a fragment.');
}
if (!token) problems.push('The check needs a token of a test account: as the second argument, or in the environment variable LEGIIT_API_TOKEN.');
else if (!/^[\x21-\x7e]{1,4096}$/.test(token)) problems.push('The token must be printable ASCII without spaces, at most 4,096 characters. The extension stores nothing else.');
if (problems.length > 0) stop(...problems);

// The TypeScript settings the check needs are generated at "npm install". An install with scripts switched off
// (a common company setting) leaves them out; they are generated here instead.
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(vitest)) {
  console.error('The project is not prepared. Run "npm install" in the repository first, then try again.');
  process.exit(2);
}
if (!existsSync(join(root, '.wxt', 'tsconfig.json'))) {
  const prepared = spawnSync(process.execPath, [join(root, 'node_modules', 'wxt', 'bin', 'wxt.mjs'), 'prepare'], { cwd: root, stdio: 'inherit' });
  if (prepared.status !== 0) {
    console.error('\nCould not prepare the project. Run "npm install" in the repository first, then try again.');
    process.exit(2);
  }
}

const notes = [];
if (keptByNpm.length > 0) notes.push(`npm kept ${keptByNpm.join(' and ')} for itself, because the "--" before the arguments was missing. The check still used ${keptByNpm.length === 1 ? 'it' : 'them'}. Write: npm run api:check -- <base URL> ${keptByNpm.map((o) => (o === '--read-only' ? o : `${o}=<id>`)).join(' ')}`);
// The two tokens of the mock server are no secret.
if (positional[1] !== undefined && !['demo-token', 'limited-token'].includes(token)) notes.push('The token was an argument: npm prints the command line, and it stays in the history of the shell. To avoid that, set the environment variable LEGIIT_API_TOKEN and leave the token out of the command.');
for (const note of notes) console.log(`Note: ${note}`);

// The token goes to the check through the environment, never on a command line.
const env = { ...process.env, LEGIIT_API_BASE_URL: baseUrl, LEGIIT_API_TOKEN: token, LEGIIT_API_WRITE: readOnly ? '0' : '1' };
if (given.business !== undefined) env.LEGIIT_API_BUSINESS_ID = given.business;
if (given.otherBusiness !== undefined) env.LEGIIT_API_OTHER_BUSINESS_ID = given.otherBusiness;

// The check writes its summary and its counts to files, so that the summary can be shown after the test results
// and the exit code does not depend on how the test runner ended.
const folder = mkdtempSync(join(tmpdir(), 'legiit-api-check-'));
env.LEGIIT_API_SUMMARY_FILE = join(folder, 'summary.txt');
env.LEGIIT_API_RESULT_FILE = join(folder, 'result.json');

const run = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.api.config.ts'], { cwd: root, env, stdio: 'inherit' });
let counts = null;
try {
  counts = JSON.parse(readFileSync(env.LEGIIT_API_RESULT_FILE, 'utf8'));
  console.log(readFileSync(env.LEGIIT_API_SUMMARY_FILE, 'utf8'));
} catch {
  counts = null;
}
rmSync(folder, { recursive: true, force: true });
for (const note of notes) console.log(`Note: ${note}`);

if (counts === null) {
  console.error('The check did not run to its end, so there is no result (exit code 2). The output above says why.');
  process.exit(2);
}
if (counts.failed > 0) process.exit(1);
if (run.status !== 0) {
  console.error('No check failed, but the test runner ended with an error (exit code 2). The output above says why. This is a fault of the check, not of your API: please report it.');
  process.exit(2);
}
process.exit(0);
