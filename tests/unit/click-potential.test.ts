import { describe, expect, it } from 'vitest';
import { BrandMatcher } from '@/brands/matcher';
import { computeClickPotential, foldStatus, GRADE_METHOD, gradeLetter } from '@/features/click-potential/metrics';
import { historyCsv, keywordKey, organicCsv, toSnapshot } from '@/features/click-potential/snapshot';
import type { SerpData } from '@/model/schemas';
import { getPack } from '@/selectors';
import { parseSerp } from '@/serp/parse';
import { fixtureDoc, scenario, scenarioBrands, serpEnv } from '../helpers/fixtures';

const matcher = new BrandMatcher(scenarioBrands);

function load(file: string, url: string): SerpData {
  const doc = fixtureDoc(file);
  return parseSerp(doc, getPack('google'), serpEnv(doc, url));
}

const full = load('google/serp-full.html', scenario.urls.serpFull!);
const plain = load('google/serp-plain.html', scenario.urls.serpPlain!);
const featured = load('google/serp-featured.html', scenario.urls.serpFeatured!);

/** A hand-built page so the arithmetic can be checked exactly: 1000x800 viewport. */
function synthetic(parts: Partial<SerpData>): SerpData {
  return {
    kind: 'serp',
    pageId: 'p1',
    url: 'https://www.google.com/search?q=test',
    keyword: 'test',
    mode: 'web',
    capturedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    viewport: { width: 1000, height: 800, dpr: 1 },
    documentHeight: 3000,
    locationText: null,
    blocks: [],
    organic: [],
    aiAnswer: null,
    recognised: true,
    packVersion: 'test',
    ...parts,
  };
}

const result = (position: number, y: number, domain = `site${position}.example`) => ({
  position,
  title: `Result ${position}`,
  url: `https://${domain}/`,
  domain,
  snippet: '',
  rect: { x: 0, y, width: 500, height: 100 },
  listStyle: false,
  address: 'link' as const,
});

describe('fold status and grade bands', () => {
  it('classifies a rectangle against the fold', () => {
    expect(foldStatus({ x: 0, y: 100, width: 10, height: 100 }, 800)).toBe('above');
    expect(foldStatus({ x: 0, y: 750, width: 10, height: 100 }, 800)).toBe('partly');
    expect(foldStatus({ x: 0, y: 800, width: 10, height: 100 }, 800)).toBe('below');
    expect(foldStatus(null, 800)).toBeNull();
  });

  it('maps scores to letters as documented', () => {
    expect([100, 85, 84, 70, 69, 50, 49, 30, 29, 0].map(gradeLetter)).toEqual(['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'F', 'F']);
    expect(GRADE_METHOD.join(' ')).toContain('estimate');
  });
});

describe('Click Potential arithmetic', () => {
  it('gives a full score when organic results start at the top with nothing else', () => {
    const cp = computeClickPotential(synthetic({ organic: [result(1, 100), result(2, 220)] }), matcher);
    expect(cp.firstOrganicTop).toBe(100);
    expect(cp.firstOrganicFold).toBe('above');
    expect(cp.grade).toMatchObject({ score: 100, letter: 'A', positionPenalty: 0, displacementPenalty: 0, estimate: true });
    // Two 500x100 results on a 1000x800 screen.
    expect(cp.organicShare).toBeCloseTo(100_000 / 800_000, 6);
    expect(cp.remainderShare).toBeCloseTo(0.875, 6);
  });

  it('applies the position and displacement penalties exactly', () => {
    // Results area starts at y=100 with an ad 500x350; the first organic result starts at y=450.
    const cp = computeClickPotential(
      synthetic({
        blocks: [{ type: 'ad', rect: { x: 0, y: 100, width: 500, height: 350 }, items: [], text: '', matchedBy: 't' }],
        organic: [result(1, 450), result(2, 550), result(3, 650), result(4, 750)],
      }),
      matcher,
    );
    // position = (450 - 100) / (800 - 100) = 0.5 → 30 points
    expect(cp.grade.positionPenalty).toBe(30);
    // visible organic = 500 x (800 - 450) = 175,000 px; ad = 175,000 px → displacement 0.5 → 20 points
    expect(cp.grade.displacementPenalty).toBe(20);
    expect(cp.grade.score).toBe(50);
    expect(cp.grade.letter).toBe('C');
    expect(cp.shares.map((s) => [s.type, s.pixels])).toEqual([
      ['ad', 175_000],
      ['organic', 175_000],
    ]);
    expect(cp.organic.map((o) => o.fold)).toEqual(['above', 'above', 'above', 'partly']);
    expect(cp.aboveFirstOrganic).toEqual([{ type: 'ad', label: 'Ads' }]);
  });

  it('gives zero when organic results start below the fold', () => {
    const cp = computeClickPotential(
      synthetic({
        blocks: [{ type: 'ai_overview', rect: { x: 0, y: 100, width: 500, height: 900 }, items: [], text: '', matchedBy: 't' }],
        organic: [result(1, 1100)],
      }),
      matcher,
    );
    expect(cp.grade).toMatchObject({ score: 0, letter: 'F', positionPenalty: 60, displacementPenalty: 40 });
    expect(cp.screensToFirstOrganic).toBeCloseTo(1.375, 6);
    expect(cp.organicShare).toBe(0);
  });

  it('does not count a knowledge panel against the grade', () => {
    const cp = computeClickPotential(
      synthetic({
        blocks: [{ type: 'knowledge_panel', rect: { x: 600, y: 100, width: 300, height: 600 }, items: [], text: '', matchedBy: 't' }],
        organic: [result(1, 100)],
      }),
      matcher,
    );
    expect(cp.grade.score).toBe(100);
    expect(cp.shares.find((s) => s.type === 'knowledge_panel')?.share).toBeCloseTo(180_000 / 800_000, 6);
    expect(cp.aboveFirstOrganic).toEqual([]);
  });

  it('counts overlapping blocks of one type once', () => {
    const ad = { type: 'ad' as const, rect: { x: 0, y: 0, width: 100, height: 100 }, items: [], text: '', matchedBy: 't' };
    const cp = computeClickPotential(synthetic({ blocks: [ad, { ...ad }] }), matcher);
    expect(cp.shares[0]).toMatchObject({ type: 'ad', pixels: 10_000, count: 2 });
  });

  it('reports "not measured" when the page carried no geometry', () => {
    const cp = computeClickPotential(synthetic({ organic: [{ ...result(1, 0), rect: null }] }), matcher);
    expect(cp.measured).toBe(false);
    expect(cp.firstOrganicTop).toBeNull();
    expect(cp.organic[0]).toMatchObject({ top: null, fold: null });
    expect(cp.explanation[0]).toMatch(/could not be measured/);
  });
});

describe('Click Potential on fixtures', () => {
  it('grades a page crowded by AI Overview, ads and a local pack as F', () => {
    const cp = computeClickPotential(full, matcher);
    expect(cp.firstOrganicTop).toBe(1431);
    expect(cp.firstOrganicFold).toBe('below');
    expect(cp.organicShare).toBe(0);
    expect(cp.grade.letter).toBe('F');
    expect(cp.aboveFirstOrganic.map((b) => b.type)).toEqual(['ad', 'ai_overview', 'local_pack']);
    const share = (type: string) => cp.shares.find((s) => s.type === type)?.share ?? 0;
    // ads: 652 x 199 of 1280 x 800; AI Overview: 652 x (800 - 379)
    expect(share('ad')).toBeCloseTo((652 * 199) / (1280 * 800), 4);
    expect(share('ai_overview')).toBeCloseTo((652 * 421) / (1280 * 800), 4);
    expect(share('local_pack')).toBe(0); // starts below the fold
  });

  it('reports position and fold status for tracked domains', () => {
    const cp = computeClickPotential(full, matcher);
    expect(cp.tracked.find((t) => t.owner === 'mine')).toMatchObject({ name: 'BrightPath Dental', position: 6, fold: 'below', top: 2475 });
    expect(cp.tracked.filter((t) => t.owner === 'competitor').map((t) => [t.name, t.position])).toEqual([
      ['Lakeside Smiles', 2],
      ['Capitol Dental Care', 4],
      ['Zilker Family Dentistry', 8],
    ]);
    expect(cp.organic[5]).toMatchObject({ owner: 'mine', brand: 'BrightPath Dental' });
    expect(cp.organic[0]).toMatchObject({ owner: null, listStyle: true });
  });

  it('grades a plain page as A and a featured-snippet page in between', () => {
    const plainCp = computeClickPotential(plain, matcher);
    expect(plainCp.grade.letter).toBe('A');
    expect(plainCp.firstOrganicTop).toBe(152);
    expect(plainCp.aboveFirstOrganic).toEqual([]);
    const featuredCp = computeClickPotential(featured, matcher);
    expect(featuredCp.grade.score).toBeGreaterThan(computeClickPotential(full, matcher).grade.score);
    expect(featuredCp.grade.score).toBeLessThan(plainCp.grade.score);
    expect(featuredCp.aboveFirstOrganic.map((b) => b.type)).toEqual(['featured_snippet', 'paa']);
  });

  it('explains the numbers in plain language without an AI provider', () => {
    const lines = computeClickPotential(full, matcher).explanation;
    expect(lines[0]).toBe('The first organic result starts 1,431 px from the top of the page — below the fold, 1.8 screens down at a 1280×800 viewport.');
    expect(lines).toContain('Above it: Ads, AI Overview, Local pack.');
    expect(lines.join('\n')).toContain('BrightPath Dental is organic result #6, 2,475 px down (below the fold).');
    expect(lines[lines.length - 1]).toMatch(/^Estimated organic click potential: F \(0\/100/);
    const untracked = computeClickPotential(full, new BrandMatcher({ mine: [], competitors: [] })).explanation.join('\n');
    expect(untracked).not.toContain('tracked domains');
  });

  it('says so when a tracked brand is missing from the page', () => {
    const other = new BrandMatcher({ mine: [{ id: 'x', name: 'Nowhere Dental', domains: ['nowhere.example'], aliases: [] }], competitors: [] });
    expect(computeClickPotential(plain, other).explanation).toContain('None of your tracked domains has an organic result on this page.');
  });
});

describe('snapshots and CSV', () => {
  const cp = computeClickPotential(full, matcher);
  const snapshot = toSnapshot(full, cp);

  it('captures keyword, timestamp, viewport and location', () => {
    expect(snapshot).toMatchObject({
      id: 'fixture-page',
      keyword: 'best dentist in austin',
      keywordKey: 'best dentist in austin',
      host: 'www.google.com',
      viewport: { width: 1280, height: 800, dpr: 1 },
      locationText: 'Austin, Texas',
      firstOrganicTop: 1431,
      gradeLetter: 'F',
    });
    expect(snapshot.organic).toHaveLength(9);
    expect(keywordKey('  Best   Dentist IN Austin ')).toBe('best dentist in austin');
  });

  it('exports the organic table as CSV', () => {
    const lines = organicCsv(full, cp).replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('keyword,captured_at,viewport,location,position,title,url,domain,top_px,fold,tracked_as,brand,list_style,address');
    expect(lines).toHaveLength(10);
    expect(lines[1]).toBe(
      'best dentist in austin,2026-11-20T12:00:00.000Z,1280x800,"Austin, Texas",1,10 Best Dentists in Austin (2026),https://www.austinhealthguide.example/best-dentists-austin,austinhealthguide.example,1431,Below the fold,,,yes,page',
    );
    expect(lines[6]).toContain(',my brand,BrightPath Dental,no,page');
  });

  it('says for each result how its address is known when Google hides the links', () => {
    // Three results of one page: an address read from the link, only the site, and nothing at all.
    const hiddenLink = 'https://www.google.com/goto?url=CAESfour';
    const page = synthetic({
      organic: [
        result(1, 200, 'brightpathdental.example'),
        { ...result(2, 320, 'lakesidesmiles.example'), address: 'site' as const },
        { ...result(3, 440), url: hiddenLink, domain: '', address: 'hidden' as const },
      ],
    });
    const measured = computeClickPotential(page, matcher);
    expect(measured.organic.map((o) => [o.position, o.address, o.domain, o.owner])).toEqual([
      [1, 'link', 'brightpathdental.example', 'mine'],
      // The site is enough to recognise a tracked brand.
      [2, 'site', 'lakesidesmiles.example', 'competitor'],
      [3, 'hidden', '', null],
    ]);
    const lines = organicCsv(page, measured).replace('\uFEFF', '').trim().split('\r\n');
    expect(lines.slice(1).map((line) => line.split(',').at(-1))).toEqual(['page', 'site only', 'hidden by Google']);
    // The stored measurement keeps it, so a later comparison never takes a site's home page for the result.
    expect(toSnapshot(page, measured).organic.map((o) => o.address)).toEqual(['link', 'site', 'hidden']);
  });

  it('exports snapshot history as CSV with per-block shares', () => {
    const lines = historyCsv([snapshot, toSnapshot(plain, computeClickPotential(plain, matcher))]).replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toContain('first_organic_px,first_organic_fold,grade_estimate,score,first_screen_pct_organic_results,first_screen_pct_ai_overview');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(',1431,Below the fold,F,0,0,');
    expect(lines[1]!.endsWith(',6,2475')).toBe(true);
    expect(lines[2]).toContain(',152,Above the fold,A,');
  });
});
