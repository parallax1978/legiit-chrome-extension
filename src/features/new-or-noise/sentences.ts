/** Turns extracted page content into the sentences New or Noise compares. */
import type { MainContent } from '@/extract/main-content';
import { countWords, splitSentences } from '@/lib/text';

export interface SentenceUnit {
  text: string;
  words: number;
}

export interface SentenceOptions {
  /** Shorter fragments (menu labels, captions) are ignored. */
  minWords?: number;
  maxSentences?: number;
}

export const MIN_SENTENCE_WORDS = 5;
export const MAX_SENTENCES_PER_PAGE = 200;

/** Sentences from body text. Headings are skipped: they label a point, they do not make it. */
export function contentSentences(content: Pick<MainContent, 'blocks'>, options: SentenceOptions = {}): SentenceUnit[] {
  const minWords = options.minWords ?? MIN_SENTENCE_WORDS;
  const max = options.maxSentences ?? MAX_SENTENCES_PER_PAGE;
  const out: SentenceUnit[] = [];
  const seen = new Set<string>();
  for (const block of content.blocks) {
    if (block.kind === 'heading') continue;
    for (const sentence of splitSentences(block.text)) {
      const words = countWords(sentence);
      if (words < minWords) continue;
      const key = sentence.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: sentence.length > 600 ? sentence.slice(0, 600) : sentence, words });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Sentences from free text (a selection or pasted text). */
export function textSentences(text: string, options: SentenceOptions = {}): SentenceUnit[] {
  return contentSentences(
    { blocks: text.split(/\n+/).map((line) => ({ kind: 'paragraph' as const, text: line })) },
    options,
  );
}
