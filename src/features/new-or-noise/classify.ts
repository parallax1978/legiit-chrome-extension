/**
 * New or Noise: which sentences of a page say what the competing pages
 * already say, and which are found only here.
 *
 * Method (also shown in the UI and in docs/ARCHITECTURE.md):
 *  1. Every sentence of the page and of each comparison page is encoded by
 *     the similarity engine.
 *  2. A comparison page "says" a sentence when its best-matching sentence
 *     reaches the engine's same-point threshold (max cosine similarity).
 *  3. The sentence is "said by most" when more than half of the comparison
 *     pages say it, "said by some" when at least one does, "only here" when
 *     none does.
 */
import { bestMatch, type EncodeOptions, type SimilarityEngine, type Vectors } from '@/similarity/engine';
import type { SentenceUnit } from './sentences';

export type SentenceClass = 'most' | 'some' | 'only';

export const CLASS_LABELS: Readonly<Record<SentenceClass, string>> = {
  most: 'Said by most',
  some: 'Said by some',
  only: 'Only here',
};

export interface ComparisonPage {
  url: string;
  title: string;
  sentences: SentenceUnit[];
}

export interface ClassifiedSentence {
  text: string;
  words: number;
  cls: SentenceClass;
  /** How many comparison pages say this. */
  pages: number;
  /** Highest similarity to any comparison sentence. */
  bestScore: number;
  /** The closest comparison sentence, when one reaches the threshold. */
  closest: { url: string; text: string } | null;
}

export interface MissingPoint {
  /** A representative sentence from a comparison page. */
  text: string;
  /** How many comparison pages make this point. */
  pages: number;
  urls: string[];
}

export interface NoiseReport {
  engine: SimilarityEngine['kind'];
  engineLabel: string;
  threshold: number;
  pagesCompared: number;
  /** Pages needed for "said by most": more than half. */
  mostNeeds: number;
  sentences: ClassifiedSentence[];
  totalWords: number;
  /** Words in each class, and their share of all classified words. */
  words: Record<SentenceClass, number>;
  share: Record<SentenceClass, number>;
  /** Points most comparison pages make that this page does not. */
  missing: MissingPoint[];
}

export const MAX_MISSING_POINTS = 12;

/** "More than half" of n pages. */
export function mostThreshold(pageCount: number): number {
  return Math.floor(pageCount / 2) + 1;
}

export function classOf(pages: number, pageCount: number): SentenceClass {
  if (pages <= 0) return 'only';
  return pages >= mostThreshold(pageCount) ? 'most' : 'some';
}

/** Lets the UI paint between chunks of similarity maths. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function classifySentences(
  target: readonly SentenceUnit[],
  pages: readonly ComparisonPage[],
  engine: SimilarityEngine,
  options: EncodeOptions = {},
): Promise<NoiseReport> {
  const usable = pages.filter((p) => p.sentences.length > 0);
  const groups = [target.map((s) => s.text), ...usable.map((p) => p.sentences.map((s) => s.text))];
  const vectors = await engine.encodeGroups(groups, options);
  const targetVectors = vectors[0]!;
  const pageVectors = vectors.slice(1);
  const threshold = engine.sameThreshold;
  const pageCount = usable.length;

  const sentences: ClassifiedSentence[] = target.map((sentence, i) => {
    let matched = 0;
    let bestScore = 0;
    let closest: ClassifiedSentence['closest'] = null;
    pageVectors.forEach((pv, p) => {
      const best = bestMatch(targetVectors, i, pv);
      if (best.score >= threshold) matched++;
      if (best.score > bestScore) {
        bestScore = best.score;
        closest = best.score >= threshold && best.index >= 0 ? { url: usable[p]!.url, text: usable[p]!.sentences[best.index]!.text } : closest;
      }
    });
    return { text: sentence.text, words: sentence.words, cls: classOf(matched, pageCount), pages: matched, bestScore, closest };
  });

  const words: Record<SentenceClass, number> = { most: 0, some: 0, only: 0 };
  for (const s of sentences) words[s.cls] += s.words;
  const totalWords = words.most + words.some + words.only;
  const share: Record<SentenceClass, number> = {
    most: totalWords ? words.most / totalWords : 0,
    some: totalWords ? words.some / totalWords : 0,
    only: totalWords ? words.only / totalWords : 0,
  };

  const missing = await findMissingPoints(targetVectors, usable, pageVectors, threshold, options.signal);

  return {
    engine: engine.kind,
    engineLabel: engine.label,
    threshold,
    pagesCompared: pageCount,
    mostNeeds: mostThreshold(pageCount),
    sentences,
    totalWords,
    words,
    share,
    missing,
  };
}

interface Candidate {
  page: number;
  index: number;
  pages: Set<number>;
  /** Sum of best similarities across pages: prefers the most central wording. */
  centrality: number;
}

/**
 * Points made by more than half of the comparison pages that no sentence of
 * the target page matches. Near-duplicates are folded into one representative.
 */
async function findMissingPoints(
  targetVectors: Vectors,
  pages: readonly ComparisonPage[],
  pageVectors: readonly Vectors[],
  threshold: number,
  signal?: AbortSignal,
): Promise<MissingPoint[]> {
  const needed = mostThreshold(pages.length);
  if (pages.length < 2) return [];
  const candidates: Candidate[] = [];

  for (let p = 0; p < pages.length; p++) {
    const pv = pageVectors[p]!;
    for (let i = 0; i < pv.count; i++) {
      // Already covered by the target page?
      if (bestMatch(pv, i, targetVectors).score >= threshold) continue;
      const covering = new Set<number>([p]);
      let centrality = 1;
      for (let q = 0; q < pages.length; q++) {
        if (q === p) continue;
        const best = bestMatch(pv, i, pageVectors[q]!);
        if (best.score >= threshold) {
          covering.add(q);
          centrality += best.score;
        }
      }
      if (covering.size >= needed) candidates.push({ page: p, index: i, pages: covering, centrality });
    }
    if (signal?.aborted) return [];
    await yieldToUi();
  }

  candidates.sort((a, b) => b.pages.size - a.pages.size || b.centrality - a.centrality);
  const chosen: Candidate[] = [];
  for (const candidate of candidates) {
    const duplicate = chosen.some(
      (c) => pageVectors[candidate.page]!.similarity(candidate.index, pageVectors[c.page]!, c.index) >= threshold,
    );
    if (!duplicate) chosen.push(candidate);
    if (chosen.length >= MAX_MISSING_POINTS) break;
  }

  return chosen.map((c) => ({
    text: pages[c.page]!.sentences[c.index]!.text,
    pages: c.pages.size,
    urls: [...c.pages].sort((a, b) => a - b).map((p) => pages[p]!.url),
  }));
}

/** Deterministic plain-language summary (the no-AI provider). */
export function explainNoise(report: NoiseReport): string[] {
  if (report.pagesCompared === 0) return ['No comparison pages could be read, so nothing could be classified.'];
  if (report.sentences.length === 0) return ['No sentences of five words or more were found on this page.'];
  const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;
  const lines = [
    `${pct(report.share.only)} of this page's words are only here; ${pct(report.share.most)} repeat what most of the ${report.pagesCompared} comparison pages say and ${pct(report.share.some)} what some of them say.`,
  ];
  const unique = report.sentences.filter((s) => s.cls === 'only');
  if (unique.length > 0) lines.push(`Found only on this page: “${unique[0]!.text}”${unique.length > 1 ? ` and ${unique.length - 1} more.` : ''}`);
  else lines.push('Nothing on this page is unique to it: every sentence has a close match on a competing page.');
  if (report.missing.length > 0) {
    lines.push(
      `${report.missing.length} point${report.missing.length === 1 ? '' : 's'} most competing pages cover that this page does not, for example: “${report.missing[0]!.text}”`,
    );
  } else if (report.pagesCompared >= 2) {
    lines.push('This page covers every point that most competing pages make.');
  }
  if (report.engine === 'lexical') {
    lines.push('The on-device model was not available, so sentences were compared by shared words. Paraphrases may be missed.');
  }
  return lines;
}
