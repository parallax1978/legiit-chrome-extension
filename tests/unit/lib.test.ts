import { describe, expect, it } from 'vitest';
import { mapLimit, sleep } from '@/lib/async';
import { csvCell, toCsv } from '@/lib/csv';
import { hashString, randomId } from '@/lib/hash';
import { intersect, unionArea } from '@/lib/rect';
import {
  cleanMultiline,
  cleanText,
  domainOf,
  isSafeImageDataUrl,
  normalizeDomainInput,
  safeHttpUrl,
  slugify,
} from '@/lib/sanitize';
import { contentTokens, countWords, splitSentences, stem, titlesAgree, tokenize } from '@/lib/text';
import {
  cleanUrl,
  hostMatchesDomain,
  isGoogleInfraHost,
  isGoogleNavHost,
  isHiddenGoogleRedirect,
  originPatternFor,
  pageOfAddressLine,
  siteOfAddressLine,
  siteOfIconUrl,
  siteOfPattern,
  unwrapGoogleUrl,
  urlKey,
} from '@/lib/url';

describe('sanitize', () => {
  it('collapses whitespace, strips control and bidi characters and truncates', () => {
    expect(cleanText('  a\n\tb\u0000‮c  ')).toBe('a bc');
    expect(cleanText('x'.repeat(20), 10)).toHaveLength(10);
    expect(cleanText(undefined)).toBe('');
    expect(cleanText(42)).toBe('');
  });

  it('keeps paragraph breaks in multiline text', () => {
    expect(cleanMultiline('a  b\r\n\r\n\r\n\r\nc ')).toBe('a b\n\nc');
  });

  it('accepts only http(s) URLs and strips credentials', () => {
    expect(safeHttpUrl('https://user:pw@example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHttpUrl('/path', 'https://example.com/x/')).toBe('https://example.com/path');
    for (const bad of ['javascript:alert(1)', 'data:text/html,<p>', 'file:///etc/passwd', 'chrome://settings', '', 'not a url', 5]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
    expect(safeHttpUrl(`https://example.com/${'a'.repeat(3000)}`)).toBeNull();
  });

  it('extracts and normalises domains', () => {
    expect(domainOf('https://WWW.Example.com/x')).toBe('example.com');
    expect(domainOf('mailto:a@b.c')).toBe('');
    expect(normalizeDomainInput('https://www.Example.co.uk/page?x=1')).toBe('example.co.uk');
    expect(normalizeDomainInput('example.com')).toBe('example.com');
    expect(normalizeDomainInput('not a domain')).toBeNull();
    expect(normalizeDomainInput('javascript:alert(1)')).toBeNull();
    // An e-mail address is not read as its domain.
    for (const value of ['info@example.com', 'mailto:info@example.com', 'https://user@example.com/', 'jane.doe@gmail.com']) expect(normalizeDomainInput(value), value).toBeNull();
    // An "@" further on is part of an ordinary address.
    expect(normalizeDomainInput('https://medium.com/@brightpath')).toBe('medium.com');
    expect(normalizeDomainInput('example.com/team/@jane')).toBe('example.com');
    expect(normalizeDomainInput('example.com/?email=a@b.c')).toBe('example.com');
    expect(normalizeDomainInput('https://user:pw@example.com/')).toBeNull();
    expect(normalizeDomainInput('*.example.com')).toBeNull();
  });

  it('builds safe file-name slugs', () => {
    expect(slugify('Best Dentist in Austin!?')).toBe('best-dentist-in-austin');
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('***')).toBe('export');
  });

  it('accepts only raster data URLs for logos', () => {
    expect(isSafeImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isSafeImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isSafeImageDataUrl('data:text/html;base64,PHA+')).toBe(false);
    expect(isSafeImageDataUrl('https://example.com/logo.png')).toBe(false);
    expect(isSafeImageDataUrl(`data:image/png;base64,${'A'.repeat(900_000)}`)).toBe(false);
  });
});

describe('url', () => {
  it('removes tracking parameters and text fragments', () => {
    expect(cleanUrl('https://a.example/p?utm_source=x&id=7&srsltid=abc#:~:text=hello')).toBe('https://a.example/p?id=7');
    expect(cleanUrl('https://a.example/p#section')).toBe('https://a.example/p#section');
    expect(cleanUrl('ftp://a.example')).toBeNull();
  });

  it('unwraps Google redirect and ad-click links', () => {
    const base = 'https://www.google.com/search?q=x';
    expect(unwrapGoogleUrl('/url?q=https://a.example/page&sa=U', base)).toBe('https://a.example/page');
    expect(
      unwrapGoogleUrl('https://www.googleadservices.com/pagead/aclk?sa=L&adurl=https%3A%2F%2Fb.example%2Fx%3Fgclid%3D1', base),
    ).toBe('https://b.example/x');
    expect(unwrapGoogleUrl('https://www.googleadservices.com/pagead/aclk?sa=L', base)).toBeNull();
    expect(unwrapGoogleUrl('https://c.example/', base)).toBe('https://c.example/');
  });

  it('classifies Google navigation and infrastructure hosts', () => {
    for (const host of ['www.google.com', 'google.co.uk', 'maps.google.de', 'support.google.com', 'accounts.google.com.au']) {
      expect(isGoogleNavHost(host), host).toBe(true);
    }
    for (const host of ['blog.google', 'play.google.com', 'example.com', 'notgoogle.com', 'google.evil.example']) {
      expect(isGoogleNavHost(host), host).toBe(false);
    }
    expect(isGoogleInfraHost('www.googleadservices.com')).toBe(true);
    expect(isGoogleInfraHost('encrypted-tbn0.gstatic.com')).toBe(true);
    expect(isGoogleInfraHost('www.youtube.com')).toBe(false);
  });

  it('builds de-duplication keys that ignore scheme, www, trailing slash and tracking', () => {
    expect(urlKey('http://www.a.example/p/?utm_medium=x')).toBe(urlKey('https://a.example/p'));
    expect(urlKey('https://a.example/p?x=1')).not.toBe(urlKey('https://a.example/p?x=2'));
  });

  it('derives one host-permission pattern per site', () => {
    expect(originPatternFor('https://www.example.com/a/b?c')).toBe('*://*.example.com/*');
    expect(originPatternFor('http://blog.example.co.uk/')).toBe('*://*.blog.example.co.uk/*');
    expect(originPatternFor('http://localhost:8787/x')).toBe('*://localhost/*');
    expect(originPatternFor('http://127.0.0.1/x')).toBe('*://127.0.0.1/*');
    expect(originPatternFor('chrome://extensions')).toBeNull();
    expect(siteOfPattern('*://*.example.com/*')).toBe('example.com');
    expect(siteOfPattern('https://web.archive.org/*')).toBe('web.archive.org');
  });

  it('matches hosts against domains including subdomains only', () => {
    expect(hostMatchesDomain('shop.example.com', 'example.com')).toBe(true);
    expect(hostMatchesDomain('www.example.com', 'example.com')).toBe(true);
    expect(hostMatchesDomain('badexample.com', 'example.com')).toBe(false);
    expect(hostMatchesDomain('example.com.evil.test', 'example.com')).toBe(false);
  });
});

describe('links whose address Google hides', () => {
  const page = 'https://www.google.com/search?q=x';

  it("recognises Google's redirect with a token, and nothing else", () => {
    expect(isHiddenGoogleRedirect('/goto?url=CAESegHEIkXXm5BIIQxZ', page)).toBe(true);
    expect(isHiddenGoogleRedirect('https://www.google.com/goto?url=CAESegHE', page)).toBe(true);
    expect(isHiddenGoogleRedirect('https://www.google.co.uk/goto?url=CAESegHE', page)).toBe(true);
    expect(isHiddenGoogleRedirect('/url?sa=t&url=CAESegHEIkXX', page)).toBe(true);
    // A redirect that names its target is unwrapped as before, so it is not a hidden one.
    expect(isHiddenGoogleRedirect('/url?q=https://example.com/page', page)).toBe(false);
    expect(isHiddenGoogleRedirect('/url?sa=t', page)).toBe(false);
    expect(isHiddenGoogleRedirect('/search?q=more', page)).toBe(false);
    expect(isHiddenGoogleRedirect('https://example.com/goto?url=CAES', page)).toBe(false);
    expect(isHiddenGoogleRedirect('javascript:alert(1)', page)).toBe(false);
    expect(isHiddenGoogleRedirect('', page)).toBe(false);
  });

  it('takes only the site from the line under a title', () => {
    expect(siteOfAddressLine('https://www.jobsboard.example \u203a freelance-jobs \u203a seo')).toBe('https://www.jobsboard.example');
    expect(siteOfAddressLine('https://www.hiringhub.example \u203a ... \u203a Business Jobs')).toBe('https://www.hiringhub.example');
    expect(siteOfAddressLine('  https://www.seoworkers.example  ')).toBe('https://www.seoworkers.example');
    expect(siteOfAddressLine('www.example.co.uk \u203a blog')).toBe('https://www.example.co.uk');
    expect(siteOfAddressLine('http://smallsite.example')).toBe('http://smallsite.example');
    // A line that names no site gives nothing: the reader must not guess.
    expect(siteOfAddressLine('30+ comments \u00b7 1 year ago')).toBeNull();
    expect(siteOfAddressLine('Forum \u00b7 r/Austin')).toBeNull();
    expect(siteOfAddressLine('javascript:alert(1) \u203a x')).toBeNull();
    expect(siteOfAddressLine('https://user:pass@evil.example \u203a x')).toBeNull();
    expect(siteOfAddressLine('')).toBeNull();
  });
});

describe('the page address a result spells out when Google hides its link', () => {
  it('reads the line under the title as an address only when every part can be a path segment', () => {
    expect(pageOfAddressLine('https://www.jobsboard.example \u203a blog \u203a guest-posting-services')).toBe('https://www.jobsboard.example/blog/guest-posting-services');
    expect(pageOfAddressLine('https://smallsite.example \u203a buy-guest-posts')).toBe('https://smallsite.example/buy-guest-posts');
    expect(pageOfAddressLine('www.example.co.uk \u203a Jobs \u203a Freelance-Seo')).toBe('https://www.example.co.uk/Jobs/Freelance-Seo');
    // The site alone is no page. Neither is a line that Google shortened, or one that shows names of sections.
    expect(pageOfAddressLine('https://smallsite.example')).toBeNull();
    expect(pageOfAddressLine('https://www.hiringhub.example \u203a ... \u203a Business Jobs')).toBeNull();
    expect(pageOfAddressLine('https://www.hiringhub.example \u203a Company Blog')).toBeNull();
    expect(pageOfAddressLine('https://www.hiringhub.example \u203a guest-posting-serv...')).toBeNull();
    expect(pageOfAddressLine('30+ comments \u00b7 1 year ago')).toBeNull();
    expect(pageOfAddressLine('javascript:alert(1) \u203a x')).toBeNull();
    // Whatever the line says, the address stays on the site it names.
    expect(pageOfAddressLine('https://smallsite.example \u203a @evil.example \u203a x')).toBeNull();
    expect(new URL(pageOfAddressLine('https://smallsite.example \u203a evil.example \u203a x')!).hostname).toBe('smallsite.example');
  });

  it('reads the site an icon stands for from the address of the icon', () => {
    expect(siteOfIconUrl('https://encrypted-tbn3.gstatic.com/faviconV2?url=https://smallsite.example&client=AIM&size=32&type=FAVICON')).toBe('https://smallsite.example');
    expect(siteOfIconUrl('https://encrypted-tbn0.gstatic.com/faviconV2?url=https://www.jobsboard.example/some/page&size=16')).toBe('https://www.jobsboard.example');
    expect(siteOfIconUrl('https://encrypted-tbn0.gstatic.com/images?q=tbn:abc')).toBeNull();
    expect(siteOfIconUrl('https://evil.example/faviconV2?url=https://smallsite.example')).toBeNull();
    expect(siteOfIconUrl('https://encrypted-tbn0.gstatic.com/faviconV2?url=javascript:alert(1)')).toBeNull();
    expect(siteOfIconUrl('data:image/gif;base64,R0lGODlhAQABAIAAAP')).toBeNull();
    expect(siteOfIconUrl('')).toBeNull();
  });

  it('tells whether a page can be the page a result is titled after', () => {
    const result = '15 Best Guest Posting Services for 2026 (Models and Prices)';
    // The page's title with the site's name added, a shortened title, different quotes: the same page.
    expect(titlesAgree(result, ['15 Best Guest Posting Services for 2026 (Models and Prices) - Distribb'])).toBe(true);
    expect(titlesAgree('Guest Posting Sites List - 76651+ Sites by Niche, DR and ...', ['Guest Posting Sites List - 76651+ Sites by Niche, DR and Traffic | Linkio'])).toBe(true);
    expect(titlesAgree('Find Freelance SEO Jobs Online - Guru', ['Find Freelance SEO Jobs Online'])).toBe(true);
    expect(titlesAgree('2026\u2019s Best SEO Services', ["2026's Best SEO Services | Trusted Experts"])).toBe(true);
    expect(titlesAgree('Buy Guest Posts', ['Something else', 'Buy Guest Posts | Guest Posting Service | UppercutLINKS'])).toBe(true);
    // The section a result is filed under, the home page, an error page: another page.
    expect(titlesAgree(result, ['Blog - Distribb'])).toBe(false);
    expect(titlesAgree(result, ['Guest Posting Services'])).toBe(false);
    expect(titlesAgree('24 Best Permanent Guest Post Services To Buy Online', ['Guest Post Services', 'Fiverr - Freelance Services Marketplace'])).toBe(false);
    expect(titlesAgree(result, ['Page not found'])).toBe(false);
    expect(titlesAgree(result, [])).toBe(false);
    expect(titlesAgree('', ['Anything'])).toBe(false);
  });
});

describe('text', () => {
  it('tokenises and counts words in any script', () => {
    expect(tokenize("Don't stop – it's 2026!")).toEqual(["don't", 'stop', "it's", '2026']);
    expect(countWords('Zahnärzte in München sind gut')).toBe(5);
    expect(countWords('')).toBe(0);
  });

  it('stems lightly and removes stop words', () => {
    expect(stem('cleanings')).toBe('clean');
    expect(stem('services')).toBe('servic');
    expect(stem('glass')).toBe('glass');
    expect(contentTokens('The dentist is cleaning the teeth')).toEqual(['dentist', 'clean', 'teeth']);
  });

  it('splits sentences without breaking on abbreviations', () => {
    expect(splitSentences('Dr. Vargas opened in 2014. We serve Austin! Do you need a visit?')).toEqual([
      'Dr. Vargas opened in 2014.',
      'We serve Austin!',
      'Do you need a visit?',
    ]);
    expect(splitSentences('   ')).toEqual([]);
    expect(splitSentences('No full stop')).toEqual(['No full stop']);
  });
});

describe('csv', () => {
  it('quotes cells and neutralises spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1 512 555 0142')).toBe("'+1 512 555 0142");
    expect(csvCell('@handle')).toBe("'@handle");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('yes');
  });

  it('writes a BOM, a header row and CRLF line endings', () => {
    expect(toCsv(['a', 'b'], [[1, 'x\ny']])).toBe('﻿a,b\r\n1,"x\ny"\r\n');
  });
});

describe('rect', () => {
  it('intersects rectangles', () => {
    expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({
      x: 5,
      y: 5,
      width: 5,
      height: 5,
    });
    expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBeNull();
  });

  it('counts overlapping area once', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 5, y: 0, width: 10, height: 10 };
    expect(unionArea([a, b])).toBe(150);
    expect(unionArea([a, a, a])).toBe(100);
    expect(unionArea([a, { x: 20, y: 20, width: 2, height: 2 }])).toBe(104);
    expect(unionArea([])).toBe(0);
  });
});

describe('async and hash helpers', () => {
  it('limits concurrency and preserves order', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await sleep(n);
      running--;
      return n * 2;
    });
    expect(out).toEqual([10, 2, 6, 4, 8]);
    expect(peak).toBe(2);
  });

  it('rejects a sleep when aborted', async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('hashes deterministically and makes unique ids', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    expect(randomId('x')).toMatch(/^x_[0-9a-f]{18}$/);
    expect(randomId()).not.toBe(randomId());
  });
});
