import { describe, expect, it } from 'vitest';
import { extractMainContent } from '@/extract/main-content';
import {
  classifySentences,
  classOf,
  explainNoise,
  mostThreshold,
  type ComparisonPage,
} from '@/features/new-or-noise/classify';
import { contentSentences, textSentences } from '@/features/new-or-noise/sentences';
import { bestMatch, DenseVectors, LexicalEngine, splitDense, type SimilarityEngine, type Vectors } from '@/similarity/engine';
import { fixtureDoc, fixtureJson } from '../helpers/fixtures';

/** A deterministic stand-in engine: texts tagged with the same [topic] are identical, everything else unrelated. */
class TopicEngine implements SimilarityEngine {
  readonly kind = 'embedding' as const;
  readonly label = 'topic stub';
  readonly sameThreshold = 0.72;
  readonly passageThreshold = 0.5;

  async encodeGroups(groups: readonly (readonly string[])[]): Promise<Vectors[]> {
    const topics = [...new Set(groups.flat().map((t) => /\[(\w+)\]/.exec(t)?.[1] ?? t))];
    const dims = topics.length;
    return groups.map((group) => {
      const data = new Float32Array(group.length * dims);
      group.forEach((text, i) => {
        data[i * dims + topics.indexOf(/\[(\w+)\]/.exec(text)?.[1] ?? text)] = 1;
      });
      return new DenseVectors(data, dims);
    });
  }
}

const unit = (text: string) => ({ text, words: text.split(/\s+/).length });
const page = (url: string, ...texts: string[]): ComparisonPage => ({ url, title: url, sentences: texts.map(unit) });

describe('sentence extraction', () => {
  it('skips headings and short fragments and removes duplicates', () => {
    const sentences = contentSentences({
      blocks: [
        { kind: 'heading', level: 2, text: 'A heading that is long enough to count' },
        { kind: 'paragraph', text: 'Short one. This sentence has more than five words in it. This sentence has more than five words in it.' },
        { kind: 'list-item', text: 'A list item that also makes a full point here' },
      ],
    });
    expect(sentences.map((s) => s.text)).toEqual([
      'This sentence has more than five words in it.',
      'A list item that also makes a full point here',
    ]);
    expect(sentences[0]?.words).toBe(9);
  });

  it('reads sentences from selected or pasted text', () => {
    expect(textSentences('First full sentence goes right here.\n\nSecond full sentence goes right here too.')).toHaveLength(2);
    expect(textSentences('too short')).toEqual([]);
  });

  it('caps the number of sentences per page', () => {
    const blocks = Array.from({ length: 500 }, (_, i) => ({ kind: 'paragraph' as const, text: `Sentence number ${i} has enough words to count.` }));
    expect(contentSentences({ blocks })).toHaveLength(200);
    expect(contentSentences({ blocks }, { maxSentences: 10 })).toHaveLength(10);
  });
});

describe('class thresholds', () => {
  it('defines "most" as more than half of the pages', () => {
    expect([1, 2, 3, 4, 5, 6].map(mostThreshold)).toEqual([1, 2, 2, 3, 3, 4]);
    expect(classOf(0, 5)).toBe('only');
    expect(classOf(1, 5)).toBe('some');
    expect(classOf(2, 5)).toBe('some');
    expect(classOf(3, 5)).toBe('most');
    expect(classOf(1, 2)).toBe('some');
    expect(classOf(2, 2)).toBe('most');
    expect(classOf(1, 1)).toBe('most');
  });
});

describe('classification (deterministic engine)', () => {
  const target = [
    unit('[six] everyone says this point about six months'),
    unit('[gum] two of four pages say this'),
    unit('[mine] nobody else says this at all'),
  ];
  const pages = [
    page('https://a.example/', '[six] a', '[gum] a', '[xray] a', '[kids] a'),
    page('https://b.example/', '[six] b', '[gum] b', '[xray] b'),
    page('https://c.example/', '[six] c', '[xray] c', '[solo] c'),
    page('https://d.example/', '[kids] d'),
  ];

  it('classifies by how many pages contain a matching sentence', async () => {
    const report = await classifySentences(target, pages, new TopicEngine());
    expect(report.pagesCompared).toBe(4);
    expect(report.mostNeeds).toBe(3);
    expect(report.sentences.map((s) => [s.cls, s.pages])).toEqual([
      ['most', 3],
      ['some', 2],
      ['only', 0],
    ]);
    expect(report.sentences[0]?.closest).toEqual({ url: 'https://a.example/', text: '[six] a' });
    expect(report.sentences[2]?.closest).toBeNull();
  });

  it('reports the share of words in each class', async () => {
    const report = await classifySentences(target, pages, new TopicEngine());
    expect(report.words).toEqual({ most: 8, some: 7, only: 7 });
    expect(report.totalWords).toBe(22);
    expect(report.share.only).toBeCloseTo(7 / 22, 6);
    expect(report.share.most + report.share.some + report.share.only).toBeCloseTo(1, 6);
  });

  it('lists points most pages make that the target does not, once each', async () => {
    const report = await classifySentences(target, pages, new TopicEngine());
    // [xray] is on 3 of 4 pages and missing from the target; [kids] is on only 2; [solo] on 1.
    expect(report.missing).toEqual([{ text: '[xray] a', pages: 3, urls: ['https://a.example/', 'https://b.example/', 'https://c.example/'] }]);
  });

  it('ignores comparison pages with no readable sentences', async () => {
    const report = await classifySentences(target, [...pages, page('https://empty.example/')], new TopicEngine());
    expect(report.pagesCompared).toBe(4);
  });

  it('handles no comparison pages and an empty target', async () => {
    const none = await classifySentences(target, [], new TopicEngine());
    expect(none.sentences.every((s) => s.cls === 'only')).toBe(true);
    expect(none.missing).toEqual([]);
    expect(explainNoise(none)[0]).toMatch(/No comparison pages/);
    const empty = await classifySentences([], pages, new TopicEngine());
    expect(empty.totalWords).toBe(0);
    expect(empty.share).toEqual({ most: 0, some: 0, only: 0 });
    expect(explainNoise(empty)[0]).toMatch(/No sentences/);
  });

  it('summarises the result in plain language', async () => {
    const lines = explainNoise(await classifySentences(target, pages, new TopicEngine()));
    expect(lines[0]).toBe("32% of this page's words are only here; 36% repeat what most of the 4 comparison pages say and 32% what some of them say.");
    expect(lines[1]).toContain('[mine] nobody else says this at all');
    expect(lines[2]).toContain('[xray] a');
  });
});

describe('lexical fallback engine', () => {
  const engine = new LexicalEngine();

  it('scores shared content words and ignores stop words and inflection', async () => {
    const [a, b] = await engine.encodeGroups([
      ['Cleanings remove plaque and tartar', 'Bananas are yellow'],
      ['A cleaning removes the plaque and the tartar', 'The banana was yellow', ''],
    ]);
    expect(a!.similarity(0, b!, 0)).toBeCloseTo(1, 6);
    expect(a!.similarity(1, b!, 1)).toBeCloseTo(1, 6);
    expect(a!.similarity(0, b!, 1)).toBe(0);
    expect(a!.similarity(0, b!, 2)).toBe(0);
    expect(bestMatch(a!, 0, b!)).toMatchObject({ index: 0 });
  });

  it('classifies the fixture article against its comparison pages and says it is a fallback', async () => {
    const manifest = fixtureJson<{ routes: { url: string; file: string }[] }>('manifest.json');
    const articles = manifest.routes.filter((r) => r.file.startsWith('articles/') && !r.file.includes('brightpath'));
    const target = contentSentences(extractMainContent(fixtureDoc('articles/brightpath-how-often-teeth-cleaning.html')));
    const pages = articles.map((r) => ({ url: r.url, title: r.url, sentences: contentSentences(extractMainContent(fixtureDoc(r.file))) }));
    expect(pages).toHaveLength(5);
    const report = await classifySentences(target, pages, engine);
    expect(report.engine).toBe('lexical');
    const cls = (needle: string) => report.sentences.find((s) => s.text.includes(needle))?.cls;
    expect(cls('every six months')).toBe('most');
    expect(cls('air-polishing system')).toBe('only');
    expect(cls('text reminder three weeks')).toBe('only');
    expect(cls('2025 patient survey')).toBe('only');
    expect(report.share.only).toBeGreaterThan(0.3);
    expect(report.missing.some((m) => /X-rays/i.test(m.text))).toBe(true);
    expect(explainNoise(report).join(' ')).toContain('compared by shared words');
  });
});

describe('dense vectors', () => {
  it('computes cosine similarity of normalised rows and splits groups', () => {
    const all = new DenseVectors(new Float32Array([1, 0, 0, 1, 0.6, 0.8]), 2);
    expect(all.count).toBe(3);
    const [first, second] = splitDense(all, [['a', 'b'], ['c']]);
    expect(first!.count).toBe(2);
    expect(second!.count).toBe(1);
    expect(first!.similarity(0, second!, 0)).toBeCloseTo(0.6, 6);
    expect(first!.similarity(1, second!, 0)).toBeCloseTo(0.8, 6);
    expect(bestMatch(second!, 0, first!)).toEqual({ score: expect.closeTo(0.8, 6), index: 1 });
    expect(bestMatch(second!, 0, new DenseVectors(new Float32Array(0), 2))).toEqual({ score: 0, index: -1 });
  });
});
