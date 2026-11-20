/** Text helpers shared by the extractors, the classifier and the brief composer. */

export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being below between both but by can ' +
    'could did do does doing down during each few for from further had has have having he her here hers herself him himself his ' +
    'how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves ' +
    'out over own same she should so some such than that the their theirs them themselves then there these they this those ' +
    'through to too under until up very was we were what when where which while who whom why will with would you your yours ' +
    'yourself yourselves also may might must shall us via per'
  ).split(' '),
);

/** Unicode-aware word tokens, lower-cased. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
}

export function countWords(text: string): number {
  return tokenize(text).length;
}

/**
 * Light stemming so "cleanings", "cleaned" and "cleaning" compare equal.
 * Deliberately simple and deterministic: plural, then -ly, -ing/-ed, then a final e.
 */
export function stem(token: string): string {
  let t = token.replace(/['’]s$/, '');
  if (t.length > 4 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
  else if (t.length > 4 && /(ss|x|ch|sh|z)es$/.test(t)) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (t.length > 6 && t.endsWith('ally')) t = t.slice(0, -2);
  else if (t.length > 5 && t.endsWith('ly')) t = t.slice(0, -2);
  if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
  if (t.length > 4 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

/** Content tokens: stop words removed, stemmed. */
export function contentTokens(text: string): string[] {
  const out: string[] = [];
  for (const token of tokenize(text)) {
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    out.push(stem(token));
  }
  return out;
}

const ABBREVIATIONS = /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|inc|ltd|co|corp|no|fig|approx|dept|est|e\.g|i\.e|u\.s|u\.k)\.)$/i;

/**
 * Splits text into sentences. Uses Intl.Segmenter when the runtime has it
 * (Chrome does) and a punctuation-based fallback otherwise, so results are
 * the same shape everywhere.
 */
export function splitSentences(text: string): string[] {
  const normalised = text.replace(/\s+/g, ' ').trim();
  if (!normalised) return [];
  const Segmenter = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  let parts: string[];
  if (typeof Segmenter === 'function') {
    parts = [...new Segmenter('en', { granularity: 'sentence' }).segment(normalised)].map((s) => s.segment);
  } else {
    parts = normalised.split(/(?<=[.!?…]["')\]]?)\s+(?=["'(\[]?[\p{Lu}\p{N}])/u);
  }
  // Re-join pieces that were split after an abbreviation ("Dr. Smith").
  const sentences: string[] = [];
  for (const part of parts) {
    const piece = part.trim();
    if (!piece) continue;
    const previous = sentences[sentences.length - 1];
    if (previous !== undefined && ABBREVIATIONS.test(previous)) {
      sentences[sentences.length - 1] = `${previous} ${piece}`;
    } else {
      sentences.push(piece);
    }
  }
  return sentences;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "1,240" style integer formatting, independent of the user's locale so exports are stable. */
export function formatInt(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function formatPercent(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatInt(count)} ${count === 1 ? singular : plural}`;
}

/** Title-cases a short phrase for labels ("emergency plumbing" → "Emergency Plumbing"). */
export function titleCase(value: string): string {
  return value.replace(/(^|[\s-])(\p{L})/gu, (_m, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`);
}

export function uniqueBy<T>(items: Iterable<T>, key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
