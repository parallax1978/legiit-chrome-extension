// @vitest-environment node
/**
 * Runs the bundled model (the exact files shipped in the package) against the
 * fixture articles, to check that the documented thresholds classify real
 * embeddings the way the method says. No network: remote models are disabled.
 */
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractMainContent } from '@/extract/main-content';
import { classifySentences, type NoiseReport } from '@/features/new-or-noise/classify';
import { contentSentences } from '@/features/new-or-noise/sentences';
import { EMBEDDING_SAME_THRESHOLD } from '@/similarity/engine';
import { fixtureJson, fixtureText } from '../helpers/fixtures';
import { NodeEmbeddingEngine } from '../helpers/node-embedding-engine';

const dom = new JSDOM('');
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser = dom.window.DOMParser;

function sentencesOf(file: string) {
  const doc = new dom.window.DOMParser().parseFromString(fixtureText(file), 'text/html');
  return contentSentences(extractMainContent(doc));
}

describe('bundled embedding model on the fixture corpus', () => {
  const engine = new NodeEmbeddingEngine();
  let report: NoiseReport;

  beforeAll(async () => {
    const manifest = fixtureJson<{ routes: { url: string; file: string }[] }>('manifest.json');
    const pages = manifest.routes
      .filter((r) => r.file.startsWith('articles/') && !r.file.includes('brightpath'))
      .map((r) => ({ url: r.url, title: r.url, sentences: sentencesOf(r.file) }));
    report = await classifySentences(sentencesOf('articles/brightpath-how-often-teeth-cleaning.html'), pages, engine);
  }, 120_000);

  it('produces 384-dimensional normalised vectors', async () => {
    const [v] = await engine.encodeGroups([['A dentist cleans teeth.', 'Dental hygienists clean your teeth.', 'Bananas are yellow.']]);
    expect(v!.count).toBe(3);
    expect(v!.similarity(0, v!, 0)).toBeCloseTo(1, 3);
    expect(v!.similarity(0, v!, 1)).toBeGreaterThan(EMBEDDING_SAME_THRESHOLD);
    expect(v!.similarity(0, v!, 2)).toBeLessThan(0.3);
  });

  it('classifies common points as said by most, even when worded differently', () => {
    const find = (needle: string) => report.sentences.find((s) => s.text.includes(needle))!;
    expect(report.engine).toBe('embedding');
    expect(report.pagesCompared).toBe(5);
    expect(find('every six months')).toMatchObject({ cls: 'most' });
    expect(find('every six months').pages).toBeGreaterThanOrEqual(4);
    expect(find('plaque and hardened tartar').cls).toBe('most');
    expect(find('gum disease often need').cls).toBe('most');
  });

  it('classifies less common points as said by some', () => {
    const find = (needle: string) => report.sentences.find((s) => s.text.includes(needle))!;
    expect(find('insurance plans cover two cleanings').cls).toBe('some');
    expect(find('Smokers and people with diabetes').cls).toBe('some');
  });

  it('classifies first-hand statements as only here', () => {
    const only = report.sentences.filter((s) => s.cls === 'only').map((s) => s.text);
    expect(only).toEqual([
      'At BrightPath Dental we use an air-polishing system that lifts stains without scraping.',
      'Our South Austin hygienists book fifty-minute appointments so nobody is rushed.',
      'In our 2025 patient survey, 68 percent of patients on a four-month schedule reported less bleeding when flossing.',
      'We send a text reminder three weeks before you are due, with a link to pick your own time.',
    ]);
    expect(report.share.only).toBeGreaterThan(0.4);
    expect(report.share.only).toBeLessThan(0.6);
  });

  it('finds what most competing pages cover that the page does not', () => {
    const missing = report.missing.map((m) => m.text).join('\n');
    expect(missing).toMatch(/X-rays/);
    expect(missing).toMatch(/first (dental )?visit|age one|turn one/i);
    for (const point of report.missing) expect(point.pages).toBeGreaterThanOrEqual(3);
    // Near-duplicates are folded: one X-ray point, not four.
    expect(report.missing.filter((m) => /X-rays/.test(m.text))).toHaveLength(1);
  });
});
