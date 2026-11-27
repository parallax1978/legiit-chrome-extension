import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertAllowed, guardedFetch, isNeverRequested, networkLog, NetworkPolicyError, PermissionRequiredError } from '@/net/guarded-fetch';
import { decodeHtml, fetchPage } from '@/net/page-fetch';
import { describeSites, grantedSites, hasAccess, missingAccess, patternsFor, requestAccess, revokeSites } from '@/net/permissions';
import { chromeMock } from '../helpers/fixtures';

function respond(body: string, init: { status?: number; url?: string; headers?: Record<string, string> } = {}): Response {
  const response = new Response(body, { status: init.status ?? 200, headers: init.headers ?? { 'content-type': 'text/html; charset=utf-8' } });
  if (init.url) Object.defineProperty(response, 'url', { value: init.url });
  return response;
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('network policy', () => {
  it('allows the Wayback Machine only for wayback requests', () => {
    expect(assertAllowed('https://web.archive.org/cdx/search/cdx?url=x', 'wayback').host).toBe('web.archive.org');
    expect(() => assertAllowed('https://example.com/', 'wayback')).toThrow(NetworkPolicyError);
    expect(() => assertAllowed('http://web.archive.org/x', 'wayback')).toThrow(NetworkPolicyError);
    expect(() => assertAllowed('https://web.archive.org.evil.example/x', 'wayback')).toThrow(NetworkPolicyError);
  });

  it('allows the configured Legiit origin only for legiit requests', () => {
    expect(assertAllowed('https://lens.legiit.com/v1/session', 'legiit').pathname).toBe('/v1/session');
    expect(() => assertAllowed('https://legiit.com/v1/session', 'legiit')).toThrow(NetworkPolicyError);
    expect(() => assertAllowed('https://lens.legiit.com.evil.example/', 'legiit')).toThrow(NetworkPolicyError);
  });

  it('rejects non-http(s) schemes for every purpose', () => {
    for (const purpose of ['wayback', 'legiit', 'page'] as const) {
      expect(() => assertAllowed('file:///etc/passwd', purpose)).toThrow(NetworkPolicyError);
      expect(() => assertAllowed('chrome-extension://abc/x', purpose)).toThrow(NetworkPolicyError);
    }
  });

  it('never requests a page of Google or of an AI site, whatever access the browser has', async () => {
    // Google can hide where a result leads: its own redirect link then stands where the address was.
    const off = [
      'https://www.google.com/goto?url=CAESegHEIkXXm5BIIQxZ',
      'https://www.google.co.uk/search?q=best+dentist',
      'https://www.google.com/url?q=https://example.com/',
      'https://maps.google.com/maps?q=x',
      'https://www.googleadservices.com/pagead/aclk?sa=L',
      'https://chatgpt.com/share/abc',
      'https://gemini.google.com/app',
      'https://www.perplexity.ai/search/x',
      'https://copilot.microsoft.com/',
    ];
    chromeMock().granted.add('*://*.google.com/*');
    chromeMock().granted.add('*://*.chatgpt.com/*');
    for (const url of off) {
      expect(isNeverRequested(new URL(url).hostname), url).toBe(true);
      expect(() => assertAllowed(url, 'page'), url).toThrow(NetworkPolicyError);
      await expect(guardedFetch(url, 'page'), url).rejects.toBeInstanceOf(NetworkPolicyError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    // Other sites, also Google's publishing sites and YouTube, are pages like any other.
    for (const url of ['https://www.example.com/a', 'https://blog.google/products/search/', 'https://www.youtube.com/watch?v=x', 'https://notgoogle.com/']) {
      expect(isNeverRequested(new URL(url).hostname), url).toBe(false);
      expect(assertAllowed(url, 'page').href, url).toBe(url);
    }
  });

  it('refuses to fetch a page on a site the user has not granted, without touching the network', async () => {
    await expect(guardedFetch('https://www.example.com/a', 'page')).rejects.toBeInstanceOf(PermissionRequiredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches a granted page without cookies or referrer and logs the request', async () => {
    chromeMock().granted.add('*://*.example.com/*');
    fetchMock.mockResolvedValue(respond('<p>ok</p>', { url: 'https://www.example.com/a' }));
    const before = networkLog().length;
    const response = await guardedFetch('https://www.example.com/a', 'page');
    expect(await response.text()).toBe('<p>ok</p>');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.example.com/a',
      expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }),
    );
    expect(networkLog().slice(before)).toMatchObject([{ host: 'www.example.com', purpose: 'page', status: 200 }]);
  });

  it('cannot be talked into sending cookies', async () => {
    chromeMock().granted.add('*://*.example.com/*');
    fetchMock.mockResolvedValue(respond('x', { url: 'https://example.com/' }));
    await guardedFetch('https://example.com/', 'page', { credentials: 'include' });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit' });
  });

  it('discards a page that redirected to a site that was not granted', async () => {
    chromeMock().granted.add('*://*.example.com/*');
    fetchMock.mockResolvedValue(respond('secret', { url: 'https://other.example.net/landing' }));
    await expect(guardedFetch('https://www.example.com/a', 'page')).rejects.toBeInstanceOf(NetworkPolicyError);
  });

  it('accepts redirects that stay inside the granted site', async () => {
    chromeMock().granted.add('*://*.example.com/*');
    fetchMock.mockResolvedValue(respond('ok', { url: 'https://example.com/a/' }));
    await expect(guardedFetch('http://www.example.com/a', 'page')).resolves.toBeInstanceOf(Response);
  });

  it('rejects a Wayback response that ended up on another origin', async () => {
    fetchMock.mockResolvedValue(respond('x', { url: 'https://elsewhere.example/' }));
    await expect(guardedFetch('https://web.archive.org/web/2020id_/https://a.example/', 'wayback')).rejects.toBeInstanceOf(NetworkPolicyError);
  });
});

describe('site permissions', () => {
  it('derives one pattern per site', () => {
    expect(patternsFor(['https://www.a.example/x', 'http://a.example/y', 'https://b.example/', 'mailto:x@y.z'])).toEqual([
      '*://*.a.example/*',
      '*://*.b.example/*',
    ]);
    expect(describeSites(['https://www.b.example/x', 'https://a.example/'])).toEqual(['a.example', 'b.example']);
  });

  it('asks only for sites that are not granted yet', async () => {
    chromeMock().granted.add('*://*.a.example/*');
    expect(await hasAccess('https://a.example/x')).toBe(true);
    expect(await missingAccess(['https://a.example/x', 'https://b.example/y'])).toEqual(['*://*.b.example/*']);
    expect(await requestAccess(['https://a.example/x', 'https://b.example/y'])).toBe(true);
    expect(chromeMock().requested).toEqual([['*://*.b.example/*']]);
  });

  it('does not prompt at all when everything is already granted', async () => {
    chromeMock().granted.add('*://*.a.example/*');
    expect(await requestAccess(['https://www.a.example/'])).toBe(true);
    expect(chromeMock().requested).toEqual([]);
  });

  it('reports a declined prompt', async () => {
    chromeMock().requestAnswer = false;
    expect(await requestAccess(['https://c.example/'])).toBe(false);
    expect(await hasAccess('https://c.example/')).toBe(false);
  });

  it('lists and revokes run-time grants, hiding built-in hosts', async () => {
    chromeMock().granted.add('*://*.a.example/*');
    chromeMock().granted.add('*://*.b.example/*');
    expect(await grantedSites()).toEqual(['*://*.a.example/*', '*://*.b.example/*']);
    await revokeSites(['*://*.a.example/*']);
    expect(await grantedSites()).toEqual(['*://*.b.example/*']);
  });
});

describe('fetchPage', () => {
  beforeEach(() => {
    chromeMock().granted.add('*://*.example.com/*');
  });

  it('returns HTML for a granted page', async () => {
    fetchMock.mockResolvedValue(respond('<title>Hi</title>', { url: 'https://example.com/' }));
    expect(await fetchPage('https://example.com/')).toMatchObject({ ok: true, status: 200, html: '<title>Hi</title>', error: null });
  });

  it('flags a missing permission instead of throwing', async () => {
    expect(await fetchPage('https://nope.example.org/')).toMatchObject({ ok: false, needsPermission: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports HTTP errors, non-HTML content and network failures as data', async () => {
    fetchMock.mockResolvedValueOnce(respond('gone', { status: 404, url: 'https://example.com/x' }));
    expect(await fetchPage('https://example.com/x')).toMatchObject({ ok: false, status: 404, error: 'The site answered 404' });
    fetchMock.mockResolvedValueOnce(respond('%PDF', { url: 'https://example.com/f.pdf', headers: { 'content-type': 'application/pdf' } }));
    expect((await fetchPage('https://example.com/f.pdf')).error).toMatch(/Not an HTML page/);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await fetchPage('https://example.com/y')).toMatchObject({ ok: false, error: 'Could not reach the site' });
    expect(await fetchPage('javascript:alert(1)')).toMatchObject({ ok: false, error: 'Not a web address' });
  });

  it('caps the amount of HTML it reads', async () => {
    fetchMock.mockResolvedValue(respond('a'.repeat(5000), { url: 'https://example.com/big' }));
    const page = await fetchPage('https://example.com/big', { maxBytes: 1000 });
    expect(page.ok).toBe(true);
    expect(page.html).toHaveLength(1000);
  });

  it('decodes using the declared charset', () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    expect(decodeHtml(latin1, 'text/html; charset=iso-8859-1')).toBe('café');
    const meta = new TextEncoder().encode('<meta charset="utf-8"><p>é</p>');
    expect(decodeHtml(meta, null)).toContain('é');
    expect(decodeHtml(new TextEncoder().encode('x'), 'text/html; charset=not-a-charset')).toBe('x');
  });
});
