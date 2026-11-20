/** Reuses Click Potential and Why Not Me data (saved snapshots) in a client brief's "Search presence" section. */
import { foldLabel } from '@/features/click-potential/metrics';
import type { SnapshotRecord } from '@/features/click-potential/snapshot';
import { hostMatchesDomain } from '@/lib/url';
import type { SearchEntry } from './compose';

/**
 * Picks the snapshots that say something about this site: those where it has
 * an organic result, and, when the site is one of the user's tracked brands,
 * every recent keyword (not ranking is information too).
 */
export function searchEntries(latestPerKeyword: readonly SnapshotRecord[], siteDomain: string, isTrackedSite: boolean, max = 6): SearchEntry[] {
  const entries: SearchEntry[] = [];
  for (const snapshot of [...latestPerKeyword].sort((a, b) => b.takenAt - a.takenAt)) {
    const mine = snapshot.organic.find((o) => hostMatchesDomain(o.domain, siteDomain)) ?? null;
    if (!mine && !isTrackedSite) continue;
    entries.push({
      keyword: snapshot.keyword,
      capturedAt: snapshot.takenAt,
      viewport: `${snapshot.viewport.width}×${snapshot.viewport.height}`,
      gradeLetter: snapshot.gradeLetter,
      gradeScore: snapshot.gradeScore,
      firstOrganicTop: snapshot.firstOrganicTop,
      myPosition: mine?.position ?? null,
      myFold: mine?.fold ? foldLabel(mine.fold) : null,
      gapSurfaces: isTrackedSite ? (snapshot.presence?.gapSurfaces ?? []) : [],
      competitorsSeen: [...new Set(snapshot.tracked.filter((t) => t.owner === 'competitor').map((t) => t.name))],
    });
    if (entries.length >= max) break;
  }
  return entries;
}
