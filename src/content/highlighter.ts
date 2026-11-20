/**
 * Highlights sentences on the live page in three classes (said by most, said
 * by some, only here) without changing the page's DOM structure.
 *
 * Preferred: the CSS Custom Highlight API. Ranges are registered with
 * CSS.highlights and styled by an adopted stylesheet: no nodes are added,
 * moved or wrapped. Fallback (older browsers): one overlay element with
 * translucent boxes positioned over the text, in a closed shadow root.
 */
import type { HighlightGroup } from '@/model/messages';
import type { HighlightReply } from '@/model/schemas';

type Kind = HighlightGroup['kind'];

const NAMES: Readonly<Record<Kind, string>> = {
  most: 'legiit-lens-most',
  some: 'legiit-lens-some',
  only: 'legiit-lens-only',
};

export const HIGHLIGHT_COLORS: Readonly<Record<Kind, string>> = {
  most: 'rgba(148, 163, 184, 0.38)',
  some: 'rgba(250, 204, 21, 0.42)',
  only: 'rgba(52, 211, 153, 0.45)',
};

const OVERLAY_TAG = 'legiit-lens-overlay';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE', 'TITLE', OVERLAY_TAG.toUpperCase()]);

export interface LocatedSentence {
  kind: Kind;
  range: Range;
}

interface TextIndex {
  /** Page text with every whitespace run collapsed to one space. */
  text: string;
  nodes: Text[];
  /** For each character of `text`: which node it came from and its offset in that node. */
  nodeOf: Int32Array;
  offsetOf: Int32Array;
}

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Builds a searchable view of the page's visible text that can be mapped back to DOM positions. */
export function indexText(root: Node): TextIndex {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode(node) {
      let parent = node.parentElement;
      while (parent) {
        if (SKIP_TAGS.has(parent.tagName.toUpperCase())) return 2; /* FILTER_REJECT */
        parent = parent.parentElement;
      }
      return 1; /* FILTER_ACCEPT */
    },
  });
  const nodes: Text[] = [];
  const chars: string[] = [];
  const nodeOf: number[] = [];
  const offsetOf: number[] = [];
  let previousWasSpace = true;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = node.nodeValue ?? '';
    const nodeIndex = nodes.length;
    nodes.push(node);
    for (let i = 0; i < value.length; i++) {
      const ch = value[i]!;
      const isSpace = /\s/.test(ch);
      if (isSpace && previousWasSpace) continue;
      chars.push(isSpace ? ' ' : ch);
      nodeOf.push(nodeIndex);
      offsetOf.push(i);
      previousWasSpace = isSpace;
    }
  }
  return { text: chars.join(''), nodes, nodeOf: Int32Array.from(nodeOf), offsetOf: Int32Array.from(offsetOf) };
}

/** Finds each sentence in the page text and returns a DOM Range for it. Sentences not on the page are counted as missed. */
export function locateSentences(root: Node, groups: readonly HighlightGroup[]): { located: LocatedSentence[]; missed: number } {
  const index = indexText(root);
  const doc = root.ownerDocument ?? (root as Document);
  const located: LocatedSentence[] = [];
  let missed = 0;
  for (const group of groups) {
    for (const sentence of group.sentences) {
      const needle = normalise(sentence);
      const start = needle ? index.text.indexOf(needle) : -1;
      if (start < 0) {
        missed++;
        continue;
      }
      const end = start + needle.length - 1;
      const range = doc.createRange();
      range.setStart(index.nodes[index.nodeOf[start]!]!, index.offsetOf[start]!);
      range.setEnd(index.nodes[index.nodeOf[end]!]!, index.offsetOf[end]! + 1);
      located.push({ kind: group.kind, range });
    }
  }
  return { located, missed };
}

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
}

let adoptedSheet: CSSStyleSheet | null = null;
let overlayHost: HTMLElement | null = null;
let overlayRanges: LocatedSentence[] = [];
let resizeTimer: ReturnType<typeof setTimeout> | undefined;

function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const ctor = (globalThis as { Highlight?: unknown }).Highlight;
  return css?.highlights && typeof ctor === 'function' ? css.highlights : null;
}

function styleText(): string {
  return (Object.keys(NAMES) as Kind[])
    .map((kind) => `::highlight(${NAMES[kind]}) { background-color: ${HIGHLIGHT_COLORS[kind]}; color: inherit; }`)
    .join('\n');
}

function applyWithHighlightApi(located: readonly LocatedSentence[], highlights: HighlightRegistry): void {
  const HighlightCtor = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
  for (const kind of Object.keys(NAMES) as Kind[]) {
    const ranges = located.filter((l) => l.kind === kind).map((l) => l.range);
    if (ranges.length > 0) highlights.set(NAMES[kind], new HighlightCtor(...ranges));
    else highlights.delete(NAMES[kind]);
  }
  if (!adoptedSheet) {
    // A constructed stylesheet adds styling without adding any node to the page.
    adoptedSheet = new CSSStyleSheet();
    adoptedSheet.replaceSync(styleText());
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, adoptedSheet];
  }
}

function drawOverlay(): void {
  if (!overlayHost) return;
  const shadow = (overlayHost as HTMLElement & { __lensRoot?: ShadowRoot }).__lensRoot;
  if (!shadow) return;
  shadow.replaceChildren();
  for (const { kind, range } of overlayRanges) {
    const rects = typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
    for (const rect of rects) {
      if (rect.width < 1 || rect.height < 1) continue;
      const box = document.createElement('div');
      box.style.cssText = `position:absolute;left:${rect.left + window.scrollX}px;top:${rect.top + window.scrollY}px;width:${rect.width}px;height:${rect.height}px;background:${HIGHLIGHT_COLORS[kind]};border-radius:2px;`;
      shadow.appendChild(box);
    }
  }
}

function onResize(): void {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawOverlay, 200);
}

function applyWithOverlay(located: LocatedSentence[]): void {
  overlayRanges = located;
  if (!overlayHost) {
    overlayHost = document.createElement(OVERLAY_TAG);
    overlayHost.setAttribute('aria-hidden', 'true');
    overlayHost.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483646;';
    (overlayHost as HTMLElement & { __lensRoot?: ShadowRoot }).__lensRoot = overlayHost.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(overlayHost);
    window.addEventListener('resize', onResize, { passive: true });
  }
  drawOverlay();
}

export function clearHighlights(): void {
  const highlights = registry();
  if (highlights) for (const name of Object.values(NAMES)) highlights.delete(name);
  if (adoptedSheet) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== adoptedSheet);
    adoptedSheet = null;
  }
  if (overlayHost) {
    overlayHost.remove();
    overlayHost = null;
    overlayRanges = [];
    window.removeEventListener('resize', onResize);
    clearTimeout(resizeTimer);
  }
}

export function applyHighlights(groups: readonly HighlightGroup[]): HighlightReply {
  clearHighlights();
  if (!document.body) return { applied: 0, missed: groups.reduce((n, g) => n + g.sentences.length, 0), method: 'none' };
  const { located, missed } = locateSentences(document.body, groups);
  if (located.length === 0) return { applied: 0, missed, method: 'none' };
  const highlights = registry();
  if (highlights) {
    applyWithHighlightApi(located, highlights);
    return { applied: located.length, missed, method: 'css-highlight' };
  }
  applyWithOverlay(located);
  return { applied: located.length, missed, method: 'overlay' };
}
