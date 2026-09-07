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
  savePhotoBatches,
  updateItem as updateStoredItem,
} from './lib/db.js';
import { prepareImage } from './lib/image.js';
import { suggestOutfit as requestOutfit, tagPhoto as requestTags } from './lib/ai.js';
import { makeWardrobePromptItems } from './lib/outfit.js';
import { getActiveProvider, updateProvider } from './lib/settings.js';
import { normalizeSeasons, normalizeWeatherSuitability, toLocalDateString } from './types.js';

/**
 * A provider set to "auto" JSON mode gets probed once, on its first real call,
 * and whatever tier actually worked is pinned so every later call goes
 * straight there instead of re-trying schema/object/text every single time.
 */
function pinResolvedJsonMode(provider, resolvedMode) {
  if (provider?.jsonMode === 'auto' && resolvedMode && resolvedMode !== 'auto') {
    updateProvider(provider.id, { jsonMode: resolvedMode });
  }
}

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
  const provider = getActiveProvider();
  const result = await requestTags(file, { provider });
  pinResolvedJsonMode(provider, result.jsonMode);
  return result;
}

/**
 * Saves one or more photos and every reviewed item that points back at them.
 *
 * Each stored photo is the re-encoded JPEG from the tagging step, so a 10 MB
 * HEIC off a phone does not sit in browser storage forever. Images are prepared
 * before the write starts, because the whole batch is written in a single
 * IndexedDB transaction that must not be interrupted by an await.
 */
export async function savePhotoItems(groups) {
  const list = Array.isArray(groups) ? groups : [groups];
  const prepared = await Promise.all(
    list.map(async ({ file, sourcePhotoId, items }) => {
      const { blob } = await prepareImage(file);
      return {
        blob,
        photo: { id: sourcePhotoId, blob, name: file?.name || '', mimeType: blob.type || 'image/jpeg' },
        items: items.map((item) => toStoredItem(item, sourcePhotoId)),
      };
    }),
  );

  const saved = await savePhotoBatches(prepared);

  return saved.flatMap((batch, index) =>
    batch.items.map((item) => ({ ...toAppItem(item), photo: prepared[index].blob })),
  );
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

/**
 * Trims a ranked wardrobe to the shortlist that gets sent for styling.
 *
 * A flat slice is wrong here: the ranking breaks ties alphabetically by
 * category, so "shoes" and "top" sort last and are the first things a plain
 * top-N drops — exactly the two categories a complete outfit cannot do without.
 * Taking rank order round-robin across categories keeps every category
 * represented while still preferring the best-scoring pieces in each.
 */
function shortlistCandidates(items, limit) {
  if (items.length <= limit) return items;

  const byCategory = new Map();
  items.forEach((item) => {
    const bucket = byCategory.get(item.category) || [];
    bucket.push(item);
    byCategory.set(item.category, bucket);
  });

  const buckets = [...byCategory.values()];
  const chosen = new Set();
  for (let depth = 0; chosen.size < limit; depth += 1) {
    let addedThisPass = false;
    for (const bucket of buckets) {
      if (depth >= bucket.length) continue;
      chosen.add(bucket[depth].id);
      addedThisPass = true;
      if (chosen.size >= limit) break;
    }
    if (!addedThisPass) break;
  }

  // Keep the original ranking order so the strongest pieces are listed first.
  return items.filter((item) => chosen.has(item.id));
}

export async function suggestOutfit({ items, preferences = {}, excludedItemIds = [], avoidRecentDays = 7 }) {
  const provider = getActiveProvider();
  const wantedItemId = preferences.wantedItemId || '';
  const candidates = makeWardrobePromptItems(shortlistCandidates(items, MAX_CANDIDATES), avoidRecentDays);

  const result = await requestOutfit({
    candidates,
    preferences,
    // A re-roll must still honour a specifically requested item.
    excludedItemIds: excludedItemIds.filter((id) => id !== wantedItemId),
    avoidRecentDays,
    today: toLocalDateString(),
    provider,
  });
  pinResolvedJsonMode(provider, result.jsonMode);
  return result;
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
