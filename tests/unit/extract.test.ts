import { describe, expect, it } from 'vitest';
import { blockText, collectBlocks } from '@/extract/blocks';
import { collectJsonLdTypes, parseHtml, readJsonLd, resolveHref } from '@/extract/html';
import { findOpportunityLinks } from '@/extract/links';
import { extractAllText, extractMainContent } from '@/extract/main-content';
import { extractPageFacts } from '@/extract/page-facts';
import { fixtureDoc, fixtureText, scenario } from '../helpers/fixtures';

describe('HTML helpers', () => {
  it('parses without executing scripts or loading resources', () => {
    (globalThis as { pwned?: boolean }).pwned = false;
    const doc = parseHtml('<script>globalThis.pwned = true</script><img src="x" onerror="globalThis.pwned = true"><p>ok</p>');
    expect(doc.querySelector('p')?.textContent).toBe('ok');
    expect((globalThis as { pwned?: boolean }).pwned).toBe(false);
  });

  it('resolves relative links against the page and rejects unsafe schemes', () => {
    const page = 'https://www.example.com/a/b';
    expect(resolveHref('../c?x=1', page)).toBe('https://www.example.com/c?x=1');
    expect(resolveHref('//cdn.example.net/x', page)).toBe('https://cdn.example.net/x');
    expect(resolveHref('#top', page)).toBeNull();
    expect(resolveHref('javascript:alert(1)', page)).toBeNull();
    expect(resolveHref('mailto:a@b.example', page)).toBeNull();
    expect(resolveHref(null, page)).toBeNull();
  });

  it('reads JSON-LD including @graph and skips malformed blocks', () => {
    const doc = parseHtml(`
      <script type="application/ld+json">{"@graph":[{"@type":["Dentist","LocalBusiness"],"address":{"@type":"PostalAddress"}},{"@type":"WebSite"}]}</script>
      <script type="application/ld+json">{ not json </script>
      <script type="application/ld+json">[{"@type":"FAQPage"}]</script>`);
    expect(readJsonLd(doc).length).toBeGreaterThanOrEqual(3);
    expect(collectJsonLdTypes(doc)).toEqual(['Dentist', 'FAQPage', 'LocalBusiness', 'PostalAddress', 'WebSite']);
  });
});

describe('block walker', () => {
  it('emits one block per run of inline text, on semantic markup and div soup alike', () => {
    const doc = parseHtml(
      '<div><h2>Title</h2><p>One <b>bold</b> two.</p><ul><li>Item A</li><li><div>Item B</div></li></ul><div>Loose text<br>after break</div></div>',
    );
    expect(collectBlocks(doc.body).map((b) => [b.kind, b.text])).toEqual([
      ['heading', 'Title'],
      ['paragraph', 'One bold two.'],
      ['list-item', 'Item A'],
      ['list-item', 'Item B'],
      ['other', 'Loose text'],
      ['other', 'after break'],
    ]);
  });

  it('skips scripts, hidden content and (optionally) site chrome', () => {
    const doc = parseHtml(
      '<nav>Menu</nav><main><p>Body</p><script>x()</script><style>p{}</style><p hidden>secret</p><p aria-hidden="true">decor</p><button>Click</button></main><footer>Foot</footer>',
    );
    expect(collectBlocks(doc.body, { skipChrome: true }).map((b) => b.text)).toEqual(['Body']);
    expect(collectBlocks(doc.body, { skipChrome: false }).map((b) => b.text)).toEqual(['Menu', 'Body', 'Foot']);
  });

  it('can leave source cards and citation markers out of answer text', () => {
    const doc = parseHtml(
      '<div><p>Claim one <a href="https://a.example">1</a> and <a href="https://b.example">a named link</a>.</p><a href="https://c.example"><div>Card title</div></a></div>',
    );
    expect(blockText(doc.body, 50, true)).toBe('Claim one and a named link.');
    expect(blockText(doc.body, 50, false)).toContain('Card title');
  });
});

describe('main content extraction', () => {
  it('extracts the article body and leaves navigation and footer out', () => {
    const content = extractMainContent(fixtureDoc('articles/brightpath-how-often-teeth-cleaning.html'));
    expect(content.method).toBe('readability');
    expect(content.text).toContain('Most people should have their teeth professionally cleaned every six months.');
    expect(content.text).toContain('air-polishing system');
    expect(content.text).not.toContain('This article is general information');
    expect(content.blocks.filter((b) => b.kind === 'heading').map((b) => b.text)).toEqual(
      expect.arrayContaining(['When to come in more often', 'How we do it at BrightPath']),
    );
    expect(content.wordCount).toBeGreaterThan(120);
    expect(content.wordCount).toBeLessThan(220);
  });

  it('falls back to page structure on pages that are not articles', () => {
    const content = extractMainContent(fixtureDoc('misc/plain-page.html'));
    expect(content.method).toBe('structure');
    expect(content.text).toBe('Hello\nA very small page with almost nothing on it.');
    expect(content.wordCount).toBe(10);
  });

  it('does not modify the document it reads', () => {
    const doc = fixtureDoc('lists/austinhealthguide-best-dentists.html');
    const before = doc.documentElement.outerHTML;
    extractMainContent(doc);
    expect(doc.documentElement.outerHTML).toBe(before);
  });

  it('handles empty input', () => {
    expect(extractMainContent(parseHtml('')).wordCount).toBe(0);
    expect(extractAllText(parseHtml(''))).toBe('');
  });

  it('can read the whole page when every mention matters', () => {
    const text = extractAllText(fixtureDoc('lists/austinhealthguide-best-dentists.html'));
    expect(text).toContain('Suggest a dentist');
    expect(text).toContain('Zilker Family Dentistry');
  });
});

describe('page facts', () => {
  it('reads on-page SEO facts from a Wayback capture', () => {
    const facts = extractPageFacts(fixtureDoc('wayback/captures/20230310101112.html'), scenario.urls.rewindPage!);
    expect(facts).toMatchObject({
      title: 'Teeth Whitening in Austin | BrightPath Dental',
      metaDescription: 'Professional teeth whitening in South Austin. Brighter teeth in a single visit.',
      canonical: 'https://www.brightpathdental.example/services/teeth-whitening',
      metaRobots: null,
      h1: ['Professional Teeth Whitening'],
      h2: ['How it works', 'Pricing', 'FAQ'],
      h3: [],
      jsonLdTypes: ['Dentist', 'FAQPage'],
      hreflangCount: 0,
      externalLinks: 1,
    });
    expect(facts.internalLinks).toBe(7); // six nav links plus the footer contact link
    expect(facts.wordCount).toBeGreaterThan(550);
    expect(facts.wordCount).toBeLessThan(700);
  });

  it('normalises robots directives and counts hreflang', () => {
    const noindex = extractPageFacts(fixtureDoc('wayback/captures/20250120120000.html'), scenario.urls.rewindPage!);
    expect(noindex.metaRobots).toBe('noindex, follow');
    expect(noindex.canonical).toBe('https://www.brightpathdental.example/');
    const hreflang = extractPageFacts(fixtureDoc('wayback/captures/20250315090000.html'), scenario.urls.rewindPage!);
    expect(hreflang.hreflangCount).toBe(2);
    expect(hreflang.metaRobots).toBeNull();
  });

  it('returns nulls and zeros for a page with nothing on it', () => {
    expect(extractPageFacts(parseHtml('<p>x</p>'), 'https://a.example/')).toEqual({
      title: null,
      metaDescription: null,
      canonical: null,
      metaRobots: null,
      h1: [],
      h2: [],
      h3: [],
      wordCount: 1,
      internalLinks: 0,
      externalLinks: 0,
      jsonLdTypes: [],
      hreflangCount: 0,
    });
  });

  it('treats www and bare hosts as the same site when counting links', () => {
    const doc = parseHtml('<a href="https://example.com/a">a</a><a href="/b">b</a><a href="https://other.example/">c</a><a href="mailto:x@example.com">m</a>');
    expect(extractPageFacts(doc, 'https://www.example.com/')).toMatchObject({ internalLinks: 2, externalLinks: 1 });
  });
});

describe('opportunity links', () => {
  it('finds author, contact and submission links on a list page', () => {
    const url = 'https://www.austinhealthguide.example/best-dentists-austin';
    const links = findOpportunityLinks(fixtureDoc('lists/austinhealthguide-best-dentists.html'), url);
    const of = (kind: string) => links.filter((l) => l.kind === kind).map((l) => l.url);
    expect(of('author')).toEqual(['https://www.austinhealthguide.example/authors/maya-ortiz']);
    expect(of('submission')).toEqual([
      'https://www.austinhealthguide.example/suggest-a-dentist',
      'https://www.austinhealthguide.example/editorial-guidelines',
    ]);
    expect(of('contact')).toEqual(
      expect.arrayContaining(['https://www.austinhealthguide.example/contact', 'mailto:editors@austinhealthguide.example']),
    );
    // Off-site social links are not contact links.
    expect(links.some((l) => l.url.includes('facebook'))).toBe(false);
  });

  it('recognises "get listed" and "write for us" wording', () => {
    const tlp = findOpportunityLinks(fixtureDoc('lists/texaslocalpicks-top-dentists.html'), 'https://texaslocalpicks.example/austin/top-rated-dentists');
    expect(tlp.find((l) => l.kind === 'submission')?.url).toBe('https://texaslocalpicks.example/get-listed');
    const vs = findOpportunityLinks(fixtureDoc('lists/smilecompare-lakeside-vs-capitol.html'), 'https://smilecompare.example/lakeside-smiles-vs-capitol-dental-care');
    expect(vs.find((l) => l.kind === 'submission')?.label).toBe('Write for us');
    expect(vs.find((l) => l.kind === 'author')?.url).toBe('https://smilecompare.example/author/dev-patel/');
  });

  it('falls back to a byline when the author is not linked and ignores unsafe links', () => {
    const doc = parseHtml(
      '<meta name="author" content="Jo Lee"><a href="javascript:alert(1)">Contact</a><a href="mailto:not-an-email">mail</a><a href="/contact">Contact</a>',
    );
    const links = findOpportunityLinks(doc, 'https://a.example/post');
    expect(links).toEqual([
      { kind: 'contact', label: 'Contact', url: 'https://a.example/contact' },
      { kind: 'author', label: 'Author: Jo Lee', url: 'https://a.example/post' },
    ]);
  });

  it('caps the number of links per kind', () => {
    const many = Array.from({ length: 30 }, (_, i) => `<a href="/contact-${i}">Contact</a>`).join('');
    expect(findOpportunityLinks(parseHtml(many), 'https://a.example/').length).toBe(6);
    expect(fixtureText('lists/atxneighbors-dentist-recommendations.html')).toContain('BrightPath Dental');
  });
});
