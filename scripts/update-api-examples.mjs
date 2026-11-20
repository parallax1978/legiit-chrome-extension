#!/usr/bin/env node
/**
 * Refreshes the generated parts of the kit in docs/legiit-api after a
 * deliberate change to a payload, the contract or the mock server:
 *
 *   npm run api:examples
 *
 * The example files are written by the kit's own test (tests/unit/
 * legiit-api-kit.test.ts) from the extension's code. Response examples depend
 * on request examples, and the reference, openapi.examples.json and the files
 * in schemas/ depend on both, so the files are written in two quiet passes,
 * the generated files are rebuilt, and only then is the test run for real:
 * that last run must be clean.
 */
import { spawnSync } from 'node:child_process';

const vitest = ['node_modules/vitest/vitest.mjs', 'run', 'tests/unit/legiit-api-kit.test.ts'];
const run = (args, stdio = 'inherit', env = process.env) => spawnSync(process.execPath, args, { stdio, env }).status ?? 1;
// In the two writing passes, an input of the examples that is out of date may be made again (the recorded answers
// of the sentence model: tests/helpers/api-examples.ts). The last run never writes anything.
const writing = { ...process.env, LEGIIT_API_EXAMPLES_UPDATE: '1' };

// Failures of these two passes mean "a file was out of date", which is what they are here to repair.
run([...vitest, '-u'], 'ignore', writing);
run([...vitest, '-u'], 'ignore', writing);
if (run(['scripts/build-api-reference.mjs']) !== 0) process.exit(1);
process.exit(run(vitest));
