/**
 * Upper bounds for everything the extension sends to Legiit.
 *
 * They are the maxLength / maxItems values of the request schemas in the API
 * contract (docs/legiit-api). The payload builders in ./payloads.ts enforce
 * them, so the backend can size columns and validation from the contract and
 * never receive more. tests/unit/legiit-api-kit.test.ts keeps code and
 * contract in step.
 *
 * Lengths are counted in UTF-16 code units (JavaScript string length). One
 * unit is at most 3 bytes in UTF-8.
 */
import { cutText } from '@/lib/sanitize';

export const LIMITS = {
  url: 2048,
  domain: 255,
  /** An email address (RFC 5321 allows 254 characters). */
  email: 254,
  /** Display name of a tracked brand or competitor (also the Settings limit). */
  brandName: 160,
  /** Domains of one brand or competitor. */
  brandDomains: 30,
  /** Largest pixel position (from the top of the document) and largest viewport side that are sent. */
  px: 10_000_000,
  viewport: 100_000,
  snapshot: {
    keyword: 500,
    location: 160,
    organic: 100,
    title: 400,
    tracked: 250,
    firstScreenShares: 12,
  },
  gapList: {
    source: 40,
    subject: 4000,
    rows: 1000,
    surface: 60,
    title: 1000,
    evidence: 2000,
    competitors: 200,
    contacts: 18,
    contactLabel: 300,
    /** Largest position inside a surface. */
    position: 1000,
  },
  contentEditor: {
    keyword: 500,
    title: 500,
    sentence: 600,
    onlyHere: 200,
    missingPoints: 12,
    urls: 8,
  },
  workspace: {
    businessName: 160,
    phones: 6,
    phone: 60,
    emails: 6,
    email: 320,
    addresses: 4,
    address: 240,
    serviceAreas: 16,
    serviceArea: 80,
    services: 20,
    service: 120,
    competitors: 200,
    focusKeywords: 30,
    focusKeyword: 200,
    avatars: 3,
    avatarName: 160,
    avatarDescription: 2000,
    briefId: 64,
    issues: 20,
    issueTitle: 300,
    issueDetail: 2000,
    issuePages: 8,
    nextSteps: 8,
    nextStep: 600,
    markdown: 200_000,
  },
  ai: {
    system: 2000,
    prompt: 10_000,
    /** A summary of 3 to 6 short lines. */
    maxOutputTokens: 700,
    /** A JSON document (the rewritten parts of a brief) needs more room: cut-off JSON cannot be used at all. */
    maxOutputTokensJson: 2000,
  },
} as const;

/**
 * No request body is larger than this (bytes of UTF-8). A body that would be
 * is not sent at all. 1 MB is the default request-size limit of nginx, so a
 * server needs no special configuration.
 */
export const MAX_REQUEST_BYTES = 1_048_576;

/** A reply larger than this is not read (bytes; a reply this size would be a mistake on the server). */
export const MAX_REPLY_BYTES = 5_000_000;

/** How long the extension waits for the complete reply before it gives up. */
export const TIMEOUT_MS = { default: 20_000, ai: 60_000 } as const;

/** Cuts text to a limit, marking the cut with an ellipsis. Never splits a surrogate pair. */
export function clip(value: string, max: number): string {
  return value.length > max ? `${cutText(value, max - 1).trimEnd()}…` : value;
}

/** Cuts an address at the limit. Addresses this long do not occur in practice; the limit is a guarantee for the server. */
export const clipUrl = (url: string): string => cutText(url, LIMITS.url);
export const clipDomain = (domain: string): string => cutText(domain, LIMITS.domain);
