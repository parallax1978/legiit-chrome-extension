/**
 * For an AI answer and one of the pages it cites: the one or two passages of
 * the page that most resemble what the answer says.
 */
import type { ContentBlock } from '@/extract/blocks';
import { countWords, splitSentences } from '@/lib/text';
import { bestMatch, type EncodeOptions, type SimilarityEngine } from '@/similarity/engine';

export interface Passage {
  /** Text from the cited page. */
  text: string;
  /** Similarity to the closest sentence of the answer (0-1). */
  score: number;
  /** The sentence of the answer it resembles. */
  answerSentence: string;
}

const MIN_PASSAGE_WORDS = 8;
const MAX_PASSAGE_WORDS = 70;
const MAX_PASSAGES_PER_PAGE = 120;

/** Paragraph-sized chunks of a page. Long paragraphs are split into runs of sentences. */
export function passageCandidates(blocks: readonly ContentBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading') continue;
    const words = countWords(block.text);
    if (words < MIN_PASSAGE_WORDS) continue;
    if (words <= MAX_PASSAGE_WORDS) {
      out.push(block.text);
    } else {
      let run: string[] = [];
      let runWords = 0;
      for (const sentence of splitSentences(block.text)) {
        const n = countWords(sentence);
        if (runWords + n > MAX_PASSAGE_WORDS && run.length > 0) {
          out.push(run.join(' '));
          run = [];
          runWords = 0;
        }
        run.push(sentence);
        runWords += n;
      }
      if (runWords >= MIN_PASSAGE_WORDS) out.push(run.join(' '));
    }
    if (out.length >= MAX_PASSAGES_PER_PAGE) break;
  }
  return out;
}

export function answerSentences(answerText: string): string[] {
  return splitSentences(answerText.replace(/\n+/g, '. ').replace(/\.\s*\./g, '.')).filter((s) => countWords(s) >= 4).slice(0, 80);
}

/**
 * Returns, per page key, the best `perPage` passages at or above the engine's
 * passage threshold, best first. Pages with nothing similar get an empty list.
 */
export async function matchPassages(
  answerText: string,
  pages: readonly { key: string; blocks: readonly ContentBlock[] }[],
  engine: SimilarityEngine,
  perPage = 2,
  options: EncodeOptions = {},
): Promise<Map<string, Passage[]>> {
  const result = new Map<string, Passage[]>();
  const sentences = answerSentences(answerText);
  const candidates = pages.map((p) => passageCandidates(p.blocks));
  for (const p of pages) result.set(p.key, []);
  if (sentences.length === 0 || candidates.every((c) => c.length === 0)) return result;

  const [answerVectors, ...pageVectors] = await engine.encodeGroups([sentences, ...candidates], options);
  pages.forEach((page, p) => {
    const vectors = pageVectors[p]!;
    const scored: Passage[] = [];
    for (let i = 0; i < vectors.count; i++) {
      const best = bestMatch(vectors, i, answerVectors!);
      if (best.index >= 0 && best.score >= engine.passageThreshold) {
        scored.push({ text: candidates[p]![i]!, score: best.score, answerSentence: sentences[best.index]! });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    result.set(page.key, scored.slice(0, perPage));
  });
  return result;
}
