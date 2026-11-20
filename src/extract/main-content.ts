/**
 * Main-content extraction. Mozilla's Readability (bundled) finds the article
 * body; a structural fallback handles pages it cannot read (home pages,
 * service pages, thin pages). Output is plain text blocks only.
 */
import { Readability } from '@mozilla/readability';
import { cleanText } from '@/lib/sanitize';
import { countWords } from '@/lib/text';
import { collectBlocks, type ContentBlock } from './blocks';
import { parseHtml } from './html';

export type { ContentBlock } from './blocks';

export interface MainContent {
  title: string;
  byline: string | null;
  blocks: ContentBlock[];
  /** Blocks joined with newlines. */
  text: string;
  wordCount: number;
  method: 'readability' | 'structure';
}

function finish(title: string, byline: string | null, blocks: ContentBlock[], method: MainContent['method']): MainContent {
  const text = blocks.map((b) => b.text).join('\n');
  return { title, byline, blocks, text, wordCount: countWords(text), method };
}

/** Extracts the main readable content of a parsed page. Never mutates `doc`. */
export function extractMainContent(doc: Document): MainContent {
  const title = cleanText(doc.querySelector('title')?.textContent ?? '', 300);
  let article: ReturnType<Readability['parse']> = null;
  try {
    // Readability rewrites the document it is given, so it gets a copy.
    article = new Readability(doc.cloneNode(true) as Document, { charThreshold: 250 }).parse();
  } catch {
    article = null;
  }
  if (article?.content && (article.textContent ?? '').trim().length >= 250) {
    const blocks = collectBlocks(parseHtml(article.content).body, { skipChrome: false });
    if (blocks.length > 0) {
      return finish(cleanText(article.title ?? title, 300) || title, cleanText(article.byline ?? '', 160) || null, blocks, 'readability');
    }
  }
  const root = doc.querySelector('main, [role="main"], article') ?? doc.body ?? doc.documentElement;
  return finish(title, null, root ? collectBlocks(root, { skipChrome: true }) : [], 'structure');
}

/** Whole-page text including navigation and footer, used where every mention matters (brand scans). */
export function extractAllText(doc: Document, maxBlocks = 6000): string {
  const root = doc.body ?? doc.documentElement;
  if (!root) return '';
  return collectBlocks(root, { skipChrome: false, maxBlocks })
    .map((b) => b.text)
    .join('\n');
}
