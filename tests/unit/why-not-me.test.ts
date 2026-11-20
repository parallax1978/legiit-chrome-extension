import { describe, expect, it, vi } from 'vitest';
import { readAnswer } from '@/answers/read';
import { BrandMatcher } from '@/brands/matcher';
import { AI_SITES, type AiSiteId } from '@/config/sites';
import { digestHtml, failedDigest, type PageDigest } from '@/extract/digest';
import { loadPages } from '@/features/shared/load-pages';
import { buildGapRows, gapCsv, sortGapRows } from '@/features/why-not-me/gap';
import { answerSentences, matchPassages, passageCandidates } from '@/features/why-not-me/passages';
import { buildAnswerPresence, buildSerpPresence, explainPresence } from '@/features/why-not-me/presence';
import { analysePage, pickAnswerTargets, pickSerpTargets } from '@/features/why-not-me/scan';
import type { FetchedHtml } from '@/net/page-fetch';
import { getPack } from '@/selectors';
import { parseSerp } from '@/serp/parse';
import { countWords } from '@/lib/text';
import { LexicalEngine } from '@/similarity/engine';
import { fixtureDoc, fixtureJson, fixtureText, scenario, scenarioBrands, serpEnv } from '../helpers/fixtures';

const matcher = new BrandMatcher(scenarioBrands);
const manifest = fixtureJson<{ routes: { url: string; file: string }[] }>('manifest.json');
const fileFor = (url: string) => manifest.routes.find((r) => r.url === url)?.file;

function serp(file: string, url: string) {
  const doc = fixtureDoc(file);
  return parseSerp(doc, getPack('google'), serpEnv(doc, url));
}

function answer(site: AiSiteId, file: string, url: string) {
  return readAnswer(fixtureDoc(file), getPack(site), site, { url, now: 1, ownHosts: AI_SITES[site].hosts });
}

/** Serves fixtures as if they had been fetched from their real URLs. */
async function fetchFixture(url: string): Promise<FetchedHtml> {
  const file = fileFor(url);
  if (!file) return { url, finalUrl: url, ok: false, status: 404, html: '', error: 'The site answered 404', needsPermission: false };
  return { url, finalUrl: url, ok: true, status: 200, html: fixtureText(file), error: null, needsPermission: false };
}

const full = serp('google/serp-full.html', scenario.urls.serpFull!);
const presence = buildSerpPresence(full, matcher);
const surface = (id: string) => presence.surfaces.find((s) => s.id === id)!;

describe('presence on Google results', () => {
  it('reports the five surfaces from the brief, plus ads when present', () => {
    expect(presence.surfaces.map((s) => s.id)).toEqual(['ai_overview', 'organic', 'local_pack', 'forum', 'video', 'ad']);
    expect(presence.sourceLabel).toBe('Google results');
    expect(presence.subject).toBe('best dentist in austin');
  });

  it('marks competitors in AI Overview citations and in its text', () => {
    const aio = surface('ai_overview');
    expect(aio.status).toBe('only-competitors');
    expect(aio.textCompetitors).toEqual(['Lakeside Smiles', 'Capitol Dental Care', 'Zilker Family Dentistry']);
    expect(aio.items.map((i) => [i.domain, i.ownSite, i.competitors])).toEqual([
      ['austinhealthguide.example', null, []],
      ['lakesidesmiles.example', 'competitor', ['Lakeside Smiles']],
      ['texaslocalpicks.example', null, []],
      ['capitoldentalcare.example', 'competitor', ['Capitol Dental Care']],
    ]);
    expect(aio.minePresent).toBe(false);
  });

  it('marks the user and competitors in organic results', () => {
    const organic = surface('organic');
    expect(organic.status).toBe('both');
    expect(organic.items.find((i) => i.mine.length > 0)).toMatchObject({ position: 6, ownSite: 'mine', domain: 'brightpathdental.example' });
    expect(organic.items.filter((i) => i.ownSite === 'competitor').map((i) => i.position)).toEqual([2, 4, 8]);
    // A third-party comparison page naming two competitors in its title.
    expect(organic.items[4]).toMatchObject({ ownSite: null, listStyle: true, competitors: ['Lakeside Smiles', 'Capitol Dental Care'] });
  });

  it('marks brands in the local pack, forums and videos', () => {
    expect(surface('local_pack')).toMatchObject({ status: 'only-competitors', competitorNames: ['Lakeside Smiles', 'Capitol Dental Care', 'Zilker Family Dentistry'] });
    expect(surface('forum')).toMatchObject({ status: 'only-competitors', competitorNames: ['Lakeside Smiles', 'Capitol Dental Care'] });
    // Videos are matched through channel names and titles, since they all live on youtube.com.
    expect(surface('video')).toMatchObject({ status: 'both', minePresent: true, competitorNames: ['Lakeside Smiles', 'Capitol Dental Care'] });
  });

  it('shows surfaces that the page does not have as absent', () => {
    const plain = buildSerpPresence(serp('google/serp-plain.html', scenario.urls.serpPlain!), matcher);
    expect(plain.surfaces.map((s) => [s.id, s.present])).toEqual([
      ['ai_overview', false],
      ['organic', true],
      ['local_pack', false],
      ['forum', false],
      ['video', false],
    ]);
    expect(plain.surfaces[0]?.status).toBe('absent');
  });

  it('still finds local-pack brands after class churn', () => {
    const churned = buildSerpPresence(serp('google/serp-churn.html', scenario.urls.serpChurn!), matcher);
    expect(churned.surfaces.find((s) => s.id === 'local_pack')?.competitorNames).toHaveLength(3);
  });

  it('treats the AI Mode answer as the AI surface', () => {
    const aiMode = buildSerpPresence(serp('google/serp-ai-mode.html', scenario.urls.serpAiMode!), matcher);
    expect(aiMode.sourceLabel).toBe('Google AI Mode');
    expect(aiMode.surfaces.map((s) => s.id)).toEqual(['ai_overview']);
    expect(aiMode.surfaces[0]).toMatchObject({ status: 'only-competitors', textCompetitors: ['Lakeside Smiles', 'Capitol Dental Care', 'Zilker Family Dentistry'] });
  });

  it('explains presence in plain language', () => {
    const lines = explainPresence(presence, matcher);
    expect(lines[0]).toBe('Your brand appears on 2 of 6 surfaces: organic results, videos.');
    expect(lines[1]).toMatch(/^Competitors: Lakeside Smiles \(ai overview, organic results, local pack, forums, videos, ads\)/);
    expect(lines[2]).toBe('Competitors are present and you are not on: ai overview, local pack, forums, ads.');
    expect(explainPresence(presence, new BrandMatcher({ mine: [], competitors: [] }))[0]).toMatch(/Add your brand/);
  });
});

describe('presence in AI answers', () => {
  it('marks mentions in the answer text and in cited pages', () => {
    const p = buildAnswerPresence(answer('chatgpt', 'ai/chatgpt.html', scenario.urls.chatgpt!), matcher);
    expect(p.sourceLabel).toBe('ChatGPT');
    expect(p.subject).toBe('Who are the best dentists in Austin?');
    expect(p.surfaces[0]).toMatchObject({ id: 'answer_text', status: 'only-competitors', textCompetitors: ['Lakeside Smiles', 'Capitol Dental Care', 'Zilker Family Dentistry'] });
    expect(p.surfaces[1]).toMatchObject({ id: 'citations', present: true });
    expect(p.surfaces[1]!.items).toHaveLength(3);
  });

  it('recognises when the answer does mention the user', () => {
    const p = buildAnswerPresence(answer('perplexity', 'ai/perplexity.html', scenario.urls.perplexity!), matcher);
    expect(p.surfaces[0]).toMatchObject({ status: 'both', textMine: ['BrightPath Dental'] });
  });
});

describe('scan targets', () => {
  it('picks cited pages first, then list-style results, without duplicates or own pages', () => {
    const targets = pickSerpTargets(full, { matcher });
    expect(targets.map((t) => [t.reason, t.foundIn, t.domain])).toEqual([
      ['cited', 'AI Overview citation', 'austinhealthguide.example'],
      ['cited', 'AI Overview citation', 'lakesidesmiles.example'],
      ['cited', 'AI Overview citation', 'texaslocalpicks.example'],
      ['cited', 'AI Overview citation', 'capitoldentalcare.example'],
      ['list', 'Organic #5', 'smilecompare.example'],
    ]);
    expect(pickSerpTargets(full, { matcher, max: 2 })).toHaveLength(2);
  });

  it('picks the pages an AI answer cites', () => {
    const targets = pickAnswerTargets(answer('gemini', 'ai/gemini.html', scenario.urls.gemini!), 'Gemini', { matcher });
    expect(targets.map((t) => t.foundIn)).toEqual(['Cited by Gemini', 'Cited by Gemini', 'Cited by Gemini']);
  });
});

describe('page loading and analysis', () => {
  it('digests fetched pages, reports failures as data and reports progress', async () => {
    const progress = vi.fn();
    const digests = await loadPages(
      ['https://www.austinhealthguide.example/best-dentists-austin', 'https://missing.example/nope'],
      { fetchPage: fetchFixture, now: () => 1000 },
      { onProgress: progress, concurrency: 2 },
    );
    expect(digests[0]).toMatchObject({ ok: true, title: '10 Best Dentists in Austin (2026) – Austin Health Guide', listStyle: true });
    expect(digests[0]!.contacts.length).toBeGreaterThan(2);
    expect(digests[1]).toMatchObject({ ok: false, error: 'The site answered 404', status: 404 });
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls[1]?.slice(0, 2)).toEqual([2, 2]);
  });

  it('uses a fresh cache entry and refetches a stale one', async () => {
    const store = new Map<string, PageDigest>();
    const cache = { get: async (k: string) => store.get(k), put: async (k: string, d: PageDigest) => void store.set(k, d) };
    const fetchPage = vi.fn(fetchFixture);
    const url = 'https://texaslocalpicks.example/austin/top-rated-dentists';
    let now = 1_000;
    await loadPages([url], { fetchPage, cache, now: () => now });
    await loadPages([`${url}?utm_source=x`], { fetchPage, cache, now: () => now });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    now += 25 * 60 * 60 * 1000;
    await loadPages([url], { fetchPage, cache, now: () => now });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('never caches failures and survives a broken cache', async () => {
    const put = vi.fn();
    const cache = { get: async () => { throw new Error('idb down'); }, put };
    const digests = await loadPages(['https://missing.example/x', scenario.urls.plainPage!], { fetchPage: fetchFixture, cache: cache as never });
    expect(digests.map((d) => d.ok)).toEqual([false, true]);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('reports which competitors a list page names and that the user is missing', async () => {
    const [target] = pickSerpTargets(full, { matcher });
    const [digest] = await loadPages([target!.url], { fetchPage: fetchFixture });
    const scan = analysePage(target!, digest!, matcher);
    expect(scan).toMatchObject({ ok: true, isGap: true, myBrandPresent: false, listStyle: true });
    // Most mentioned first; ties in alphabetical order.
    expect(scan.competitors).toEqual([
      { name: 'Capitol Dental Care', mentions: 2 },
      { name: 'Lakeside Smiles', mentions: 2 },
      { name: 'Zilker Family Dentistry', mentions: 2 },
    ]);
    expect(scan.contacts.map((c) => c.kind)).toEqual(expect.arrayContaining(['author', 'contact', 'submission']));
  });

  it('does not call a page a gap when it also names the user', () => {
    const url = 'https://www.atxneighbors.example/dentist-recommendations';
    const digest = digestHtml(fixtureText(fileFor(url)!), url);
    const scan = analysePage({ url, title: 't', domain: 'atxneighbors.example', reason: 'cited', foundIn: 'Cited by Perplexity', position: 2 }, digest, matcher);
    expect(scan.myBrandPresent).toBe(true);
    expect(scan.isGap).toBe(false);
    expect(scan.competitors.map((c) => c.name)).toEqual(['Lakeside Smiles']);
  });

  it('carries fetch failures through as unscanned pages', () => {
    const target = { url: 'https://x.example/', title: 'X', domain: 'x.example', reason: 'cited' as const, foundIn: 'Cited by ChatGPT', position: 1 };
    expect(analysePage(target, failedDigest(target.url, 'Timed out'), matcher)).toMatchObject({ ok: false, error: 'Timed out', isGap: false });
    expect(analysePage(target, failedDigest(target.url, 'Site access not granted', 0, true), matcher).needsPermission).toBe(true);
  });
});

describe('passages most similar to the answer', () => {
  it('splits a page into paragraph-sized candidates', () => {
    const digest = digestHtml(fixtureText('lists/austinhealthguide-best-dentists.html'), 'https://www.austinhealthguide.example/best-dentists-austin');
    const candidates = passageCandidates(digest.blocks);
    expect(candidates.some((c) => c.startsWith('Lakeside Smiles is praised for gentle cleanings'))).toBe(true);
    expect(candidates.every((c) => countWords(c) >= 8)).toBe(true);
    const long = passageCandidates([{ kind: 'paragraph', text: Array.from({ length: 30 }, (_, i) => `Sentence ${i} has exactly six words.`).join(' ') }]);
    expect(long.length).toBeGreaterThan(1);
    expect(long.every((c) => countWords(c) <= 70)).toBe(true);
  });

  it('returns the one or two closest passages per cited page with the sentence they resemble', async () => {
    const chatgpt = answer('chatgpt', 'ai/chatgpt.html', scenario.urls.chatgpt!);
    expect(answerSentences(chatgpt.text).length).toBeGreaterThanOrEqual(4);
    const pages = await Promise.all(
      chatgpt.citations.map(async (c) => ({ key: c.url, blocks: digestHtml((await fetchFixture(c.url)).html, c.url).blocks })),
    );
    const passages = await matchPassages(chatgpt.text, pages, new LexicalEngine());
    const ahg = passages.get('https://www.austinhealthguide.example/best-dentists-austin')!;
    expect(ahg.length).toBeGreaterThanOrEqual(1);
    expect(ahg.length).toBeLessThanOrEqual(2);
    expect(ahg).toHaveLength(2);
    // The answer repeats two of this page's paragraphs almost word for word.
    const texts = ahg.map((p) => p.text).join('\n');
    expect(texts).toContain('Lakeside Smiles is praised for gentle cleanings, same-week appointments and clear pricing for new patients.');
    expect(texts).toContain('Capitol Dental Care is a downtown practice known for cosmetic work and evening hours');
    for (const passage of ahg) expect(passage.text).toContain(passage.answerSentence.includes('Lakeside') ? 'Lakeside Smiles' : 'Capitol Dental Care');
    expect(ahg[0]!.score).toBeGreaterThan(0.6);
    expect(ahg[0]!.score).toBeGreaterThanOrEqual(ahg[1]!.score);
    expect(passages.get('https://smilecompare.example/lakeside-smiles-vs-capitol-dental-care')![0]!.text).toContain('downtown practice known for cosmetic work');
  });

  it('returns nothing for an empty answer or an unrelated page', async () => {
    const engine = new LexicalEngine();
    expect((await matchPassages('', [{ key: 'a', blocks: [{ kind: 'paragraph', text: 'Some words that are long enough to be a passage here.' }] }], engine)).get('a')).toEqual([]);
    const unrelated = await matchPassages('Lakeside Smiles is a dentist in Austin with gentle cleanings.', [
      { key: 'b', blocks: [{ kind: 'paragraph', text: 'Quarterly revenue grew because container shipping rates fell sharply.' }] },
    ], engine);
    expect(unrelated.get('b')).toEqual([]);
  });
});

describe('gap list', () => {
  it('lists every place a competitor is present and the user is not', () => {
    const rows = buildGapRows(presence);
    expect(rows.every((r) => r.competitors.length > 0)).toBe(true);
    const bySurface = (id: string) => rows.filter((r) => r.surfaceId === id);
    expect(bySurface('ai_overview').map((r) => r.surface)).toEqual(expect.arrayContaining(['AI Overview text', 'AI Overview citation']));
    expect(bySurface('local_pack')).toHaveLength(3);
    expect(bySurface('organic').map((r) => r.surface)).toEqual(expect.arrayContaining(['Organic #2', 'Organic #4', 'Organic #5', 'Organic #8']));
    // The user's own result and the video that features the user are not gaps.
    expect(rows.some((r) => r.domain === 'brightpathdental.example')).toBe(false);
    expect(rows.some((r) => r.title.includes('BrightPath'))).toBe(false);
  });

  it('separates competitor-owned pages from third-party pages you could get onto', () => {
    const rows = buildGapRows(presence);
    const ownSite = rows.find((r) => r.surface === 'Organic #2')!;
    expect(ownSite).toMatchObject({ pageType: 'competitor-site', actionable: false });
    expect(ownSite.evidence).toBe("Lakeside Smiles's own page appears here; yours does not.");
    const versus = rows.find((r) => r.surface === 'Organic #5')!;
    expect(versus).toMatchObject({ pageType: 'list', actionable: true, competitors: ['Lakeside Smiles', 'Capitol Dental Care'] });
    expect(rows.find((r) => r.surfaceId === 'forum')).toMatchObject({ pageType: 'forum', actionable: true });
  });

  it('adds scan evidence, contact links and newly found gaps after "Scan sources"', async () => {
    const targets = pickSerpTargets(full, { matcher });
    const digests = await loadPages(targets.map((t) => t.url), { fetchPage: fetchFixture });
    const scans = targets.map((t, i) => analysePage(t, digests[i]!, matcher));
    const rows = buildGapRows(presence, scans);

    // The "10 Best Dentists" page did not look like a gap from its title; the scan shows it names all three competitors.
    const listPage = rows.find((r) => r.domain === 'austinhealthguide.example')!;
    expect(listPage).toMatchObject({ scanned: true, pageType: 'list', actionable: true });
    expect(listPage.competitors).toEqual(['Capitol Dental Care', 'Lakeside Smiles', 'Zilker Family Dentistry']);
    expect(listPage.evidence).toBe('This page names Capitol Dental Care (2×), Lakeside Smiles (2×) and Zilker Family Dentistry (2×) and never mentions you.');
    expect(listPage.contacts.some((c) => c.kind === 'submission')).toBe(true);
    // The same page is a gap on two surfaces: it is cited by the AI Overview and it ranks #1.
    expect(rows.filter((r) => r.domain === 'austinhealthguide.example').map((r) => r.surface).sort()).toEqual(['AI Overview citation', 'Organic #1']);

    const tlp = rows.find((r) => r.domain === 'texaslocalpicks.example')!;
    expect(tlp.contacts.find((c) => c.kind === 'submission')?.url).toBe('https://texaslocalpicks.example/get-listed');
    // Sorted by priority: the scanned AI Overview citations come before plain organic rows.
    expect(rows[0]!.surfaceId).toBe('ai_overview');
    expect(rows.indexOf(listPage)).toBeLessThan(rows.findIndex((r) => r.surface === 'Organic #8'));
  });

  it('builds gap rows for AI answers, and for cited pages once they are scanned', async () => {
    const copilot = answer('copilot', 'ai/copilot.html', scenario.urls.copilot!);
    const p = buildAnswerPresence(copilot, matcher);
    const before = buildGapRows(p);
    expect(before[0]).toMatchObject({ surface: 'Answer text', pageType: 'surface' });
    expect(before[0]!.evidence).toBe('The Copilot answer names Lakeside Smiles, Capitol Dental Care and Zilker Family Dentistry and does not mention you.');
    // A citation labelled only "SmileCompare" says nothing about competitors until the page is read.
    expect(before.some((r) => r.domain === 'smilecompare.example')).toBe(false);

    const targets = pickAnswerTargets(copilot, 'Copilot', { matcher });
    const digests = await loadPages(targets.map((t) => t.url), { fetchPage: fetchFixture });
    const after = buildGapRows(p, targets.map((t, i) => analysePage(t, digests[i]!, matcher)));
    const versus = after.find((r) => r.domain === 'smilecompare.example')!;
    expect(versus).toMatchObject({ surface: 'Cited page', scanned: true, pageType: 'list' });
    expect([...versus.competitors].sort()).toEqual(['Capitol Dental Care', 'Lakeside Smiles']);
    expect(after.find((r) => r.domain === 'smilecompare.example')!.contacts.map((c) => c.label)).toContain('Write for us');
  });

  it('flags a cited page that is a competitor\'s own site', () => {
    const p = buildAnswerPresence(answer('gemini', 'ai/gemini.html', scenario.urls.gemini!), matcher);
    expect(buildGapRows(p).find((r) => r.domain === 'capitoldentalcare.example')).toMatchObject({ surface: 'Cited page', pageType: 'competitor-site', actionable: false });
  });

  it('has no gap rows when the user is present wherever competitors are', () => {
    const p = buildAnswerPresence(answer('perplexity', 'ai/perplexity.html', scenario.urls.perplexity!), matcher);
    expect(buildGapRows(p).filter((r) => r.surfaceId === 'answer_text')).toEqual([]);
  });

  it('sorts by any column in both directions', () => {
    const rows = buildGapRows(presence);
    const byPosition = sortGapRows(rows, 'position', 'asc').map((r) => r.position ?? Infinity);
    expect([...byPosition].sort((a, b) => a - b)).toEqual(byPosition);
    const byCompetitors = sortGapRows(rows, 'competitors', 'desc').map((r) => r.competitors.length);
    expect([...byCompetitors].sort((a, b) => b - a)).toEqual(byCompetitors);
    const byDomain = sortGapRows(rows, 'domain', 'asc').map((r) => r.domain ?? '');
    expect([...byDomain].sort((a, b) => a.localeCompare(b))).toEqual(byDomain);
    expect(sortGapRows(rows, 'priority', 'asc')[0]!.priority).toBeLessThanOrEqual(rows[0]!.priority);
    expect(rows).toHaveLength(sortGapRows(rows, 'title', 'desc').length);
  });

  it('exports the gap list as CSV', () => {
    const csv = gapCsv(presence, buildGapRows(presence)).replace('﻿', '');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(
      'source,query_or_question,surface,position,title,url,domain,competitors_present,your_brand_present,evidence,page_type,actionable,scanned,contact_links',
    );
    expect(lines.length).toBe(buildGapRows(presence).length + 1);
    expect(csv).toContain('Google results,best dentist in austin,Organic #5,5,');
    expect(csv).toContain('Lakeside Smiles; Capitol Dental Care');
  });
});
