import { describe, expect, it } from 'vitest';
import { answerFromPastedText, readAnswer } from '@/answers/read';
import { AI_SITES, type AiSiteId } from '@/config/sites';
import { AnswerDataSchema, parseOrNull } from '@/model/schemas';
import { getPack } from '@/selectors';
import { fixtureDoc, scenario } from '../helpers/fixtures';

function read(site: AiSiteId, file: string, url: string) {
  return readAnswer(fixtureDoc(file), getPack(site), site, { url, now: 1, ownHosts: AI_SITES[site].hosts });
}

describe('AI answer reader', () => {
  it('reads the latest ChatGPT answer, not an earlier turn', () => {
    const answer = read('chatgpt', 'ai/chatgpt.html', scenario.urls.chatgpt!);
    expect(answer.recognised).toBe(true);
    expect(answer.question).toBe('Who are the best dentists in Austin?');
    expect(answer.text).toMatch(/^Based on recent patient reviews/);
    expect(answer.text).toContain('Zilker Family Dentistry');
    expect(answer.text).not.toContain('A dental cleaning is a preventive visit');
    expect(answer.citations.map((c) => c.url)).toEqual([
      'https://www.austinhealthguide.example/best-dentists-austin',
      'https://smilecompare.example/lakeside-smiles-vs-capitol-dental-care',
      'https://texaslocalpicks.example/austin/top-rated-dentists',
    ]);
  });

  it('drops tracking parameters and links to the AI site itself', () => {
    const answer = read('chatgpt', 'ai/chatgpt.html', scenario.urls.chatgpt!);
    const serialised = JSON.stringify(answer.citations);
    expect(serialised).not.toContain('utm_source');
    expect(serialised).not.toContain('openai.com');
    expect(serialised).not.toContain('chatgpt.com');
    expect(serialised).not.toContain('nationaloralhealth'); // cited only by the earlier answer
  });

  it('reads Gemini, including its sources list', () => {
    const answer = read('gemini', 'ai/gemini.html', scenario.urls.gemini!);
    expect(answer.recognised).toBe(true);
    expect(answer.question).toBe('Who are the best dentists in Austin?');
    expect(answer.text).toContain('Capitol Dental Care – downtown');
    expect(answer.citations.map((c) => c.domain)).toEqual([
      'austinhealthguide.example',
      'texaslocalpicks.example',
      'capitoldentalcare.example',
    ]);
    expect(answer.citations[0]?.title).toContain('10 Best Dentists in Austin');
  });

  it('reads Perplexity and leaves numeric citation markers out of the wording', () => {
    const answer = read('perplexity', 'ai/perplexity.html', scenario.urls.perplexity!);
    expect(answer.recognised).toBe(true);
    expect(answer.question).toBe('best dentists in austin');
    expect(answer.text).toContain('BrightPath Dental');
    expect(answer.text).not.toMatch(/\b[12]\b\s*$/m);
    expect(answer.citations.map((c) => c.domain)).toEqual(['austinhealthguide.example', 'atxneighbors.example']);
  });

  it('reads Copilot and its citation list', () => {
    const answer = read('copilot', 'ai/copilot.html', scenario.urls.copilot!);
    expect(answer.recognised).toBe(true);
    expect(answer.question).toBe('Who are the best dentists in Austin?');
    expect(answer.text).toContain('Lakeside Smiles');
    expect(answer.citations.map((c) => c.domain)).toEqual(['texaslocalpicks.example', 'smilecompare.example']);
  });

  it('produces schema-valid data for every site', () => {
    for (const [site, file, url] of [
      ['chatgpt', 'ai/chatgpt.html', scenario.urls.chatgpt!],
      ['gemini', 'ai/gemini.html', scenario.urls.gemini!],
      ['perplexity', 'ai/perplexity.html', scenario.urls.perplexity!],
      ['copilot', 'ai/copilot.html', scenario.urls.copilot!],
    ] as const) {
      expect(parseOrNull(AnswerDataSchema, JSON.parse(JSON.stringify(read(site, file, url)))), site).not.toBeNull();
    }
  });

  it('reports unknown markup as unrecognised so the UI can offer paste', () => {
    const answer = read('chatgpt', 'ai/chatgpt-unrecognised.html', scenario.urls.chatgptUnrecognised!);
    expect(answer.recognised).toBe(false);
    expect(answer.text).toBe('');
    expect(answer.citations).toEqual([]);
  });

  it('treats a page with no conversation yet as unrecognised', () => {
    const doc = new DOMParser().parseFromString('<main><h1>What can I help with?</h1></main>', 'text/html');
    const answer = readAnswer(doc, getPack('chatgpt'), 'chatgpt', { url: 'https://chatgpt.com/', now: 1, ownHosts: ['chatgpt.com'] });
    expect(answer.recognised).toBe(false);
  });
});

describe('pasted answers', () => {
  it('keeps the wording and extracts any links', () => {
    const answer = answerFromPastedText(
      'Top picks:\n\nLakeside Smiles (https://www.lakesidesmiles.example/?utm_source=ai) and Capitol Dental Care.\nSee https://texaslocalpicks.example/austin/top-rated-dentists.',
      5,
    );
    expect(answer.site).toBe('pasted');
    expect(answer.recognised).toBe(true);
    expect(answer.text).toContain('Capitol Dental Care');
    expect(answer.citations.map((c) => c.url)).toEqual([
      'https://www.lakesidesmiles.example/',
      'https://texaslocalpicks.example/austin/top-rated-dentists',
    ]);
    expect(parseOrNull(AnswerDataSchema, answer)).not.toBeNull();
  });

  it('is unrecognised when empty and ignores non-http links', () => {
    expect(answerFromPastedText('   ', 1).recognised).toBe(false);
    expect(answerFromPastedText('click javascript:alert(1) or ftp://x.example', 1).citations).toEqual([]);
  });
});
