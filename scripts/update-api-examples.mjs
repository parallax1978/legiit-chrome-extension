#!/usr/bin/env node
/**
 * Refreshes docs/legiit-api/examples and docs/legiit-api/reference.md after a
 * deliberate change to a payload, the contract or the mock server:
 *
 *   npm run api:examples
 *
 * The example files are written by the kit's own test (tests/unit/
 * legiit-api-kit.test.ts) from the extension's code. Response examples depend
 * on request examples, and the reference depends on both, so the files are
 * written in two quiet passes, the reference is rebuilt, and only then is the
 * test run for real: that last run must be clean.
 */
import { spawnSync } from 'node:child_process';

const vitest = ['node_modules/vitest/vitest.mjs', 'run', 'tests/unit/legiit-api-kit.test.ts'];
const run = (args, stdio = 'inherit') => spawnSync(process.execPath, args, { stdio }).status ?? 1;

// Failures of these two passes mean "a file was out of date", which is what they are here to repair.
run([...vitest, '-u'], 'ignore');
run([...vitest, '-u'], 'ignore');
if (run(['scripts/build-api-reference.mjs']) !== 0) process.exit(1);
process.exit(run(vitest));
