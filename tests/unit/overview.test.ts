import { describe, expect, it } from 'vitest';
import { readAnswer } from '@/answers/read';
import { BrandMatcher } from '@/brands/matcher';
import { LEGIIT_SERVICES } from '@/config/legiit-links';
import { AI_SITES, type AiSiteId } from '@/config/sites';
import { extractPageFacts } from '@/extract/page-facts';
import { computeClickPotential } from '@/features/click-potential/metrics';
import { toSnapshot, type SnapshotRecord } from '@/features/click-potential/snapshot';
import { findIssues } from '@/features/instant-brief/issues';
import { keywordRows } from '@/features/overview/keywords';
import { buildAnswerOverview, buildPageOverview, buildResultsOverview } from '@/features/overview/overview';
import { crowdingOf, daysAgo, howFarDown, listOf, someOf } from '@/features/overview/words';
import { buildAnswerPresence, buildSerpPresence, summarisePresence } from '@/features/why-not-me/presence';
import { getPack } from '@/selectors';
import { parseSerp } from '@/serp/parse';
import { fixtureDoc, scenario, scenarioBrands, serpEnv } from '../helpers/fixtures';

const matcher = new BrandMatcher(scenarioBrands);
const results = (file: string, url: string, who: BrandMatcher = matcher) => {
  const doc = fixtureDoc(file);
  const serp = parseSerp(doc, getPack('google'), serpEnv(doc, url));
  return { serp, overview: buildResultsOverview(serp, computeClickPotential(serp, who), buildSerpPresence(serp, who), who) };
};

describe('plain words', () => {
  it('names how crowded a search is instead of grading it', () => {
    expect(['A', 'B', 'C', 'D', 'F'].map((letter) => crowdingOf(letter as 'A'))).toEqual(['open', 'open', 'crowded', 'crowded', 'very-crowded']);
  });

  it('counts in screens instead of pixels', () => {
    expect(howFarDown(152, 800)).toBe('on the first screen');
    expect(howFarDown(799, 800)).toBe('on the first screen');
    expect(howFarDown(900, 800)).toBe('just below the first screen');
    expect(howFarDown(1431, 800)).toBe('about 2 screens down');
    expect(howFarDown(3101, 900)).toBe('about 3 screens down');
    expect(howFarDown(null, 800)).toBe('');
    expect(howFarDown(500, 0)).toBe('');
  });

  it('writes lists and dates the way people say them', () => {
    expect(listOf([])).toBe('');
    expect(listOf(['a'])).toBe('a');
    expect(listOf(['a', 'b'])).toBe('a and b');
    expect(listOf(['a', 'b', 'c'])).toBe('a, b and c');
    expect(someOf(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
    const day = 86_400_000;
    expect([0, 1, 3, 45, 70].map((days) => daysAgo(1_000 * day - days * day, 1_000 * day))).toEqual(['today', 'yesterday', '3 days ago', 'a month ago', '2 months ago']);
  });
});

describe('the Overview of a Google results page', () => {
  it('says where the user stands, who is ahead and how crowded the page is', () => {
    const { overview } = results('google/serp-full.html', scenario.urls.serpFull!);
    expect(overview).toMatchObject({ kind: 'results', headline: 'You are #6 for “best dentist in austin”.', tone: 'mixed', crowding: 'very-crowded', personal: true });
    expect(overview.facts).toEqual([
      'Your result is about 3 screens down: people scroll to reach it.',
      "Google's AI answer names Lakeside Smiles, Capitol Dental Care and Zilker Family Dentistry, not you.",
      'Lakeside Smiles is #2, Capitol Dental Care is #4 and Zilker Family Dentistry is #8.',
      '2 ads, the AI answer and a map of local businesses come before the first result, which starts about 2 screens down.',
    ]);
    // No pixel and no letter grade in what the user reads first.
    expect([overview.headline, ...overview.facts, ...overview.steps.map((s) => s.text)].join(' ')).not.toMatch(/\bpx\b|\bfold\b|organic|\bgrade\b/i);
  });

  it('turns what it found into at most three next steps, each with the tool that does it', () => {
    const { overview } = results('google/serp-full.html', scenario.urls.serpFull!);
    expect(overview.steps.map((s) => [s.id, s.open?.tool, s.legiit?.url])).toEqual([
      ['lists', 'why', LEGIIT_SERVICES.guestPosts.url],
      ['ai-sources', 'why', LEGIIT_SERVICES.backlinks.url],
      ['local', 'why', LEGIIT_SERVICES.localSeo.url],
    ]);
    expect(overview.steps[0]!.text).toBe('3 pages that look like “best of” lists rank here (austinhealthguide.example, texaslocalpicks.example and smilecompare.example). If they can name you, being on them puts you on this page.');
    expect(overview.steps[1]!.text).toBe('The AI answer draws on 4 pages. Being on those pages is how you get into the answer.');
    // A quiet page has one thing to do: compare.
    const quiet = results('google/serp-plain.html', scenario.urls.serpPlain!).overview;
    expect(quiet).toMatchObject({ headline: 'You are #5 for “how often should you get your teeth cleaned”.', crowding: 'open' });
    expect(quiet.facts).toContain('Your result is on the first screen.');
    expect(quiet.facts).toContain('The results start at the top of the page.');
    expect(quiet.steps.map((s) => s.id)).toEqual(['compare']);
  });

  it('reads the same from a page on which Google hides the links', () => {
    const shown = results('google/serp-full.html', scenario.urls.serpFull!).overview;
    const hidden = results('google/serp-hidden-links.html', scenario.urls.serpHidden!).overview;
    expect(hidden.headline).toBe('You are #6 for “family dentist austin tx”.');
    expect(hidden.facts).toEqual(shown.facts);
    expect(hidden.steps.map((s) => s.text)).toEqual(shown.steps.map((s) => s.text));
  });

  it('says it plainly when the user is not on the page, and names who is', () => {
    const elsewhere = new BrandMatcher({ mine: [{ id: 'x', name: 'Northgate Dental', domains: ['northgatedental.example'], aliases: [] }], competitors: [] });
    const { overview } = results('google/serp-plain.html', scenario.urls.serpPlain!, elsewhere);
    expect(overview).toMatchObject({ headline: 'You are not on page 1 for “how often should you get your teeth cleaned”.', tone: 'bad' });
    expect(overview.facts[0]).toBe('The top results are from capitoldentalcare.example, smilehealthdaily.example, lakesidesmiles.example and 5 more.');
    expect(overview.steps.map((s) => [s.id, s.text])).toEqual([['compare', 'Check one of your pages against the pages that rank here.']]);
    // On a later page of results the place is counted from the first page on.
    const later = results('google/serp-plain.html', `${scenario.urls.serpPlain!}&start=10`);
    expect(later.overview.headline).toBe('You are about #15 for “how often should you get your teeth cleaned”.');
    expect(results('google/serp-plain.html', `${scenario.urls.serpPlain!}&start=10`, elsewhere).overview.headline).toMatch(/^You are not on this page for/);
  });

  it('does not speak about "you" before the user has said which site is theirs', () => {
    const nobody = new BrandMatcher({ mine: [], competitors: [] });
    const { overview } = results('google/serp-full.html', scenario.urls.serpFull!, nobody);
    expect(overview).toMatchObject({ personal: false, tone: 'neutral', headline: '9 results for “best dentist in austin”. The first is from austinhealthguide.example.' });
    expect(overview.facts[0]).toBe("Google's AI answer draws on austinhealthguide.example, lakesidesmiles.example, texaslocalpicks.example and 1 more.");
    expect(overview.steps).toEqual([]);
    expect([overview.headline, ...overview.facts].join(' ')).not.toMatch(/\byou\b|\byour\b/i);
  });

  it('does not call a competitor\'s own page or a forum thread a list to get named on', () => {
    const { serp } = results('google/serp-plain.html', scenario.urls.serpPlain!);
    const organic = serp.organic.map((o) =>
      o.position === 1 ? { ...o, listStyle: true } : o.position === 2 ? { ...o, listStyle: true, domain: 'reddit.com' } : o.position === 4 ? { ...o, listStyle: true } : o,
    );
    const page = { ...serp, organic };
    const overview = buildResultsOverview(page, computeClickPotential(page, matcher), buildSerpPresence(page, matcher), matcher);
    // #1 is a tracked competitor's site, #2 is a forum: only #4 is a list someone else wrote.
    expect(overview.steps.find((s) => s.id === 'lists')?.text).toBe('A page that looks like a “best of” list ranks here (familydentalfacts.example). If it can name you, being on it puts you on this page.');
  });
});

describe('the Overview of an AI answer', () => {
  const answer = (site: AiSiteId) => readAnswer(fixtureDoc(`ai/${site}.html`), getPack(site), site, { url: scenario.urls[site]!, now: 1, ownHosts: AI_SITES[site].hosts });

  it('says whether the answer names the user, and what to do when it does not', () => {
    const chatgpt = buildAnswerOverview(buildAnswerPresence(answer('chatgpt'), matcher), matcher);
    expect(chatgpt).toMatchObject({ kind: 'answer', tone: 'bad', headline: 'ChatGPT names Lakeside Smiles, Capitol Dental Care and Zilker Family Dentistry, not you.' });
    expect(chatgpt.facts).toEqual(['The question: “Who are the best dentists in Austin?”.', 'Its sources: austinhealthguide.example, smilecompare.example and texaslocalpicks.example.']);
    expect(chatgpt.steps.map((s) => [s.id, s.open?.tool, s.legiit?.url])).toEqual([['sources', 'why', LEGIIT_SERVICES.guestPosts.url]]);

    const perplexity = buildAnswerOverview(buildAnswerPresence(answer('perplexity'), matcher), matcher);
    expect(perplexity).toMatchObject({ tone: 'good', headline: 'Perplexity names you.' });
    expect(perplexity.facts).toContain('It also names Lakeside Smiles and Capitol Dental Care.');
    // Named already: nothing to chase, the pages are there to look at.
    expect(perplexity.steps.map((s) => s.id)).toEqual(['details']);
  });

  it('reads Google AI Mode the same way', () => {
    const doc = fixtureDoc('google/serp-ai-mode.html');
    const serp = parseSerp(doc, getPack('google'), serpEnv(doc, scenario.urls.serpAiMode!));
    const overview = buildAnswerOverview(buildSerpPresence(serp, matcher), matcher);
    expect(overview.kind).toBe('answer');
    expect(overview.headline).toMatch(/^Google AI Mode names .*, not you\.$/);
  });
});

describe('the Overview of an ordinary page', () => {
  const check = (html: string, url: string, isMine: boolean) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const facts = extractPageFacts(doc, url);
    const issues = findIssues([{ url, kind: new URL(url).pathname === '/' ? 'home' : 'other', doc, facts }]);
    const imagesWithoutAlt = [...doc.querySelectorAll('img')].filter((img) => !(img.getAttribute('alt') ?? '').trim()).length;
    return buildPageOverview({ url, title: facts.title ?? '', facts, issues, imagesWithoutAlt, isMine });
  };

  it('names the basic problems of the page in plain words', () => {
    const overview = check(
      '<html><head><title>Home</title><meta name="robots" content="noindex"></head><body><h1>One</h1><h1>Two</h1><img src="a.png"><img src="b.png" alt=""><p>Short.</p></body></html>',
      'http://www.example.com/services',
      true,
    );
    expect(overview).toMatchObject({ kind: 'page', tone: 'bad', personal: true });
    expect(overview.headline).toMatch(/^\d+ things to fix on your page\.$/);
    expect(overview.facts).toEqual([
      'The page is not served over HTTPS, so browsers call it “not secure”.',
      'The page tells search engines not to list it.',
      'The title says very little (“Home”).',
      'There is no description for search results, so Google writes its own.',
    ]);
    expect(overview.steps.map((s) => [s.id, s.open?.tool])).toEqual([['content', 'noise'], ['history', 'rewind'], ['brief', 'brief']]);
  });

  it('says so when nothing basic is wrong', () => {
    const html = `<html><head><title>Teeth Cleaning in South Austin | BrightPath</title><meta name="description" content="x"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://www.example.com/cleaning"></head><body><h1>Teeth cleaning</h1><p>${'word '.repeat(150)}</p></body></html>`;
    const overview = check(html, 'https://www.example.com/cleaning', false);
    expect(overview).toMatchObject({ headline: 'No basic problems on this page.', tone: 'good', facts: [], personal: false });
  });
});

describe('My keywords', () => {
  const day = 86_400_000;
  const doc = fixtureDoc('google/serp-full.html');
  const serp = parseSerp(doc, getPack('google'), serpEnv(doc, scenario.urls.serpFull!));
  const base = toSnapshot(serp, computeClickPotential(serp, matcher), summarisePresence(buildSerpPresence(serp, matcher)));
  const at = (id: string, takenAt: number, change: Partial<SnapshotRecord> = {}): SnapshotRecord => ({ ...base, id, takenAt, ...change });
  const mine = (position: number | null) => base.tracked.filter((t) => t.owner !== 'mine').concat(position === null ? [] : [{ ...base.tracked.find((t) => t.owner === 'mine')!, position }]);

  it('lists each search once, newest first, with the user\'s place and how it moved', () => {
    const rows = keywordRows([
      at('a1', 10 * day, { tracked: mine(9) }),
      at('a2', 12 * day, { tracked: mine(6) }),
      at('b1', 11 * day, { keyword: 'emergency dentist austin', keywordKey: 'emergency dentist austin', tracked: mine(null) }),
    ]);
    expect(rows.map((r) => [r.keyword, r.rank, r.moved, r.entered, r.checks])).toEqual([
      ['best dentist in austin', 6, 3, null, 2],
      ['emergency dentist austin', null, null, null, 1],
    ]);
    expect(rows[0]).toMatchObject({ ai: 'out', crowding: 'very-crowded', searchUrl: 'https://www.google.com/search?q=best%20dentist%20in%20austin' });
  });

  it('tells coming onto the page and falling off it apart from moving on it', () => {
    const came = keywordRows([at('a1', 10 * day, { tracked: mine(null) }), at('a2', 12 * day, { tracked: mine(8) })])[0]!;
    expect([came.rank, came.moved, came.entered]).toEqual([8, null, 'in']);
    const left = keywordRows([at('a1', 10 * day, { tracked: mine(8) }), at('a2', 12 * day, { tracked: mine(null) })])[0]!;
    expect([left.rank, left.moved, left.entered]).toEqual([null, null, 'out']);
    const down = keywordRows([at('a1', 10 * day, { tracked: mine(3) }), at('a2', 12 * day, { tracked: mine(5) })])[0]!;
    expect(down.moved).toBe(-2);
  });

  it('counts two looks at one page on one day as one check', () => {
    const rows = keywordRows([at('a1', 12 * day + 1_000, { tracked: mine(7) }), at('a2', 12 * day + 60_000, { tracked: mine(6) })]);
    expect([rows[0]!.rank, rows[0]!.moved, rows[0]!.entered]).toEqual([6, null, null]);
  });

  it('knows what it cannot know', () => {
    // Stored before any brand was tracked: there is no "you" in it.
    const blank = keywordRows([at('a1', 12 * day, { tracked: [], presence: null })])[0]!;
    expect([blank.rank, blank.ai]).toEqual([undefined, 'unknown']);
    // A search without an AI answer.
    const plainDoc = fixtureDoc('google/serp-plain.html');
    const plain = parseSerp(plainDoc, getPack('google'), serpEnv(plainDoc, scenario.urls.serpPlain!));
    const row = keywordRows([toSnapshot(plain, computeClickPotential(plain, matcher), summarisePresence(buildSerpPresence(plain, matcher)))])[0]!;
    expect([row.rank, row.ai, row.crowding]).toEqual([5, 'none', 'open']);
  });
});
