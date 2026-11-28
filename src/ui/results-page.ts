/**
 * The Google results page in the current tab, measured: shared by the Overview and by "This search", so that both
 * show the same numbers and the measurement is stored once, whichever of them is on screen.
 */
import { useEffect, useMemo, useState } from 'react';
import { computeClickPotential, type ClickPotential } from '@/features/click-potential/metrics';
import { toSnapshot, type SnapshotRecord } from '@/features/click-potential/snapshot';
import { recordRun } from '@/features/shared/gating';
import { buildSerpPresence, summarisePresence, type Presence } from '@/features/why-not-me/presence';
import { SerpDataSchema, type SerpData } from '@/model/schemas';
import { sendToTab } from '@/panel/tabs';
import { saveSnapshot } from '@/storage/db';
import { useSettings, useTarget } from './hooks';

export interface ResultsPage {
  /** True when the tab shows a Google results page. */
  onSerp: boolean;
  tabId: number | null;
  serp: SerpData | null;
  cp: ClickPotential | null;
  presence: Presence | null;
  /** What is stored for this page view (or would be, when the user saves by hand). */
  snapshot: SnapshotRecord | null;
  error: string | null;
  /** Counts up each time the page was looked at and, unless the user saves by hand, stored: lists of stored measurements reload on it. */
  stored: number;
}

export function useResultsPage(): ResultsPage {
  const { access, epoch } = useTarget();
  const { settings, matcher } = useSettings();
  const [serp, setSerp] = useState<SerpData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [stored, setStored] = useState(0);

  const ready = access.status === 'ready' ? access : null;
  const onSerp = ready?.ping.agent === 'google' && ready.ping.serp === true;
  const tabId = ready?.tabId ?? null;

  useEffect(() => {
    let alive = true;
    setError(null);
    if (!onSerp || tabId === null) {
      setSerp(null);
      return;
    }
    sendToTab(tabId, { type: 'lens:get-serp' }, SerpDataSchema).then(
      (data) => alive && setSerp(data),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not read the results page'),
    );
    return () => {
      alive = false;
    };
  }, [onSerp, tabId, epoch]);

  const cp = useMemo(() => (serp ? computeClickPotential(serp, matcher) : null), [serp, matcher]);
  const presence = useMemo(() => (serp ? buildSerpPresence(serp, matcher) : null), [serp, matcher]);
  const snapshot = useMemo(() => (serp && cp && presence ? toSnapshot(serp, cp, matcher.isEmpty ? null : summarisePresence(presence)) : null), [serp, cp, presence, matcher]);

  // Store what is on screen (unless the user chose to save by hand), then tell the lists.
  useEffect(() => {
    if (!snapshot || !serp?.recognised || serp.mode !== 'web' || !cp?.measured) return;
    let alive = true;
    void (async () => {
      if (settings.snapshots.autoSave !== 'manual') {
        await saveSnapshot(snapshot);
        if (alive && savedId !== snapshot.id) {
          setSavedId(snapshot.id);
          void recordRun();
        }
      }
      if (alive) setStored((count) => count + 1);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, settings.snapshots.autoSave]);

  return { onSerp, tabId, serp, cp, presence, snapshot, error, stored };
}
