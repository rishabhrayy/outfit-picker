/**
 * Shared browser-side data shapes and normalizers for Outfit Picker.
 * Records deliberately use plain objects so they can be structured-cloned into
 * IndexedDB without a serialization library.
 */

export const ITEM_CATEGORIES = Object.freeze([
  'top',
  'bottom',
  'dress',
  'outerwear',
  'shoes',
  'accessory',
]);

// Short aliases make these convenient to consume from components.
export const CATEGORIES = ITEM_CATEGORIES;

export const SEASONS = Object.freeze([
  'spring',
  'summer',
  'autumn',
  'winter',
  'all-season',
]);

export const SEASON_OPTIONS = SEASONS;

export const WEATHER_SUITABILITY = Object.freeze([
  'cold',
  'cool',
  'mild',
  'warm',
  'hot',
  'rainy',
  'windy',
]);

export const WEATHER_OPTIONS = WEATHER_SUITABILITY;

const CATEGORY_ALIASES = new Map([
  ['top', 'top'],
  ['tops', 'top'],
  ['shirt', 'top'],
  ['t shirt', 'top'],
  ['t-shirt', 'top'],
  ['tee', 'top'],
  ['blouse', 'top'],
  ['sweater', 'top'],
  ['jumper', 'top'],
  ['hoodie', 'top'],
  ['bottom', 'bottom'],
  ['bottoms', 'bottom'],
  ['pants', 'bottom'],
  ['trousers', 'bottom'],
  ['jeans', 'bottom'],
  ['shorts', 'bottom'],
  ['skirt', 'bottom'],
  ['dress', 'dress'],
  ['gown', 'dress'],
  ['jumpsuit', 'dress'],
  ['romper', 'dress'],
  ['outerwear', 'outerwear'],
  ['jacket', 'outerwear'],
  ['coat', 'outerwear'],
  ['blazer', 'outerwear'],
  ['cardigan', 'outerwear'],
  ['shoes', 'shoes'],
  ['shoe', 'shoes'],
  ['footwear', 'shoes'],
  ['sneakers', 'shoes'],
  ['boots', 'shoes'],
  ['sandals', 'shoes'],
  ['accessory', 'accessory'],
  ['accessories', 'accessory'],
  ['bag', 'accessory'],
  ['jewellery', 'accessory'],
  ['jewelry', 'accessory'],
  ['hat', 'accessory'],
  ['scarf', 'accessory'],
  ['belt', 'accessory'],
]);

const SEASON_ALIASES = new Map([
  ['spring', 'spring'],
  ['summer', 'summer'],
  ['autumn', 'autumn'],
  ['fall', 'autumn'],
  ['winter', 'winter'],
  ['all season', 'all-season'],
  ['all-season', 'all-season'],
  ['all seasons', 'all-season'],
  ['year round', 'all-season'],
  ['year-round', 'all-season'],
  ['any', 'all-season'],
]);

const WEATHER_ALIASES = new Map([
  ['cold', 'cold'],
  ['freezing', 'cold'],
  ['cool', 'cool'],
  ['mild', 'mild'],
  ['temperate', 'mild'],
  ['warm', 'warm'],
  ['hot', 'hot'],
  ['rain', 'rainy'],
  ['rainy', 'rainy'],
  ['wet', 'rainy'],
  ['windy', 'windy'],
  ['wind', 'windy'],
]);

function cleanString(value, maxLength = 120) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function cleanId(value, prefix) {
  const cleaned = cleanString(value, 160).replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned || createId(prefix);
}

function normalizeTimestamp(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function isBlobLike(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof value.arrayBuffer === 'function'
      && typeof value.size === 'number',
  );
}

/**
 * Creates a local, collision-resistant identifier without any dependency.
 */
export function createId(prefix = 'record') {
  const safePrefix = cleanString(prefix, 40).replace(/[^a-zA-Z0-9_-]/g, '') || 'record';
  const uuid = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : [Date.now().toString(36), Math.random().toString(36).slice(2, 12)].join('-');

  return [safePrefix, uuid].join('_');
}

/**
 * Uses local calendar time rather than UTC, which is important for "last worn".
 */
export function toLocalDateString(date = new Date()) {
  const dateValue = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(dateValue.getTime())) {
    return null;
  }

  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, '0');
  const day = String(dateValue.getDate()).padStart(2, '0');
  return [year, month, day].join('-');
}

export function normalizeDate(value) {
  if (value instanceof Date) {
    return toLocalDateString(value);
  }

  const cleaned = cleanString(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return null;
  }

  const parsed = new Date(cleaned + 'T12:00:00');
  return Number.isNaN(parsed.getTime()) ? null : cleaned;
}

export function normalizeTextList(value, { maxItems = 16, maxLength = 80 } = {}) {
  const values = Array.isArray(value) ? value : [value];
  const seen = new Set();

  return values
    .map((entry) => cleanString(entry, maxLength))
    .filter(Boolean)
    .filter((entry) => {
      const key = entry.toLocaleLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

export function normalizeCategory(value, fallback = 'accessory') {
  const normalized = cleanString(value).toLocaleLowerCase();
  return CATEGORY_ALIASES.get(normalized) || fallback;
}

export function normalizeSeasons(value) {
  const values = Array.isArray(value) ? value : [value];
  const seen = new Set();

  values.forEach((entry) => {
    const season = SEASON_ALIASES.get(cleanString(entry).toLocaleLowerCase());
    if (season) {
      seen.add(season);
    }
  });

  return [...seen];
}

export function normalizeWeatherSuitability(value) {
  const values = Array.isArray(value) ? value : [value];
  const seen = new Set();

  values.forEach((entry) => {
    const weather = WEATHER_ALIASES.get(cleanString(entry).toLocaleLowerCase());
    if (weather) {
      seen.add(weather);
    }
  });

  return [...seen];
}

export function normalizeCrop(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);

  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }

  return {
    x,
    y,
    width,
    height,
    unit: value.unit === 'pixels' ? 'pixels' : 'percent',
  };
}

/**
 * Strictly normalizes the smaller shape returned by image tagging.
 * It returns null when a category cannot be mapped to the app's six categories.
 */
export function normalizeDetectedItem(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const category = normalizeCategory(value.category, null);
  if (!category) {
    return null;
  }

  return {
    category,
    colors: normalizeTextList(firstDefined(value.colors, value.color)),
    styleTags: normalizeTextList(
      firstDefined(value.styleTags, value.style_tags, value.styles, value.style),
    ),
    seasons: normalizeSeasons(
      firstDefined(value.seasons, value.seasonSuitability, value.season_suitability),
    ),
    weatherSuitability: normalizeWeatherSuitability(
      firstDefined(value.weatherSuitability, value.weather_suitability, value.weather),
    ),
  };
}

/**
 * Produces the canonical item record stored in IndexedDB.
 *
 * sourcePhotoId is nullable while a confirmation form is being edited, but
 * saveItem/saveItems require it before persistence.
 */
export function normalizeWardrobeItem(value = {}, { now = new Date() } = {}) {
  const timestamp = normalizeTimestamp(now, new Date().toISOString());
  const detected = normalizeDetectedItem(value);

  return {
    id: cleanId(value.id, 'item'),
    sourcePhotoId: cleanString(firstDefined(value.sourcePhotoId, value.source_photo_id), 160) || null,
    category: detected ? detected.category : normalizeCategory(value.category),
    colors: detected ? detected.colors : normalizeTextList(firstDefined(value.colors, value.color)),
    styleTags: detected
      ? detected.styleTags
      : normalizeTextList(firstDefined(value.styleTags, value.style_tags, value.styles, value.style)),
    seasons: detected
      ? detected.seasons
      : normalizeSeasons(firstDefined(value.seasons, value.seasonSuitability, value.season_suitability)),
    weatherSuitability: detected
      ? detected.weatherSuitability
      : normalizeWeatherSuitability(
        firstDefined(value.weatherSuitability, value.weather_suitability, value.weather),
      ),
    notes: cleanString(value.notes, 4_000),
    lastWornDate: normalizeDate(firstDefined(value.lastWornDate, value.last_worn_date)),
    crop: normalizeCrop(firstDefined(value.crop, value.cropRect, value.crop_rect)),
    createdAt: normalizeTimestamp(value.createdAt, timestamp),
    updatedAt: normalizeTimestamp(value.updatedAt, timestamp),
  };
}

/**
 * Produces the canonical photo record. The Blob itself stays in IndexedDB.
 */
export function normalizePhotoRecord(value = {}, { now = new Date() } = {}) {
  const source = isBlobLike(value) ? { blob: value } : value || {};
  const timestamp = normalizeTimestamp(now, new Date().toISOString());
  const blob = source.blob || null;
  const blobType = isBlobLike(blob) ? cleanString(blob.type, 120) : '';

  return {
    id: cleanId(source.id, 'photo'),
    blob,
    name: cleanString(firstDefined(source.name, source.fileName, source.filename), 255),
    mimeType: cleanString(firstDefined(source.mimeType, source.type, blobType), 120)
      || 'application/octet-stream',
    size: isBlobLike(blob) ? blob.size : Number(source.size) || 0,
    createdAt: normalizeTimestamp(source.createdAt, timestamp),
    updatedAt: normalizeTimestamp(source.updatedAt, timestamp),
  };
}

export const normalizeItem = normalizeWardrobeItem;
export const normalizePhoto = normalizePhotoRecord;
