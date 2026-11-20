/**
 * IndexedDB: history and caches. Everything here stays on the device.
 *
 *   snapshots  Click Potential history, one record per results page viewed
 *   briefs     saved client briefs
 *   cdx        Wayback capture indexes (cache)
 *   captures   facts extracted from Wayback captures (cache)
 *   pages      digests of fetched source and comparison pages (cache)
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PageDigest } from '@/extract/digest';
import type { PageFacts } from '@/extract/page-facts';
import type { SnapshotRecord } from '@/features/click-potential/snapshot';
import type { Brief } from '@/features/instant-brief/compose';
import type { Capture } from '@/features/rewind/cdx';
import type { RewindCache } from '@/features/rewind/load';
import type { PageCache } from '@/features/shared/load-pages';

interface LensDb extends DBSchema {
  snapshots: { key: string; value: SnapshotRecord; indexes: { 'by-keyword': string; 'by-time': number } };
  briefs: { key: string; value: Brief; indexes: { 'by-time': number } };
  cdx: { key: string; value: { url: string; fetchedAt: number; captures: Capture[] } };
  captures: { key: string; value: { key: string; url: string; timestamp: string; fetchedAt: number; facts: PageFacts } };
  pages: { key: string; value: { key: string; fetchedAt: number; digest: PageDigest }; indexes: { 'by-time': number } };
}

const DB_NAME = 'legiit-lens';
const DB_VERSION = 1;
const MAX_SNAPSHOTS = 5000;
const PAGE_CACHE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

let dbPromise: Promise<IDBPDatabase<LensDb>> | null = null;

function db(): Promise<IDBPDatabase<LensDb>> {
  dbPromise ??= openDB<LensDb>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      const snapshots = database.createObjectStore('snapshots', { keyPath: 'id' });
      snapshots.createIndex('by-keyword', 'keywordKey');
      snapshots.createIndex('by-time', 'takenAt');
      const briefs = database.createObjectStore('briefs', { keyPath: 'id' });
      briefs.createIndex('by-time', 'createdAt');
      database.createObjectStore('cdx', { keyPath: 'url' });
      database.createObjectStore('captures', { keyPath: 'key' });
      const pages = database.createObjectStore('pages', { keyPath: 'key' });
      pages.createIndex('by-time', 'fetchedAt');
    },
  });
  return dbPromise;
}

/** For tests: forget the open connection. */
export function resetDbConnection(): void {
  void dbPromise?.then((d) => d.close()).catch(() => undefined);
  dbPromise = null;
}

/* ------------------------------ Snapshots ------------------------------ */

/** Saves or updates the snapshot for one page load (same id = same page). */
export async function saveSnapshot(snapshot: SnapshotRecord): Promise<void> {
  const database = await db();
  await database.put('snapshots', snapshot);
  // Keep the history bounded: drop the oldest records beyond the cap.
  const count = await database.count('snapshots');
  if (count > MAX_SNAPSHOTS) {
    const tx = database.transaction('snapshots', 'readwrite');
    let cursor = await tx.store.index('by-time').openCursor();
    let excess = count - MAX_SNAPSHOTS;
    while (cursor && excess > 0) {
      await cursor.delete();
      excess--;
      cursor = await cursor.continue();
    }
    await tx.done;
  }
}

/** Snapshots for one keyword (or all), newest first. */
export async function listSnapshots(keywordKey?: string, limit = 500): Promise<SnapshotRecord[]> {
  const database = await db();
  const all = keywordKey ? await database.getAllFromIndex('snapshots', 'by-keyword', keywordKey) : await database.getAll('snapshots');
  return all.sort((a, b) => b.takenAt - a.takenAt).slice(0, limit);
}

export interface KeywordSummary {
  keywordKey: string;
  keyword: string;
  count: number;
  latest: SnapshotRecord;
}

/** One row per keyword with its newest snapshot, most recently viewed first. */
export async function listKeywords(): Promise<KeywordSummary[]> {
  const byKey = new Map<string, KeywordSummary>();
  for (const snapshot of await listSnapshots(undefined, MAX_SNAPSHOTS)) {
    const existing = byKey.get(snapshot.keywordKey);
    if (existing) existing.count++;
    else byKey.set(snapshot.keywordKey, { keywordKey: snapshot.keywordKey, keyword: snapshot.keyword, count: 1, latest: snapshot });
  }
  return [...byKey.values()].sort((a, b) => b.latest.takenAt - a.latest.takenAt);
}

export async function deleteSnapshot(id: string): Promise<void> {
  await (await db()).delete('snapshots', id);
}

export async function deleteKeyword(keywordKey: string): Promise<void> {
  const database = await db();
  const tx = database.transaction('snapshots', 'readwrite');
  for (const key of await tx.store.index('by-keyword').getAllKeys(keywordKey)) await tx.store.delete(key);
  await tx.done;
}

/* ------------------------------ Briefs ------------------------------ */

export async function saveBrief(brief: Brief): Promise<void> {
  await (await db()).put('briefs', brief);
}

export async function getBrief(id: string): Promise<Brief | undefined> {
  return (await db()).get('briefs', id);
}

export async function listBriefs(limit = 50): Promise<Brief[]> {
  const all = await (await db()).getAll('briefs');
  return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function deleteBrief(id: string): Promise<void> {
  await (await db()).delete('briefs', id);
}

/* ------------------------------ Caches ------------------------------ */

export const rewindCache: RewindCache = {
  async getCdx(url) {
    const record = await (await db()).get('cdx', url);
    return record ? { fetchedAt: record.fetchedAt, captures: record.captures } : undefined;
  },
  async putCdx(url, captures, fetchedAt) {
    await (await db()).put('cdx', { url, fetchedAt, captures });
  },
  async getCapture(key) {
    return (await (await db()).get('captures', key))?.facts;
  },
  async putCapture(key, url, timestamp, facts, fetchedAt) {
    await (await db()).put('captures', { key, url, timestamp, fetchedAt, facts });
  },
};

export const pageCache: PageCache = {
  async get(key) {
    return (await (await db()).get('pages', key))?.digest;
  },
  async put(key, digest) {
    await (await db()).put('pages', { key, fetchedAt: digest.fetchedAt, digest });
  },
};

/** Drops page digests older than a week. Called when the panel opens. */
export async function prunePageCache(now = Date.now()): Promise<number> {
  const database = await db();
  const tx = database.transaction('pages', 'readwrite');
  const stale = await tx.store.index('by-time').getAllKeys(IDBKeyRange.upperBound(now - PAGE_CACHE_KEEP_MS));
  for (const key of stale) await tx.store.delete(key);
  await tx.done;
  return stale.length;
}

/* ------------------------------ Housekeeping ------------------------------ */

export interface StorageSummary {
  snapshots: number;
  briefs: number;
  waybackIndexes: number;
  waybackCaptures: number;
  cachedPages: number;
}

export async function storageSummary(): Promise<StorageSummary> {
  const database = await db();
  const [snapshots, briefs, waybackIndexes, waybackCaptures, cachedPages] = await Promise.all([
    database.count('snapshots'),
    database.count('briefs'),
    database.count('cdx'),
    database.count('captures'),
    database.count('pages'),
  ]);
  return { snapshots, briefs, waybackIndexes, waybackCaptures, cachedPages };
}

export async function clearCaches(): Promise<void> {
  const database = await db();
  await Promise.all([database.clear('cdx'), database.clear('captures'), database.clear('pages')]);
}

export async function clearHistory(): Promise<void> {
  const database = await db();
  await Promise.all([database.clear('snapshots'), database.clear('briefs')]);
}

export async function clearAllData(): Promise<void> {
  await clearCaches();
  await clearHistory();
}
