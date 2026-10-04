import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { backupFileName, createBackup, parseBackup, restoreBackup } from '../src/lib/backup.js';
import { clearAll, getItems, getOutfitRecords, getPhoto, saveItem, saveOutfitRecord, savePhoto } from '../src/lib/db.js';

const pixels = new Uint8Array(70_000).map((_, index) => (index * 31) % 256); // bigger than one conversion chunk

async function seed() {
  await savePhoto({ id: 'photo-1', blob: new Blob([pixels], { type: 'image/jpeg' }), name: 'mirror.jpg' });
  await saveItem({ id: 'item-1', sourcePhotoId: 'photo-1', category: 'top', colors: ['navy'], styleTags: ['smart'] });
  await saveItem({ id: 'item-2', sourcePhotoId: 'photo-1', category: 'shoes', colors: ['white'] });
  await saveOutfitRecord({ id: 'outfit-1', date: '2026-09-30', itemIds: ['item-1', 'item-2'], status: 'worn' });
}

describe('backup and restore', () => {
  beforeEach(async () => {
    await clearAll();
  });

  it('round-trips items, outfits and photo bytes exactly', async () => {
    await seed();
    const backup = JSON.parse(JSON.stringify(await createBackup()));
    await clearAll();
    expect(await getItems()).toHaveLength(0);

    const counts = await restoreBackup(parseBackup(JSON.stringify(backup)));
    expect(counts).toMatchObject({ photos: 1, items: 2, outfits: 1, skipped: 0 });

    const items = await getItems();
    expect(items.map((item) => item.id).sort()).toEqual(['item-1', 'item-2']);
    expect(items.find((item) => item.id === 'item-1').colors).toEqual(['navy']);
    expect((await getOutfitRecords()).map((record) => record.id)).toEqual(['outfit-1']);

    const photo = await getPhoto('photo-1');
    expect(new Uint8Array(await photo.blob.arrayBuffer())).toEqual(pixels);
    expect(photo.mimeType).toBe('image/jpeg');
  });

  it('restoring twice replaces by id instead of duplicating', async () => {
    await seed();
    const backup = await createBackup();
    await restoreBackup(backup);
    await restoreBackup(backup);
    expect(await getItems()).toHaveLength(2);
  });

  it('keeps what is already here when restoring an older backup', async () => {
    await seed();
    const backup = await createBackup();
    await savePhoto({ id: 'photo-2', blob: new Blob([pixels.slice(0, 10)], { type: 'image/jpeg' }) });
    await saveItem({ id: 'item-3', sourcePhotoId: 'photo-2', category: 'bottom' });
    await restoreBackup(backup);
    expect((await getItems()).map((item) => item.id).sort()).toEqual(['item-1', 'item-2', 'item-3']);
  });

  it('skips items whose photo is missing from the file', async () => {
    await seed();
    const backup = await createBackup();
    backup.items.push({ id: 'orphan', sourcePhotoId: 'gone', category: 'top' });
    await clearAll();
    const counts = await restoreBackup(backup);
    expect(counts.skipped).toBe(1);
    expect((await getItems()).map((item) => item.id)).not.toContain('orphan');
  });

  it('never contains API keys', async () => {
    await seed();
    const text = JSON.stringify(await createBackup());
    expect(text).not.toMatch(/apiKey|sk-[A-Za-z0-9]/);
  });

  it('rejects files that are not a backup, with a readable reason', () => {
    expect(() => parseBackup('not json')).toThrow(/not valid JSON/);
    expect(() => parseBackup('{"hello":1}')).toThrow(/not an Outfit Picker backup/);
    expect(() => parseBackup(JSON.stringify({ format: 'outfit-picker-backup', version: 99, photos: [], items: [], outfits: [] }))).toThrow(/newer version/);
    expect(() => parseBackup(JSON.stringify({ format: 'outfit-picker-backup', version: 1, photos: [], items: [] }))).toThrow(/outfits/);
  });

  it('names the file by date', () => {
    expect(backupFileName(new Date(2026, 9, 4))).toBe('outfit-picker-backup-2026-10-04.json');
  });
});
