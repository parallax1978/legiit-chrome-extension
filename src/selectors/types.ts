/**
 * Selector packs: every Google and AI-site selector lives in one versioned
 * JSON file per site (src/selectors/*.json). A pack is data, not code — it
 * can be replaced by a validated override without shipping a new build.
 *
 * Each named slot lists candidates in priority order. The first candidate
 * that matches at least one element wins; the rest are fallbacks.
 */
export interface SelectorCandidate {
  /** CSS selector for the starting elements. */
  css: string;
  /**
   * Optional regular expression (case-insensitive) that the element's own
   * short text or aria-label must match. Used for heading-text fallbacks such
   * as "People also ask" when class names change.
   */
  text?: string;
  /** Optional selector: map every match to its closest matching ancestor (or itself). */
  closest?: string;
  /** Free-form note for maintainers. */
  note?: string;
}

export interface SelectorSlot {
  description?: string;
  /** Required slots are flagged by the health check when nothing matches. */
  required?: boolean;
  candidates: SelectorCandidate[];
}

export interface SelectorPack {
  site: string;
  /** Bump on every change. Format: YYYY.MM.DD-n */
  version: string;
  updated: string;
  description?: string;
  slots: Record<string, SelectorSlot>;
}

export interface SlotMatch {
  elements: Element[];
  /** Index of the winning candidate, or -1 when nothing matched. */
  candidateIndex: number;
  /** Human-readable description of the winning candidate. */
  candidate: string | null;
}
