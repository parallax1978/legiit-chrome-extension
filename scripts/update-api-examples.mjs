#!/usr/bin/env node
/**
 * Refreshes docs/legiit-api/examples and docs/legiit-api/reference.md after a
 * deliberate change to a payload, the contract or the mock server:
 *
 *   npm run api:examples
 *
 * The example files are written by the kit's own test (tests/unit/
 * legiit-api-kit.test.ts) from the extension's code. Response examples depend
 * on request examples, so the first pass may report missing files; the second
 * pass must be clean.
 */
import { spawnSync } from 'node:child_process';

const run = (args) => spawnSync(process.execPath, args, { stdio: 'inherit' }).status ?? 1;
const vitest = ['node_modules/vitest/vitest.mjs', 'run', 'tests/unit/legiit-api-kit.test.ts'];

run([...vitest, '-u', '--reporter=dot']);
run([...vitest, '-u', '--reporter=dot']);
if (run(['scripts/build-api-reference.mjs']) !== 0) process.exit(1);
process.exit(run(vitest));
