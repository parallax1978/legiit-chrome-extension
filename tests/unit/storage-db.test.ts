import { beforeEach, describe, expect, it } from 'vitest';
import { BrandMatcher } from '@/brands/matcher';
import { digestHtml } from '@/extract/digest';
import { computeClickPotential } from '@/features/click-potential/metrics';
import { toSnapshot, type SnapshotRecord } from '@/features/click-potential/snapshot';
import { composeBrief } from '@/features/instant-brief/compose';
import { extractBusinessFacts } from '@/features/instant-brief/extract';
import { parseCdx } from '@/features/rewind/cdx';
import { currentGate, gateState, recordRun } from '@/features/shared/gating';
import { getPack } from '@/selectors';
import { parseSerp } from '@/serp/parse';
import {
  clearAllData,
  clearCaches,
  deleteBrief,
  deleteKeyword,
  deleteSnapshot,
  getBrief,
  listBriefs,
  listKeywords,
  listSnapshots,
  pageCache,
  prunePageCache,
  resetDbConnection,
  rewindCache,
  saveBrief,
  saveSnapshot,
  storageSummary,
} from '@/storage/db';
import { getRunCount } from '@/storage/settings';
import { fixtureDoc, fixtureJson, fixtureText, scenario, scenarioBrands, serpEnv } from '../helpers/fixtures';

const matcher = new BrandMatcher(scenarioBrands);

function snapshot(file: string, url: string, overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
  const doc = fixtureDoc(file);
  const serp = parseSerp(doc, getPack('google'), serpEnv(doc, url));
  return { ...toSnapshot(serp, computeClickPotential(serp, matcher)), ...overrides };
}

beforeEach(async () => {
  await clearAllData();
});

describe('snapshot history', () => {
  it('stores a snapshot per page load and updates it when the page is re-measured', async () => {
    const first = snapshot('google/serp-full.html', scenario.urls.serpFull!);
    await saveSnapshot(first);
    await saveSnapshot({ ...first, firstOrganicTop: 999 });
    const stored = await listSnapshots();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ keyword: 'best dentist in austin', firstOrganicTop: 999, locationText: 'Austin, Texas' });
    expect(stored[0]?.viewport).toEqual({ width: 1280, height: 800, dpr: 1 });
  });

  it('lists history per keyword, newest first', async () => {
    const base = snapshot('google/serp-full.html', scenario.urls.serpFull!);
    await saveSnapshot({ ...base, id: 'a', takenAt: 1000 });
    await saveSnapshot({ ...base, id: 'b', takenAt: 3000 });
    await saveSnapshot({ ...base, id: 'c', takenAt: 2000 });
    await saveSnapshot(snapshot('google/serp-plain.html', scenario.urls.serpPlain!, { id: 'd', takenAt: 2500 }));
    expect((await listSnapshots(base.keywordKey)).map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect((await listSnapshots()).map((s) => s.id)).toEqual(['b', 'd', 'c', 'a']);
    expect((await listSnapshots(undefined, 2)).map((s) => s.id)).toEqual(['b', 'd']);
  });

  it('summarises keywords with their latest snapshot', async () => {
    const base = snapshot('google/serp-full.html', scenario.urls.serpFull!);
    await saveSnapshot({ ...base, id: 'a', takenAt: 1000 });
    await saveSnapshot({ ...base, id: 'b', takenAt: 3000 });
    await saveSnapshot(snapshot('google/serp-plain.html', scenario.urls.serpPlain!, { id: 'd', takenAt: 5000 }));
    const keywords = await listKeywords();
    expect(keywords.map((k) => [k.keyword, k.count, k.latest.id])).toEqual([
      ['how often should you get your teeth cleaned', 1, 'd'],
      ['best dentist in austin', 2, 'b'],
    ]);
  });

  it('deletes one snapshot or a whole keyword', async () => {
    const base = snapshot('google/serp-full.html', scenario.urls.serpFull!);
    await saveSnapshot({ ...base, id: 'a' });
    await saveSnapshot({ ...base, id: 'b' });
    await saveSnapshot(snapshot('google/serp-plain.html', scenario.urls.serpPlain!, { id: 'd' }));
    await deleteSnapshot('a');
    expect(await listSnapshots()).toHaveLength(2);
    await deleteKeyword(base.keywordKey);
    expect((await listSnapshots()).map((s) => s.id)).toEqual(['d']);
  });

  it('survives reopening the database', async () => {
    await saveSnapshot(snapshot('google/serp-full.html', scenario.urls.serpFull!));
    resetDbConnection();
    expect(await listSnapshots()).toHaveLength(1);
  });
});

describe('briefs', () => {
  it('saves, lists, loads and deletes briefs', async () => {
    const facts = extractBusinessFacts([{ url: 'https://www.brightpathdental.example/', kind: 'home', doc: fixtureDoc('site/index.html') }]);
    await saveBrief(composeBrief({ id: 'one', now: 100, facts, issues: [], competitors: [] }));
    await saveBrief(composeBrief({ id: 'two', now: 200, facts, issues: [], competitors: [] }));
    expect((await listBriefs()).map((b) => b.id)).toEqual(['two', 'one']);
    expect((await getBrief('one'))?.businessName).toBe('BrightPath Dental');
    await deleteBrief('one');
    expect(await getBrief('one')).toBeUndefined();
  });
});

describe('caches', () => {
  it('caches Wayback indexes and capture facts', async () => {
    const captures = parseCdx(fixtureJson('wayback/cdx-teeth-whitening.json'));
    expect(await rewindCache.getCdx('https://x.example/')).toBeUndefined();
    await rewindCache.putCdx('https://x.example/', captures, 42);
    expect(await rewindCache.getCdx('https://x.example/')).toEqual({ fetchedAt: 42, captures });
    const facts = { title: 't', metaDescription: null, canonical: null, metaRobots: null, h1: [], h2: [], h3: [], wordCount: 1, internalLinks: 0, externalLinks: 0, jsonLdTypes: [], hreflangCount: 0 };
    await rewindCache.putCapture('k', 'https://x.example/', '20240101000000', facts, 1);
    expect(await rewindCache.getCapture('k')).toEqual(facts);
    expect(await rewindCache.getCapture('missing')).toBeUndefined();
  });

  it('caches page digests and prunes old ones', async () => {
    const url = 'https://www.austinhealthguide.example/best-dentists-austin';
    const digest = digestHtml(fixtureText('lists/austinhealthguide-best-dentists.html'), url, url, 200, 1_000);
    await pageCache.put('fresh', { ...digest, fetchedAt: 10 * 24 * 60 * 60 * 1000 });
    await pageCache.put('stale', { ...digest, fetchedAt: 1_000 });
    expect((await pageCache.get('stale'))?.title).toContain('10 Best Dentists');
    expect(await prunePageCache(10 * 24 * 60 * 60 * 1000 + 5)).toBe(1);
    expect(await pageCache.get('stale')).toBeUndefined();
    expect(await pageCache.get('fresh')).toBeDefined();
  });

  it('reports and clears what is stored', async () => {
    await saveSnapshot(snapshot('google/serp-full.html', scenario.urls.serpFull!));
    await rewindCache.putCdx('https://x.example/', [], 1);
    expect(await storageSummary()).toEqual({ snapshots: 1, briefs: 0, waybackIndexes: 1, waybackCaptures: 0, cachedPages: 0 });
    await clearCaches();
    expect(await storageSummary()).toMatchObject({ snapshots: 1, waybackIndexes: 0 });
    await clearAllData();
    expect(await storageSummary()).toEqual({ snapshots: 0, briefs: 0, waybackIndexes: 0, waybackCaptures: 0, cachedPages: 0 });
  });
});

describe('account gating', () => {
  it('ships asking for an account before the first run, and lets a connected user through', async () => {
    expect(await currentGate(false)).toMatchObject({ gated: true, limit: 0, runsUsed: 0 });
    expect((await currentGate(true)).gated).toBe(false);
  });

  it('when switched off, is never gated and counts nothing', async () => {
    expect(gateState(1_000_000, false, false)).toEqual({ gated: false, enabled: false, runsUsed: 1_000_000, limit: null, remaining: null });
    await recordRun(false);
    await recordRun(false);
    expect(await getRunCount()).toBe(0);
    expect((await currentGate(false, false)).gated).toBe(false);
  });

  it('is off for the end-to-end tests of the features, which set their own key', async () => {
    await chrome.storage.local.set({ 'testing.noAccountGate': true });
    expect((await currentGate(false)).gated).toBe(false);
    await chrome.storage.local.remove('testing.noAccountGate');
    expect((await currentGate(false)).gated).toBe(true);
  });

  it('asks for an account after N free runs when the flag is set', async () => {
    expect(gateState(2, false, 3)).toMatchObject({ gated: false, enabled: true, remaining: 1 });
    expect(gateState(3, false, 3)).toMatchObject({ gated: true, remaining: 0 });
    await recordRun(3);
    await recordRun(3);
    await recordRun(3);
    expect(await currentGate(false, 3)).toMatchObject({ gated: true, runsUsed: 3, limit: 3 });
  });

  it('never gates a connected account', async () => {
    expect(gateState(50, true, 3)).toMatchObject({ gated: false, enabled: true });
  });
});
