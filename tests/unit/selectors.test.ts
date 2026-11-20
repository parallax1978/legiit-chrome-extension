import { describe, expect, it } from 'vitest';
import { BUNDLED_PACKS, getPack, PACK_SITES } from '@/selectors';
import { compareVersions, matchCandidate, outermost, resolveSlot, selectorHealth, validatePack } from '@/selectors/resolve';
import { fixtureDoc } from '../helpers/fixtures';

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('selector packs', () => {
  it('ships one versioned, valid pack per site', () => {
    expect(PACK_SITES.sort()).toEqual(['chatgpt', 'copilot', 'gemini', 'google', 'perplexity']);
    for (const site of PACK_SITES) {
      const pack = BUNDLED_PACKS[site];
      expect(pack.site).toBe(site);
      expect(pack.version).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/);
      expect(validatePack(pack, site), site).not.toBeNull();
      for (const [name, slot] of Object.entries(pack.slots)) {
        expect(slot.candidates.length, `${site}.${name}`).toBeGreaterThan(0);
        for (const candidate of slot.candidates) {
          // Every selector and regular expression in a pack must be syntactically valid.
          expect(() => document.createDocumentFragment().querySelector(candidate.css), `${site}.${name}: ${candidate.css}`).not.toThrow();
          if (candidate.closest) expect(() => document.body.closest(candidate.closest!), candidate.closest).not.toThrow();
          if (candidate.text) expect(() => new RegExp(candidate.text!, 'iu'), candidate.text).not.toThrow();
        }
      }
    }
  });

  it('gives every important slot at least one fallback', () => {
    const google = BUNDLED_PACKS.google;
    for (const slot of ['resultsRoot', 'organicTitleLink', 'aiOverview', 'ads', 'localPack', 'featuredSnippet', 'peopleAlsoAsk', 'video']) {
      expect(google.slots[slot]?.candidates.length, slot).toBeGreaterThanOrEqual(2);
    }
    for (const site of ['chatgpt', 'gemini', 'perplexity', 'copilot'] as const) {
      expect(BUNDLED_PACKS[site].slots['answer']?.candidates.length, site).toBeGreaterThanOrEqual(3);
      expect(BUNDLED_PACKS[site].slots['answer']?.required).toBe(true);
    }
  });
});

describe('resolver', () => {
  it('uses the first candidate that matches and reports which one', () => {
    const d = doc('<div class="new"><p id="x">hi</p></div>');
    const match = resolveSlot(d, { candidates: [{ css: '.old' }, { css: '.new' }, { css: 'div' }] });
    expect(match.candidateIndex).toBe(1);
    expect(match.elements).toHaveLength(1);
    expect(match.candidate).toBe('.new');
  });

  it('returns an empty match when nothing fits or the slot is missing', () => {
    const d = doc('<p>hi</p>');
    expect(resolveSlot(d, { candidates: [{ css: '.nope' }] })).toEqual({ elements: [], candidateIndex: -1, candidate: null });
    expect(resolveSlot(d, undefined).candidateIndex).toBe(-1);
  });

  it('filters by heading text and climbs to the closest container', () => {
    const d = doc(
      '<div id="rso"><div class="a"><div role="heading">People also ask</div><p>q</p></div><div class="b"><div role="heading">Videos</div></div></div>',
    );
    const found = matchCandidate(d, { css: "[role='heading']", text: '^People also ask$', closest: '#rso > *' });
    expect(found.map((el) => el.className)).toEqual(['a']);
  });

  it('reads aria-label when the element text is long', () => {
    const d = doc(`<section aria-label="Sponsored"><p>${'x'.repeat(400)}</p></section>`);
    expect(matchCandidate(d, { css: '[aria-label]', text: '^Sponsored$' })).toHaveLength(1);
  });

  it('never throws on a broken selector or regular expression from a pack', () => {
    const d = doc('<p>hi</p>');
    expect(matchCandidate(d, { css: 'p:::bad' })).toEqual([]);
    expect(matchCandidate(d, { css: 'p', text: '(' })).toEqual([]);
    expect(matchCandidate(d, { css: 'p', closest: '>>bad' })).toEqual([]);
  });

  it('keeps only outermost elements', () => {
    const d = doc('<div id="a"><div id="b"></div></div><div id="c"></div>');
    const all = Array.from(d.querySelectorAll('div'));
    expect(outermost(all).map((el) => el.id)).toEqual(['a', 'c']);
  });
});

describe('pack validation and overrides', () => {
  const override = {
    site: 'google',
    version: '2099.01.01-1',
    updated: '2099-01-01',
    slots: { resultsRoot: { required: true, candidates: [{ css: '#new-root' }] } },
  };

  it('accepts a well-formed pack and strips unknown fields', () => {
    const pack = validatePack({ ...override, evil: 'x', slots: { a: { candidates: [{ css: 'p', run: 'alert(1)' }] } } });
    expect(pack?.slots['a']?.candidates[0]).toEqual({ css: 'p' });
    expect(pack).not.toHaveProperty('evil');
  });

  it('rejects malformed packs', () => {
    expect(validatePack(null)).toBeNull();
    expect(validatePack({ site: 'google', version: '1', slots: {} })).toBeNull();
    expect(validatePack({ site: 'google', version: '1', slots: { a: { candidates: [{ css: 5 }] } } })).toBeNull();
    expect(validatePack({ site: 'google', version: '1', slots: { a: { candidates: [{ css: 'x'.repeat(601) }] } } })).toBeNull();
    expect(validatePack(override, 'chatgpt')).toBeNull();
  });

  it('compares versions numerically', () => {
    expect(compareVersions('2026.11.20-2', '2026.11.20-1')).toBeGreaterThan(0);
    expect(compareVersions('2026.11.20-10', '2026.11.20-9')).toBeGreaterThan(0);
    expect(compareVersions('2026.11.20-1', '2026.11.20-1')).toBe(0);
    expect(compareVersions('2025.12.31-9', '2026.01.01-1')).toBeLessThan(0);
  });

  it('prefers a newer valid override and ignores older or invalid ones', () => {
    expect(getPack('google', { google: override }).version).toBe('2099.01.01-1');
    expect(getPack('google', { google: { ...override, version: '2000.01.01-1' } }).version).toBe(BUNDLED_PACKS.google.version);
    expect(getPack('google', { google: 'broken' }).version).toBe(BUNDLED_PACKS.google.version);
    expect(getPack('google', { chatgpt: override }).version).toBe(BUNDLED_PACKS.google.version);
    expect(getPack('google').version).toBe(BUNDLED_PACKS.google.version);
  });
});

describe('selector health check', () => {
  it('reports the winning candidate for each slot on a recognised page', () => {
    const report = selectorHealth(fixtureDoc('google/serp-full.html'), BUNDLED_PACKS.google);
    const bySlot = new Map(report.map((r) => [r.slot, r]));
    expect(bySlot.get('resultsRoot')).toMatchObject({ matched: 1, candidateIndex: 0, required: true });
    expect(bySlot.get('organicTitleLink')?.matched).toBe(9);
    expect(bySlot.get('aiOverview')?.candidateIndex).toBe(0);
    expect(bySlot.get('featuredSnippet')?.matched).toBe(0);
  });

  it('shows fallbacks in use when class names have churned', () => {
    const report = selectorHealth(fixtureDoc('google/serp-churn.html'), BUNDLED_PACKS.google);
    const bySlot = new Map(report.map((r) => [r.slot, r]));
    expect(bySlot.get('aiOverview')?.candidateIndex).toBe(2);
    expect(bySlot.get('ads')?.candidateIndex).toBe(2);
    expect(bySlot.get('peopleAlsoAsk')?.candidateIndex).toBe(2);
    expect(bySlot.get('organicTitleLink')?.matched).toBe(9);
  });

  it('flags required slots that find nothing on an unrecognised page', () => {
    const report = selectorHealth(fixtureDoc('google/serp-unrecognised.html'), BUNDLED_PACKS.google);
    const failing = report.filter((r) => r.required && r.matched === 0).map((r) => r.slot);
    expect(failing).toEqual(expect.arrayContaining(['resultsRoot', 'organicTitleLink', 'stripParent']));
  });
});
