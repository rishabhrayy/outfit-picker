/**
 * Backup and restore for a wardrobe that otherwise lives only in this browser.
 *
 * A backup is one JSON file: every item, outfit record and photo (photos as
 * base64), so it can be restored here after clearing site data, or on another
 * device. API keys live in localStorage, not IndexedDB, so they are never part
 * of a backup and cannot leak through a shared file.
 */

import { readAll, writeAll } from './db.js';

export const BACKUP_FORMAT = 'outfit-picker-backup';
export const BACKUP_VERSION = 1;

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // String.fromCharCode takes arguments, so convert in chunks to stay under the call-stack limit
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

export function backupFileName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `outfit-picker-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

/** Reads the whole wardrobe into a plain, JSON-ready backup object. */
export async function createBackup({ now = new Date() } = {}) {
  const { photos, items, outfits } = await readAll();
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    photos: await Promise.all(
      photos.map(async ({ blob, ...meta }) => ({ ...meta, data: blob ? await blobToBase64(blob) : '' })),
    ),
    items,
    outfits,
  };
}

/** Checks a file's text is a backup this version can read, with a plain-English error if not. */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not an Outfit Picker backup (it is not valid JSON).');
  }
  if (data?.format !== BACKUP_FORMAT) {
    throw new Error('That file is not an Outfit Picker backup.');
  }
  if (!Number.isInteger(data.version) || data.version > BACKUP_VERSION) {
    throw new Error('This backup was made by a newer version of Outfit Picker. Update the app, then try again.');
  }
  for (const key of ['photos', 'items', 'outfits']) {
    if (!Array.isArray(data[key])) throw new Error(`This backup is damaged: "${key}" is missing.`);
  }
  return data;
}

/**
 * Restores a parsed backup on top of what is already here. Matching ids are
 * replaced and everything else is kept, so restoring never deletes anything.
 * Items whose photo is missing from the file are skipped rather than saved broken.
 */
export async function restoreBackup(data) {
  const photos = data.photos
    .filter((photo) => photo?.id && photo.data)
    .map(({ data: base64, ...meta }) => ({ ...meta, blob: base64ToBlob(base64, meta.mimeType || 'image/jpeg') }));
  const photoIds = new Set(photos.map((photo) => photo.id));
  const items = data.items.filter((item) => item?.sourcePhotoId && photoIds.has(item.sourcePhotoId));
  const counts = await writeAll({ photos, items, outfits: data.outfits.filter(Boolean) });
  return { ...counts, skipped: data.items.length - items.length };
}
