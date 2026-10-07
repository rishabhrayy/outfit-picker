import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { bulkUpdateItems as bulkUpdateStored, clearAll, getItems, saveItem, savePhoto } from '../src/lib/db.js';
import { bulkUpdateItems } from '../src/services.js';

async function seed() {
  await savePhoto({ id: 'p1', blob: new Blob(['x'], { type: 'image/jpeg' }) });
  await saveItem({ id: 'a', sourcePhotoId: 'p1', category: 'top', styleTags: ['casual'], seasons: ['summer'], weatherSuitability: ['warm'] });
  await saveItem({ id: 'b', sourcePhotoId: 'p1', category: 'bottom', styleTags: ['smart'], seasons: ['autumn'], weatherSuitability: ['cool'] });
  await saveItem({ id: 'c', sourcePhotoId: 'p1', category: 'shoes', styleTags: ['sport'] });
}

const byId = async () => Object.fromEntries((await getItems()).map((item) => [item.id, item]));

describe('bulk edit in storage', () => {
  beforeEach(async () => {
    await clearAll();
    await seed();
  });

  it('adds a tag to each item’s own tags when given a function, instead of replacing them', async () => {
    await bulkUpdateStored(['a', 'b'], (item) => ({ styleTags: [...item.styleTags, 'date-night'] }));
    const items = await byId();

    expect(items.a.styleTags).toEqual(['casual', 'date-night']);
    expect(items.b.styleTags).toEqual(['smart', 'date-night']);
    expect(items.c.styleTags).toEqual(['sport']); // not selected, not touched
  });

  it('applies a plain object identically to every item, which replaces rather than merges', async () => {
    // This is exactly why "add a tag" needs the function form above.
    await bulkUpdateStored(['a', 'b'], { styleTags: ['x'] });
    const items = await byId();
    expect(items.a.styleTags).toEqual(['x']);
    expect(items.b.styleTags).toEqual(['x']);
  });

  it('skips ids that no longer exist and does nothing for an empty selection', async () => {
    const updated = await bulkUpdateStored(['a', 'ghost'], { notes: 'hi' });
    expect(updated.map((item) => item.id)).toEqual(['a']);
    expect(await bulkUpdateStored([], { notes: 'x' })).toEqual([]);
    expect(await bulkUpdateStored(undefined, {})).toEqual([]);
    expect(Object.keys(await byId()).sort()).toEqual(['a', 'b', 'c']); // no "ghost" record appeared
  });

  it('keeps an item’s identity and creation date, and moves its updated time', async () => {
    const before = (await byId()).a;
    await new Promise((resolve) => setTimeout(resolve, 5));

    await bulkUpdateStored(['a'], { id: 'hijack', createdAt: '2000-01-01T00:00:00.000Z', notes: 'n' });
    const items = await byId();

    expect(items.hijack).toBeUndefined();
    expect(items.a.createdAt).toBe(before.createdAt);
    expect(items.a.updatedAt > before.updatedAt).toBe(true);
    expect(items.a.notes).toBe('n');
  });

  it('writes nothing if the patch fails part-way through the selection', async () => {
    await expect(bulkUpdateStored(['a', 'b'], (item) => {
      if (item.id === 'b') throw new Error('boom');
      return { notes: 'changed' };
    })).rejects.toThrow('boom');

    expect((await byId()).a.notes).toBe('');
  });
});

describe('bulk edit through the app’s services', () => {
  beforeEach(async () => {
    await clearAll();
    await seed();
  });

  it('hands a function the item as the app sees it, with season and weather combined and no photo', async () => {
    let seen;
    const updated = await bulkUpdateItems(['a'], (item) => {
      seen = item;
      return { notes: 'n' };
    });

    expect(seen.seasons).toEqual(['summer', 'warm']);
    expect(seen.photo).toBeNull();
    expect(updated[0]).toMatchObject({ id: 'a', seasons: ['summer', 'warm'], notes: 'n', photo: null });
  });

  it('splits a season change back into the stored season and weather fields', async () => {
    await bulkUpdateItems(['a', 'b'], { seasons: ['winter', 'cold'] });
    const items = await byId();

    for (const id of ['a', 'b']) {
      expect(items[id].seasons).toEqual(['winter']);
      expect(items[id].weatherSuitability).toEqual(['cold']);
    }
    expect(items.c.seasons).toEqual([]);
  });

  it('can add one season while keeping each item’s weather', async () => {
    await bulkUpdateItems(['a'], (item) => ({ seasons: [...item.seasons, 'winter'] }));
    const { a } = await byId();
    expect(a.seasons).toEqual(['summer', 'winter']);
    expect(a.weatherSuitability).toEqual(['warm']);
  });

  it('drops words outside the season and weather vocabulary instead of storing them', async () => {
    await bulkUpdateItems(['a'], { seasons: ['winter', 'tropical-vibes'] });
    const { a } = await byId();
    expect(a.seasons).toEqual(['winter']);
    expect(a.weatherSuitability).toEqual([]);
  });
});
