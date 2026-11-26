/**
 * Account gating, controlled by one config flag (REQUIRE_ACCOUNT_AFTER_FREE_RUNS
 * in src/config/constants.ts). It ships at 0: the first screen asks for an email
 * address, and every feature runs once the extension is connected.
 */
import { REQUIRE_ACCOUNT_AFTER_FREE_RUNS } from '@/config/constants';
import { gateSwitchedOffForTests, getRunCount, incrementRunCount } from '@/storage/settings';

export interface GateState {
  /** True when the user must connect a Legiit account to keep running features. */
  gated: boolean;
  enabled: boolean;
  runsUsed: number;
  limit: number | null;
  remaining: number | null;
}

export function gateState(runsUsed: number, connected: boolean, limit: number | false = REQUIRE_ACCOUNT_AFTER_FREE_RUNS): GateState {
  if (limit === false || !Number.isFinite(limit) || limit < 0) {
    return { gated: false, enabled: false, runsUsed, limit: null, remaining: null };
  }
  if (connected) return { gated: false, enabled: true, runsUsed, limit, remaining: null };
  return { gated: runsUsed >= limit, enabled: true, runsUsed, limit, remaining: Math.max(0, limit - runsUsed) };
}

export async function currentGate(connected: boolean, limit: number | false = REQUIRE_ACCOUNT_AFTER_FREE_RUNS): Promise<GateState> {
  if (limit === false || (await gateSwitchedOffForTests())) return gateState(0, connected, false);
  return gateState(await getRunCount(), connected, limit);
}

/** Counts one feature run. Does nothing (and stores nothing) while gating is off. */
export async function recordRun(limit: number | false = REQUIRE_ACCOUNT_AFTER_FREE_RUNS): Promise<void> {
  if (limit === false) return;
  await incrementRunCount();
}
