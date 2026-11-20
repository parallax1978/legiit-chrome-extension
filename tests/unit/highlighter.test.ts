import { describe, expect, it } from 'vitest';
import { applyHighlights, clearHighlights, indexText, locateSentences } from '@/content/highlighter';
import { asTabRequest } from '@/model/messages';

function setBody(html: string): void {
  document.body.replaceChildren();
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const node of Array.from(parsed.body.childNodes)) document.body.appendChild(document.importNode(node, true));
}

describe('locating sentences on the live page', () => {
  it('indexes visible text with whitespace collapsed and skips scripts and styles', () => {
    setBody('<p>One   two\n three.</p><script>var hidden = 1;</script><style>p{}</style><p>Four.</p>');
    expect(indexText(document.body).text).toBe('One two three.Four.');
  });

  it('finds sentences that span inline elements and returns exact ranges', () => {
    setBody('<p>Most people need a <strong>professional cleaning</strong> every six months. Our hygienists never rush.</p>');
    const { located, missed } = locateSentences(document.body, [
      { kind: 'most', sentences: ['Most people need a professional cleaning every six months.'] },
      { kind: 'only', sentences: ['Our hygienists never rush.'] },
    ]);
    expect(missed).toBe(0);
    expect(located.map((l) => [l.kind, l.range.toString()])).toEqual([
      ['most', 'Most people need a professional cleaning every six months.'],
      ['only', 'Our hygienists never rush.'],
    ]);
    // The first range starts in one text node and ends in another (after the <strong>).
    expect(located[0]!.range.startContainer).not.toBe(located[0]!.range.endContainer);
  });

  it('tolerates differences in whitespace between the extracted sentence and the page', () => {
    setBody('<p>Line one\n      continues   here.</p>');
    const { located } = locateSentences(document.body, [{ kind: 'some', sentences: ['Line one continues here.'] }]);
    expect(located).toHaveLength(1);
    expect(located[0]!.range.toString().replace(/\s+/g, ' ')).toBe('Line one continues here.');
  });

  it('counts sentences that are not on the page as missed', () => {
    setBody('<p>Only this is here.</p>');
    const { located, missed } = locateSentences(document.body, [{ kind: 'only', sentences: ['Only this is here.', 'This one is not.', ''] }]);
    expect(located).toHaveLength(1);
    expect(missed).toBe(2);
  });

  it('never changes the DOM while locating', () => {
    setBody('<article><h1>Title</h1><p>A sentence that will be located on the page.</p></article>');
    const before = document.body.innerHTML;
    locateSentences(document.body, [{ kind: 'only', sentences: ['A sentence that will be located on the page.'] }]);
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('applying highlights', () => {
  it('reports "none" when nothing can be located, and clears safely when nothing was applied', () => {
    setBody('<p>Nothing to see.</p>');
    expect(applyHighlights([{ kind: 'only', sentences: ['Absent sentence.'] }])).toEqual({ applied: 0, missed: 1, method: 'none' });
    expect(() => clearHighlights()).not.toThrow();
  });

  it('falls back to a single overlay element when the CSS Custom Highlight API is missing, and removes it on clear', () => {
    setBody('<p>A sentence that will be located on the page.</p>');
    const before = document.body.innerHTML;
    const reply = applyHighlights([{ kind: 'only', sentences: ['A sentence that will be located on the page.'] }]);
    expect(reply).toMatchObject({ applied: 1, missed: 0, method: 'overlay' });
    // The page content itself is untouched: the overlay is one element outside <body>.
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelectorAll('legiit-lens-overlay')).toHaveLength(1);
    expect(document.querySelector('legiit-lens-overlay')!.shadowRoot).toBeNull(); // closed shadow root
    clearHighlights();
    expect(document.querySelectorAll('legiit-lens-overlay')).toHaveLength(0);
  });
});

describe('requests accepted by the page agent', () => {
  it('accepts only known request types with well-formed payloads', () => {
    expect(asTabRequest({ type: 'lens:ping' })).toEqual({ type: 'lens:ping' });
    expect(asTabRequest({ type: 'lens:fetch-same-origin', urls: ['https://a.example/x'] })).not.toBeNull();
    expect(asTabRequest({ type: 'lens:highlight', groups: [{ kind: 'only', sentences: ['x'] }] })).not.toBeNull();
    for (const bad of [
      null,
      'lens:ping',
      { type: 'something-else' },
      { type: 'lens:fetch-same-origin' },
      { type: 'lens:fetch-same-origin', urls: Array.from({ length: 13 }, () => 'https://a.example/') },
      { type: 'lens:fetch-same-origin', urls: [5] },
      { type: 'lens:highlight', groups: [{ kind: 'evil', sentences: [] }] },
      { type: 'lens:highlight', groups: [{ kind: 'only', sentences: [{}] }] },
      { type: 'lens:highlight', groups: 'x' },
    ]) {
      expect(asTabRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
