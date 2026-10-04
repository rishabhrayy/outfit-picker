import { describe, expect, it } from 'vitest';

import {
  filterWardrobeForOutfit,
  isRecentlyWorn,
  itemMatchesWeather,
  missingForCompleteOutfit,
  occasionKey,
  shuffleOutfit,
} from '../src/lib/outfit.js';

const wardrobe = [
  { id: 't1', category: 'top', seasons: ['summer'], styleTags: ['casual'] },
  { id: 't2', category: 'top', seasons: ['winter'], styleTags: ['smart'] },
  { id: 'b1', category: 'bottom', seasons: [], styleTags: [] },
  { id: 's1', category: 'shoes', seasons: [], styleTags: [] },
  { id: 'd1', category: 'dress', seasons: ['summer'], styleTags: [] },
];

describe('outfit logic', () => {
  it('maps occasion labels and falls back to casual', () => {
    expect(occasionKey('Date night')).toBe('date');
    expect(occasionKey('something odd')).toBe('casual');
  });

  it('counts recent wear in whole days', () => {
    const now = new Date('2026-10-04T12:00:00');
    expect(isRecentlyWorn('2026-10-01', 7, now)).toBe(true);
    expect(isRecentlyWorn('2026-09-20', 7, now)).toBe(false);
    expect(isRecentlyWorn('', 7, now)).toBe(false);
    expect(isRecentlyWorn('2026-10-01', 0, now)).toBe(false);
  });

  it('treats untagged items as fine for any weather', () => {
    expect(itemMatchesWeather({ seasons: [] }, 'hot')).toBe(true);
    expect(itemMatchesWeather({ seasons: ['any'] }, 'any')).toBe(true);
  });

  it('ranks by weather but never removes a whole category', () => {
    const ranked = filterWardrobeForOutfit(wardrobe, { weather: 'hot' });
    expect(ranked).toHaveLength(wardrobe.length);
    expect(ranked.findIndex((item) => item.id === 't1')).toBeLessThan(ranked.findIndex((item) => item.id === 't2'));
  });

  it('always includes a requested item in a shuffle', () => {
    for (let run = 0; run < 30; run += 1) {
      expect(shuffleOutfit(wardrobe, { requiredItemId: 't2' }).itemIds).toContain('t2');
    }
  });

  it('a shuffle never mixes a dress with a top and bottom', () => {
    for (let run = 0; run < 50; run += 1) {
      const ids = shuffleOutfit(wardrobe).itemIds;
      const hasDress = ids.includes('d1');
      const hasSeparates = ids.some((id) => id.startsWith('t') || id === 'b1');
      expect(hasDress && hasSeparates).toBe(false);
      expect(ids).toContain('s1');
    }
  });

  it('names what a complete outfit is missing', () => {
    expect(missingForCompleteOutfit([{ category: 'top' }])).toEqual(['shoes', 'a bottom']);
    expect(missingForCompleteOutfit([{ category: 'dress' }, { category: 'shoes' }])).toEqual([]);
  });
});
