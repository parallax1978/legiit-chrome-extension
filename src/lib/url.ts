import { safeHttpUrl, stripWww } from './sanitize';

/** Query parameters that only track clicks. Removed for display, de-duplication and fetching. */
const TRACKING_PARAMS = /^(utm_[a-z_]+|gclid|gclsrc|gbraid|wbraid|gad_source|gad_campaignid|dclid|fbclid|msclkid|yclid|ttclid|twclid|li_fat_id|srsltid|ved|usg|sa|ei|mc_cid|mc_eid|mkt_tok|_hsenc|_hsmi|_gl|_ga|igshid|ref_src)$/i;

/** Removes tracking parameters and scroll-to-text fragments. Returns null for non-http(s) input. */
export function cleanUrl(value: string, base?: string): string | null {
  const safe = safeHttpUrl(value, base);
  if (!safe) return null;
  const url = new URL(safe);
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  if (url.hash.includes(':~:')) {
    const fragment = url.hash.split(':~:')[0] ?? '';
    url.hash = fragment === '#' ? '' : fragment;
  }
  return url.href;
}

/**
 * Google wraps some result links (/url?q=…, /url?url=…). Returns the real
 * destination, cleaned, or null if the link is not an http(s) URL.
 */
export function unwrapGoogleUrl(href: string, base: string): string | null {
  const safe = safeHttpUrl(href, base);
  if (!safe) return null;
  const url = new URL(safe);
  if (isGoogleNavHost(url.hostname) && (url.pathname === '/url' || url.pathname === '/interstitial')) {
    const target = url.searchParams.get('q') ?? url.searchParams.get('url');
    return target ? cleanUrl(target) : null;
  }
  if (isGoogleInfraHost(url.hostname)) {
    // Ad click redirects carry the landing page in "adurl".
    const target = url.searchParams.get('adurl');
    return target ? cleanUrl(target) : null;
  }
  return cleanUrl(url.href);
}

/** Google's own navigation hosts: search, maps, accounts, help. Links to them are UI, not results. */
export function isGoogleNavHost(host: string): boolean {
  return /^(?:(?:www|maps|accounts|policies|support|myaccount|myactivity|consent|lens|images)\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(
    host.toLowerCase(),
  );
}

/** Redirect, ad-serving and static-asset hosts that never are a destination page. */
export function isGoogleInfraHost(host: string): boolean {
  return (
    /(^|\.)(googleadservices|googleusercontent|gstatic|googlesyndication|doubleclick|google-analytics|googleapis|googletagmanager|ggpht)\.(com|net)$/.test(
      host.toLowerCase(),
    ) || /^(g\.co|goo\.gl)$/.test(host.toLowerCase())
  );
}

/** Stable key for de-duplicating URLs that differ only by scheme, www, trailing slash or tracking. */
export function urlKey(value: string): string {
  const cleaned = cleanUrl(value);
  if (!cleaned) return value.trim().toLowerCase();
  const url = new URL(cleaned);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `${stripWww(url.hostname)}${path}${url.search}`.toLowerCase();
}

/**
 * The host-permission pattern requested for a URL: the site and its
 * subdomains, both schemes (so http→https and www redirects stay inside the
 * grant). "https://www.example.com/a" → "*://*.example.com/*".
 */
export function originPatternFor(value: string): string | null {
  const safe = safeHttpUrl(value);
  if (!safe) return null;
  const host = stripWww(new URL(safe).hostname);
  if (!host) return null;
  // IP addresses and single-label hosts cannot take a subdomain wildcard.
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return `*://${host}/*`;
  return `*://*.${host}/*`;
}

/** Human-readable site name for a host-permission pattern. */
export function siteOfPattern(pattern: string): string {
  return pattern
    .replace(/^[^:]+:\/\//, '')
    .replace(/^\*\./, '')
    .replace(/\/\*$/, '');
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** True when `host` is `domain` or one of its subdomains. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = stripWww(host);
  const d = stripWww(domain);
  return h === d || h.endsWith(`.${d}`);
}
