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

/**
 * Google can hide where a result link leads: the link goes to Google's own redirect with a token that only Google
 * can read (https://www.google.com/goto?url=CAES…). True for such a link: the destination is not in the link at all.
 */
export function isHiddenGoogleRedirect(href: string, base: string): boolean {
  const safe = safeHttpUrl(href, base);
  if (!safe) return false;
  const url = new URL(safe);
  if (!isGoogleNavHost(url.hostname)) return false;
  if (url.pathname === '/goto') return true;
  if (url.pathname === '/url' || url.pathname === '/interstitial') {
    const target = url.searchParams.get('q') ?? url.searchParams.get('url');
    return target !== null && target !== '' && cleanUrl(target) === null;
  }
  return false;
}

const ADDRESS_HOST = /^(https?:\/\/)?[\p{L}\p{N}]([\p{L}\p{N}.-]*[\p{L}\p{N}])?\.[\p{L}]{2,24}(:\d{1,5})?\/?$/u;

/**
 * The site named by the address line that Google prints under a result's title
 * ("https://www.example.com › blog › post"), as an origin: "https://www.example.com". null for a line that does not
 * start with a site ("30+ comments · 1 year ago").
 *
 * Only the site is taken from the line. The parts after it are not the path of the page: Google shortens them,
 * leaves parts out, or prints the names of the site's own breadcrumb trail.
 */
export function siteOfAddressLine(text: string): string | null {
  const first = (text.replace(/\s+/g, ' ').trim().slice(0, 600).split(/\s*›\s*/)[0] ?? '').trim();
  if (!ADDRESS_HOST.test(first)) return null;
  const safe = safeHttpUrl(/^https?:\/\//i.test(first) ? first : `https://${first}`);
  return safe ? new URL(safe).origin : null;
}

/** A part of an address line that can be one segment of a path: no space, and not the "..." of a shortened line. */
const PATH_SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}._~%+,;=@:!$'()*-]{0,200}$/u;

/**
 * The page address that the line under a result's title spells out: "https://www.example.com › blog › post" reads
 * as https://www.example.com/blog/post. It is a guess, never a fact: Google shortens this line, leaves parts out,
 * or prints the names of the site's sections instead of the path. So the address counts only after the page that
 * answers there has been checked against the title of the result (see titlesAgree). null when the line names no
 * site, shows the site alone, or has a part that cannot be a path segment ("BuzzStream Blog", "...").
 */
export function pageOfAddressLine(text: string): string | null {
  const parts = text.replace(/\s+/g, ' ').trim().slice(0, 600).split(/\s*›\s*/).map((part) => part.trim());
  const site = siteOfAddressLine(parts[0] ?? '');
  const segments = parts.slice(1);
  if (!site || segments.length === 0 || segments.length > 12) return null;
  if (!segments.every((segment) => PATH_SEGMENT.test(segment) && !segment.endsWith('...') && !segment.includes('…'))) return null;
  return safeHttpUrl(`${site}/${segments.join('/')}`);
}

/**
 * The site whose icon Google shows: the address of the icon names it
 * (https://encrypted-tbn0.gstatic.com/faviconV2?url=https://www.example.com&size=32). null for any other image.
 */
export function siteOfIconUrl(src: string): string | null {
  const safe = safeHttpUrl(src);
  if (!safe) return null;
  const icon = new URL(safe);
  if (!/(^|\.)gstatic\.com$/.test(icon.hostname) || !icon.pathname.startsWith('/favicon')) return null;
  const named = safeHttpUrl(icon.searchParams.get('url') ?? '');
  return named ? new URL(named).origin : null;
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
