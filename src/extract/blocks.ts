/**
 * Block-level text walker. Kept free of heavy dependencies because content
 * scripts use it too (the Readability-based extractor lives in main-content.ts).
 */
import { cleanText } from '@/lib/sanitize';

export interface ContentBlock {
  kind: 'heading' | 'paragraph' | 'list-item' | 'quote' | 'cell' | 'other';
  /** Heading level 1-6, for headings only. */
  level?: number;
  text: string;
}

const SKIP = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'SELECT', 'BUTTON',
  'TEXTAREA', 'INPUT', 'VIDEO', 'AUDIO', 'MAP', 'HEAD', 'DIALOG',
]);

const CHROME_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'MENU']);

const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
  'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL', 'BR',
]);

function kindOf(tag: string): { kind: ContentBlock['kind']; level?: number } {
  if (/^H[1-6]$/.test(tag)) return { kind: 'heading', level: Number(tag[1]) };
  if (tag === 'P') return { kind: 'paragraph' };
  if (tag === 'LI' || tag === 'DD' || tag === 'DT') return { kind: 'list-item' };
  if (tag === 'BLOCKQUOTE') return { kind: 'quote' };
  if (tag === 'TD' || tag === 'TH') return { kind: 'cell' };
  return { kind: 'other' };
}

/**
 * Walks the tree and emits one block per run of inline content, breaking at
 * block-level elements. Works on semantic markup and on "div soup" alike.
 */
export interface CollectOptions {
  /** Skip nav, header, footer, aside and form subtrees. */
  skipChrome: boolean;
  maxBlocks?: number;
  /**
   * Skip links that are cards (a link wrapping block-level content) or bare
   * citation markers ("1", "[2]"). Used for AI answers, where source cards and
   * footnote numbers are not part of the answer's wording.
   */
  skipLinkCards?: boolean;
}

function isLinkCard(el: Element): boolean {
  if (el.tagName.toUpperCase() !== 'A') return false;
  for (const child of Array.from(el.children)) {
    if (BLOCK.has(child.tagName.toUpperCase())) return true;
  }
  return /^\[?\d{1,3}\]?$/.test((el.textContent ?? '').trim());
}

export function collectBlocks(root: Node, options: CollectOptions = { skipChrome: false }): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const max = options.maxBlocks ?? 4000;
  let buffer = '';
  let context: { kind: ContentBlock['kind']; level?: number } = { kind: 'other' };

  const flush = (): void => {
    const text = cleanText(buffer, 5000);
    buffer = '';
    if (text && blocks.length < max) blocks.push({ ...context, text });
  };

  const visit = (node: Node): void => {
    if (blocks.length >= max) return;
    if (node.nodeType === 3) {
      buffer += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag)) return;
    if (options.skipChrome && CHROME_TAGS.has(tag)) return;
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return;
    if (options.skipLinkCards && isLinkCard(el)) return;
    const isBlock = BLOCK.has(tag);
    if (!isBlock) {
      for (const child of Array.from(el.childNodes)) visit(child);
      return;
    }
    flush();
    if (tag === 'BR' || tag === 'HR') return;
    const previous = context;
    const own = kindOf(tag);
    // Keep the more specific outer kind for generic wrappers (a <div> inside an <li> stays a list item),
    // and keep "quote" for paragraphs inside a blockquote.
    context = own.kind === 'other' || (previous.kind === 'quote' && own.kind === 'paragraph') ? previous : own;
    for (const child of Array.from(el.childNodes)) visit(child);
    flush();
    context = previous;
  };

  visit(root);
  flush();
  return blocks;
}

/** Text of an element with one line per block, for answer and overview bodies. */
export function blockText(root: Node, maxBlocks = 400, skipLinkCards = false): string {
  return collectBlocks(root, { skipChrome: false, maxBlocks, skipLinkCards })
    .map((b) => b.text)
    .join('\n');
}
