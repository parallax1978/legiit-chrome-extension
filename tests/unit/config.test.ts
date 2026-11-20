import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEGIIT_API_BASE_URL,
  PRODUCT_NAME,
  REQUIRE_ACCOUNT_AFTER_FREE_RUNS,
  SINGLE_PURPOSE,
} from '@/config/constants';
import { GOOGLE_SEARCH_DOMAINS } from '@/config/google-domains';
import { AI_SITE_MATCHES, AI_SITES, aiSiteForHost, GOOGLE_SEARCH_MATCHES, isGoogleSearchHost } from '@/config/sites';

describe('product constants', () => {
  it('uses the agreed name and single-purpose statement', () => {
    expect(PRODUCT_NAME).toBe('Legiit Lens');
    expect(SINGLE_PURPOSE).toBe(
      'Shows how visible a web page or brand is in Google results and AI answers, and what explains it.',
    );
    // The manifest description doubles as the store summary: 132 characters at most.
    expect(SINGLE_PURPOSE.length).toBeLessThanOrEqual(132);
  });

  it('ships with account gating off', () => {
    expect(REQUIRE_ACCOUNT_AFTER_FREE_RUNS).toBe(false);
  });

  it('points the Legiit client at an https origin', () => {
    expect(new URL(DEFAULT_LEGIIT_API_BASE_URL).protocol).toBe('https:');
  });
});

describe('Google country domains', () => {
  it('lists every supported domain exactly once', () => {
    expect(GOOGLE_SEARCH_DOMAINS).toHaveLength(187);
    expect(new Set(GOOGLE_SEARCH_DOMAINS).size).toBe(GOOGLE_SEARCH_DOMAINS.length);
    for (const domain of GOOGLE_SEARCH_DOMAINS) expect(domain).toMatch(/^google\.[a-z]{2,3}(\.[a-z]{2})?$/);
    for (const expected of ['google.com', 'google.co.uk', 'google.de', 'google.com.au', 'google.co.jp', 'google.cat']) {
      expect(GOOGLE_SEARCH_DOMAINS).toContain(expected);
    }
  });

  it('turns each domain into one explicit match pattern with no TLD wildcard', () => {
    expect(GOOGLE_SEARCH_MATCHES).toHaveLength(GOOGLE_SEARCH_DOMAINS.length);
    for (const pattern of GOOGLE_SEARCH_MATCHES) {
      expect(pattern).toMatch(/^https:\/\/www\.google\.[a-z.]+\/search\*$/);
      expect(pattern.slice('https://'.length, pattern.indexOf('/search'))).not.toContain('*');
    }
  });

  it('recognises Google search hosts', () => {
    expect(isGoogleSearchHost('www.google.com')).toBe(true);
    expect(isGoogleSearchHost('www.google.co.uk')).toBe(true);
    expect(isGoogleSearchHost('gemini.google.com')).toBe(false);
    expect(isGoogleSearchHost('www.google.evil.example')).toBe(false);
  });
});

describe('AI sites', () => {
  it('covers exactly the four sites in the brief', () => {
    expect(Object.keys(AI_SITES).sort()).toEqual(['chatgpt', 'copilot', 'gemini', 'perplexity']);
    expect(AI_SITE_MATCHES.sort()).toEqual([
      'https://chatgpt.com/*',
      'https://copilot.microsoft.com/*',
      'https://gemini.google.com/*',
      'https://perplexity.ai/*',
      'https://www.perplexity.ai/*',
    ]);
  });

  it('maps hosts to sites', () => {
    expect(aiSiteForHost('chatgpt.com')).toBe('chatgpt');
    expect(aiSiteForHost('WWW.PERPLEXITY.AI')).toBe('perplexity');
    expect(aiSiteForHost('copilot.microsoft.com')).toBe('copilot');
    expect(aiSiteForHost('example.com')).toBeNull();
  });
});
