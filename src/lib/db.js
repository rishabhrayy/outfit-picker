import {
  normalizePhotoRecord,
  normalizeWardrobeItem,
} from '../types.js';

export const DB_NAME = 'outfit-picker';
export const DB_VERSION = 1;
export const PHOTO_STORE = 'photos';
export const ITEM_STORE = 'items';

let databasePromise;

function ensureIndexedDb() {
  if (!globalThis.indexedDB) {
    throw new Error(
      'IndexedDB is unavailable in this browser. Outfit Picker needs browser storage to save a wardrobe.',
    );
  }
}

function isBlobLike(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof value.arrayBuffer === 'function'
      && typeof value.size === 'number',
  );
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted.'));
  });
}

function ensureIndex(store, name, keyPath, options = {}) {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath, options);
  }
}

function upgradeDatabase(database, transaction) {
  const photos = database.objectStoreNames.contains(PHOTO_STORE)
    ? transaction.objectStore(PHOTO_STORE)
    : database.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
  const items = database.objectStoreNames.contains(ITEM_STORE)
    ? transaction.objectStore(ITEM_STORE)
    : database.createObjectStore(ITEM_STORE, { keyPath: 'id' });

  ensureIndex(photos, 'createdAt', 'createdAt');
  ensureIndex(items, 'category', 'category');
  ensureIndex(items, 'sourcePhotoId', 'sourcePhotoId');
  ensureIndex(items, 'lastWornDate', 'lastWornDate');
  ensureIndex(items, 'createdAt', 'createdAt');
}

/**
 * Opens Outfit Picker's local IndexedDB database. It is cached per page load.
 */
export function openDatabase() {
  ensureIndexedDb();

  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      upgradeDatabase(request.result, request.transaction);
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };

    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error || new Error('Could not open Outfit Picker storage.'));
    };

    request.onblocked = () => {
      databasePromise = undefined;
      reject(new Error('Outfit Picker storage is open in another tab. Close that tab and try again.'));
    };
  });

  return databasePromise;
}

export const getDatabase = openDatabase;

async function withTransaction(storeNames, mode, work) {
  const database = await openDatabase();
  const transaction = database.transaction(storeNames, mode);
  const completed = transactionToPromise(transaction);

  try {
    const result = await work(transaction);
    await completed;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // It may already have completed or aborted after the original failure.
    }

    try {
      await completed;
    } catch {
      // Preserve the more useful request/work error below.
    }

    throw error;
  }
}

function requireSourcePhoto(item) {
  if (!item.sourcePhotoId) {
    throw new Error('A wardrobe item must have a sourcePhotoId before it can be saved.');
  }
}

function normalizeSavedItem(value, now = new Date()) {
  const item = normalizeWardrobeItem(value, { now });
  requireSourcePhoto(item);
  return item;
}

/**
 * Saves a Blob/File plus lightweight metadata. Returns the canonical photo record.
 *
 * Examples:
 *   savePhoto(file)
 *   savePhoto(blob, { name: 'look.jpg', mimeType: 'image/jpeg' })
 *   savePhoto({ id, blob, name })
 */
export async function savePhoto(photoOrBlob, metadata = {}) {
  const rawPhoto = isBlobLike(photoOrBlob)
    ? { ...metadata, blob: photoOrBlob }
    : { ...(photoOrBlob || {}), ...metadata };
  const photo = normalizePhotoRecord(rawPhoto);

  if (!isBlobLike(photo.blob)) {
    throw new Error('savePhoto expects a Blob or File in the photo record.');
  }

  return withTransaction(PHOTO_STORE, 'readwrite', async (transaction) => {
    await requestToPromise(transaction.objectStore(PHOTO_STORE).put(photo));
    return photo;
  });
}

/**
 * Returns a photo record, including its Blob, or null if it no longer exists.
 */
export async function getPhoto(id) {
  if (!id) {
    return null;
  }

  return withTransaction(PHOTO_STORE, 'readonly', async (transaction) => {
    const photo = await requestToPromise(transaction.objectStore(PHOTO_STORE).get(id));
    return photo ? normalizePhotoRecord(photo) : null;
  });
}

export async function saveItem(value) {
  const item = normalizeSavedItem(value);

  return withTransaction(ITEM_STORE, 'readwrite', async (transaction) => {
    await requestToPromise(transaction.objectStore(ITEM_STORE).put(item));
    return item;
  });
}

/**
 * Saves all items in one atomic transaction. If any item lacks a source photo,
 * nothing is written.
 */
export async function saveItems(values) {
  if (!Array.isArray(values)) {
    throw new Error('saveItems expects an array of wardrobe items.');
  }

  const now = new Date();
  const items = values.map((value) => normalizeSavedItem(value, now));

  return withTransaction(ITEM_STORE, 'readwrite', async (transaction) => {
    const store = transaction.objectStore(ITEM_STORE);
    await Promise.all(items.map((item) => requestToPromise(store.put(item))));
    return items;
  });
}

/**
 * Saves several photos and all of their items in one atomic transaction.
 *
 * Used by bulk upload: either the whole batch lands or none of it does, so a
 * failure part-way through cannot leave items pointing at a missing photo.
 *
 * Every record is normalized BEFORE the transaction opens, and every put is
 * issued in the same tick. An await inside an IndexedDB transaction lets it
 * auto-commit, which would silently drop the remaining writes.
 */
export async function savePhotoBatches(batches) {
  if (!Array.isArray(batches)) {
    throw new Error('savePhotoBatches expects an array of { photo, items } batches.');
  }

  const now = new Date();
  const prepared = batches.map(({ photo, items }) => {
    const photoRecord = normalizePhotoRecord(photo, { now });
    if (!isBlobLike(photoRecord.blob)) {
      throw new Error('Every batch needs a photo with a Blob before it can be saved.');
    }

    return {
      photo: photoRecord,
      items: (items || []).map((item) => normalizeSavedItem({ ...item, sourcePhotoId: photoRecord.id }, now)),
    };
  });

  return withTransaction([PHOTO_STORE, ITEM_STORE], 'readwrite', async (transaction) => {
    const photoStore = transaction.objectStore(PHOTO_STORE);
    const itemStore = transaction.objectStore(ITEM_STORE);
    const writes = [];

    prepared.forEach(({ photo, items }) => {
      writes.push(requestToPromise(photoStore.put(photo)));
      items.forEach((item) => writes.push(requestToPromise(itemStore.put(item))));
    });

    await Promise.all(writes);
    return prepared;
  });
}

/**
 * Gets all stored wardrobe items, newest first. Pass { category } to filter locally.
 */
export async function getItems({ category } = {}) {
  return withTransaction(ITEM_STORE, 'readonly', async (transaction) => {
    const store = transaction.objectStore(ITEM_STORE);
    const request = category && store.indexNames.contains('category')
      ? store.index('category').getAll(category)
      : store.getAll();
    const items = await requestToPromise(request);

    return items
      .map((item) => normalizeWardrobeItem(item))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  });
}

export async function getItem(id) {
  if (!id) {
    return null;
  }

  return withTransaction(ITEM_STORE, 'readonly', async (transaction) => {
    const item = await requestToPromise(transaction.objectStore(ITEM_STORE).get(id));
    return item ? normalizeWardrobeItem(item) : null;
  });
}

/**
 * Applies a partial update while preserving immutable id, sourcePhotoId, and createdAt
 * unless the caller explicitly supplies a replacement sourcePhotoId.
 * Returns null when the item does not exist.
 */
export async function updateItem(id, changes = {}) {
  if (!id) {
    throw new Error('updateItem requires an item id.');
  }

  return withTransaction(ITEM_STORE, 'readwrite', async (transaction) => {
    const store = transaction.objectStore(ITEM_STORE);
    const existing = await requestToPromise(store.get(id));
    if (!existing) {
      return null;
    }

    const updated = normalizeSavedItem(
      {
        ...existing,
        ...(changes || {}),
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      },
      new Date(),
    );

    await requestToPromise(store.put(updated));
    return updated;
  });
}

/**
 * Deletes the item record only. Its source photo remains because another item can
 * reference it (for example, a top and shoes detected in the same outfit photo).
 */
export async function deleteItem(id) {
  if (!id) {
    return false;
  }

  return withTransaction(ITEM_STORE, 'readwrite', async (transaction) => {
    const store = transaction.objectStore(ITEM_STORE);
    const existing = await requestToPromise(store.get(id));
    if (!existing) {
      return false;
    }

    await requestToPromise(store.delete(id));
    return true;
  });
}

/**
 * Loads several photos at once and returns a Map keyed by photo id.
 *
 * Items that were detected in the same photo share one record, so the wardrobe
 * grid asks for far fewer photos than it has items.
 */
export async function getPhotos(ids) {
  const wanted = [...new Set((ids || []).filter(Boolean))];
  if (!wanted.length) {
    return new Map();
  }

  return withTransaction(PHOTO_STORE, 'readonly', async (transaction) => {
    const store = transaction.objectStore(PHOTO_STORE);
    const photos = await Promise.all(wanted.map((id) => requestToPromise(store.get(id))));

    return new Map(
      photos
        .filter(Boolean)
        .map((photo) => {
          const normalized = normalizePhotoRecord(photo);
          return [normalized.id, normalized];
        }),
    );
  });
}

/**
 * Removes photo blobs that no item points at any more.
 *
 * deleteItem deliberately leaves the photo behind, because a sibling item
 * detected in the same picture may still need it. This reclaims the space once
 * the last of those siblings is gone.
 */
export async function deleteOrphanPhotos() {
  return withTransaction([PHOTO_STORE, ITEM_STORE], 'readwrite', async (transaction) => {
    const photoStore = transaction.objectStore(PHOTO_STORE);
    const [photoIds, items] = await Promise.all([
      requestToPromise(photoStore.getAllKeys()),
      requestToPromise(transaction.objectStore(ITEM_STORE).getAll()),
    ]);

    const referenced = new Set(items.map((item) => item.sourcePhotoId).filter(Boolean));
    const orphans = photoIds.filter((id) => !referenced.has(id));
    await Promise.all(orphans.map((id) => requestToPromise(photoStore.delete(id))));
    return orphans.length;
  });
}

/**
 * Clears every stored wardrobe item and photo in a single transaction.
 */
export async function clearAll() {
  return withTransaction([PHOTO_STORE, ITEM_STORE], 'readwrite', async (transaction) => {
    await Promise.all([
      requestToPromise(transaction.objectStore(PHOTO_STORE).clear()),
      requestToPromise(transaction.objectStore(ITEM_STORE).clear()),
    ]);
  });
}
