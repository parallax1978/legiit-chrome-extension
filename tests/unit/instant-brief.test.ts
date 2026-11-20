import { describe, expect, it } from 'vitest';
import { parseHtml } from '@/extract/html';
import { extractPageFacts } from '@/extract/page-facts';
import { categoryNoun, composeBrief, draftAvatars, draftNextSteps, withRewrites, type SearchEntry } from '@/features/instant-brief/compose';
import { assembleSitePages, classifyPage, linksToRead, pickSitePages, sameDocument, samePage } from '@/features/instant-brief/crawl';
import { extractBusinessFacts, normaliseHex, type SitePage } from '@/features/instant-brief/extract';
import { findIssues } from '@/features/instant-brief/issues';
import { briefToMarkdown, escapeMarkdown } from '@/features/instant-brief/markdown';
import { fixtureDoc, fixtureJson } from '../helpers/fixtures';

const ORIGIN = 'https://www.brightpathdental.example';
const manifest = fixtureJson<{ routes: { url: string; file: string }[] }>('manifest.json');
const home = fixtureDoc('site/index.html');

function loadSite(): SitePage[] {
  return pickSitePages(home, `${ORIGIN}/`).flatMap((p) => {
    const file = manifest.routes.find((r) => r.url === p.url)?.file;
    return file ? [{ url: p.url, kind: p.kind, doc: fixtureDoc(file) }] : [];
  });
}

const site = loadSite();
const facts = extractBusinessFacts(site);
const issues = findIssues(site.map((p) => ({ ...p, facts: extractPageFacts(p.doc, p.url) })));

describe('choosing site pages from the navigation', () => {
  it('picks home, about, services, contact, pricing and locations from the menu', () => {
    const picked = pickSitePages(home, `${ORIGIN}/`);
    expect(picked.map((p) => [p.kind, new URL(p.url).pathname])).toEqual([
      ['home', '/'],
      ['about', '/about'],
      ['services', '/services'],
      ['contact', '/contact'],
      ['pricing', '/pricing'],
      ['locations', '/locations'],
      ['other', '/blog/how-often-teeth-cleaning'],
    ]);
    expect(picked.length).toBeLessThanOrEqual(8);
  });

  it('never leaves the site and skips files, legal pages and logins', () => {
    const doc = parseHtml(`<nav>
      <a href="https://other.example/about">Other</a><a href="/about-us">About</a><a href="/brochure.pdf">PDF</a>
      <a href="/privacy">Privacy</a><a href="/wp-login.php">Login</a><a href="/careers">Careers</a>
      <a href="javascript:void(0)">JS</a><a href="mailto:a@b.example">Mail</a><a href="#top">Top</a></nav>`);
    const picked = pickSitePages(doc, 'https://a.example/');
    expect(picked.map((p) => p.url)).toEqual(['https://a.example/', 'https://a.example/about-us']);
    expect(picked.every((p) => new URL(p.url).origin === 'https://a.example')).toBe(true);
  });

  it('always includes the current page and caps the total', () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="/page-${i}">Page ${i}</a>`).join('');
    const picked = pickSitePages(parseHtml(`<nav>${links}</nav>`), 'https://a.example/deep/current?x=1#frag');
    expect(picked).toHaveLength(8);
    expect(picked[0]?.url).toBe('https://a.example/');
    expect(picked[1]?.url).toBe('https://a.example/deep/current');
    expect(new Set(picked.map((p) => p.url)).size).toBe(8);
    expect(pickSitePages(parseHtml(`<nav>${links}</nav>`), 'https://a.example/', 3)).toHaveLength(3);
  });

  it('falls back to body links when a page has no navigation element', () => {
    const picked = pickSitePages(parseHtml('<div><a href="/services">What we do</a><a href="/contact">Call us</a></div>'), 'https://a.example/');
    expect(picked.map((p) => p.kind)).toEqual(['home', 'services', 'contact']);
  });

  it('classifies pages by path and link text', () => {
    expect(classifyPage('/', '')).toBe('home');
    expect(classifyPage('/who-we-are', '')).toBe('about');
    expect(classifyPage('/x', 'Our services')).toBe('services');
    expect(classifyPage('/plans-and-pricing', '')).toBe('pricing');
    expect(classifyPage('/service-areas', '')).toBe('locations');
    expect(classifyPage('/blog/post', 'Read more')).toBe('other');
  });
});

describe('putting the pages of a brief together', () => {
  const SITE = 'https://site.example';
  const page = (title: string, extra = ''): string =>
    `<html lang="en"><head><title>${title}</title><meta name="description" content="About ${title}"></head><body><nav><a href="/">Home</a><a href="/about">About us</a><a href="/services">Services</a></nav><h1>${title}</h1>${extra}</body></html>`;
  const read = (path: string, title: string, finalPath = path) => ({ url: `${SITE}${path}`, ok: true, finalUrl: `${SITE}${finalPath}`, html: page(title) });
  const duplicateTitles = (pages: readonly SitePage[]) => findIssues(pages.map((p) => ({ ...p, facts: extractPageFacts(p.doc, p.url) }))).filter((i) => i.code === 'duplicate-title');
  const assemble = (open: { url: string; doc: Document }, links: Parameters<typeof assembleSitePages>[1], pages: Parameters<typeof assembleSitePages>[2]) =>
    assembleSitePages<Document>(open, links, pages, parseHtml, sameDocument);

  it('knows the same path, and the same document', () => {
    expect(samePage(`${SITE}/?gad_source=1`, `${SITE}/`)).toBe(true);
    expect(samePage(`${SITE}/services/?_gl=1*abc#top`, `${SITE}/services`)).toBe(true);
    expect(samePage(`${SITE}/services`, `${SITE}/about`)).toBe(false);
    expect(samePage(`${SITE}/`, 'https://other.example/')).toBe(false);
    expect(samePage('not a url', 'not a url')).toBe(false);
    expect(sameDocument(parseHtml(page('Family dentist')), parseHtml(page('  family   DENTIST ', '<p>Other text</p>')))).toBe(true);
    expect(sameDocument(parseHtml(page('Family dentist')), parseHtml(page('About us')))).toBe(false);
  });

  it('reads the home page once when it was opened from an ad: known tracking is not even fetched again', () => {
    const open = { url: `${SITE}/?gad_source=1&gclid=EAIaIQ`, doc: parseHtml(page('Family dentist in Austin')) };
    const links = pickSitePages(open.doc, open.url);
    // The home page is already in hand: it is not fetched again.
    expect(linksToRead(links, open.url).map((l) => l.url)).toEqual([`${SITE}/about`, `${SITE}/services`]);
    const { pages, unread } = assemble(open, links, [read('/about', 'About us'), read('/services', 'Our services')]);
    expect(pages.map((p) => `${p.kind}:${p.url}`)).toEqual([`home:${open.url}`, `about:${SITE}/about`, `services:${SITE}/services`]);
    expect(unread).toEqual([]);
    expect(duplicateTitles(pages)).toEqual([]);
  });

  it('reads an inner page once when its address carries a parameter it does not know', () => {
    const open = { url: `${SITE}/services?ref=newsletter`, doc: parseHtml(page('Our services')) };
    const links = pickSitePages(open.doc, open.url);
    // "?ref=" could be anything, so the plain address is read as well. It reads the same: it is the same page.
    expect(linksToRead(links, open.url).map((l) => l.url)).toEqual([`${SITE}/`, `${SITE}/services`, `${SITE}/about`]);
    const { pages, unread } = assemble(open, links, [read('/', 'Family dentist in Austin'), read('/services', 'Our services'), read('/about', 'About us')]);
    expect(pages.map((p) => `${p.kind}:${p.url}`)).toEqual([`home:${SITE}/`, `services:${open.url}`, `about:${SITE}/about`]);
    expect(unread).toEqual([]);
    expect(duplicateTitles(pages)).toEqual([]);
    // When that second read fails, nothing is missing either: the page is in hand.
    const failed = assemble(open, links, [read('/', 'Family dentist in Austin'), { url: `${SITE}/services`, ok: false, finalUrl: null, html: '' }, read('/about', 'About us')]);
    expect(failed.pages.map((p) => p.url)).toEqual([`${SITE}/`, open.url, `${SITE}/about`]);
    expect(failed.unread).toEqual([]);
  });

  it('keeps both pages on a site that routes its pages by query string', () => {
    // WordPress with plain permalinks: every page lives at "/", told apart by ?page_id=.
    const menu = '<nav><a href="/">Home</a><a href="/?page_id=2">About us</a><a href="/?page_id=3">Services</a></nav>';
    const open = { url: 'https://wp.example/?page_id=2', doc: parseHtml(`<html><head><title>About us</title></head><body>${menu}<h1>About us</h1></body></html>`) };
    const links = pickSitePages(open.doc, open.url);
    expect(linksToRead(links, open.url).map((l) => l.url)).toEqual(['https://wp.example/']);
    const home = { url: 'https://wp.example/', ok: true, finalUrl: 'https://wp.example/', html: `<html><head><title>Leeds Plumbing</title></head><body>${menu}<h1>Plumbers in Leeds</h1></body></html>` };
    const { pages } = assemble(open, links, [home]);
    // The home page is read and is the home page; the open page is another page that happens to share its path.
    expect(pages.map((p) => `${p.kind}:${p.url}`)).toEqual(['other:https://wp.example/?page_id=2', 'home:https://wp.example/']);
    expect(duplicateTitles(pages)).toEqual([]);
  });

  it('never holds more pages than the limit', () => {
    const menu = Array.from({ length: 30 }, (_, i) => `<a href="/page-${i}">Page ${i}</a>`).join('');
    const open = { url: `${SITE}/deep/current?ref=newsletter`, doc: parseHtml(`<title>Current</title><nav>${menu}</nav>`) };
    const links = pickSitePages(open.doc, open.url);
    expect(links).toHaveLength(8);
    const toRead = linksToRead(links, open.url);
    const others = (title: (i: number) => string) => toRead.map((l, i) => ({ url: l.url, ok: true, finalUrl: l.url, html: l.url.endsWith('/deep/current') ? '<title>Current</title>' : page(title(i)) }));
    const { pages } = assemble(open, links, others((i) => `Page ${i}`));
    expect(pages).toHaveLength(8);
    expect(pages.filter((p) => samePage(p.url, open.url))).toHaveLength(1);
    // Even when the plain address turns out to be another page: eight pages, the open one among them.
    const distinct = assemble(open, links, toRead.map((l, i) => ({ url: l.url, ok: true, finalUrl: l.url, html: page(`Another ${i}`) })));
    expect(distinct.pages).toHaveLength(8);
    expect(distinct.pages.some((p) => p.url === open.url)).toBe(true);
  });

  it('counts two links that end on one page once, under the more telling kind', () => {
    const open = { url: `${SITE}/`, doc: parseHtml(page('Family dentist in Austin', '<a href="/home">Start</a>')) };
    const links = [...pickSitePages(open.doc, open.url), { url: `${SITE}/home`, label: 'Start', kind: 'other' as const }, { url: `${SITE}/company`, label: 'Company', kind: 'about' as const }];
    const { pages, unread } = assemble(
      open,
      links,
      // "/home" redirects to the open page, "/company" to "/about".
      [read('/about', 'About us'), read('/services', 'Our services'), read('/home', 'Family dentist in Austin', '/'), read('/company', 'About us', '/about')],
    );
    expect(pages.map((p) => `${p.kind}:${p.url}`)).toEqual([`home:${SITE}/`, `about:${SITE}/about`, `services:${SITE}/services`]);
    expect(unread).toEqual([]);
    expect(duplicateTitles(pages)).toEqual([]);
  });

  it('makes the open page the home page when the home link redirects to it', () => {
    // "/" answers with a redirect to "/en/", and the brief is built on "/en/".
    const menu = '<nav><a href="/">Home</a><a href="/en/about">About</a></nav>';
    const html = `<html><head><title>Leeds Plumbing</title><meta name="description" content="Family plumbers in Leeds since 1990."></head><body>${menu}<h1>Plumbers in Leeds</h1></body></html>`;
    const open = { url: 'https://shop.example/en/', doc: parseHtml(html) };
    const links = pickSitePages(open.doc, open.url);
    expect(links.map((l) => `${l.kind}:${l.url}`)).toEqual(['home:https://shop.example/', 'other:https://shop.example/en/', 'about:https://shop.example/en/about']);
    const { pages } = assemble(open, links, [
      { url: 'https://shop.example/', ok: true, finalUrl: 'https://shop.example/en/', html },
      { url: 'https://shop.example/en/about', ok: true, finalUrl: 'https://shop.example/en/about', html: page('About') },
    ]);
    expect(pages.map((p) => `${p.kind}:${p.url}`)).toEqual(['home:https://shop.example/en/', 'about:https://shop.example/en/about']);
    // So the facts that are read from the home page are there.
    expect(extractBusinessFacts(pages).description).toBe('Family plumbers in Leeds since 1990.');
  });

  it('lists the pages that could not be read, and still includes the open page when no link names it', () => {
    const open = { url: `${SITE}/landing?x=1`, doc: parseHtml(page('Landing')) };
    const links = [{ url: `${SITE}/about`, label: 'About us', kind: 'about' as const }, { url: `${SITE}/services`, label: 'Services', kind: 'services' as const }];
    const { pages, unread } = assemble(open, links, [{ url: `${SITE}/about`, ok: false, finalUrl: null, html: '' }]);
    expect(pages.map((p) => `${p.kind}:${p.url}`)).toEqual([`other:${open.url}`]);
    expect(unread).toEqual([`${SITE}/about`, `${SITE}/services`]);
  });

  it('is not stopped by an address with a stray per cent sign', () => {
    expect(classifyPage('/sale-50%-off', '')).toBe('other');
    expect(classifyPage('/caf%E9', 'About us')).toBe('about');
    const doc = parseHtml('<title>Sale</title><nav><a href="/sale-50%-off">Sale</a><a href="/about">About</a></nav>');
    expect(pickSitePages(doc, `${SITE}/sale-50%-off`).map((l) => l.url)).toEqual([`${SITE}/`, `${SITE}/sale-50%-off`, `${SITE}/about`]);
    expect(assemble({ url: `${SITE}/100%`, doc }, [], []).pages.map((p) => p.kind)).toEqual(['other']);
  });
});

describe('business facts', () => {
  it('reads name, contact details and address', () => {
    expect(facts).toMatchObject({
      siteUrl: `${ORIGIN}/`,
      name: 'BrightPath Dental',
      nameSource: 'structured data',
      phones: ['(512) 555-0142'],
      emails: ['hello@brightpathdental.example', 'billing@brightpathdental.example'],
      addresses: ['2410 South Lamar Blvd, Suite 120, Austin, TX 78704, US'],
    });
    expect(facts.description).toMatch(/^Gentle, unhurried dental care/);
  });

  it('reads service areas, services and social profiles', () => {
    expect(facts.serviceAreas).toEqual(['South Austin', 'Zilker', 'Barton Hills', 'Travis Heights']);
    expect(facts.services).toEqual(['Cleanings and exams', 'Teeth whitening', 'Crowns and fillings', 'Invisalign', 'Emergency dentistry', "Children's dentistry"]);
    expect(facts.socialProfiles).toEqual([
      { network: 'Facebook', url: 'https://www.facebook.example/brightpathdental' },
      { network: 'Instagram', url: 'https://www.instagram.example/brightpathdental' },
    ]);
  });

  it('reads JSON-LD organisation data, logo and brand colours', () => {
    expect(facts.organisation).toEqual({
      types: ['Dentist', 'LocalBusiness'],
      priceRange: '$$',
      openingHours: ['Mo-Th 07:30-17:30', 'Fr 08:00-14:00'],
      rating: { value: '4.9', count: '286' },
      founded: null,
    });
    expect(facts.logoUrl).toBe(`${ORIGIN}/assets/brightpath-logo.png`);
    expect(facts.brandColors.map((c) => c.hex)).toEqual(['#0e7c86', '#0a5a62', '#f4a340']);
  });

  it('prefers colours and logo measured on the live page', () => {
    const live = extractBusinessFacts(site, {
      colors: [
        { hex: 'rgb(18, 52, 86)', weight: 10, source: 'header background' },
        { hex: '#ffffff', weight: 99, source: 'page background' },
        { hex: '#777777', weight: 5, source: 'text' },
      ],
      logoUrl: `${ORIGIN}/live-logo.png`,
      logoDataUrl: 'data:image/png;base64,AAAA',
      fonts: ['Nunito'],
    });
    expect(live.brandColors[0]).toEqual({ hex: '#123456', source: 'header background' });
    expect(live.brandColors.map((c) => c.hex)).not.toContain('#ffffff');
    expect(live.brandColors.map((c) => c.hex)).not.toContain('#777777');
    expect(live.logoUrl).toBe(`${ORIGIN}/live-logo.png`);
    expect(live.logoDataUrl).toBe('data:image/png;base64,AAAA');
    expect(live.fonts).toEqual(['Nunito']);
  });

  it('samples the tone of voice from running prose only', () => {
    expect(facts.tone?.sample).toMatch(/^We believe a dental visit should never feel rushed\./);
    expect(facts.tone?.sample).not.toMatch(/Book a visit|I used to dread/);
    expect(facts.tone?.traits).toEqual(expect.arrayContaining(['Speaks directly to the reader (“you”)', 'First person plural (“we”, “our”)']));
  });

  it('finds on-site testimonials with their authors', () => {
    expect(facts.testimonials).toEqual([
      { quote: 'I used to dread the dentist. The BrightPath team explained every step and I never felt rushed.', author: 'Priya R., Zilker' },
      { quote: 'They saw my son the same day he chipped a tooth. Kind, fast and fairly priced.', author: 'Marcus T., Travis Heights' },
    ]);
  });

  it('proposes focus keywords from titles and H1s, without the brand name or page labels', () => {
    const phrases = facts.keywordCandidates.map((k) => k.phrase);
    expect(phrases).toEqual(
      expect.arrayContaining(['gentle dentistry in south austin', 'dental services in austin', 'how often should you get your teeth cleaned']),
    );
    expect(phrases.some((p) => /brightpath|contact|pricing|about/.test(p))).toBe(false);
  });

  it('falls back through site name, page titles and the domain for the business name', () => {
    const titled = (title: string) => ({ url: 'https://acme.example/', kind: 'home' as const, doc: parseHtml(`<title>${title}</title>`) });
    expect(extractBusinessFacts([{ ...titled('x'), doc: parseHtml('<meta property="og:site_name" content="Acme Roofing"><title>x</title>') }])).toMatchObject({
      name: 'Acme Roofing',
      nameSource: 'site name tag',
    });
    const fromTitles = extractBusinessFacts([
      titled('Roof Repair | Acme Roofing'),
      { url: 'https://acme.example/about', kind: 'about', doc: parseHtml('<title>About Us | Acme Roofing</title>') },
    ]);
    expect(fromTitles).toMatchObject({ name: 'Acme Roofing', nameSource: 'page titles' });
    expect(extractBusinessFacts([titled('Welcome')])).toMatchObject({ name: 'acme.example', nameSource: 'domain' });
  });

  it('finds phones, emails, areas and testimonials in plain text and ignores junk', () => {
    const doc = parseHtml(`<main>
      <p>Call us on 512-555-0199 or (512) 555-0199. Write to office@acme.example, not logo@2x.png.</p>
      <p>Proudly serving Round Rock, Cedar Park and Pflugerville since 1999.</p>
      <div class="testimonial"><p>Great work on our roof, on time and tidy.</p><span class="author">Sam K.</span></div>
      <script>var x = "fake@script.example";</script></main>`);
    const plain = extractBusinessFacts([{ url: 'https://acme.example/', kind: 'home', doc }]);
    expect(plain.phones).toEqual(['512-555-0199']);
    expect(plain.emails).toEqual(['office@acme.example']);
    expect(plain.serviceAreas).toEqual(['Round Rock', 'Cedar Park', 'Pflugerville']);
    expect(plain.testimonials).toEqual([{ quote: 'Great work on our roof, on time and tidy.', author: 'Sam K.' }]);
    expect(plain.organisation).toBeNull();
  });

  it('normalises colour notations', () => {
    expect(normaliseHex('#ABC')).toBe('#aabbcc');
    expect(normaliseHex('#0E7C86FF')).toBe('#0e7c86');
    expect(normaliseHex('rgba(14, 124, 134, 0.5)')).toBe('#0e7c86');
    expect(normaliseHex('teal')).toBeNull();
  });

  it('returns an empty but valid result when there are no pages', () => {
    const empty = extractBusinessFacts([]);
    expect(empty).toMatchObject({ siteUrl: '', name: null, phones: [], services: [], tone: null, pages: [] });
  });
});

describe('on-page issues', () => {
  const by = (code: string) => issues.find((i) => i.code === code);

  it('finds the problems planted in the fixture site', () => {
    expect(by('missing-description')).toMatchObject({ severity: 'medium', pages: [`${ORIGIN}/pricing`] });
    expect(by('short-title')?.detail).toBe('Titles under 15 characters: /pricing (“Pricing”).');
    expect(by('multiple-h1')).toMatchObject({ severity: 'low', pages: [`${ORIGIN}/locations`] });
    expect(by('missing-alt')?.detail).toBe('/: 1 image.');
    expect(by('missing-canonical')?.pages).toEqual([`${ORIGIN}/blog/how-often-teeth-cleaning`]);
    expect(by('noindex')).toBeUndefined();
    expect(by('missing-title')).toBeUndefined();
  });

  it('orders issues by severity', () => {
    const order = issues.map((i) => i.severity);
    expect(order).toEqual([...order].sort((a, b) => ['high', 'medium', 'low'].indexOf(a) - ['high', 'medium', 'low'].indexOf(b)));
  });

  it('flags noindex, missing titles, duplicate titles, off-page canonicals and plain HTTP', () => {
    const page = (url: string, html: string, kind: SitePage['kind'] = 'other') => {
      const doc = parseHtml(html);
      return { url, kind, doc, facts: extractPageFacts(doc, url) };
    };
    const found = findIssues([
      page('http://a.example/', '<title>Same title here</title><meta name="robots" content="NOINDEX"><h1>x</h1>', 'home'),
      page('http://a.example/b', '<title>Same title here</title><link rel="canonical" href="http://a.example/"><h1>x</h1>'),
      page('http://a.example/c', '<h1>No title</h1>'),
    ]);
    const codes = found.map((i) => i.code);
    expect(codes.slice(0, 3)).toEqual(expect.arrayContaining(['not-https', 'noindex', 'missing-title']));
    expect(found.filter((i) => i.severity === 'high')).toHaveLength(3);
    expect(codes).toEqual(expect.arrayContaining(['duplicate-title', 'canonical-elsewhere', 'missing-viewport', 'no-structured-data']));
    expect(found.find((i) => i.code === 'canonical-elsewhere')?.detail).toBe('/b → http://a.example/.');
  });

  it('reports nothing for a clean page', () => {
    const html = `<title>A perfectly reasonable page title</title><meta name="description" content="d"><meta name="viewport" content="width=device-width">
      <link rel="canonical" href="https://a.example/x"><script type="application/ld+json">{"@type":"Organization"}</script>
      <main><h1>Heading</h1><p>${'word '.repeat(150)}</p><img src="a.png" alt="described"></main>`;
    const doc = parseHtml(html);
    expect(findIssues([{ url: 'https://a.example/x', kind: 'home', doc, facts: extractPageFacts(doc, 'https://a.example/x') }])).toEqual([]);
  });
});

describe('composing the brief', () => {
  const search: SearchEntry[] = [
    {
      keyword: 'best dentist in austin',
      capturedAt: Date.UTC(2026, 10, 20),
      viewport: '1280×800',
      gradeLetter: 'F',
      gradeScore: 0,
      firstOrganicTop: 1431,
      myPosition: 6,
      myFold: 'Below the fold',
      gapSurfaces: ['AI Overview', 'Local pack'],
      competitorsSeen: ['Lakeside Smiles', 'Capitol Dental Care'],
    },
  ];
  const brief = composeBrief({
    id: 'brief-1',
    now: Date.UTC(2026, 10, 20, 9),
    facts,
    issues,
    competitors: [{ name: 'Lakeside Smiles', domain: 'lakesidesmiles.example', source: 'tracked' }],
    search,
  });

  it('has the seven sections in order', () => {
    expect(brief.sections.map((s) => s.title)).toEqual(['Business', 'Offer', 'Customers', 'Competitors', 'Search presence', 'Issues', 'Next steps']);
    expect(brief.businessName).toBe('BrightPath Dental');
    expect(brief.writtenBy).toBe('template');
  });

  it('drafts three avatars from the offer, the area and the proof on the site, labelled as drafts', () => {
    expect(brief.avatars).toHaveLength(3);
    expect(brief.avatars[0]).toMatchObject({ name: 'The urgent need', who: 'Someone in South Austin who needs emergency dentistry now and has not chosen a dentist yet.' });
    expect(brief.avatars[1]?.who).toBe('Someone comparing two or three dentists in South Austin before booking teeth whitening.');
    expect(brief.avatars[1]?.proof).toBe('The site already offers a 4.9-star rating from 286 reviews, a testimonial from Priya R., Zilker and a public pricing page.');
    const customers = brief.sections.find((s) => s.id === 'customers')!;
    expect(customers.note).toMatch(/^Draft avatars/);
    expect(customers.lists.every((l) => l.label.startsWith('Draft — '))).toBe(true);
    expect(categoryNoun(facts)).toBe('dentist');
  });

  it('reuses Click Potential and Why Not Me data in the search section', () => {
    const section = brief.sections.find((s) => s.id === 'search')!;
    expect(section.lists[0]?.label).toBe('“best dentist in austin” — 2026-11-20, 1280×800');
    expect(section.lists[0]?.items).toEqual([
      'Organic position #6 (below the fold)',
      'First organic result starts 1,431 px down; organic click potential F (0/100, estimate)',
      'Competitors present and the business absent in: AI Overview, Local pack',
      'Competitors seen: Lakeside Smiles, Capitol Dental Care',
    ]);
  });

  it('writes next steps tied to what was found', () => {
    expect(brief.nextSteps[0]).toBe(
      'For “best dentist in austin”, competitors appear in ai overview, local pack and BrightPath Dental does not. Review the gap list for pages to get included on.',
    );
    expect(brief.nextSteps.join('\n')).toContain('the site ranks #6 but sits below the fold');
    expect(brief.nextSteps.join('\n')).toContain('Missing meta description (1 page).');
    expect(brief.nextSteps.length).toBeLessThanOrEqual(8);
  });

  it('still produces a useful brief from almost nothing', () => {
    const bare = extractBusinessFacts([{ url: 'https://acme.example/', kind: 'home', doc: parseHtml('<title>Welcome</title><p>Hello.</p>') }]);
    const minimal = composeBrief({ id: 'b', now: 0, facts: bare, issues: [], competitors: [] });
    expect(minimal.businessName).toBe('acme.example');
    expect(minimal.avatars).toHaveLength(3);
    expect(minimal.avatars[0]?.who).toBe('Someone who needs its main service now and has not chosen a business yet.');
    expect(minimal.nextSteps).toEqual(
      expect.arrayContaining([
        'No customer testimonials were found on the site. Add a few, with names and locations.',
        'Add LocalBusiness or Organization structured data with name, address, phone and opening hours.',
        'Name two or three competitors so their visibility can be compared with this site.',
      ]),
    );
    expect(minimal.sections.find((s) => s.id === 'competitors')?.paragraphs).toEqual(['No competitors have been added yet.']);
    expect(draftNextSteps(bare, [], [], [])).toEqual(minimal.nextSteps);
    expect(draftAvatars(bare)[1]?.proof).toBe('The site has little to reassure this person yet.');
  });

  it('prints no empty line for an avatar without searches or proof, and no competitor name twice', () => {
    const base = composeBrief({ id: 'b', now: Date.UTC(2026, 10, 20), facts, issues, competitors: [{ name: 'rival.example', domain: 'rival.example', source: 'tracked' }, { name: 'Lakeside Smiles', domain: 'lakesidesmiles.example', source: 'tracked' }] });
    const sparse = withRewrites(base, { avatars: [1, 2, 3].map((n) => ({ name: `N${n}`, who: 'W', wants: 'Wa', worries: 'Wo', searches: [], proof: '' })), writtenBy: 'legiit' });
    const customers = sparse.sections.find((section) => section.id === 'customers')!;
    expect(customers.lists[0]!.items).toEqual(['W', 'Wants: Wa', 'Worries about: Wo']);
    const markdown = briefToMarkdown(sparse, { name: '', logoDataUrl: null });
    expect(markdown).not.toMatch(/Searches for: *\n/);
    expect(markdown).not.toMatch(/^- *$/m);
    // A competitor that is known by its domain only is listed once, not as "rival.example (rival.example)".
    expect(sparse.sections.find((section) => section.id === 'competitors')!.lists[0]!.items).toEqual(['rival.example', 'Lakeside Smiles (lakesidesmiles.example)']);
  });

  it('accepts rewritten avatars and next steps only when they are well-formed', () => {
    const rewritten = withRewrites(brief, { avatars: brief.avatars.map((a) => ({ ...a, name: `AI ${a.name}` })), nextSteps: ['Do one thing'], writtenBy: 'chrome-prompt' });
    expect(rewritten.writtenBy).toBe('chrome-prompt');
    expect(rewritten.avatars[0]?.name).toBe('AI The urgent need');
    expect(rewritten.sections.find((s) => s.id === 'next')?.lists[0]?.items).toEqual(['Do one thing']);
    const rejected = withRewrites(brief, { avatars: [brief.avatars[0]!], nextSteps: [], writtenBy: 'legiit' });
    expect(rejected.avatars).toEqual(brief.avatars);
    expect(rejected.nextSteps).toEqual(brief.nextSteps);
  });
});

describe('Markdown export', () => {
  const brief = composeBrief({ id: 'b', now: Date.UTC(2026, 10, 20), facts, issues, competitors: [] });
  const markdown = briefToMarkdown(brief, { name: 'North Star SEO', logoDataUrl: null });

  it('carries the agency name and no Legiit branding', () => {
    expect(markdown.split('\n').slice(0, 3)).toEqual(['# Client brief: BrightPath Dental', '', 'Prepared by North Star SEO · 2026-11-20']);
    expect(markdown).not.toMatch(/legiit/i);
    expect(briefToMarkdown(brief, { name: '', logoDataUrl: null })).toContain('Prepared 2026-11-20');
  });

  it('includes every section and the extracted facts', () => {
    for (const heading of ['## Business', '## Offer', '## Customers', '## Competitors', '## Search presence', '## Issues', '## Next steps']) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain('- **Phone:** (512) 555-0142');
    expect(markdown).toContain('### Draft — The urgent need');
    expect(markdown).toContain('- Teeth whitening');
  });

  it('escapes page-derived text so it cannot inject markup', () => {
    expect(escapeMarkdown('<script>alert(1)</script> [x](javascript:alert(1)) *bold* `code`')).toBe(
      '\\<script\\>alert(1)\\</script\\> \\[x\\](javascript:alert(1)) \\*bold\\* \\`code\\`',
    );
    expect(escapeMarkdown('# not a heading\nsecond line')).toBe('\\# not a heading second line');
    const hostile = extractBusinessFacts([
      { url: 'https://evil.example/', kind: 'home', doc: parseHtml('<meta property="og:site_name" content="<img src=x onerror=alert(1)> [click](javascript:alert(1))"><title>t</title>') },
    ]);
    const out = briefToMarkdown(composeBrief({ id: 'b', now: 0, facts: hostile, issues: [], competitors: [] }), { name: 'A', logoDataUrl: null });
    // Every angle bracket and link bracket is backslash-escaped, so nothing renders as markup.
    expect(out).not.toMatch(/(^|[^\\])<img/);
    expect(out).toContain('\\<img src=x onerror=alert(1)\\>');
    expect(out).not.toMatch(/(^|[^\\])\[click\]/);
  });
});
