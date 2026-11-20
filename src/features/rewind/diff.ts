/**
 * Rewind's differ: what changed between two captures of a page, as a dated
 * timeline of changes between consecutive distinct captures and as a
 * two-date comparison.
 */
import type { PageFacts } from '@/extract/page-facts';
import { formatInt } from '@/lib/text';
import { formatCaptureDate, type Capture } from './cdx';

export type FieldKey = keyof PageFacts;

export const FIELD_LABELS: Readonly<Record<FieldKey, string>> = {
  title: 'Title',
  metaDescription: 'Meta description',
  canonical: 'Canonical',
  metaRobots: 'Meta robots',
  h1: 'H1',
  h2: 'H2',
  h3: 'H3',
  wordCount: 'Main-content words',
  internalLinks: 'Internal links',
  externalLinks: 'External links',
  jsonLdTypes: 'JSON-LD types',
  hreflangCount: 'hreflang tags',
};

export const FIELD_ORDER: readonly FieldKey[] = [
  'title', 'metaDescription', 'canonical', 'metaRobots', 'h1', 'h2', 'h3',
  'wordCount', 'internalLinks', 'externalLinks', 'jsonLdTypes', 'hreflangCount',
];

export interface CaptureFacts {
  capture: Capture;
  facts: PageFacts;
}

export type FieldChange =
  | { field: FieldKey; label: string; kind: 'text'; before: string | null; after: string | null; significant: boolean; summary: string }
  | { field: FieldKey; label: string; kind: 'list'; before: string[]; after: string[]; added: string[]; removed: string[]; significant: boolean; summary: string }
  | { field: FieldKey; label: string; kind: 'number'; before: number; after: number; delta: number; significant: boolean; summary: string };

export interface TimelineEntry {
  from: CaptureFacts;
  to: CaptureFacts;
  changes: FieldChange[];
}

const TEXT_FIELDS: readonly FieldKey[] = ['title', 'metaDescription', 'canonical', 'metaRobots'];
const LIST_FIELDS: readonly FieldKey[] = ['h1', 'h2', 'h3', 'jsonLdTypes'];

function quote(value: string | null): string {
  return value === null || value === '' ? '(none)' : `“${value}”`;
}

/** Items in `after` that are not in `before` (and vice versa), respecting how many times each occurs. */
function listDelta(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const remaining = new Map<string, number>();
  for (const item of before) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  const added: string[] = [];
  for (const item of after) {
    const n = remaining.get(item) ?? 0;
    if (n > 0) remaining.set(item, n - 1);
    else added.push(item);
  }
  const removed: string[] = [];
  for (const item of before) {
    const n = remaining.get(item) ?? 0;
    if (n > 0) {
      removed.push(item);
      remaining.set(item, n - 1);
    }
  }
  return { added, removed };
}

/** Small counting changes are noise (a nav link added, a sentence reworded); large ones are flagged. */
function numberIsSignificant(field: FieldKey, before: number, after: number): boolean {
  const delta = Math.abs(after - before);
  if (field === 'hreflangCount') return delta > 0;
  if (field === 'wordCount') return delta >= Math.max(30, before * 0.05);
  return delta >= Math.max(3, before * 0.1);
}

export function diffFacts(before: PageFacts, after: PageFacts): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of FIELD_ORDER) {
    const label = FIELD_LABELS[field];
    if (TEXT_FIELDS.includes(field)) {
      const a = before[field] as string | null;
      const b = after[field] as string | null;
      if (a === b) continue;
      const summary =
        a === null ? `${label} added: ${quote(b)}` : b === null ? `${label} removed (was ${quote(a)})` : `${label} changed from ${quote(a)} to ${quote(b)}`;
      changes.push({ field, label, kind: 'text', before: a, after: b, significant: true, summary });
    } else if (LIST_FIELDS.includes(field)) {
      const a = before[field] as string[];
      const b = after[field] as string[];
      const { added, removed } = listDelta(a, b);
      if (added.length === 0 && removed.length === 0) continue;
      const parts: string[] = [];
      if (added.length > 0) parts.push(`added ${added.map(quote).join(', ')}`);
      if (removed.length > 0) parts.push(`removed ${removed.map(quote).join(', ')}`);
      changes.push({ field, label, kind: 'list', before: a, after: b, added, removed, significant: true, summary: `${label}: ${parts.join('; ')}` });
    } else {
      const a = before[field] as number;
      const b = after[field] as number;
      if (a === b) continue;
      const delta = b - a;
      const percent = a > 0 ? ` (${delta > 0 ? '+' : ''}${Math.round((delta / a) * 100)}%)` : '';
      changes.push({
        field,
        label,
        kind: 'number',
        before: a,
        after: b,
        delta,
        significant: numberIsSignificant(field, a, b),
        summary: `${label}: ${formatInt(a)} → ${formatInt(b)}${percent}`,
      });
    }
  }
  return changes;
}

/**
 * Changes between consecutive captures, oldest first. Captures whose
 * extracted facts are identical to the previous one produce no entry, so the
 * timeline only contains captures that are actually distinct.
 */
export function buildTimeline(captures: readonly CaptureFacts[]): TimelineEntry[] {
  const ordered = [...captures].sort((a, b) => a.capture.time - b.capture.time);
  const entries: TimelineEntry[] = [];
  let previous = ordered[0];
  for (const current of ordered.slice(1)) {
    const changes = diffFacts(previous!.facts, current.facts);
    if (changes.length > 0) {
      entries.push({ from: previous!, to: current, changes });
      previous = current;
    }
  }
  return entries;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Changes in the N days before [date]": entries whose newer capture falls in
 * the window that ends on `date` (inclusive, whole UTC day). The change
 * happened some time between the two captures of each entry.
 */
export function changesBefore(timeline: readonly TimelineEntry[], date: number, days: number): TimelineEntry[] {
  const dayStart = Math.floor(date / DAY_MS) * DAY_MS;
  const end = dayStart + DAY_MS - 1;
  const start = dayStart - Math.max(0, days) * DAY_MS;
  return timeline.filter((entry) => entry.to.capture.time >= start && entry.to.capture.time <= end);
}

export type DiffToken = { type: 'same' | 'added' | 'removed'; text: string };

/** Word-level diff (longest common subsequence) for the two-date view. */
export function wordDiff(before: string, after: string): DiffToken[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  if (a.length * b.length > 250_000) {
    return [
      ...(before ? [{ type: 'removed' as const, text: before }] : []),
      ...(after ? [{ type: 'added' as const, text: after }] : []),
    ];
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1]! + 1 : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const tokens: DiffToken[] = [];
  const push = (type: DiffToken['type'], word: string): void => {
    const last = tokens[tokens.length - 1];
    if (last && last.type === type) last.text += ` ${word}`;
    else tokens.push({ type, text: word });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]!);
      i++;
      j++;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      push('removed', a[i]!);
      i++;
    } else {
      push('added', b[j]!);
      j++;
    }
  }
  while (i < a.length) push('removed', a[i++]!);
  while (j < b.length) push('added', b[j++]!);
  return tokens;
}

/** Deterministic plain-language summary (the no-AI provider). */
export function explainTimeline(timeline: readonly TimelineEntry[], captureCount: number): string[] {
  if (captureCount === 0) return ['The Wayback Machine has no captures of this page.'];
  if (captureCount === 1) return ['Only one capture exists, so there is nothing to compare yet.'];
  if (timeline.length === 0) return [`No on-page changes were found across the ${captureCount} captures that were read.`];
  const lines = [
    `${timeline.length} change${timeline.length === 1 ? '' : 's'} found across ${captureCount} captures, from ${formatCaptureDate(timeline[0]!.from.capture.time)} to ${formatCaptureDate(timeline[timeline.length - 1]!.to.capture.time)}.`,
  ];
  const risky = timeline.flatMap((entry) =>
    entry.changes
      .filter((c) => (c.field === 'metaRobots' && c.kind === 'text' && /noindex/.test(c.after ?? '')) || c.field === 'canonical')
      .map((c) => `${formatCaptureDate(entry.to.capture.time)}: ${c.summary}`),
  );
  if (risky.length > 0) lines.push(`Indexing-related changes: ${risky.join(' · ')}.`);
  const biggestDrop = timeline
    .flatMap((entry) => entry.changes.filter((c) => c.kind === 'number' && c.field === 'wordCount' && c.delta < 0).map((c) => ({ entry, c })))
    .sort((x, y) => (x.c.kind === 'number' && y.c.kind === 'number' ? x.c.delta - y.c.delta : 0))[0];
  if (biggestDrop && biggestDrop.c.kind === 'number' && biggestDrop.c.significant) {
    lines.push(
      `Largest content cut: ${formatInt(-biggestDrop.c.delta)} words removed between ${formatCaptureDate(biggestDrop.entry.from.capture.time)} and ${formatCaptureDate(biggestDrop.entry.to.capture.time)}.`,
    );
  }
  const last = timeline[timeline.length - 1]!;
  lines.push(`Most recent change (by ${formatCaptureDate(last.to.capture.time)}): ${last.changes.map((c) => c.summary).join('; ')}.`);
  return lines;
}
