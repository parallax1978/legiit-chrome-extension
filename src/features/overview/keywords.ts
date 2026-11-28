/**
 * "My keywords": every search the user looked at, with where they stood and how that moved.
 *
 * It is built from the measurements stored on the device. The extension never searches Google itself, so a row is
 * as fresh as the last time the user ran that search.
 */
import type { SnapshotRecord } from '@/features/click-potential/snapshot';
import { crowdingOf, type Crowding } from './words';

export interface KeywordRow {
  keywordKey: string;
  keyword: string;
  checkedAt: number;
  /** The user's best organic position at the last check. null: not on that page. undefined: no site of theirs was tracked then. */
  rank: number | null | undefined;
  /** Compared with the check before: places gained (positive) or lost (negative). null when there is nothing to compare. */
  moved: number | null;
  /** 'in': came onto the page since the check before. 'out': fell off it. */
  entered: 'in' | 'out' | null;
  /** Whether Google's AI answer named or cited the user. 'none': the search showed no AI answer. */
  ai: 'in' | 'out' | 'none' | 'unknown';
  crowding: Crowding;
  /** How many checks are stored for this keyword. */
  checks: number;
  /** The same search again, for the user to open. */
  searchUrl: string;
}

/**
 * A stored measurement lists the tracked brands that had a result, not the ones that had none. So "no result of
 * the user's" reads as: brands were tracked then (the measurement carries who was where), and none of the user's
 * is listed. Whether a brand of the user's own was among them is asked by the caller, who knows the settings.
 */
function rankOf(snapshot: SnapshotRecord): number | null | undefined {
  const positions = snapshot.tracked.filter((t) => t.owner === 'mine').map((t) => t.position).filter((p): p is number => p !== null);
  if (positions.length > 0) return Math.min(...positions);
  return snapshot.presence ? null : undefined;
}

function aiOf(snapshot: SnapshotRecord): KeywordRow['ai'] {
  if (!snapshot.presence) return 'unknown';
  const ai = snapshot.presence.surfaces.find((s) => s.id === 'ai_overview');
  if (!ai) return 'none';
  return ai.status === 'both' || ai.status === 'only-you' ? 'in' : 'out';
}

/** One row per keyword, most recently checked first. `snapshots` in any order. */
export function keywordRows(snapshots: readonly SnapshotRecord[]): KeywordRow[] {
  const byKey = new Map<string, SnapshotRecord[]>();
  for (const snapshot of snapshots) {
    if (snapshot.mode !== 'web') continue;
    byKey.set(snapshot.keywordKey, [...(byKey.get(snapshot.keywordKey) ?? []), snapshot]);
  }
  const rows: KeywordRow[] = [];
  for (const [keywordKey, list] of byKey) {
    const sorted = [...list].sort((a, b) => b.takenAt - a.takenAt);
    const latest = sorted[0]!;
    const rank = rankOf(latest);
    // The check before: the newest one of another day, so that two looks at one page are one check.
    const earlier = sorted.find((s) => new Date(s.takenAt).toDateString() !== new Date(latest.takenAt).toDateString());
    const before = earlier ? rankOf(earlier) : undefined;
    let moved: number | null = null;
    let entered: KeywordRow['entered'] = null;
    if (typeof rank === 'number' && typeof before === 'number') moved = before - rank;
    else if (typeof rank === 'number' && before === null) entered = 'in';
    else if (rank === null && typeof before === 'number') entered = 'out';
    rows.push({
      keywordKey,
      keyword: latest.keyword,
      checkedAt: latest.takenAt,
      rank,
      moved,
      entered,
      ai: aiOf(latest),
      crowding: crowdingOf(latest.gradeLetter),
      checks: sorted.length,
      searchUrl: `https://${latest.host}/search?q=${encodeURIComponent(latest.keyword)}`,
    });
  }
  return rows.sort((a, b) => b.checkedAt - a.checkedAt);
}
