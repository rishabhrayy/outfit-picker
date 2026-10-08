import { describe, expect, it } from 'vitest';

import {
  corePair,
  deriveFeedback,
  filterWardrobeForOutfit,
  localOutfit,
  packForTrip,
  pairKey,
  planOutfitsForDays,
  shuffleOutfit,
} from '../src/lib/outfit.js';
import { normalizeOutfitRecord, normalizeWardrobeItem } from '../src/types.js';

const item = (id, category, extra = {}) => ({ id, category, colors: [], styleTags: [], seasons: [], ...extra });

const closet = [
  item('t1', 'top'), item('t2', 'top'), item('t3', 'top'), item('t4', 'top'),
  item('b1', 'bottom'), item('b2', 'bottom'), item('b3', 'bottom'),
  item('s1', 'shoes'), item('s2', 'shoes'),
  item('o1', 'outerwear', { seasons: ['cold', 'winter'] }),
];
const byId = new Map(closet.map((entry) => [entry.id, entry]));
const seeded = (seed = 1) => () => {
  // Small deterministic generator so "random" tests are repeatable.
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const many = (count, fn) => Array.from({ length: count }, (unused, index) => fn(index));

describe('out of rotation', () => {
  it('is never suggested, shuffled or ranked', () => {
    const closetWithLaundry = closet.map((entry) => (entry.id === 't1' ? { ...entry, unavailable: 'laundry' } : entry));
    expect(filterWardrobeForOutfit(closetWithLaundry).map((entry) => entry.id)).not.toContain('t1');
    many(40, (seed) => expect(shuffleOutfit(closetWithLaundry, {}, 7, seeded(seed + 1)).itemIds).not.toContain('t1'));
  });

  it('is still used when asked for by name', () => {
    const closetWithLaundry = closet.map((entry) => (entry.id === 't1' ? { ...entry, unavailable: 'laundry' } : entry));
    expect(localOutfit(closetWithLaundry, { requiredItemId: 't1' }).itemIds).toContain('t1');
  });

  it('is stored only with a known reason, and empty otherwise', () => {
    expect(normalizeWardrobeItem({ category: 'top', unavailable: 'repair' }).unavailable).toBe('repair');
    expect(normalizeWardrobeItem({ category: 'top', unavailable: 'stolen by the cat' }).unavailable).toBe('');
    expect(normalizeWardrobeItem({ category: 'top' }).unavailable).toBe('');
  });
});

describe('love it / never again', () => {
  it('rules out the defining pair, not every piece in the outfit', () => {
    expect(corePair(['t1', 'b1', 's1'], byId)).toBe(pairKey('b1', 't1'));
    const dresses = new Map([['d1', item('d1', 'dress')], ['s1', item('s1', 'shoes')]]);
    expect(corePair(['d1', 's1'], dresses)).toBe(pairKey('d1', 's1'));
    expect(corePair(['s1'], byId)).toBeNull();
  });

  it('turns records into feedback, and ignores worn and planned ones', () => {
    const feedback = deriveFeedback([
      { status: 'rejected', itemIds: ['t1', 'b1', 's1'] },
      { status: 'loved', itemIds: ['t2', 'b2', 's2'] },
      { status: 'loved', itemIds: ['t2', 'b3', 'gone'] },
      { status: 'worn', itemIds: ['t3', 'b3'] },
    ], closet);
    expect([...feedback.blockedPairs]).toEqual([pairKey('t1', 'b1')]);
    expect(feedback.lovedCounts.get('t2')).toBe(2);
    expect(feedback.lovedCounts.has('t3')).toBe(false);
    expect(feedback.lovedOutfits).toEqual([['t2', 'b2', 's2'], ['t2', 'b3']]);
  });

  it('never shuffles a ruled-out pairing while another exists', () => {
    const small = [item('t1', 'top'), item('b1', 'bottom'), item('b2', 'bottom'), item('s1', 'shoes')];
    const feedback = { blockedPairs: new Set([pairKey('t1', 'b1')]), lovedCounts: new Map(), lovedOutfits: [] };
    many(60, (seed) => {
      const ids = shuffleOutfit(small, { feedback }, 7, seeded(seed + 1)).itemIds;
      expect(ids).toContain('b2');
      expect(ids).not.toContain('b1');
    });
    expect(localOutfit(small, { feedback }).itemIds).toEqual(expect.arrayContaining(['t1', 'b2', 's1']));
  });

  it('still makes an outfit when every pairing has been ruled out', () => {
    const tiny = [item('t1', 'top'), item('b1', 'bottom'), item('s1', 'shoes')];
    const feedback = { blockedPairs: new Set([pairKey('t1', 'b1')]), lovedCounts: new Map(), lovedOutfits: [] };
    expect(localOutfit(tiny, { feedback }).itemIds).toHaveLength(3);
  });

  it('nudges loved pieces up the ranking, but not past the weather', () => {
    const feedback = { blockedPairs: new Set(), lovedCounts: new Map([['t2', 1]]), lovedOutfits: [] };
    const ranked = filterWardrobeForOutfit(closet, { feedback }).filter((entry) => entry.category === 'top');
    expect(ranked[0].id).toBe('t2');

    const seasonal = [item('warm', 'top', { seasons: ['summer'] }), item('loved', 'top', { seasons: ['winter'] })];
    const lovedALot = { blockedPairs: new Set(), lovedCounts: new Map([['loved', 9]]), lovedOutfits: [] };
    expect(filterWardrobeForOutfit(seasonal, { weather: 'hot', feedback: lovedALot })[0].id).toBe('warm');
  });

  it('stores loved and rejected as their own statuses, and new sources', () => {
    expect(normalizeOutfitRecord({ itemIds: ['a'], status: 'loved', source: 'photo' })).toMatchObject({ status: 'loved', source: 'photo' });
    expect(normalizeOutfitRecord({ itemIds: ['a'], status: 'rejected', source: 'week' })).toMatchObject({ status: 'rejected', source: 'week' });
    expect(normalizeOutfitRecord({ itemIds: ['a'], status: 'bogus' }).status).toBe('worn');
  });
});

describe('plan my week', () => {
  const week = many(7, (index) => ({ date: `2026-10-${String(12 + index).padStart(2, '0')}`, weather: 'mild', occasion: 'Work' }));

  it('gives every day a complete outfit and its own date', () => {
    const plan = planOutfitsForDays(closet, week, { random: seeded(3) });
    expect(plan.map((day) => day.date)).toEqual(week.map((day) => day.date));
    plan.forEach((day) => {
      const categories = day.itemIds.map((id) => byId.get(id).category);
      expect(categories).toEqual(expect.arrayContaining(['top', 'bottom', 'shoes']));
    });
  });

  it('does not repeat a top or bottom until every one has been worn', () => {
    const plan = planOutfitsForDays(closet, week, { random: seeded(5) });
    const firstFourTops = plan.slice(0, 4).map((day) => day.itemIds.find((id) => id.startsWith('t')));
    expect(new Set(firstFourTops).size).toBe(4);
    const firstThreeBottoms = plan.slice(0, 3).map((day) => day.itemIds.find((id) => id.startsWith('b')));
    expect(new Set(firstThreeBottoms).size).toBe(3);
  });

  it('adds a layer on a cold or rainy day', () => {
    const [cold] = planOutfitsForDays(closet, [{ date: '2026-10-12', weather: 'cold' }], { random: () => 0 });
    expect(cold.itemIds).toContain('o1');
  });

  it('skips pieces that are out of rotation', () => {
    const away = closet.map((entry) => (entry.id === 'b1' ? { ...entry, unavailable: 'cleaning' } : entry));
    planOutfitsForDays(away, week, { random: seeded(9) }).forEach((day) => expect(day.itemIds).not.toContain('b1'));
  });
});

describe('pack for a trip', () => {
  const days = (count, weather = 'mild', extra = {}) => many(count, (index) => ({ date: `2026-11-${String(index + 1).padStart(2, '0')}`, weather, ...extra }));

  it('packs fewer pieces than days of outfits, re-wearing bottoms and shoes', () => {
    const { packingList, outfits } = packForTrip(closet, days(6));
    expect(outfits).toHaveLength(6);
    const count = (category) => packingList.filter((entry) => entry.category === category).length;
    expect(count('bottom')).toBe(2);
    expect(count('shoes')).toBe(2);
    expect(count('top')).toBe(4);
    expect(packingList.length).toBeLessThan(6 * 3);
  });

  it('only wears what was packed, and every day is complete', () => {
    const { packingList, outfits } = packForTrip(closet, days(5));
    const packed = new Set(packingList.map((entry) => entry.id));
    outfits.forEach((day) => {
      day.itemIds.forEach((id) => expect(packed.has(id)).toBe(true));
      expect(day.itemIds.map((id) => byId.get(id).category)).toEqual(expect.arrayContaining(['top', 'bottom', 'shoes']));
    });
  });

  it('packs one layer when any day is cold or wet, and wears it only then', () => {
    const mixed = [...days(2, 'warm'), { date: '2026-11-03', weather: 'cold' }];
    const { packingList, outfits } = packForTrip(closet, mixed);
    expect(packingList.map((entry) => entry.id)).toContain('o1');
    expect(outfits[0].itemIds).not.toContain('o1');
    expect(outfits[2].itemIds).toContain('o1');
    expect(packForTrip(closet, days(3, 'warm')).packingList.map((entry) => entry.id)).not.toContain('o1');
  });

  it('prefers neutral colours, which pair with more', () => {
    const bottoms = [item('loud', 'bottom', { colors: ['orange'] }), item('plain', 'bottom', { colors: ['navy'] })];
    const { packingList } = packForTrip([...bottoms, item('t', 'top'), item('s', 'shoes')], days(2));
    expect(packingList.map((entry) => entry.id)).toContain('plain');
    expect(packingList.map((entry) => entry.id)).not.toContain('loud');
  });

  it('keeps the packed items free of internal scoring fields', () => {
    const { packingList } = packForTrip(closet, days(2));
    packingList.forEach((entry) => expect(Object.keys(entry).some((key) => key.startsWith('_'))).toBe(false));
  });

  it('returns nothing for no days', () => {
    expect(packForTrip(closet, [])).toEqual({ packingList: [], outfits: [] });
  });
});

describe('colour harmony in the instant pick', () => {
  it('sorts colour words into families, with neutrals going with anything', async () => {
    const { colourFamily, colourHarmony, outfitHarmony } = await import('../src/lib/outfit.js');
    expect(['navy', 'light blue', 'Burgundy', 'denim', 'sage', 'hot pink', 'plaid'].map(colourFamily)).toEqual(['neutral', 'blue', 'red', 'neutral', 'green', 'pink', null]);
    const red = item('r', 'top', { colors: ['red'] });
    const orange = item('o', 'bottom', { colors: ['orange'] });
    const navy = item('n', 'bottom', { colors: ['navy'] });
    const maroon = item('m', 'bottom', { colors: ['maroon'] });
    const green = item('g', 'bottom', { colors: ['green'] });
    expect(colourHarmony(red, orange)).toBe(-3);
    expect(colourHarmony(red, navy)).toBe(1);
    expect(colourHarmony(red, maroon)).toBe(1);
    expect(colourHarmony(red, green)).toBe(-3);
    expect(colourHarmony(red, item('b', 'bottom', { colors: ['blue'] }))).toBe(0);
    expect(colourHarmony(red, item('x', 'bottom'))).toBe(1);
    expect(outfitHarmony([red, orange, item('p', 'shoes', { colors: ['pink'] })])).toBeLessThan(outfitHarmony([red, navy, item('w', 'shoes', { colors: ['white'] })]));
  });

  it('never pairs a clash when a neutral is there, even if the clashing piece ranks higher', () => {
    const closetWithColour = [
      item('red-top', 'top', { colors: ['red'], seasons: ['summer'] }),
      item('orange-shorts', 'bottom', { colors: ['orange'], seasons: ['summer'] }),
      item('navy-jeans', 'bottom', { colors: ['navy'] }),
      item('white-shoes', 'shoes', { colors: ['white'] }),
    ];
    // Orange shorts match the hot weather and navy jeans don't, so on weather
    // alone the shorts would win.
    expect(localOutfit(closetWithColour, { weather: 'hot', requiredItemId: 'red-top' }).itemIds).toContain('navy-jeans');
    many(40, (seed) => {
      expect(shuffleOutfit(closetWithColour, { weather: 'hot', requiredItemId: 'red-top' }, 7, seeded(seed + 1)).itemIds).not.toContain('orange-shorts');
    });
  });

  it('picks shoes that go with the top and bottom', () => {
    const shoesCloset = [
      item('pink-top', 'top', { colors: ['pink'] }),
      item('jeans', 'bottom', { colors: ['denim'] }),
      item('red-shoes', 'shoes', { colors: ['red'] }),
      item('black-shoes', 'shoes', { colors: ['black'] }),
    ];
    expect(localOutfit(shoesCloset).itemIds).toContain('black-shoes');
  });
});
