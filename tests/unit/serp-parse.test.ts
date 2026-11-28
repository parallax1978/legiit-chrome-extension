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

/*
 * Google can hide where every link of a results page leads: the link is Google's own redirect with a token only
 * Google can read. This page has the markup of such a page as it was served in November 2026, with invented
 * sites. What still tells where a result leads: the line under its title (the site), a "More results from" link
 * (the site), and the data the page keeps for its AI answer (exact addresses of the pages it cites).
 */
const HIDDEN_LINKS_PAGE = `<!doctype html><html><body><div id="rcnt">
<div id="tvcap"><div id="tads"><span class="LoygGf">Sponsored results</span>
  <div data-text-ad="1"><a href="/goto?url=CAESad1" data-pcu="https://www.brightpathdental.example/"><div role="heading" aria-level="3">Emergency Dentist Austin</div></a><span data-dtld="brightpathdental.example"></span></div>
</div></div>
<div id="center_col"><div id="search"><div><div id="rso">
  <div class="MjjYud"><div class="A6K0A"><div class="wHYlTd tF2Cxc" data-hveid="a" data-ved="a">
    <div class="yuRUbf"><a jsname="UWckNb" class="zReHs" href="/goto?url=CAESone" ping="/url?sa=t&amp;url=CAESone"><h3 class="LC20lb">10 Best Dentists in Austin (2026)</h3><span class="VuuXrf">Austin Health Guide</span><cite class="qLRx3b" role="text">https://www.austinhealthguide.example<span role="text"> › best › dentists</span></cite></a></div>
    <div class="VwiC3b"><span>Our editors compared forty practices.</span></div>
  </div></div></div>
  <div class="ULSxyf"><div class="YzCcne"><div role="heading" aria-level="2"><span>You said: best dentist in austin</span></div><div role="heading" aria-level="2">AI Overview</div><h3 data-ignore-copy="">AI Mode replied:</h3><p>Several practices in Austin are <mark><span data-skip-highlighting="">[Highlight start]</span>well reviewed<span data-skip-highlighting="">[Highlight end]</span></mark>.</p>
    <a href="/goto?url=CAESsrc1" aria-label="Austin Health Guide"></a><a href="/goto?url=CAESsrc2" aria-label="Texas Local Picks"></a>
    <div class="card"><a href="/goto?url=CAESsrc3" aria-label="Dentist Reviews You Can Trust | Dental Review Hub"></a><div aria-hidden="true"><div><img data-src="https://encrypted-tbn2.gstatic.com/faviconV2?url=https://www.dentalreviewhub.example&amp;client=AIM&amp;size=16" src="data:image/gif;base64,R0lGODlhAQABAIAAAP"></div><span>Dental Review Hub</span></div></div>
    <ul><li><a href="/goto?url=CAESsrc3b"></a><div><img data-src="https://encrypted-tbn2.gstatic.com/faviconV2?url=https://www.dentalreviewhub.example&amp;size=32"><div>dentalreviewhub.example</div></div></li></ul>
    <ul><li><a href="https://www.google.com/search?q=dentists"></a><div><img data-src="https://encrypted-tbn2.gstatic.com/faviconV2?url=https://www.google.com&amp;size=32"><div>Google</div></div></li></ul>
    <!--TgQPHd|||[[&quot;id-1&quot;,null,null,0,&quot;https://encrypted-tbn1.gstatic.com/faviconV2?url\\u003dhttps://www.austinhealthguide.example\\u0026client\\u003dAIM&quot;,&quot;Austin Health Guide&quot;,3,&quot;https://www.austinhealthguide.example/best/dentists-in-austin/?utm_source\\u003dx&quot;,null,null]]-->
    <!--TgQPHd|||[[null,[&quot;10 Best Dentists in Austin (2026) – Austin Health Guide&quot;,&quot;Our editors compared forty practices.&quot;,&quot;Austin Health Guide&quot;,&quot;https://encrypted-tbn1.gstatic.com/faviconV2?url\\u003dhttps://www.austinhealthguide.example\\u0026client\\u003dAIM&quot;]]]-->
    <!--TgQPHd|||[[&quot;id-2&quot;,null,null,0,&quot;https://encrypted-tbn2.gstatic.com/faviconV2?url\\u003dhttps://www.texaslocalpicks.example&quot;,&quot;Texas Local Picks&quot;,2,&quot;https://www.texaslocalpicks.example/austin/dentists&quot;,null,null]]-->
  </div></div>
  <div class="MjjYud"><div class="A6K0A"><div class="wHYlTd tF2Cxc" data-hveid="b" data-ved="b">
    <div class="yuRUbf"><a jsname="UWckNb" class="zReHs" href="/goto?url=CAEStwo"><h3 class="LC20lb">Top 5 Family Dentists Compared</h3><span class="VuuXrf">Lakeside Smiles</span><cite class="qLRx3b" role="text">https://www.lakesidesmiles.example<span role="text"> › ... › Family Dentistry</span></cite></a></div>
    <div class="VwiC3b"><span>Same-week appointments.</span></div>
  </div></div></div>
  <div class="MjjYud"><div><div id="k04FTb"><span role="heading" aria-level="2">Sponsored results</span>
    <div data-text-ad="1"><a href="/goto?url=CAESad2" data-pcu="https://www.capitoldentalcare.example/book"><div role="heading" aria-level="3">Capitol Dental Care – Evening Appointments</div></a><span data-dtld="capitoldentalcare.example"></span></div>
  </div></div></div>
  <div class="MjjYud"><div class="A6K0A"><div class="wHYlTd tF2Cxc" data-hveid="c" data-ved="c">
    <div class="yuRUbf"><a jsname="UWckNb" class="zReHs" href="/goto?url=CAESthree"><h3 class="LC20lb">Which dentist do you trust in Austin?</h3><span class="VuuXrf">Forum · r/Austin</span><cite class="qLRx3b" role="text">30+ comments · 1 year ago</cite></a></div>
    <div class="VwiC3b"><span>I would look for a practice with weekend hours.</span></div>
    <a href="/search?q=best+dentist+in+austin+site:www.forum.example&amp;sa=X"><span>More results from www.forum.example</span></a>
  </div></div></div>
  <div class="MjjYud"><div class="A6K0A"><div class="wHYlTd tF2Cxc" data-hveid="d" data-ved="d">
    <div class="yuRUbf"><a jsname="UWckNb" class="zReHs" href="/goto?url=CAESfour"><h3 class="LC20lb">Dentist recommendations from neighbors</h3><span class="VuuXrf">ATX Neighbors</span><cite class="qLRx3b" role="text">12 answers</cite></a></div>
  </div></div></div>
  <div class="MjjYud"><div class="A6K0A"><div class="wHYlTd tF2Cxc" data-hveid="e" data-ved="e">
    <div class="yuRUbf"><a jsname="UWckNb" class="zReHs" href="/goto?url=CAESfive"><h3 class="LC20lb">Lakeside Smiles | Cosmetic Dentist</h3><span class="VuuXrf">Lakeside Smiles</span><cite class="qLRx3b" role="text">https://www.lakesidesmiles.example<span role="text"> › services › cosmetic</span></cite></a></div>
  </div></div></div>
  <div class="MjjYud"><div class="A6K0A"><div class="wHYlTd tF2Cxc" data-hveid="f" data-ved="f">
    <div class="yuRUbf"><a jsname="UWckNb" class="zReHs" href="https://www.capitoldentalcare.example/about?utm_source=x"><h3 class="LC20lb">Capitol Dental Care: Downtown</h3><cite class="qLRx3b" role="text">https://www.capitoldentalcare.example<span role="text"> › about</span></cite></a></div>
  </div></div></div>
  <div class="MjjYud"><div class="A6K0A"><div class="wHYlTd tF2Cxc" data-hveid="h" data-ved="h">
    <div class="yuRUbf"><a jsname="UWckNb" class="zReHs" href="/goto?url=CAESeight"><h3 class="LC20lb">Best dentist in Austin? : r/Austin</h3><span class="VuuXrf">Reddit&nbsp;·&nbsp;r/Austin</span><cite class="qLRx3b" role="text">40+ comments · 2 years ago</cite></a></div>
  </div></div></div>
  <div class="MjjYud"><div class="A6K0A"><div class="wHYlTd tF2Cxc" data-hveid="g" data-ved="g">
    <div class="yuRUbf"><a jsname="UWckNb" class="zReHs" href="/goto?url=CAESseven"><h3 class="LC20lb">Find a dentist near you - Help</h3><cite class="qLRx3b" role="text">https://support.google.com<span role="text"> › answer</span></cite></a></div>
  </div></div></div>
</div></div></div></div></div>
<div class="fbar"><div><div><a role="button" href="/search?q=best+dentist+in+austin"><div><span>Austin, Texas</span></div><div> - Based on your past activity</div></a></div><update-location>Update location</update-location></div></div>
</body></html>`;

describe('a results page on which Google hides where the links lead', () => {
  // The page of the tests below has: results with an address line, one with a "More results from" link, one with
  // nothing, one with a platform label, and an AI Overview whose sources are named by data, or only by an icon.
  const url = 'https://www.google.com/search?q=best+dentist+in+austin';
  const read = (): SerpData => {
    const doc = new DOMParser().parseFromString(HIDDEN_LINKS_PAGE, 'text/html');
    return parseSerp(doc, getPack('google'), { ...serpEnv(doc, url), rectOf: () => null, isVisible: () => true });
  };

  it('still finds every organic result, in order, with what the page says about its address', () => {
    const serp = read();
    expect(serp.organic.map((o) => [o.position, o.address, o.domain, o.url])).toEqual([
      // The page's own data names the exact page of this site with this title.
      [1, 'link', 'austinhealthguide.example', 'https://www.austinhealthguide.example/best/dentists-in-austin/'],
      // The line under the title names the site. Its other parts are not a path, so the page is not known.
      [2, 'site', 'lakesidesmiles.example', 'https://www.lakesidesmiles.example/'],
      // No address line: the site comes from "More results from …".
      [3, 'site', 'forum.example', 'https://www.forum.example/'],
      // Nothing names the site: the result keeps Google's own link, and has no domain.
      [4, 'hidden', '', 'https://www.google.com/goto?url=CAESfour'],
      // A second result of a site that is already in the list is a result of its own.
      [5, 'site', 'lakesidesmiles.example', 'https://www.lakesidesmiles.example/'],
      // A link that shows its address is read as before.
      [6, 'link', 'capitoldentalcare.example', 'https://www.capitoldentalcare.example/about'],
      // No address line, but Google's own label names the platform ("Reddit · r/Austin").
      [7, 'site', 'reddit.com', 'https://www.reddit.com/'],
    ]);
    // The line under a title can spell a page address out. It is kept as a guess, apart from the address that is
    // known; a line that Google shortened ("...") or that shows names is no guess.
    expect(serp.organic.map((o) => o.guess ?? null)).toEqual([null, null, null, null, 'https://www.lakesidesmiles.example/services/cosmetic', null, null]);
    // Google's own help pages are not results, hidden link or not.
    expect(serp.organic.some((o) => o.title.includes('Help'))).toBe(false);
    expect(serp.organic[0]!.snippet).toBe('Our editors compared forty practices.');
    expect(parseOrNull(SerpDataSchema, JSON.parse(JSON.stringify(serp)))).not.toBeNull();
  });

  it('reads what is around the results as the live page has it: ads between results, the place, the answer', () => {
    const serp = read();
    // A block of ads between the organic results has no id of its own: it is found by its ad units.
    const ads = serp.blocks.filter((b) => b.type === 'ad');
    expect(ads.map((b) => b.items.map((i) => i.domain))).toEqual([['brightpathdental.example'], ['capitoldentalcare.example']]);
    // Its ad is no organic result.
    expect(serp.organic.some((o) => o.title.includes('Evening Appointments'))).toBe(false);
    // The place Google used, from the foot of the page.
    expect(serp.locationText).toBe('Austin, Texas');
    // The wording of the answer: without what is there for screen readers only, and without the list of its
    // sources, which shows each source by the name of its site.
    expect(serp.aiAnswer?.text).toBe('Several practices in Austin are well reviewed.');
  });

  it('reads the sources of the AI answer from the data the page keeps for it', () => {
    const serp = read();
    expect(serp.aiAnswer?.citations).toEqual([
      { url: 'https://www.austinhealthguide.example/best/dentists-in-austin/', domain: 'austinhealthguide.example', title: '10 Best Dentists in Austin (2026) – Austin Health Guide' },
      { url: 'https://www.texaslocalpicks.example/austin/dentists', domain: 'texaslocalpicks.example', title: 'Texas Local Picks' },
      // A source of which the page shows only the site, by its icon: listed once, with the site as its address.
      { url: 'https://www.dentalreviewhub.example/', domain: 'dentalreviewhub.example', title: 'Dentist Reviews You Can Trust | Dental Review Hub', address: 'site' },
    ]);
    expect(serp.blocks.find((b) => b.type === 'ad')?.items).toMatchObject([{ url: 'https://www.brightpathdental.example/', domain: 'brightpathdental.example' }]);
  });

  it('a page without that data keeps the site of each result and has no sources', () => {
    const doc = new DOMParser().parseFromString(HIDDEN_LINKS_PAGE.replace(/<!--TgQPHd[\s\S]*?-->/g, ''), 'text/html');
    const serp = parseSerp(doc, getPack('google'), { ...serpEnv(doc, url), rectOf: () => null, isVisible: () => true });
    expect(serp.organic.map((o) => o.address)).toEqual(['site', 'site', 'site', 'hidden', 'site', 'link', 'site']);
    expect(serp.organic[0]).toMatchObject({ domain: 'austinhealthguide.example', url: 'https://www.austinhealthguide.example/', guess: 'https://www.austinhealthguide.example/best/dentists' });
    // Without that data the only source left is the one the page shows by its site's icon. Google is no source.
    expect(serp.aiAnswer?.citations.map((c) => [c.domain, c.address])).toEqual([['dentalreviewhub.example', 'site']]);
  });
});

describe('the full results page as Google serves it when it hides the links', () => {
  const shown = parse('google/serp-full.html', scenario.urls.serpFull!);
  const hidden = parse('google/serp-hidden-links.html', scenario.urls.serpHidden!);

  it('finds the same results, in the same places, with the same sites', () => {
    expect(hidden.recognised).toBe(true);
    expect(hidden.keyword).toBe('family dentist austin tx');
    expect(hidden.organic.map((o) => [o.position, o.title, o.domain, o.rect, o.listStyle])).toEqual(
      shown.organic.map((o) => [o.position, o.title, o.domain, o.rect, o.listStyle]),
    );
    expect(blockTypes(hidden)).toEqual(blockTypes(shown));
  });

  it('knows the page address of the results that the AI Overview cites, and the site of the others', () => {
    expect(hidden.organic.map((o) => o.address)).toEqual(['link', 'link', 'link', 'link', 'site', 'site', 'site', 'site', 'site']);
    // An exact address is the same address the page with visible links gives.
    expect(hidden.organic.slice(0, 4).map((o) => o.url)).toEqual(shown.organic.slice(0, 4).map((o) => o.url));
    expect(hidden.organic.slice(4).map((o) => o.url)).toEqual(shown.organic.slice(4).map((o) => `${new URL(o.url).origin}/`));
    expect(hidden.aiAnswer?.citations.map((c) => c.url)).toEqual(shown.aiAnswer?.citations.map((c) => c.url));
    // No address anywhere in the result is one of Google's.
    const addresses = [...hidden.organic.map((o) => o.url), ...hidden.blocks.flatMap((b) => b.items.map((i) => i.url ?? ''))];
    expect(addresses.filter((u) => /google\./.test(u))).toEqual([]);
  });

  it('keeps the ads, and the titles of videos and discussions whose address is hidden', () => {
    const items = (type: string) => hidden.blocks.filter((b) => b.type === type).flatMap((b) => b.items);
    expect(items('ad').map((i) => i.domain)).toEqual(shown.blocks.filter((b) => b.type === 'ad').flatMap((b) => b.items.map((i) => i.domain)));
    // A label like "YouTube · channel" or "Reddit · r/Austin" names the platform, so it names the site.
    expect(items('video').map((i) => [i.title, i.url, i.address])).toEqual(
      shown.blocks.find((b) => b.type === 'video')!.items.map((i) => [i.title, 'https://www.youtube.com/', 'site']),
    );
    expect(items('forum').map((i) => [i.title, i.url, i.domain])).toEqual(
      shown.blocks.find((b) => b.type === 'forum')!.items.map((i, n) => (n === 0 ? [i.title, 'https://www.reddit.com/', 'reddit.com'] : [i.title, null, null])),
    );
  });
});

describe('AI Mode as the live page builds a turn', () => {
  // The markers are the ones Google uses on the live page (November 2026): a turn, the heading that repeats the
  // question for screen readers, and the answer, whose marker is a list ("aimfl,mfl"). The content is invented.
  const html = `<!doctype html><html><body><div id="center_col">
    <div class="CKgc1d" data-scope-id="turn">
      <div><span role="heading" aria-level="2"><span>You said: who is the best dentist in austin</span>who is the best dentist in austin</span></div>
      <div data-subtree="aimc"><div>
        <h3 data-ignore-copy="">AI Mode replied:</h3>
        <div data-subtree="aimfl,mfl">
          <p>Lakeside Smiles is <mark><span data-skip-highlighting="">[Highlight start]</span>often recommended<span data-skip-highlighting="">[Highlight end]</span></mark> for families.</p>
          <ul><li>Capitol Dental Care is close to downtown.</li></ul>
          <ul><li><a href="/goto?url=CAESm1"></a><div><img data-src="https://encrypted-tbn1.gstatic.com/faviconV2?url=https://www.austinhealthguide.example&amp;size=32"><div>austinhealthguide.example</div></div></li></ul>
          <!--TgQPHd|||[[&quot;id-9&quot;,null,null,0,&quot;https://encrypted-tbn2.gstatic.com/faviconV2?url\\u003dhttps://www.texaslocalpicks.example&quot;,&quot;Texas Local Picks&quot;,2,&quot;https://www.texaslocalpicks.example/austin/dentists&quot;,null,null]]-->
        </div>
      </div></div>
    </div>
  </div></body></html>`;
  const url = 'https://www.google.com/search?q=who+is+the+best+dentist+in+austin&udm=50';

  it('reads the question, the wording of the answer and its sources', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const serp = parseSerp(doc, getPack('google'), { ...serpEnv(doc, url), rectOf: () => null, isVisible: () => true });
    expect(serp.mode).toBe('ai-mode');
    expect(serp.aiAnswer).toMatchObject({ site: 'google-ai-mode', recognised: true, question: 'who is the best dentist in austin' });
    expect(serp.aiAnswer?.text).toBe('Lakeside Smiles is often recommended for families.\nCapitol Dental Care is close to downtown.');
    expect(serp.aiAnswer?.citations).toEqual([
      { url: 'https://www.texaslocalpicks.example/austin/dentists', domain: 'texaslocalpicks.example', title: 'Texas Local Picks' },
      { url: 'https://www.austinhealthguide.example/', domain: 'austinhealthguide.example', title: 'austinhealthguide.example', address: 'site' },
    ]);
    expect(parseOrNull(SerpDataSchema, JSON.parse(JSON.stringify(serp)))).not.toBeNull();
  });
});
