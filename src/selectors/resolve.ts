import type { SelectorCandidate, SelectorPack, SelectorSlot, SlotMatch } from './types';

const MAX_TEXT_PROBE = 200;
const regexCache = new Map<string, RegExp | null>();

function compile(source: string): RegExp | null {
  if (regexCache.has(source)) return regexCache.get(source) ?? null;
  let regex: RegExp | null = null;
  if (source.length <= 600) {
    try {
      regex = new RegExp(source, 'iu');
    } catch {
      regex = null;
    }
  }
  regexCache.set(source, regex);
  return regex;
}

/** The short text a heading-style element shows: its own text, or its aria-label. */
function probeText(el: Element): string {
  const label = el.getAttribute('aria-label');
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text && text.length <= MAX_TEXT_PROBE) return text;
  return label ? label.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_PROBE) : '';
}

export function describeCandidate(candidate: SelectorCandidate): string {
  let out = candidate.css;
  if (candidate.text) out += `  text~/${candidate.text}/i`;
  if (candidate.closest) out += `  ↑ ${candidate.closest}`;
  return out.slice(0, 240);
}

/** Elements matched by one candidate, in document order, without duplicates. */
export function matchCandidate(root: ParentNode, candidate: SelectorCandidate): Element[] {
  let found: Element[];
  try {
    found = Array.from(root.querySelectorAll(candidate.css));
  } catch {
    return []; // An invalid selector in a pack must never break the page.
  }
  if (candidate.text) {
    const regex = compile(candidate.text);
    if (!regex) return [];
    found = found.filter((el) => regex.test(probeText(el)));
  }
  if (candidate.closest) {
    const mapped: Element[] = [];
    for (const el of found) {
      try {
        const up = el.closest(candidate.closest);
        if (up) mapped.push(up);
      } catch {
        return [];
      }
    }
    found = mapped;
  }
  return [...new Set(found)];
}

export function resolveSlot(root: ParentNode, slot: SelectorSlot | undefined): SlotMatch {
  if (slot) {
    for (let i = 0; i < slot.candidates.length; i++) {
      const candidate = slot.candidates[i]!;
      const elements = matchCandidate(root, candidate);
      if (elements.length > 0) return { elements, candidateIndex: i, candidate: describeCandidate(candidate) };
    }
  }
  return { elements: [], candidateIndex: -1, candidate: null };
}

export function resolve(root: ParentNode, pack: SelectorPack, slotName: string): SlotMatch {
  return resolveSlot(root, pack.slots[slotName]);
}

/** Drops elements that sit inside another element of the same list. */
export function outermost(elements: readonly Element[]): Element[] {
  return elements.filter((el) => !elements.some((other) => other !== el && other.contains(el)));
}

export interface SlotHealth {
  slot: string;
  required: boolean;
  matched: number;
  candidate: string | null;
  candidateIndex: number;
  candidates: number;
}

/** Runs every slot of a pack against a document. Powers the selector health-check page. */
export function selectorHealth(root: ParentNode, pack: SelectorPack): SlotHealth[] {
  return Object.entries(pack.slots).map(([name, slot]) => {
    const match = resolveSlot(root, slot);
    return {
      slot: name,
      required: slot.required === true,
      matched: match.elements.length,
      candidate: match.candidate,
      candidateIndex: match.candidateIndex,
      candidates: slot.candidates.length,
    };
  });
}

/** Structural validation for packs loaded from storage (overrides). Returns null when unusable. */
export function validatePack(value: unknown, expectedSite?: string): SelectorPack | null {
  if (typeof value !== 'object' || value === null) return null;
  const pack = value as Partial<SelectorPack>;
  if (typeof pack.site !== 'string' || typeof pack.version !== 'string') return null;
  if (expectedSite && pack.site !== expectedSite) return null;
  if (typeof pack.slots !== 'object' || pack.slots === null) return null;
  const slots: Record<string, SelectorSlot> = {};
  const entries = Object.entries(pack.slots as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 100) return null;
  for (const [name, raw] of entries) {
    if (typeof raw !== 'object' || raw === null) return null;
    const slot = raw as Partial<SelectorSlot>;
    if (!Array.isArray(slot.candidates) || slot.candidates.length > 30) return null;
    const candidates: SelectorCandidate[] = [];
    for (const c of slot.candidates as unknown[]) {
      if (typeof c !== 'object' || c === null) return null;
      const cand = c as Partial<SelectorCandidate>;
      if (typeof cand.css !== 'string' || cand.css.length === 0 || cand.css.length > 600) return null;
      if (cand.text !== undefined && (typeof cand.text !== 'string' || cand.text.length > 600)) return null;
      if (cand.closest !== undefined && (typeof cand.closest !== 'string' || cand.closest.length > 600)) return null;
      candidates.push({
        css: cand.css,
        ...(cand.text !== undefined ? { text: cand.text } : {}),
        ...(cand.closest !== undefined ? { closest: cand.closest } : {}),
      });
    }
    slots[name.slice(0, 80)] = { required: slot.required === true, candidates };
  }
  return {
    site: pack.site.slice(0, 40),
    version: pack.version.slice(0, 40),
    updated: typeof pack.updated === 'string' ? pack.updated.slice(0, 40) : '',
    slots,
  };
}

/** Compares "YYYY.MM.DD-n" style versions. Positive when a is newer. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.\-_]/).map((p) => Number.parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
