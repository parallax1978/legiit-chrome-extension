import { describe, expect, it } from 'vitest';
import { parseOrNull, SerpDataSchema, type SerpData } from '@/model/schemas';
import { getPack } from '@/selectors';
import { isListStyleTitle, parseSerp } from '@/serp/parse';
import { fixtureDoc, scenario, serpEnv } from '../helpers/fixtures';

function parse(file: string, url: string): SerpData {
  const doc = fixtureDoc(file);
  return parseSerp(doc, getPack('google'), serpEnv(doc, url));
}

const blockTypes = (serp: SerpData) => serp.blocks.map((b) => b.type);

describe('Google results parser: full page (AI Overview, ads, local pack)', () => {
  const serp = parse('google/serp-full.html', scenario.urls.serpFull!);

  it('reads the keyword, mode, location and viewport', () => {
    expect(serp.keyword).toBe('best dentist in austin');
    expect(serp.mode).toBe('web');
    expect(serp.locationText).toBe('Austin, Texas');
    expect(serp.viewport).toEqual({ width: 1280, height: 800, dpr: 1 });
    expect(serp.recognised).toBe(true);
  });

  it('finds every block type on the page', () => {
    expect(blockTypes(serp)).toEqual(['ai_overview', 'ad', 'ad', 'local_pack', 'paa', 'video', 'forum']);
  });

  it('lists organic results in order and excludes links inside other blocks', () => {
    expect(serp.organic.map((o) => o.domain)).toEqual([
      'austinhealthguide.example',
      'lakesidesmiles.example',
      'texaslocalpicks.example',
      'capitoldentalcare.example',
      'smilecompare.example',
      'brightpathdental.example',
      'atxneighbors.example',
      'zilkerfamilydentistry.example',
      'texasdentalboard.example',
    ]);
    expect(serp.organic.map((o) => o.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(serp.organic[0]).toMatchObject({
      title: '10 Best Dentists in Austin (2026)',
      url: 'https://www.austinhealthguide.example/best-dentists-austin',
      listStyle: true,
    });
    expect(serp.organic[0]?.snippet).toMatch(/^Our editors compared reviews/);
    expect(serp.organic.filter((o) => o.listStyle).map((o) => o.position)).toEqual([1, 3, 5]);
  });

  it('measures each result and block in document coordinates', () => {
    const first = serp.organic[0]!;
    expect(first.rect).toMatchObject({ x: 180, width: 652 });
    expect(first.rect!.y).toBeGreaterThan(serp.viewport.height); // pushed below the fold by AI Overview + ads + local pack
    const ys = serp.organic.map((o) => o.rect!.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    const overview = serp.blocks.find((b) => b.type === 'ai_overview')!;
    expect(overview.rect!.height).toBeGreaterThan(300);
    expect(overview.rect!.y).toBeLessThan(first.rect!.y);
  });

  it('reads AI Overview wording and citations without labels, buttons or tracking fragments', () => {
    const answer = serp.aiAnswer!;
    expect(answer.site).toBe('google-ai-overview');
    expect(answer.question).toBe('best dentist in austin');
    expect(answer.text).toMatch(/^Several Austin dental practices are recommended/);
    expect(answer.text).toContain('Zilker Family Dentistry');
    expect(answer.text).not.toMatch(/AI Overview|Show more|Learn more|Generative AI/);
    expect(answer.citations.map((c) => c.url)).toEqual([
      'https://www.austinhealthguide.example/best-dentists-austin',
      'https://www.lakesidesmiles.example/',
      'https://texaslocalpicks.example/austin/top-rated-dentists',
      'https://www.capitoldentalcare.example/',
    ]);
  });

  it('resolves ad landing pages from click redirects', () => {
    const [top, bottom] = serp.blocks.filter((b) => b.type === 'ad');
    expect(top!.items.map((i) => i.url)).toEqual([
      'https://www.lakesidesmiles.example/new-patients',
      'https://www.dentalplansnow.example/austin',
    ]);
    expect(top!.items[0]?.title).toBe('Lakeside Smiles – New Patient Special $79');
    expect(bottom!.items.map((i) => i.domain)).toEqual(['capitoldentalcare.example']);
    expect(JSON.stringify(serp)).not.toContain('googleadservices');
  });

  it('reads local-pack businesses, questions, videos and forum threads', () => {
    const by = (type: string) => serp.blocks.find((b) => b.type === type)!;
    expect(by('local_pack').items.map((i) => i.title)).toEqual(['Lakeside Smiles', 'Capitol Dental Care', 'Zilker Family Dentistry']);
    expect(by('local_pack').items[0]?.url).toBe('https://www.lakesidesmiles.example/');
    expect(by('paa').items).toHaveLength(4);
    expect(by('paa').items[0]).toMatchObject({ title: 'How much does a dentist cost in Austin?', url: null });
    expect(by('video').items.map((i) => i.title)).toContain('Meet the BrightPath Dental Team');
    expect(by('forum').items.map((i) => i.domain)).toEqual(['reddit.com', 'atxmoms.example', 'askaustin.example']);
  });

  it('never reports Google navigation links as results', () => {
    const urls = [...serp.organic.map((o) => o.url), ...serp.blocks.flatMap((b) => b.items.map((i) => i.url ?? ''))];
    expect(urls.some((u) => /google\.com\/(search|maps|setprefs)|support\.google\.com/.test(u))).toBe(false);
  });

  it('produces data that passes the cross-context schema', () => {
    expect(parseOrNull(SerpDataSchema, JSON.parse(JSON.stringify(serp)))).not.toBeNull();
  });
});

describe('Google results parser: other layouts', () => {
  it('handles a plain page with organic results only', () => {
    const serp = parse('google/serp-plain.html', scenario.urls.serpPlain!);
    expect(serp.blocks).toEqual([]);
    expect(serp.aiAnswer).toBeNull();
    expect(serp.organic).toHaveLength(8);
    expect(serp.organic[0]!.rect!.y).toBeLessThan(200);
    expect(serp.organic[4]).toMatchObject({ domain: 'brightpathdental.example', position: 5 });
  });

  it('separates the featured snippet from organic results', () => {
    const serp = parse('google/serp-featured.html', scenario.urls.serpFeatured!);
    expect(blockTypes(serp)).toEqual(['featured_snippet', 'paa', 'image', 'knowledge_panel']);
    const snippet = serp.blocks[0]!;
    expect(snippet.items.map((i) => i.url)).toEqual(['https://www.capitoldentalcare.example/blog/whitening-how-long']);
    expect(snippet.text).toContain('six months to three years');
    expect(serp.organic.map((o) => o.domain)).not.toContain('capitoldentalcare.example');
    expect(serp.organic).toHaveLength(6);
    expect(serp.blocks[3]!.rect!.x).toBeGreaterThan(800); // knowledge panel sits in the right-hand column
  });

  it('handles ads plus local pack without an AI Overview', () => {
    const serp = parse('google/serp-local.html', scenario.urls.serpLocal!);
    expect(blockTypes(serp)).toEqual(['ad', 'local_pack', 'paa']);
    expect(serp.blocks[0]!.items).toHaveLength(3);
    expect(serp.blocks[1]!.items.map((i) => i.title)).toEqual(['Capitol Dental Care', 'Austin Emergency Dental', 'Zilker Family Dentistry']);
    expect(serp.aiAnswer).toBeNull();
  });

  it('does not mistake the empty right-hand column for a knowledge panel', () => {
    for (const [file, url] of [
      ['google/serp-full.html', scenario.urls.serpFull!],
      ['google/serp-plain.html', scenario.urls.serpPlain!],
      ['google/serp-local.html', scenario.urls.serpLocal!],
    ] as const) {
      expect(blockTypes(parse(file, url))).not.toContain('knowledge_panel');
    }
  });
});

describe('Google results parser: fallbacks after class churn', () => {
  const full = parse('google/serp-full.html', scenario.urls.serpFull!);
  const churn = parse('google/serp-churn.html', scenario.urls.serpChurn!);

  it('finds the same blocks through heading text and structure', () => {
    expect(blockTypes(churn)).toEqual(blockTypes(full));
    for (const block of churn.blocks) expect(block.matchedBy).toMatch(/text~/);
  });

  it('finds the same organic results with the same geometry', () => {
    expect(churn.organic.map((o) => [o.position, o.url, o.title])).toEqual(full.organic.map((o) => [o.position, o.url, o.title]));
    expect(churn.organic.map((o) => o.rect)).toEqual(full.organic.map((o) => o.rect));
    expect(churn.organic[0]?.snippet).toMatch(/^Our editors compared reviews/);
  });

  it('still reads ads, local businesses and AI Overview citations', () => {
    const ad = churn.blocks.find((b) => b.type === 'ad')!;
    expect(ad.items.map((i) => i.domain)).toEqual(['lakesidesmiles.example', 'dentalplansnow.example']);
    expect(churn.blocks.find((b) => b.type === 'local_pack')!.items.map((i) => i.title)).toEqual([
      'Lakeside Smiles',
      'Capitol Dental Care',
      'Zilker Family Dentistry',
    ]);
    expect(churn.aiAnswer?.citations).toHaveLength(4);
  });

  it('works on a country domain', () => {
    expect(new URL(churn.url).hostname).toBe('www.google.co.uk');
    expect(churn.keyword).toBe('best dentist in austin');
  });
});

describe('Google results parser: AI Mode', () => {
  const serp = parse('google/serp-ai-mode.html', scenario.urls.serpAiMode!);

  it('reads the latest answer, its question and its citations only', () => {
    expect(serp.mode).toBe('ai-mode');
    const answer = serp.aiAnswer!;
    expect(answer.site).toBe('google-ai-mode');
    expect(answer.recognised).toBe(true);
    expect(answer.question).toBe('best dentist in austin');
    expect(answer.text).toMatch(/^Austin has several well-reviewed dental practices/);
    expect(answer.text).not.toContain('An earlier answer');
    expect(answer.citations.map((c) => c.url)).toEqual([
      'https://www.austinhealthguide.example/best-dentists-austin',
      'https://texaslocalpicks.example/austin/top-rated-dentists',
      'https://www.capitoldentalcare.example/',
    ]);
  });
});

describe('Google results parser: unrecognised pages', () => {
  it('reports an interstitial as unrecognised instead of guessing', () => {
    const serp = parse('google/serp-unrecognised.html', scenario.urls.serpUnrecognised!);
    expect(serp.recognised).toBe(false);
    expect(serp.organic).toEqual([]);
    expect(serp.blocks).toEqual([]);
    expect(serp.keyword).toBe('blocked query');
  });

  it('survives an empty document and hostile markup', () => {
    const empty = new DOMParser().parseFromString('', 'text/html');
    expect(parseSerp(empty, getPack('google'), serpEnv(empty, 'https://www.google.com/search?q=x')).recognised).toBe(false);

    const hostile = new DOMParser().parseFromString(
      `<div id="rso"><div class="g"><a href="javascript:alert(1)"><h3>Bad</h3></a></div>
       <div class="g"><a href="https://ok.example/?utm_source=x"><h3>${'A'.repeat(900)}<img src=x onerror=alert(1)></h3></a></div>
       <div class="g"><a href="/search?q=more"><h3>More results</h3></a></div></div>`,
      'text/html',
    );
    const env = { ...serpEnv(hostile, 'https://www.google.com/search?q=x'), isVisible: () => true };
    const serp = parseSerp(hostile, getPack('google'), env);
    expect(serp.organic).toHaveLength(1);
    expect(serp.organic[0]!.url).toBe('https://ok.example/');
    expect(serp.organic[0]!.title.length).toBeLessThanOrEqual(300);
    expect(parseOrNull(SerpDataSchema, JSON.parse(JSON.stringify(serp)))).not.toBeNull();
  });
});

describe('list-style titles', () => {
  it('recognises best / top / vs / alternatives pages', () => {
    for (const title of [
      '10 Best Dentists in Austin (2026)',
      'Top Rated Dentists in Austin, Texas',
      'Lakeside Smiles vs Capitol Dental Care',
      'Asana Alternatives for Small Teams',
      'Invisalign versus braces compared',
      '7 dentists we trust',
    ]) {
      expect(isListStyleTitle(title), title).toBe(true);
    }
    for (const title of ['About Zilker Family Dentistry', 'BrightPath Dental | Gentle Dentistry', 'Stopwatch for bestowing awards']) {
      expect(isListStyleTitle(title), title).toBe(false);
    }
  });
});
