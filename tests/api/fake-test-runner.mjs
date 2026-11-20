/**
 * For the test of the runner (tests/unit/legiit-api-suite-runner.test.ts) only: loaded with "node --import"
 * before scripts/api-check.mjs, it stands in for the test runner (vitest) that the script starts. So the two
 * cases in which a run has no verdict can be tried without breaking anything:
 *   FAKE_TEST_RUNNER=crash       the test runner ends before the check wrote a result
 *   FAKE_TEST_RUNNER=late-error  no check failed, but the test runner ended with an error
 */
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const real = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  if (!args?.some((arg) => String(arg).endsWith('vitest.mjs'))) return real(command, args, options);
  if (process.env.FAKE_TEST_RUNNER === 'late-error') {
    writeFileSync(options.env.LEGIIT_API_RESULT_FILE, JSON.stringify({ passed: 34, failed: 0, skipped: 0, warnings: 0 }));
    writeFileSync(options.env.LEGIIT_API_SUMMARY_FILE, '\nLegiit API conformance summary\n  Result:                PASSED: all 34 checks passed, and no check was skipped.\n');
  }
  return { status: 1, signal: null, output: [], pid: 0, stdout: null, stderr: null };
};
syncBuiltinESMExports();
