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
import { contentTokens, countWords, splitSentences, stem, tokenize } from '@/lib/text';
import {
  cleanUrl,
  hostMatchesDomain,
  isGoogleInfraHost,
  isGoogleNavHost,
  originPatternFor,
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
