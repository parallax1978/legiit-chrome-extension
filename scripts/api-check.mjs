#!/usr/bin/env node
/**
 * Runs the conformance check against a Legiit API. Works the same way in every
 * shell (bash, PowerShell, cmd), because the address and the token are plain
 * arguments:
 *
 *   npm run api:check -- <base URL> <token> [--read-only] [--business=<id>] [--other-business=<id>]
 *
 *   npm run api:check -- http://localhost:8787 demo-token
 *
 * The same values can come from the environment instead (LEGIIT_API_BASE_URL,
 * LEGIIT_API_TOKEN, LEGIIT_API_WRITE=0, LEGIIT_API_BUSINESS_ID,
 * LEGIIT_API_OTHER_BUSINESS_ID). See docs/legiit-api/README.md, "How to test".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [baseUrl, token] = args.filter((a) => !a.startsWith('--'));
const flag = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);

const known = ['--read-only', '--business=', '--other-business='];
const unknown = flags.filter((f) => !known.some((k) => (k.endsWith('=') ? f.startsWith(k) : f === k)));
if (unknown.length > 0) {
  console.error(`Unknown option: ${unknown.join(' ')}\nUsage: npm run api:check -- <base URL> <token> [--read-only] [--business=<id>] [--other-business=<id>]`);
  process.exit(2);
}

const env = { ...process.env };
if (baseUrl) env.LEGIIT_API_BASE_URL = baseUrl;
if (token) env.LEGIIT_API_TOKEN = token;
if (flags.includes('--read-only')) env.LEGIIT_API_WRITE = '0';
if (flag('business')) env.LEGIIT_API_BUSINESS_ID = flag('business');
if (flag('other-business')) env.LEGIIT_API_OTHER_BUSINESS_ID = flag('other-business');

if (!env.LEGIIT_API_BASE_URL || !env.LEGIIT_API_TOKEN) {
  console.error('The check needs the address of your API and a token of a test account:\n\n  npm run api:check -- https://your-staging-host your-test-token\n');
  process.exit(2);
}

// The TypeScript settings the check needs are generated at "npm install". An install with scripts switched off
// (a common company setting) leaves them out; they are generated here instead.
if (!existsSync(join(root, '.wxt', 'tsconfig.json'))) {
  const prepared = spawnSync(process.execPath, [join(root, 'node_modules', 'wxt', 'bin', 'wxt.mjs'), 'prepare'], { cwd: root, stdio: 'inherit' });
  if (prepared.status !== 0) {
    console.error('\nCould not prepare the project. Run "npm install" in the repository first, then try again.');
    process.exit(2);
  }
}

// The suite writes its summary to a file, so that it can be shown after the test results and not in the middle of them.
const summary = join(mkdtempSync(join(tmpdir(), 'legiit-api-check-')), 'summary.txt');
env.LEGIIT_API_SUMMARY_FILE = summary;

const result = spawnSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.api.config.ts'], { cwd: root, env, stdio: 'inherit' });
if (existsSync(summary)) console.log(readFileSync(summary, 'utf8'));
process.exit(result.status ?? 1);
