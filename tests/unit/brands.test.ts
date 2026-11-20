import { describe, expect, it } from 'vitest';
import { BrandMatcher, splitHits } from '@/brands/matcher';
import { scenarioBrands } from '../helpers/fixtures';

const matcher = new BrandMatcher(scenarioBrands);

describe('BrandMatcher', () => {
  it('matches tracked domains and their subdomains', () => {
    expect(matcher.matchDomain('https://www.brightpathdental.example/about')).toMatchObject([{ owner: 'mine', via: 'domain' }]);
    expect(matcher.matchDomain('blog.lakesidesmiles.example')).toMatchObject([{ owner: 'competitor', name: 'Lakeside Smiles' }]);
    expect(matcher.matchDomain('notlakesidesmiles.example')).toEqual([]);
    expect(matcher.matchDomain('lakesidesmiles.example.evil.test')).toEqual([]);
    expect(matcher.matchDomain(null)).toEqual([]);
  });

  it('matches names and aliases as whole words, case-insensitively', () => {
    expect(matcher.matchText('We recommend LAKESIDE SMILES and Capitol Dental.').map((h) => h.name)).toEqual([
      'Lakeside Smiles',
      'Capitol Dental Care',
    ]);
    expect(matcher.matchText('Bright  Path Dental is in South Austin').map((h) => h.owner)).toEqual(['mine']);
    // No partial-word matches.
    expect(matcher.matchText('The brightpaths of lakesidesmilesy')).toEqual([]);
  });

  it('matches bare domains mentioned in text and curly apostrophes', () => {
    expect(matcher.matchText('See zilkerfamilydentistry.example for details').map((h) => h.name)).toEqual(['Zilker Family Dentistry']);
    const withApostrophe = new BrandMatcher({
      mine: [{ id: 'm', name: "Rosie's Diner", domains: [], aliases: [] }],
      competitors: [],
    });
    expect(withApostrophe.matchText('Try Rosie’s Diner tonight')).toHaveLength(1);
  });

  it('counts mentions per brand', () => {
    const counts = matcher.countMentions('Lakeside Smiles, lakeside smiles and Capitol Dental Care. Lakeside Smiles Dentistry too.');
    expect(counts.get('c1')).toBe(3);
    expect(counts.get('c2')).toBe(1);
    expect(counts.has('me')).toBe(false);
  });

  it('merges domain and text hits per brand for a result item', () => {
    const hits = matcher.matchItem({
      url: 'https://www.lakesidesmiles.example/',
      title: 'Lakeside Smiles vs Capitol Dental Care',
      text: '',
    });
    expect(hits).toHaveLength(2);
    expect(hits.find((h) => h.brandId === 'c1')?.via).toBe('domain');
    expect(hits.find((h) => h.brandId === 'c2')?.via).toBe('name');
    expect(splitHits(hits)).toMatchObject({ mine: [], competitors: [{}, {}] });
  });

  it('handles regex metacharacters and non-Latin names safely', () => {
    const tricky = new BrandMatcher({
      mine: [{ id: 'a', name: 'C++ Dental (Austin)', domains: [], aliases: ['Zähne & Co.'] }],
      competitors: [{ id: 'b', name: '歯科クリニック', domains: [], aliases: [] }],
    });
    expect(tricky.matchText('Visit C++ Dental (Austin) today')).toHaveLength(1);
    expect(tricky.matchText('Zähne & Co. ist gut')).toHaveLength(1);
    expect(tricky.matchText('おすすめの 歯科クリニック です')).toHaveLength(1);
  });

  it('reports what is tracked', () => {
    expect(matcher.hasMine).toBe(true);
    expect(matcher.hasCompetitors).toBe(true);
    expect(new BrandMatcher({ mine: [], competitors: [] }).isEmpty).toBe(true);
    expect(matcher.nameOf('c3')).toBe('Zilker Family Dentistry');
    expect(matcher.ownerOf('me')).toBe('mine');
  });
});
