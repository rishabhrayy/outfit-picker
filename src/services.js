/**
 * Wires the presentational app to browser storage and the selected AI provider.
 *
 * This is the only module that knows about both sides, so the UI never touches
 * IndexedDB or fetch directly, and the storage layer never sees view state such
 * as object URLs or blobs held in memory.
 */

import {
  clearAll,
  deleteItem as deleteStoredItem,
  deleteOrphanPhotos,
  getItems,
  getPhotos,
  saveItems,
  savePhoto,
  updateItem as updateStoredItem,
} from './lib/db.js';
import { prepareImage } from './lib/image.js';
import { suggestOutfit as requestOutfit, tagPhoto as requestTags } from './lib/ai.js';
import { makeWardrobePromptItems } from './lib/outfit.js';
import { getApiKey, getProvider } from './lib/settings.js';
import { normalizeSeasons, normalizeWeatherSuitability, toLocalDateString } from './types.js';

// The model is asked to choose from a shortlist rather than the whole wardrobe,
// which keeps the request small once a closet grows past a hundred pieces.
const MAX_CANDIDATES = 60;

/**
 * Storage keeps seasons and weather apart; the forms show one combined field.
 */
function toAppItem(item, photos) {
  const photo = photos?.get(item.sourcePhotoId) || null;

  return {
    id: item.id,
    sourcePhotoId: item.sourcePhotoId,
    photo: photo?.blob || null,
    category: item.category,
    colors: item.colors,
    styleTags: item.styleTags,
    seasons: [...item.seasons, ...item.weatherSuitability],
    notes: item.notes,
    lastWornDate: item.lastWornDate || '',
    crop: item.crop,
  };
}

function toStoredItem(item, sourcePhotoId) {
  return {
    id: item.id,
    sourcePhotoId: sourcePhotoId || item.sourcePhotoId,
    category: item.category,
    colors: item.colors,
    styleTags: item.styleTags,
    seasons: normalizeSeasons(item.seasons),
    weatherSuitability: normalizeWeatherSuitability(item.seasons),
    notes: item.notes,
    lastWornDate: item.lastWornDate,
    crop: item.crop,
  };
}

async function attachPhotos(items) {
  const photos = await getPhotos(items.map((item) => item.sourcePhotoId));
  return items.map((item) => toAppItem(item, photos));
}

export async function listItems() {
  return attachPhotos(await getItems());
}

export async function tagPhoto(file) {
  const providerId = getProvider();
  return requestTags(file, { apiKey: getApiKey(providerId), providerId });
}

/**
 * Saves the photo once and every reviewed item that points back at it.
 *
 * The stored photo is the re-encoded JPEG from the tagging step, so a 10 MB
 * HEIC from a phone does not sit in browser storage forever.
 */
export async function savePhotoItems({ file, sourcePhotoId, items }) {
  const { blob } = await prepareImage(file);
  const photo = await savePhoto({
    id: sourcePhotoId,
    blob,
    name: file?.name || '',
    mimeType: blob.type || 'image/jpeg',
  });

  const saved = await saveItems(items.map((item) => toStoredItem(item, photo.id)));
  return saved.map((item) => ({ ...toAppItem(item), photo: blob }));
}

export async function updateItem(item) {
  const updated = await updateStoredItem(item.id, toStoredItem(item));
  if (!updated) {
    throw new Error('That item is no longer in your wardrobe.');
  }

  return { ...toAppItem(updated), photo: item.photo || null };
}

export async function deleteItem(id) {
  await deleteStoredItem(id);
  // The photo may have held several items; drop it once the last one is gone.
  await deleteOrphanPhotos();
}

export async function markItemsWorn(ids, date) {
  const lastWornDate = date || toLocalDateString();
  for (const id of ids) {
    await updateStoredItem(id, { lastWornDate });
  }
}

export async function clearWardrobe() {
  await clearAll();
}

export async function suggestOutfit({ items, preferences = {}, excludedItemIds = [], avoidRecentDays = 7 }) {
  const providerId = getProvider();
  const wantedItemId = preferences.wantedItemId || '';
  const candidates = makeWardrobePromptItems(items.slice(0, MAX_CANDIDATES), avoidRecentDays);

  return requestOutfit({
    candidates,
    preferences,
    // A re-roll must still honour a specifically requested item.
    excludedItemIds: excludedItemIds.filter((id) => id !== wantedItemId),
    avoidRecentDays,
    today: toLocalDateString(),
    apiKey: getApiKey(providerId),
    providerId,
  });
}

export const services = {
  listItems,
  tagPhoto,
  savePhotoItems,
  updateItem,
  deleteItem,
  markItemsWorn,
  clearWardrobe,
  suggestOutfit,
};

export default services;
