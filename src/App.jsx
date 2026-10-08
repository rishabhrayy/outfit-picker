import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, CalendarDays, CalendarRange, Camera, CloudSun, Footprints, Gem, Heart, History,
  ArrowLeft, ArrowRight, Layers, LayoutGrid, Lock, Plane, Plus, RefreshCw, Settings, Shirt, Shuffle, Sparkles, X,
} from 'lucide-react';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  controlsFromCrop,
  cropFromControls,
  coverLayout,
  spotlightStyle,
} from './lib/crop.js';
import {
  EMPTY_FEEDBACK,
  computeWardrobeStats,
  deriveFeedback,
  filterWardrobeForOutfit,
  isAvailable,
  isRecentlyWorn,
  isCompleteOutfit,
  localOutfit,
  missingForCompleteOutfit,
  occasionKey,
  packForTrip,
  planOutfitsForDays,
  shuffleOutfit,
} from './lib/outfit.js';
import {
  MAX_FORECAST_DAYS,
  currentRoundedPosition,
  describeDay,
  fetchForecast,
  forecastNote,
  searchPlaces,
} from './lib/weather.js';
import { BUILTIN_PRESET_ID, DEFAULT_PRESET_ID, PROVIDER_PRESETS, detectKeyMismatch, getPreset } from './lib/providers.js';
import { exhaustedUntil, isExhausted, testProvider, usageToday } from './lib/ai.js';
import {
  canUseShareSheet,
  isIosStandalone,
  pickShareableFile,
  shareCandidates,
  shareFile,
} from './lib/shareFile.js';
import {
  MAX_REPEAT_DAYS,
  addProvider,
  deleteProvider,
  getActiveProviderId,
  getLastBackupAt,
  getOutfitPreferences,
  getProviders,
  getRepeatDays,
  getWeatherLocation,
  hasAnyProvider,
  setActiveProviderId,
  setLastBackupAt,
  shouldNudgeBackup,
  snoozeBackupNudge,
  setOutfitPreferences,
  setRepeatDays,
  setWeatherLocation,
  updateProvider,
} from './lib/settings.js';
import './App.css';

const EMPTY_SERVICES = {};
const CATEGORIES = ['top', 'bottom', 'dress', 'outerwear', 'shoes', 'accessory'];
const CATEGORY_META = {
  top: { label: 'Tops', Icon: Shirt },
  bottom: { label: 'Bottoms', Icon: TrousersIcon },
  dress: { label: 'Dresses', Icon: DressIcon },
  outerwear: { label: 'Layers', Icon: Layers },
  shoes: { label: 'Shoes', Icon: Footprints },
  accessory: { label: 'Extras', Icon: Gem },
};

// Lucide has no trousers or dress, so these two are drawn on its 24px grid
// with the same 2px rounded strokes.
function TrousersIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M7 3h10l1.5 18h-4.2L12 10l-2.3 11H5.5Z" />
      <path d="M7 6.5h10" />
    </svg>
  );
}

function DressIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 3v3.5L7.5 10 4.5 21h15L16.5 10 15 6.5V3" />
      <path d="M9 6.5c1 .8 2 1.2 3 1.2s2-.4 3-1.2" />
    </svg>
  );
}

function CategoryIcon({ category }) {
  const Icon = CATEGORY_META[category]?.Icon || Shirt;
  return <Icon className="category-icon" strokeWidth={1.5} aria-hidden="true" />;
}
const OCCASIONS = ['Everyday', 'Work', 'Dinner', 'Date night', 'Event', 'Active'];
const VIBES = ['Easy', 'Polished', 'Playful', 'Minimal', 'Sporty', 'Bold'];
const WEATHER_OPTIONS = [
  { value: 'cold', label: 'Cold', temperature: 6 },
  { value: 'cool', label: 'Cool', temperature: 14 },
  { value: 'mild', label: 'Mild', temperature: 20 },
  { value: 'warm', label: 'Warm', temperature: 26 },
  { value: 'hot', label: 'Hot', temperature: 32 },
];

// Season and weather are stored as a controlled vocabulary, so anything outside
// this list is dropped on save. Style tags are the place for free-form words.
// Shared by the item editor's hint text and bulk-edit's "set season" action.
const SEASON_WEATHER_VALUES = ['spring', 'summer', 'autumn', 'winter', 'all-season', 'cold', 'cool', 'mild', 'warm', 'hot', 'rainy', 'windy'];
const SEASON_HINT = `Recognised: ${SEASON_WEATHER_VALUES.join(', ')}`;

// Why a piece is out of rotation. Suggestions, shuffles and plans skip it.
const UNAVAILABLE_OPTIONS = [
  { value: 'laundry', label: 'In the wash', short: 'In the wash' },
  { value: 'cleaning', label: 'At the dry cleaner', short: 'Dry cleaning' },
  { value: 'repair', label: 'Needs repair', short: 'Needs repair' },
  { value: 'away', label: 'Lent out or packed away', short: 'Away' },
];
const unavailableLabel = (reason) => UNAVAILABLE_OPTIONS.find((option) => option.value === reason)?.short || '';

// Each photo costs one vision call and one decode, so a batch is bounded to keep
// tagging time and peak memory predictable on a phone.
const MAX_BATCH_PHOTOS = 20;

function uid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function asList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function normalizeItem(item = {}) {
  return {
    id: item.id || uid(),
    sourcePhotoId: item.sourcePhotoId || item.source_photo_id || uid(),
    photo: item.photo || item.photoBlob || item.blob || null,
    imageUrl: item.imageUrl || item.photoUrl || item.previewUrl || item.url || '',
    category: CATEGORIES.includes(item.category) ? item.category : 'top',
    colors: asList(item.colors),
    styleTags: asList(item.styleTags || item.style_tags || item.tags),
    seasons: asList(item.seasons || item.season || item.weatherSuitability || item.weather_suitability),
    notes: item.notes || '',
    lastWornDate: item.lastWornDate || item.last_worn_date || '',
    pricePaid: Number(item.pricePaid) > 0 ? Number(item.pricePaid) : null,
    unavailable: UNAVAILABLE_OPTIONS.some((option) => option.value === item.unavailable) ? item.unavailable : '',
    crop: item.crop || null,
  };
}

/**
 * A date plus the items worn or planned for it. Local re-normalizer, same
 * reasoning as normalizeItem above: the UI shouldn't trust the storage
 * layer's exact shape, and this keeps every outfit-record field a defined,
 * predictable type no matter where the record came from.
 */
function normalizeOutfitEntry(record = {}) {
  return {
    id: record.id || uid(),
    date: record.date || localDate(),
    itemIds: Array.isArray(record.itemIds) ? record.itemIds.filter(Boolean) : [],
    status: ['planned', 'loved', 'rejected'].includes(record.status) ? record.status : 'worn',
    source: record.source || 'manual',
    explanation: record.explanation || '',
    occasion: record.occasion || '',
  };
}

function displayCategory(category) {
  return CATEGORY_META[category]?.label || category;
}

function localDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}


function formatDate(value) {
  if (!value) return 'Never worn';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function addDays(dateString, count) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + count);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function weekday(dateString) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(`${dateString}T12:00:00`));
}

const isWeekend = (dateString) => [0, 6].includes(new Date(`${dateString}T12:00:00`).getDay());

const BUSY_RETRY_DELAY_MS = 5000;

/**
 * Runs an AI call, and if the provider says it's busy (503) or rate-limiting
 * (429) even after its own fallback model, waits a few seconds and tries once
 * more. Gemini's free tier gave "high demand" on both models at once during
 * testing, and it usually clears within seconds.
 */
async function retryWhenBusy(call, onWaiting) {
  try {
    return await call();
  } catch (error) {
    // A used-up daily allowance won't come back in five seconds.
    if ((error?.status !== 503 && error?.status !== 429) || error.dailyQuota) throw error;
    onWaiting?.();
    await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
    return call();
  }
}

// One forecast per place, reused across the Outfit and Journal screens for
// half an hour, so switching tabs doesn't re-ask the weather service.
const forecastCache = new Map();
const FORECAST_TTL_MS = 30 * 60_000;

async function loadForecast(location) {
  const key = `${location.latitude},${location.longitude}`;
  const cached = forecastCache.get(key);
  if (cached && Date.now() - cached.at < FORECAST_TTL_MS) return cached.days;
  const days = await fetchForecast(location, { days: MAX_FORECAST_DAYS });
  forecastCache.set(key, { at: Date.now(), days });
  return days;
}

/** The forecast for a saved location: { days, error }, or nothing while off. */
function useForecast(location) {
  const [state, setState] = useState({ days: null, error: '' });
  const latitude = location?.latitude;
  const longitude = location?.longitude;

  useEffect(() => {
    if (latitude === undefined || longitude === undefined) {
      setState({ days: null, error: '' });
      return undefined;
    }
    let isCurrent = true;
    loadForecast({ latitude, longitude })
      .then((days) => { if (isCurrent) setState({ days, error: '' }); })
      .catch((error) => { if (isCurrent) setState({ days: null, error: error.message }); });
    return () => { isCurrent = false; };
  }, [latitude, longitude]);

  return state;
}

function itemImage(item, blobUrls) {
  return item.imageUrl || blobUrls[item.id] || '';
}

/**
 * Narrows the wardrobe before anything is sent for styling: season and weather
 * first, then occasion and vibe overlap, with recently worn pieces pushed down.
 */
function suggestionFilters(preferences, feedback) {
  return {
    weather: preferences.weather,
    rain: Boolean(preferences.rain),
    occasion: occasionKey(preferences.occasion),
    vibe: preferences.vibe,
    requiredItemId: preferences.wantedItemId,
    feedback,
  };
}

function shortlistForSuggestion(items, preferences, repeatDays, excludedItemIds, feedback) {
  const wanted = preferences.wantedItemId;
  const shortlist = filterWardrobeForOutfit(items, suggestionFilters(preferences, feedback), repeatDays);

  // A re-roll skips the previous suggestion, but never a piece the user asked for.
  return shortlist.filter((item) => item.id === wanted || !excludedItemIds.includes(item.id));
}

/**
 * Renders one item from its source photo. Several items can share a photo, so
 * the item's own crop is applied here rather than stored as separate pixels.
 */
function Photo({ item, blobUrls, className = '', alt = '' }) {
  const src = itemImage(item, blobUrls);
  if (!src) {
    return (
      <div className={`photo-placeholder ${className}`} aria-label={alt || 'No photo available'}>
        <CategoryIcon category={item.category} />
      </div>
    );
  }
  return <CroppedImage src={src} crop={item.crop} alt={alt} className={className} />;
}

/**
 * Draws just the cropped part of a photo, filling a frame of any shape. A crop
 * can be any rectangle (tall for trousers, wide for shoes), so the layout is
 * worked out from the photo's real size and the frame's real size rather than
 * one CSS zoom. With no crop it's an ordinary cover-fit image.
 */
function CroppedImage({ src, crop, alt = '', className = '' }) {
  const frameRef = useRef(null);
  const imageRef = useRef(null);
  const [frame, setFrame] = useState(null);
  const [natural, setNatural] = useState(null);
  const hasCrop = Boolean(crop && Number(crop.width) > 0 && Number(crop.width) < 99.5);

  useEffect(() => {
    if (!hasCrop || !frameRef.current) return undefined;
    const element = frameRef.current;
    const measure = () => setFrame({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [hasCrop]);

  // A cached image can finish loading before React attaches onLoad.
  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth) setNatural({ width: image.naturalWidth, height: image.naturalHeight });
  }, [src]);

  const layout = hasCrop && frame && natural
    ? coverLayout({ naturalWidth: natural.width, naturalHeight: natural.height, frameWidth: frame.width, frameHeight: frame.height, crop })
    : null;

  let style;
  if (layout) {
    style = { position: 'absolute', maxWidth: 'none', objectFit: 'fill', width: layout.width, height: layout.height, left: layout.left, top: layout.top };
  } else if (hasCrop) {
    // Hidden for the moment before it's measured, rather than flashing the whole photo.
    style = { opacity: 0 };
  }

  return (
    <span className={`photo-frame ${className}`} ref={frameRef}>
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        style={style}
        onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      />
    </span>
  );
}

/**
 * Shows an item's photo in full, with a highlighted box over just the region
 * it was tagged from — the opposite move from Photo above, which zooms in
 * and hides the rest. Used in the item editor, where there's room to show the
 * whole outfit photo an item came from instead of a tight crop. Falls back to
 * the ordinary zoomed view when there is nothing meaningful to highlight (no
 * crop yet, or a photo that only ever held this one item).
 */
function PhotoSpotlight({ item, blobUrls, className = '' }) {
  const src = itemImage(item, blobUrls);
  const box = spotlightStyle(item.crop);
  const alt = `${displayCategory(item.category)} item`;

  if (!src) {
    return (
      <div className={`photo-placeholder ${className}`} aria-label={alt}>
        <CategoryIcon category={item.category} />
      </div>
    );
  }

  if (!box) {
    return <Photo item={item} blobUrls={blobUrls} className={className} alt={alt} />;
  }

  // The box is positioned in percent, so it sits on a wrapper exactly the
  // image's size; letterboxing the image inside a fixed frame would put the
  // highlight in the wrong place.
  return (
    <span className={`photo-spotlight ${className}`}>
      <span className="spotlight-stage">
        <img src={src} alt={`${alt}, highlighted within the photo it was tagged from`} />
        <span className="spotlight-box" style={box} />
      </span>
    </span>
  );
}

function CropControls({ crop, onChange, idPrefix }) {
  const controls = controlsFromCrop(crop);
  const update = (changes) => onChange(cropFromControls({ ...controls, ...changes }));

  return (
    <div className="crop-controls" aria-label="Crop controls">
      <label htmlFor={`${idPrefix}-zoom`}>Zoom</label>
      <input
        id={`${idPrefix}-zoom`}
        type="range"
        min={MIN_ZOOM}
        max={MAX_ZOOM}
        step="0.05"
        value={controls.zoom}
        onChange={(event) => update({ zoom: Number(event.target.value) })}
      />
      <label htmlFor={`${idPrefix}-x`}>Left / right</label>
      <input
        id={`${idPrefix}-x`}
        type="range"
        min="0"
        max="100"
        value={controls.x}
        disabled={controls.zoom <= MIN_ZOOM}
        onChange={(event) => update({ x: Number(event.target.value) })}
      />
      <label htmlFor={`${idPrefix}-y`}>Up / down</label>
      <input
        id={`${idPrefix}-y`}
        type="range"
        min="0"
        max="100"
        value={controls.y}
        disabled={controls.zoom <= MIN_ZOOM}
        onChange={(event) => update({ y: Number(event.target.value) })}
      />
      <button
        className="text-button crop-reset"
        type="button"
        disabled={controls.zoom <= MIN_ZOOM}
        onClick={() => onChange(null)}
      >
        Reset crop
      </button>
    </div>
  );
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const describeCounts = ({ items, photos, outfits }) =>
  `${plural(items, 'item')}, ${plural(photos, 'photo')} and ${plural(outfits, 'outfit')}`;

/**
 * Main presentational app shell.
 *
 * Optional service contract for the data/API layer:
 * - listItems(): Promise<Item[]>
 * - tagPhoto(file): Promise<Item[] | { items: Item[], model?: string }>
 * - savePhotoItems({ file, sourcePhotoId, items }): Promise<Item[]>
 * - updateItem(item): Promise<Item>
 * - deleteItem(id): Promise<void>
 * - suggestOutfit({ items, preferences, excludedItemIds, avoidRecentDays }):
 *   Promise<{ itemIds: string[], explanation: string }>
 * - markItemsWorn(ids, date): Promise<void>
 * - clearWardrobe(): Promise<void>
 * - exportBackup(): Promise<{ blob: Blob, fileName: string, counts: object }>
 * - importBackup(file): Promise<{ items: number, photos: number, outfits: number, skipped: number }>
 */
export default function App({ services = EMPTY_SERVICES, initialItems = [], reloadKey = 0 }) {
  const [items, setItems] = useState(() => initialItems.map(normalizeItem));
  // Reading a wardrobe out of IndexedDB is async, so without this the empty
  // state flashes on every cold launch and tells a stocked wardrobe it is empty.
  const [isLoading, setIsLoading] = useState(() => Boolean(services.listItems));
  const [outfitRecords, setOutfitRecords] = useState([]);
  // Opens on Today: the outfit is the point, the wardrobe is how it gets there.
  const [activeTab, setActiveTab] = useState('outfit');
  const [editingItem, setEditingItem] = useState(null);
  const [toast, setToastState] = useState(null);
  const [blobUrls, setBlobUrls] = useState({});
  // null | 'edit' | 'build' — the wardrobe grid's multi-select mode. Bulk-edit
  // and the manual outfit builder share this one mode rather than each having
  // their own selection UI; which action bar shows depends on the purpose.
  const [wardrobeMode, setWardrobeMode] = useState(null);
  // The ids a manually built outfit is being saved from, or null when the
  // save-a-look modal is closed.
  const [buildingItemIds, setBuildingItemIds] = useState(null);
  // Bumped after a restore so the wardrobe and journal re-read storage
  const [restoredAt, setRestoredAt] = useState(0);
  const [weatherLocation, setWeatherLocationState] = useState(getWeatherLocation);
  // The "today's outfit photo" sheet, opened from Outfit or Journal.
  const [photoCheckOpen, setPhotoCheckOpen] = useState(false);
  // "Love it" / "never again" records, turned into what suggestions use.
  const feedback = useMemo(() => deriveFeedback(outfitRecords, items), [outfitRecords, items]);
  // How many times each piece has been worn, for the wardrobe's sorting.
  const wornCounts = useMemo(() => {
    const counts = new Map();
    outfitRecords.filter((record) => record.status === 'worn').forEach((record) => {
      record.itemIds.forEach((id) => counts.set(id, (counts.get(id) || 0) + 1));
    });
    return counts;
  }, [outfitRecords]);

  const changeWeatherLocation = (location) => {
    setWeatherLocation(location);
    setWeatherLocationState(getWeatherLocation());
  };

  /**
   * Switches tabs and always drops any in-progress wardrobe selection, so a
   * half-finished bulk-edit or outfit build never lingers into an unrelated
   * screen. Entering build mode on purpose (Outfit tab's "Build it myself",
   * Journal's "Plan an outfit") goes around this on purpose — see below.
   */
  const goToTab = (tab) => {
    setActiveTab(tab);
    setWardrobeMode(null);
  };

  const startBuildingOutfit = () => {
    setActiveTab('wardrobe');
    setWardrobeMode('build');
  };

  useEffect(() => {
    let isCurrent = true;
    if (!services.listItems) return undefined;
    services.listItems()
      .then((loaded) => {
        if (isCurrent) setItems((loaded || []).map(normalizeItem));
      })
      .catch((error) => {
        if (isCurrent) setToast(error?.message || 'Your wardrobe could not be loaded right now.');
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });
    return () => { isCurrent = false; };
  }, [services, reloadKey, restoredAt]);

  useEffect(() => {
    let isCurrent = true;
    if (!services.getOutfitRecords) return undefined;
    services.getOutfitRecords()
      .then((loaded) => {
        if (isCurrent) setOutfitRecords((loaded || []).map(normalizeOutfitEntry));
      })
      .catch(() => {
        // The journal is a nice-to-have view, not core storage — a failure
        // here should not interrupt anything else the app is doing.
      });
    return () => { isCurrent = false; };
  }, [services, reloadKey, restoredAt]);

  // One object URL per PHOTO, not per item: a full-outfit shot backs several
  // items, and a bulk upload multiplies that. Keying by photo also means editing
  // one item no longer revokes and remints every URL in the wardrobe.
  useEffect(() => {
    const created = {};
    const byPhoto = {};
    items.forEach((item) => {
      if (item.imageUrl || !(item.photo instanceof Blob)) return;
      const photoKey = item.sourcePhotoId || item.id;
      if (!created[photoKey]) created[photoKey] = URL.createObjectURL(item.photo);
      byPhoto[item.id] = created[photoKey];
    });
    setBlobUrls(byPhoto);
    return () => Object.values(created).forEach((url) => URL.revokeObjectURL(url));
  }, [items]);

  /**
   * Undo instead of "Are you sure?". A deleting action changes the screen at
   * once and only really happens (commit) when its toast goes away, so Undo
   * just puts things back. An action that's already saved instead passes an
   * undo that reverses it. Either way only one undo is offered at a time: a
   * newer toast commits the older one, and so does leaving the app.
   */
  const pendingUndoRef = useRef(null);

  const flushPendingUndo = () => {
    const pending = pendingUndoRef.current;
    pendingUndoRef.current = null;
    if (pending?.commit) {
      Promise.resolve(pending.commit()).catch((error) => setToastState({ id: Date.now(), message: error?.message || 'That change could not be saved.' }));
    }
  };

  const setToast = (message) => {
    flushPendingUndo();
    setToastState(message ? { id: Date.now(), message } : null);
  };

  const showUndo = (message, { commit, undo }) => {
    flushPendingUndo();
    const id = Date.now();
    pendingUndoRef.current = { id, commit, undo };
    setToastState({ id, message, undoable: true });
  };

  const undoLast = () => {
    const pending = pendingUndoRef.current;
    pendingUndoRef.current = null;
    setToastState(null);
    pending?.undo?.();
  };

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => {
      if (pendingUndoRef.current?.id === toast.id) flushPendingUndo();
      setToastState(null);
    }, toast.undoable ? 6000 : 3400);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  // Closing or backgrounding the app keeps whatever wasn't undone.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushPendingUndo(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flushPendingUndo);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flushPendingUndo);
    };
  }, []);

  const updateItem = async (nextItem) => {
    const normalized = normalizeItem(nextItem);
    try {
      const saved = services.updateItem ? normalizeItem(await services.updateItem(normalized)) : normalized;
      setItems((current) => current.map((item) => (item.id === normalized.id ? saved : item)));
      setToast('Saved to your wardrobe.');
      return saved;
    } catch (error) {
      setToast(error?.message || 'That change could not be saved.');
      throw error;
    }
  };

  /**
   * Takes pieces off the screen now and deletes them for real once the Undo
   * toast goes. Undo puts them back where they were in the list.
   */
  const removeItemsWithUndo = (ids, message) => {
    const before = items;
    const removed = before.filter((item) => ids.includes(item.id));
    if (!removed.length) return;
    setItems((current) => current.filter((item) => !ids.includes(item.id)));
    showUndo(message, {
      commit: async () => {
        for (const id of ids) await services.deleteItem?.(id);
      },
      undo: () => setItems((current) => {
        const byId = new Map(current.map((item) => [item.id, item]));
        removed.forEach((item) => byId.set(item.id, item));
        const added = current.filter((item) => !before.some((old) => old.id === item.id));
        return [...added, ...before.filter((item) => byId.has(item.id)).map((item) => byId.get(item.id))];
      }),
    });
  };

  const deleteItem = (id) => {
    setEditingItem(null);
    removeItemsWithUndo([id], 'Item deleted.');
  };

  /**
   * Takes one group per source photo, so a bulk upload lands as a single
   * all-or-nothing write rather than a photo at a time.
   */
  const saveBatch = async (groups) => {
    const list = Array.isArray(groups) ? groups : [groups];
    const prepared = list.map(({ file, sourcePhotoId, reviewedItems }) => ({
      file,
      sourcePhotoId,
      items: reviewedItems.map((item) => normalizeItem({ ...item, sourcePhotoId, photo: file })),
    }));
    const flat = prepared.flatMap((group) => group.items);

    try {
      const stored = services.savePhotoItems ? await services.savePhotoItems(prepared) : flat;
      const normalized = (stored || flat).map(normalizeItem);
      const photoCount = prepared.length;
      setItems((current) => [...normalized, ...current]);
      setToast(
        `${normalized.length} ${normalized.length === 1 ? 'item' : 'items'} added`
        + `${photoCount > 1 ? ` from ${photoCount} photos` : ''}.`,
      );
      setActiveTab('wardrobe');
      return normalized;
    } catch (error) {
      setToast(error?.message || 'Those items could not be saved.');
      throw error;
    }
  };

  const clearWardrobe = async () => {
    if (!window.confirm('Clear every saved item and photo from this device? This cannot be undone.')) return;
    try {
      await services.clearWardrobe?.();
      setItems([]);
      setOutfitRecords([]);
      setToast('Your wardrobe has been cleared.');
    } catch (error) {
      setToast(error?.message || 'Your wardrobe could not be cleared.');
    }
  };

  const restoreWardrobe = async (file) => {
    if (!file) return;
    try {
      const counts = await services.importBackup(file);
      setRestoredAt(Date.now());
      const skipped = counts.skipped ? ` ${plural(counts.skipped, 'item')} without a photo skipped.` : '';
      setToast(`Restored ${describeCounts(counts)}.${skipped}`);
    } catch (error) {
      setToast(error?.message || 'That backup could not be restored.');
    }
  };

  /**
   * Marks an outfit as worn: each item's lastWornDate, plus one journal
   * record. Saved straight away; Undo deletes the record and puts every
   * piece's previous last-worn date back.
   */
  const wearOutfit = async ({ itemIds, date, source, explanation, message = 'Marked as worn today.', onUndone }) => {
    const wornDate = date || localDate();
    const previous = new Map(items.filter((item) => itemIds.includes(item.id)).map((item) => [item.id, item.lastWornDate || '']));
    const record = await services.recordOutfitWorn?.({ itemIds, date: wornDate, source, explanation });
    setItems((current) => current.map((item) => (itemIds.includes(item.id) ? { ...item, lastWornDate: wornDate } : item)));
    if (record) setOutfitRecords((current) => [normalizeOutfitEntry(record), ...current]);

    showUndo(message, {
      undo: async () => {
        try {
          if (record) await services.deleteOutfitRecord?.(record.id);
          await services.bulkUpdateItems?.(itemIds, (item) => ({ lastWornDate: previous.get(item.id) || '' }));
          setItems((current) => current.map((item) => (previous.has(item.id) ? { ...item, lastWornDate: previous.get(item.id) } : item)));
          if (record) setOutfitRecords((current) => current.filter((entry) => entry.id !== record.id));
          onUndone?.();
        } catch (error) {
          setToast(error?.message || 'That couldn\'t be undone.');
        }
      },
    });
  };

  /**
   * Saves a manually built look — from Outfit's "Build it myself" or
   * Journal's "Plan an outfit," which both funnel into the same wardrobe
   * selection mode. A date of today saves it as worn now; any other date
   * plans it for later. Same modal, same handler, either way.
   */
  const saveLook = async ({ itemIds, date, occasion, explanation }) => {
    try {
      if (date === localDate()) {
        await wearOutfit({ itemIds, date, source: 'manual', explanation, message: 'Saved — marked as worn today.' });
      } else {
        const record = await services.planOutfit?.({ itemIds, date, occasion, explanation });
        if (record) setOutfitRecords((current) => [normalizeOutfitEntry(record), ...current]);
        setToast(`Planned for ${formatDate(date)}.`);
      }
      setBuildingItemIds(null);
      setWardrobeMode(null);
    } catch (error) {
      setToast(error?.message || 'That look could not be saved.');
    }
  };

  /** "Love it" or "never suggest this again" on a suggestion; Undo removes it. */
  const rateOutfit = async ({ itemIds, rating, source, explanation, message, onUndone }) => {
    const record = await services.rateOutfit?.({ itemIds, rating, source, explanation });
    if (!record) return;
    setOutfitRecords((current) => [normalizeOutfitEntry(record), ...current]);
    showUndo(message || (rating === 'loved' ? 'Loved.' : 'Won\'t be suggested again.'), {
      undo: async () => {
        try {
          await services.deleteOutfitRecord?.(record.id);
          setOutfitRecords((current) => current.filter((entry) => entry.id !== record.id));
          onUndone?.();
        } catch (error) {
          setToast(error?.message || 'That couldn\'t be undone.');
        }
      },
    });
  };

  /** Saves a week plan or trip as planned outfits, one record per day. */
  const savePlan = async (days, { source, occasion = '' }) => {
    try {
      const saved = [];
      for (const day of days) {
        if (!day.itemIds.length) continue;
        const record = await services.planOutfit?.({ itemIds: day.itemIds, date: day.date, occasion: day.occasion || occasion, source });
        if (record) saved.push(normalizeOutfitEntry(record));
      }
      setOutfitRecords((current) => [...saved, ...current]);
      setToast(`${plural(saved.length, 'outfit')} planned. They're in your journal.`);
      return true;
    } catch (error) {
      setToast(error?.message || 'That plan could not be saved.');
      return false;
    }
  };

  /** Adds common basics from the first-run guide, each with a drawn stand-in photo. */
  const quickAddBasics = async (basics) => {
    try {
      const groups = await Promise.all(basics.map(async (basic) => {
        const blob = await drawBasic(basic);
        const file = new File([blob], `${basic.key}.jpg`, { type: 'image/jpeg' });
        const sourcePhotoId = uid();
        return {
          file,
          sourcePhotoId,
          items: [normalizeItem({
            id: uid(), sourcePhotoId, photo: file, category: basic.category, colors: basic.colors,
            styleTags: basic.styleTags, seasons: basic.seasons, notes: basic.label,
          })],
        };
      }));
      const stored = services.savePhotoItems ? await services.savePhotoItems(groups) : groups.flatMap((group) => group.items);
      setItems((current) => [...(stored || []).map(normalizeItem), ...current]);
      setToast(`${plural(basics.length, 'piece')} added. Today is ready.`);
    } catch (error) {
      setToast(error?.message || 'Those pieces could not be added.');
    }
  };

  /** Marks pieces out of rotation (or back in), from the wardrobe or the editor. */
  const setAvailability = (ids, reason) => bulkUpdateWardrobe(ids, { unavailable: reason || '' });

  // "Allow again" for a ruled-out pairing: just removes the record, no confirm,
  // since it's as easy to rule out again.
  const removeOutfitRecordQuietly = async (id) => {
    try {
      await services.deleteOutfitRecord?.(id);
      setOutfitRecords((current) => current.filter((record) => record.id !== id));
    } catch (error) {
      setToast(error?.message || 'That could not be changed.');
    }
  };

  const deleteOutfitEntry = (id) => {
    const before = outfitRecords;
    const removed = before.find((record) => record.id === id);
    if (!removed) return;
    setOutfitRecords((current) => current.filter((record) => record.id !== id));
    showUndo('Removed from your journal.', {
      commit: () => services.deleteOutfitRecord?.(id),
      undo: () => setOutfitRecords((current) => {
        const index = before.indexOf(removed);
        const next = [...current];
        next.splice(Math.min(index, next.length), 0, removed);
        return next;
      }),
    });
  };

  /**
   * Applies one change (a tag, a season, a category) to several wardrobe
   * items at once. The service never returns a photo (bulk-edit never
   * touches sourcePhotoId), so the existing blob already held in state is
   * kept rather than dropped.
   */
  const bulkUpdateWardrobe = async (ids, changes) => {
    try {
      const updated = await services.bulkUpdateItems?.(ids, changes);
      const byId = new Map((updated || []).map((item) => [item.id, item]));
      setItems((current) => current.map((item) => {
        const next = byId.get(item.id);
        return next ? { ...normalizeItem(next), photo: item.photo } : item;
      }));
      setToast(`${ids.length} ${ids.length === 1 ? 'item' : 'items'} updated.`);
      setWardrobeMode(null);
    } catch (error) {
      setToast(error?.message || 'Those items could not be updated.');
    }
  };

  const bulkDeleteWardrobe = (ids) => {
    setWardrobeMode(null);
    removeItemsWithUndo(ids, `${plural(ids.length, 'item')} deleted.`);
  };

  return (
    <div className="outfit-app">
      <header className="app-header">
        <button className="brand" type="button" onClick={() => goToTab('wardrobe')} aria-label="Go to wardrobe">
          <span className="brand-mark">◐</span>
          <span>Outfit Picker</span>
        </button>
      </header>

      <main className="app-content">
        {activeTab === 'wardrobe' && (
          <WardrobeView
            isLoading={isLoading}
            items={items}
            blobUrls={blobUrls}
            onOpenItem={setEditingItem}
            onAdd={() => goToTab('upload')}
            onSuggest={() => goToTab('outfit')}
            mode={wardrobeMode}
            onSetMode={setWardrobeMode}
            onBulkUpdate={bulkUpdateWardrobe}
            onBulkDelete={bulkDeleteWardrobe}
            onBuildOutfit={setBuildingItemIds}
            onSetAvailability={setAvailability}
            wornCounts={wornCounts}
          />
        )}
        {activeTab === 'upload' && (
          <UploadView
            tagPhoto={services.tagPhoto}
            onSaveBatch={saveBatch}
            onCancel={() => goToTab('wardrobe')}
            onToast={setToast}
          />
        )}
        {activeTab === 'outfit' && (
          <OutfitView
            items={items}
            blobUrls={blobUrls}
            repeatDays={getRepeatDays()}
            onSuggest={services.suggestOutfit}
            onWearOutfit={wearOutfit}
            onRateOutfit={rateOutfit}
            onAdd={() => goToTab('upload')}
            onBuildOwn={startBuildingOutfit}
            onOpenPhotoCheck={() => setPhotoCheckOpen(true)}
            onToast={setToast}
            feedback={feedback}
            weatherLocation={weatherLocation}
            isLoading={isLoading}
            onOpenSettings={() => goToTab('settings')}
            onQuickAdd={quickAddBasics}
            onGoToBackup={() => {
              goToTab('settings');
              setTimeout(() => document.getElementById('backup')?.scrollIntoView({ block: 'start' }), 60);
            }}
          />
        )}
        {activeTab === 'journal' && (
          <JournalView
            items={items}
            blobUrls={blobUrls}
            outfitRecords={outfitRecords}
            onPlanOutfit={startBuildingOutfit}
            onDeleteOutfitRecord={deleteOutfitEntry}
            onAllowAgain={removeOutfitRecordQuietly}
            onOpenPhotoCheck={() => setPhotoCheckOpen(true)}
            onSavePlan={savePlan}
            buildCapsule={services.buildCapsule}
            onAdd={() => goToTab('upload')}
            onToast={setToast}
            feedback={feedback}
            repeatDays={getRepeatDays()}
            weatherLocation={weatherLocation}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsView
            weatherLocation={weatherLocation}
            onWeatherLocationChange={changeWeatherLocation}
            onClear={clearWardrobe}
            exportBackup={services.exportBackup}
            onRestore={restoreWardrobe}
            onToast={setToast}
            dataKey={`${restoredAt}:${items.length}:${outfitRecords.length}`}
          />
        )}
      </main>

      <nav className="bottom-nav" aria-label="Primary navigation">
        <NavButton icon={<LayoutGrid />} label="Wardrobe" active={activeTab === 'wardrobe'} onClick={() => goToTab('wardrobe')} />
        <NavButton icon={<Plus />} label="Add" active={activeTab === 'upload'} onClick={() => goToTab('upload')} />
        <NavButton icon={<Sparkles />} label="Today" active={activeTab === 'outfit'} onClick={() => goToTab('outfit')} />
        <NavButton icon={<CalendarDays />} label="Journal" active={activeTab === 'journal'} onClick={() => goToTab('journal')} />
        <NavButton icon={<Settings />} label="Settings" active={activeTab === 'settings'} onClick={() => goToTab('settings')} />
      </nav>

      {editingItem && (
        <ItemEditor
          item={editingItem}
          blobUrls={blobUrls}
          onClose={() => setEditingItem(null)}
          onSave={updateItem}
          onDelete={deleteItem}
          locate={services.locateItem}
          onToast={setToast}
        />
      )}
      {photoCheckOpen && (
        <OutfitPhotoModal
          items={items}
          blobUrls={blobUrls}
          analyze={services.analyzeOutfitPhoto}
          weatherLocation={weatherLocation}
          onClose={() => setPhotoCheckOpen(false)}
          onLog={async ({ itemIds, newPieces = [], file, verdict, onUndone }) => {
            // Pieces that aren't in the wardrobe yet are added from this photo
            // first, each cropped to itself, so logging is one tap either way.
            let addedIds = [];
            if (newPieces.length && file) {
              const sourcePhotoId = uid();
              const prepared = [{ file, sourcePhotoId, items: newPieces.map((piece) => normalizeItem({ ...piece, id: uid(), sourcePhotoId, photo: file })) }];
              const stored = services.savePhotoItems ? await services.savePhotoItems(prepared) : prepared[0].items;
              const added = (stored || []).map(normalizeItem);
              addedIds = added.map((item) => item.id);
              setItems((current) => [...added, ...current]);
            }
            const allIds = [...itemIds, ...addedIds];
            const message = addedIds.length
              ? `Logged as worn today. ${plural(addedIds.length, 'new piece')} added to your wardrobe.`
              : 'Logged as worn today.';
            await wearOutfit({ itemIds: allIds, date: localDate(), source: 'photo', explanation: verdict, message, onUndone });
          }}
          onToast={setToast}
        />
      )}
      {buildingItemIds && (
        <SaveLookModal
          items={items}
          blobUrls={blobUrls}
          itemIds={buildingItemIds}
          onClose={() => { setBuildingItemIds(null); setWardrobeMode(null); }}
          onSave={saveLook}
        />
      )}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div className="toast">
            <span>{toast.message}</span>
            {toast.undoable && <button className="toast-undo" type="button" onClick={undoLast}>Undo</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function NavButton({ icon, label, active, onClick }) {
  return (
    <button className={`nav-button ${active ? 'is-active' : ''}`} type="button" onClick={onClick}>
      <span className="nav-icon" aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// "Not worn in a while" means this many days, or never.
const STALE_DAYS = 30;

function WardrobeView({
  items, blobUrls, onOpenItem, onAdd, onSuggest, isLoading,
  mode, onSetMode, onBulkUpdate, onBulkDelete, onBuildOutfit, onSetAvailability, wornCounts = new Map(),
}) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkTag, setBulkTag] = useState('');
  const [bulkSeason, setBulkSeason] = useState(SEASON_WEATHER_VALUES[0]);
  const [bulkAvailability, setBulkAvailability] = useState('laundry');
  const unavailableCount = items.filter((item) => !isAvailable(item)).length;
  const staleCount = items.filter((item) => isAvailable(item) && !isRecentlyWorn(item.lastWornDate, STALE_DAYS)).length;
  const filteredItems = useMemo(() => {
    let shown = items;
    if (filter === 'unavailable') shown = shown.filter((item) => !isAvailable(item));
    else if (filter === 'stale') shown = shown.filter((item) => isAvailable(item) && !isRecentlyWorn(item.lastWornDate, STALE_DAYS));
    else if (filter !== 'all') shown = shown.filter((item) => item.category === filter);

    // Every word has to match somewhere: "navy jumper" finds the navy jumper.
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      shown = shown.filter((item) => {
        const text = [displayCategory(item.category), item.category, ...item.colors, ...item.styleTags, ...item.seasons, item.notes].join(' ').toLowerCase();
        return words.every((word) => text.includes(word));
      });
    }

    const worn = (item) => wornCounts.get(item.id) || 0;
    const lastWorn = (item) => item.lastWornDate || '';
    if (sort === 'least-worn') return [...shown].sort((a, b) => worn(a) - worn(b) || lastWorn(a).localeCompare(lastWorn(b)));
    if (sort === 'most-worn') return [...shown].sort((a, b) => worn(b) - worn(a));
    if (sort === 'longest') return [...shown].sort((a, b) => lastWorn(a).localeCompare(lastWorn(b)));
    return shown;
  }, [filter, items, query, sort, wornCounts]);

  // The filter is only offered while something is out; don't strand it.
  useEffect(() => {
    if (filter === 'unavailable' && !unavailableCount) setFilter('all');
  }, [filter, unavailableCount]);

  const selectAllShown = () => setSelectedIds(filteredItems.map((item) => item.id));

  const selecting = mode === 'edit' || mode === 'build';

  useEffect(() => {
    if (!selecting) setSelectedIds([]);
  }, [selecting]);

  const toggleSelected = (id) => {
    setSelectedIds((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  };

  const cancelSelecting = () => {
    onSetMode(null);
    setSelectedIds([]);
  };

  const addTagToSelected = () => {
    const tag = bulkTag.trim();
    if (!tag || !selectedIds.length) return;
    onBulkUpdate(selectedIds, (item) => ({ styleTags: [...new Set([...item.styleTags, tag])] }));
    setBulkTag('');
  };

  const setSeasonForSelected = () => {
    if (!selectedIds.length) return;
    onBulkUpdate(selectedIds, { seasons: [bulkSeason] });
  };

  return (
    <section className="screen wardrobe-screen">
      <div className="screen-heading wardrobe-heading">
        <div>
          <p className="eyebrow">YOUR CLOSET</p>
          <h1>{mode === 'build' ? 'Pick the pieces' : 'What are we wearing?'}</h1>
        </div>
        {selecting ? (
          <button className="text-button" type="button" onClick={cancelSelecting}>Cancel</button>
        ) : (
          <span className="item-count">{items.length} {items.length === 1 ? 'piece' : 'pieces'}</span>
        )}
      </div>

      {mode === 'build' && (
        <p className="inline-note">Tap the pieces for your look, then save it — worn today, or planned for later.</p>
      )}

      {!selecting && items.length > 0 && (
        <>
          <button className="suggest-strip" type="button" onClick={onSuggest}>
            <span className="sparkle"><Sparkles aria-hidden="true" /></span>
            <span><strong>See today’s outfit</strong><small>Picked for the weather, ready to wear</small></span>
            <span className="arrow">→</span>
          </button>
          <button className="secondary-button full-width select-toggle" type="button" onClick={() => onSetMode('edit')}>
            Select pieces to edit or delete
          </button>
        </>
      )}

      {items.length > 0 && (
        <div className="wardrobe-tools">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search colour, type, notes…" aria-label="Search your wardrobe" />
          <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort">
            <option value="newest">Newest</option>
            <option value="least-worn">Least worn</option>
            <option value="most-worn">Most worn</option>
            <option value="longest">Longest since worn</option>
          </select>
        </div>
      )}

      <div className="filter-scroll" aria-label="Filter by category">
        <FilterChip label="All" active={filter === 'all'} count={items.length} onClick={() => setFilter('all')} />
        {CATEGORIES.map((category) => (
          <FilterChip
            key={category}
            label={CATEGORY_META[category].label}
            active={filter === category}
            count={items.filter((item) => item.category === category).length}
            onClick={() => setFilter(category)}
          />
        ))}
        {staleCount > 0 && (
          <FilterChip label={`Not worn in ${STALE_DAYS} days`} active={filter === 'stale'} count={staleCount} onClick={() => setFilter('stale')} />
        )}
        {unavailableCount > 0 && (
          <FilterChip label="Out of rotation" active={filter === 'unavailable'} count={unavailableCount} onClick={() => setFilter('unavailable')} />
        )}
      </div>

      {mode === 'edit' && filteredItems.length > 0 && selectedIds.length < filteredItems.length && (
        <button className="text-button select-all" type="button" onClick={selectAllShown}>Select all {filteredItems.length} shown</button>
      )}

      {isLoading ? (
        <div className="wardrobe-grid" aria-hidden="true">
          {Array.from({ length: 4 }, (unused, index) => <div className="card-skeleton" key={index} />)}
        </div>
      ) : filteredItems.length ? (
        <div className="wardrobe-grid">
          {filteredItems.map((item) => {
            const isSelected = selectedIds.includes(item.id);
            return (
              <button
                className={`wardrobe-card ${isSelected ? 'is-selected' : ''} ${isAvailable(item) ? '' : 'is-unavailable'}`}
                type="button"
                key={item.id}
                onClick={() => (selecting ? toggleSelected(item.id) : onOpenItem(item))}
              >
                <Photo item={item} blobUrls={blobUrls} className="wardrobe-photo" alt={`${displayCategory(item.category)} item`} />
                {selecting && <span className={`select-check ${isSelected ? 'is-checked' : ''}`} aria-hidden="true">{isSelected ? '✓' : ''}</span>}
                <span className="card-copy">
                  <span className="card-category">{displayCategory(item.category)}</span>
                  <span className="card-colors">{item.colors.length ? item.colors.join(' · ') : 'Untitled piece'}</span>
                </span>
                {isAvailable(item)
                  ? item.lastWornDate && <span className="worn-badge">Worn {formatDate(item.lastWornDate)}</span>
                  : <span className="worn-badge unavailable-badge">{unavailableLabel(item.unavailable)}</span>}
              </button>
            );
          })}
          {!selecting && (
            <button className="add-card" type="button" onClick={onAdd}>
              <span aria-hidden="true"><Plus /></span>
              <strong>Add a piece</strong>
            </button>
          )}
        </div>
      ) : (
        <EmptyWardrobe filter={filter} onAdd={onAdd} hasItems={items.length > 0} />
      )}

      {mode === 'edit' && selectedIds.length > 0 && (
        <div className="bulk-action-bar">
          <p>{selectedIds.length} selected</p>
          <div className="bulk-action-row">
            <input value={bulkTag} placeholder="Add a style tag…" onChange={(event) => setBulkTag(event.target.value)} />
            <button className="secondary-button compact" type="button" disabled={!bulkTag.trim()} onClick={addTagToSelected}>Add tag</button>
          </div>
          <div className="bulk-action-row">
            <select value={bulkSeason} onChange={(event) => setBulkSeason(event.target.value)}>
              {SEASON_WEATHER_VALUES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <button className="secondary-button compact" type="button" onClick={setSeasonForSelected}>Set season</button>
          </div>
          <div className="bulk-action-row">
            <select value={bulkAvailability} onChange={(event) => setBulkAvailability(event.target.value)} aria-label="Why these pieces are out of rotation">
              {UNAVAILABLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <button className="secondary-button compact" type="button" onClick={() => onSetAvailability(selectedIds, bulkAvailability)}>Mark out</button>
          </div>
          {selectedIds.some((id) => items.find((item) => item.id === id && !isAvailable(item))) && (
            <button className="secondary-button full-width" type="button" onClick={() => onSetAvailability(selectedIds, '')}>
              Back in rotation
            </button>
          )}
          <button className="danger-button full-width" type="button" onClick={() => onBulkDelete(selectedIds)}>
            Delete {selectedIds.length} {selectedIds.length === 1 ? 'piece' : 'pieces'}
          </button>
        </div>
      )}

      {mode === 'build' && selectedIds.length > 0 && (
        <div className="bulk-action-bar">
          <p>{selectedIds.length} {selectedIds.length === 1 ? 'piece' : 'pieces'} selected</p>
          <button className="primary-button full-width" type="button" onClick={() => onBuildOutfit(selectedIds)}>
            Save this look <span>→</span>
          </button>
        </div>
      )}
    </section>
  );
}

function FilterChip({ label, count, active, onClick }) {
  return (
    <button className={`filter-chip ${active ? 'is-selected' : ''}`} type="button" onClick={onClick}>
      {label}<span>{count}</span>
    </button>
  );
}

function EmptyWardrobe({ filter, onAdd, hasItems }) {
  if (hasItems) {
    return <p className="inline-note">Nothing matches. Try another search or filter.</p>;
  }
  const filtered = filter !== 'all';
  return (
    <div className="empty-state wardrobe-empty">
      <div className="empty-illustration" aria-hidden="true"><span><Sparkles /></span><span><Shirt /></span><span><Footprints /></span></div>
      <h2>{filtered ? `No ${displayCategory(filter).toLowerCase()} yet` : 'Your wardrobe starts here'}</h2>
      <p>{filtered ? 'Try another category, or add something new.' : 'Snap a photo of a piece or a full outfit. We’ll help sort every item.'}</p>
      <button className="primary-button" type="button" onClick={onAdd}>Add your first piece <span>→</span></button>
    </div>
  );
}

function UploadView({ tagPhoto, onSaveBatch, onCancel, onToast }) {
  const inputRef = useRef(null);
  // One entry per picked photo. Each carries its own preview URL, tagging status
  // and detected items, so one failure never blocks the rest of the batch.
  const [entries, setEntries] = useState([]);
  const [stage, setStage] = useState('pick');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [isSaving, setIsSaving] = useState(false);
  const [taggingNote, setTaggingNote] = useState('');
  const [busyNote, setBusyNote] = useState('');
  const [mergeSelection, setMergeSelection] = useState([]);

  // Preview URLs are owned by this component for the life of the batch.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  useEffect(() => () => {
    entriesRef.current.forEach((entry) => URL.revokeObjectURL(entry.previewUrl));
  }, []);

  const reset = () => {
    entries.forEach((entry) => URL.revokeObjectURL(entry.previewUrl));
    setEntries([]);
    setStage('pick');
    setProgress({ done: 0, total: 0 });
    setTaggingNote('');
    setMergeSelection([]);
    if (inputRef.current) inputRef.current.value = '';
  };

  const addFiles = (event) => {
    const picked = [...(event.target.files || [])];
    if (inputRef.current) inputRef.current.value = '';
    if (!picked.length) return;

    const images = picked.filter((file) => file.type.startsWith('image/'));
    const skipped = picked.length - images.length;
    const room = MAX_BATCH_PHOTOS - entries.length;
    const accepted = images.slice(0, Math.max(0, room));
    const overflow = images.length - accepted.length;

    if (!accepted.length) {
      onToast(room <= 0 ? `That is the ${MAX_BATCH_PHOTOS}-photo limit for one batch.` : 'Please choose image files.');
      return;
    }

    setEntries((current) => [
      ...current,
      ...accepted.map((file) => ({
        id: uid(),
        file,
        previewUrl: URL.createObjectURL(file),
        status: 'pending',
        error: '',
        items: [],
      })),
    ]);
    setStage('ready');

    const notes = [];
    if (skipped) notes.push(`${skipped} non-image ${skipped === 1 ? 'file was' : 'files were'} skipped`);
    if (overflow) notes.push(`${overflow} over the ${MAX_BATCH_PHOTOS}-photo limit ${overflow === 1 ? 'was' : 'were'} left out`);
    if (notes.length) onToast(`${notes.join(', ')}.`);
  };

  const removeEntry = (id) => {
    setEntries((current) => {
      const target = current.find((entry) => entry.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      const next = current.filter((entry) => entry.id !== id);
      if (!next.length) {
        setStage('pick');
        setTaggingNote('');
      }
      return next;
    });
    setMergeSelection((current) => current.filter((entry) => !entry.startsWith(id)));
  };

  const patchEntry = (id, changes) => {
    setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry)));
  };

  const blankItem = () => normalizeItem({ id: uid(), sourcePhotoId: 'pending', category: 'top' });

  /**
   * Tags one photo and records the result on its entry. A busy provider gets
   * one more try after a short pause before the photo is marked as failed.
   */
  const tagEntry = async (entry) => {
    patchEntry(entry.id, { status: 'tagging', error: '', note: '' });
    try {
      if (!tagPhoto) throw new Error('Add an AI provider in Settings to auto-tag.');
      const response = await retryWhenBusy(
        () => tagPhoto(entry.file),
        () => setBusyNote('Google is busy. Trying this photo again in a few seconds…'),
      );
      setBusyNote('');
      const found = (Array.isArray(response) ? response : response?.items) || [];
      const items = found.map((item) => normalizeItem({ ...item, id: uid(), sourcePhotoId: 'pending' }));
      patchEntry(entry.id, {
        status: 'done',
        model: response?.model || '',
        items: items.length ? items : [blankItem()],
        note: items.length ? '' : 'Nothing wearable was found here. Add it by hand or remove the photo.',
      });
      return { failed: false, found: items.length };
    } catch (error) {
      setBusyNote('');
      patchEntry(entry.id, {
        status: 'failed',
        error: error?.message || 'Tagging failed for this photo.',
        items: [blankItem()],
      });
      return { failed: true, found: 0 };
    }
  };

  // From the review screen: tag one failed photo again without redoing the rest.
  const retryEntry = async (entry) => {
    const outcome = await tagEntry(entry);
    if (!outcome.failed) {
      setTaggingNote(outcome.found ? `${plural(outcome.found, 'piece')} found. Check them, then save.` : 'Still nothing wearable found in that photo.');
    }
  };

  /**
   * Tags photos one at a time. Free API tiers rate-limit aggressively, and a
   * burst of parallel vision calls is the fastest way to trip that, so this
   * trades wall-clock for reliability and shows progress instead.
   */
  const analyseAll = async () => {
    const queue = entries.filter((entry) => entry.status === 'pending' || entry.status === 'failed');
    if (!queue.length) return;

    setStage('tagging');
    setProgress({ done: 0, total: queue.length });
    setTaggingNote('');

    let failures = 0;
    let detected = 0;

    for (let index = 0; index < queue.length; index += 1) {
      const outcome = await tagEntry(queue[index]);
      if (outcome.failed) failures += 1;
      detected += outcome.found;
      setProgress({ done: index + 1, total: queue.length });
    }

    setStage('review');
    setTaggingNote(
      failures
        ? `${detected} ${detected === 1 ? 'piece' : 'pieces'} found. ${failures} ${failures === 1 ? 'photo' : 'photos'} could not be tagged. Tap Try again below.`
        : `${detected} ${detected === 1 ? 'piece' : 'pieces'} found across ${queue.length} ${queue.length === 1 ? 'photo' : 'photos'}. Review before saving.`,
    );
  };

  const tagManually = () => {
    setEntries((current) => current.map((entry) => ({
      ...entry,
      status: 'done',
      items: entry.items.length ? entry.items : [blankItem()],
    })));
    setStage('review');
    setTaggingNote('Add the details for each piece, then save.');
  };

  const patchItem = (entryId, itemId, changes) => {
    setEntries((current) => current.map((entry) => (
      entry.id === entryId
        ? { ...entry, items: entry.items.map((item) => (item.id === itemId ? { ...item, ...changes } : item)) }
        : entry
    )));
  };

  const addItem = (entryId) => {
    setEntries((current) => current.map((entry) => (
      entry.id === entryId ? { ...entry, items: [...entry.items, blankItem()] } : entry
    )));
  };

  const removeItem = (entryId, itemId) => {
    setEntries((current) => current.map((entry) => (
      entry.id === entryId ? { ...entry, items: entry.items.filter((item) => item.id !== itemId) } : entry
    )));
    setMergeSelection((current) => current.filter((key) => key !== `${entryId}:${itemId}`));
  };

  // Merging only ever happens within one photo, because merged pieces must still
  // point at a single source image.
  const toggleMerge = (entryId, itemId) => {
    const key = `${entryId}:${itemId}`;
    setMergeSelection((current) => (
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]
    ));
  };

  const mergeableEntryId = (() => {
    if (mergeSelection.length < 2) return null;
    const owners = new Set(mergeSelection.map((key) => key.split(':')[0]));
    return owners.size === 1 ? [...owners][0] : null;
  })();

  const mergeSelected = () => {
    if (!mergeableEntryId) return;
    const chosen = new Set(mergeSelection.map((key) => key.split(':')[1]));
    setEntries((current) => current.map((entry) => {
      if (entry.id !== mergeableEntryId) return entry;
      const selected = entry.items.filter((item) => chosen.has(item.id));
      if (selected.length < 2) return entry;
      const keeper = {
        ...selected[0],
        colors: [...new Set(selected.flatMap((item) => item.colors))],
        styleTags: [...new Set(selected.flatMap((item) => item.styleTags))],
        seasons: [...new Set(selected.flatMap((item) => item.seasons))],
        notes: selected.map((item) => item.notes).filter(Boolean).join(' '),
      };
      return {
        ...entry,
        items: entry.items
          .filter((item) => !chosen.has(item.id) || item.id === keeper.id)
          .map((item) => (item.id === keeper.id ? keeper : item)),
      };
    }));
    setMergeSelection([]);
  };

  // A photo that failed (or is being retried) has only a blank placeholder, which must never be saved.
  const savable = entries.filter((entry) => entry.status !== 'failed' && entry.status !== 'tagging' && entry.items.length);
  const totalItems = savable.reduce((count, entry) => count + entry.items.length, 0);

  const save = async () => {
    const groups = savable
      .map((entry) => ({ file: entry.file, sourcePhotoId: uid(), reviewedItems: entry.items }));
    if (!groups.length) return;

    setIsSaving(true);
    try {
      await onSaveBatch(groups);
      reset();
    } finally {
      setIsSaving(false);
    }
  };

  if (stage === 'pick') {
    return (
      <section className="screen upload-screen">
        <div className="screen-heading">
          <div><p className="eyebrow">ADD TO WARDROBE</p><h1>Show me your clothes</h1></div>
        </div>
        <div className="upload-dropzone">
          <div className="camera-orb" aria-hidden="true"><Camera /></div>
          <h2>Choose your photos</h2>
          <p>Pick one or many. Single pieces, mirror selfies, and whole outfits all work. We’ll find the wearable items, not the background.</p>
          <button className="primary-button" type="button" onClick={() => inputRef.current?.click()}>Choose photos <span>→</span></button>
          <small>Up to {MAX_BATCH_PHOTOS} at a time · JPG, PNG, HEIC and more</small>
        </div>
        <div className="tip-card"><span aria-hidden="true"><Sparkles /></span><p><strong>Tip:</strong> Natural photos are perfect. You don’t need product shots or a plain background.</p></div>
        <input ref={inputRef} className="visually-hidden" type="file" accept="image/*" multiple onChange={addFiles} />
      </section>
    );
  }

  if (stage === 'ready' || stage === 'tagging') {
    const busy = stage === 'tagging';
    return (
      <section className="screen upload-screen">
        <div className="review-header">
          <div>
            <p className="eyebrow">PHOTOS READY</p>
            <h1>{entries.length} {entries.length === 1 ? 'photo' : 'photos'}</h1>
          </div>
          {!busy && <button className="text-button" type="button" onClick={reset}>Start over</button>}
        </div>
        <p className="review-description">Every wearable item in each photo becomes its own wardrobe piece. You review everything before it saves.</p>

        <div className="batch-grid">
          {entries.map((entry) => (
            <figure className={`batch-tile status-${entry.status}`} key={entry.id}>
              <img src={entry.previewUrl} alt="" />
              {entry.status === 'tagging' && <span className="batch-badge working"><span className="button-spinner dark" /></span>}
              {entry.status === 'done' && <span className="batch-badge ok">✓</span>}
              {entry.status === 'failed' && <span className="batch-badge bad">!</span>}
              {!busy && (
                <button className="batch-remove" type="button" aria-label="Remove this photo" onClick={() => removeEntry(entry.id)}><X aria-hidden="true" /></button>
              )}
            </figure>
          ))}
          {!busy && entries.length < MAX_BATCH_PHOTOS && (
            <button className="batch-tile batch-add" type="button" onClick={() => inputRef.current?.click()}>
              <span aria-hidden="true"><Plus /></span><small>Add more</small>
            </button>
          )}
        </div>

        {busy ? (
          <>
            <div className="batch-progress" role="status" aria-live="polite">
              <div className="batch-progress-bar"><span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
              <p>{busyNote || `Tagging photo ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`}</p>
            </div>
            <p className="inline-note">One at a time, so a free API tier doesn’t rate-limit the batch.</p>
          </>
        ) : (
          <>
            <button className="primary-button full-width" type="button" onClick={analyseAll}>
              Auto-tag {entries.length === 1 ? 'this photo' : `all ${entries.length} photos`} <span className="button-icon" aria-hidden="true"><Sparkles /></span>
            </button>
            <button className="secondary-button full-width" type="button" onClick={tagManually}>Tag them myself</button>
            <button className="text-button centered" type="button" onClick={onCancel}>Cancel</button>
          </>
        )}
        <input ref={inputRef} className="visually-hidden" type="file" accept="image/*" multiple onChange={addFiles} />
      </section>
    );
  }

  return (
    <section className="screen upload-screen review-screen">
      <div className="review-header">
        <div>
          <p className="eyebrow">REVIEW DETECTION</p>
          <h1>{totalItems} {totalItems === 1 ? 'piece' : 'pieces'} from {entries.length} {entries.length === 1 ? 'photo' : 'photos'}</h1>
        </div>
        <button className="text-button" type="button" onClick={reset}>Start over</button>
      </div>
      {taggingNote && <p className="inline-note">{taggingNote}</p>}

      {mergeSelection.length >= 2 && (
        <div className="review-actions">
          <button className="secondary-button compact" type="button" disabled={!mergeableEntryId} onClick={mergeSelected}>
            Merge selected ({mergeSelection.length})
          </button>
          {!mergeableEntryId && <p className="inline-note">Pieces can only merge within the same photo.</p>}
        </div>
      )}

      {entries.map((entry, entryIndex) => (
        <div className="photo-group" key={entry.id}>
          <div className="source-photo-row">
            <img src={entry.previewUrl} alt="" />
            <span>
              <strong>Photo {entryIndex + 1}</strong>
              <small>{entry.status === 'failed' || entry.status === 'tagging' ? 'Not tagged yet' : `${plural(entry.items.length, 'piece')} found`}</small>
            </span>
            <button className="icon-text-button danger-text" type="button" onClick={() => removeEntry(entry.id)}>Remove</button>
          </div>
          {(entry.status === 'failed' || entry.status === 'tagging') ? (
            <div className="retry-box" role={entry.status === 'failed' ? 'alert' : 'status'}>
              <p>{entry.status === 'tagging' ? (busyNote || 'Tagging this photo again…') : entry.error}</p>
              <div className="retry-actions">
                <button className="primary-button compact" type="button" disabled={entry.status === 'tagging'} onClick={() => retryEntry(entry)}>
                  {entry.status === 'tagging' ? <><span className="button-spinner" /> Trying…</> : <><RefreshCw className="inline-icon" aria-hidden="true" /> Try again</>}
                </button>
                {entry.status === 'failed' && (
                  <button className="text-button" type="button" onClick={() => patchEntry(entry.id, { status: 'manual', error: '' })}>Fill in by hand</button>
                )}
              </div>
            </div>
          ) : (
            <>
              {entry.note && <p className="inline-note">{entry.note}</p>}
              <div className="review-list">
                {entry.items.map((item, index) => (
                  <ReviewItemCard
                    key={item.id}
                    item={item}
                    index={index}
                    preview={entry.previewUrl}
                    selected={mergeSelection.includes(`${entry.id}:${item.id}`)}
                    onToggleMerge={() => toggleMerge(entry.id, item.id)}
                    onChange={(changes) => patchItem(entry.id, item.id, changes)}
                    onRemove={() => removeItem(entry.id, item.id)}
                  />
                ))}
              </div>
              <button className="text-button" type="button" onClick={() => addItem(entry.id)}><Plus className="inline-icon" aria-hidden="true" /> Add a piece the AI missed</button>
            </>
          )}
        </div>
      ))}

      <button className="primary-button full-width save-batch-button" type="button" disabled={isSaving || !totalItems} onClick={save}>
        {isSaving ? <><span className="button-spinner" /> Saving…</> : <>Save {totalItems} to wardrobe <span>→</span></>}
      </button>
      <button className="text-button centered" type="button" onClick={onCancel}>Cancel without saving</button>
    </section>
  );
}

function ReviewItemCard({ item, index, preview, selected, onToggleMerge, onChange, onRemove }) {
  const updateList = (key, value) => onChange({ [key]: asList(value) });
  // Compact by default: the AI's tags are usually right, so the whole form is
  // one tap away rather than in the way. A piece with nothing filled in (added
  // by hand) opens straight to the form.
  const [isOpen, setIsOpen] = useState(() => !item.colors.length && !item.notes);

  if (!isOpen) {
    const details = [...item.styleTags.slice(0, 2), ...item.seasons.slice(0, 2)].join(' · ');
    return (
      <article className="review-row">
        <CroppedImage src={preview} crop={item.crop} alt="" className="review-row-photo" />
        <div className="review-row-copy">
          <strong>{displayCategory(item.category)}{item.colors.length ? ` · ${item.colors.join(', ')}` : ''}</strong>
          {item.notes && <span>{item.notes}</span>}
          {details && <small>{details}</small>}
        </div>
        <button className="text-button" type="button" onClick={() => setIsOpen(true)}>Edit</button>
        <button className="icon-text-button" type="button" onClick={onRemove} aria-label={`Remove piece ${index + 1}`}><X aria-hidden="true" /></button>
      </article>
    );
  }

  return (
    <article className="review-card">
      <div className="review-card-topline">
        <label className="merge-toggle"><input type="checkbox" checked={selected} onChange={onToggleMerge} /> <span>Merge</span></label>
        <span>Piece {index + 1}</span>
        <button className="icon-text-button danger-text" type="button" onClick={onRemove}>Remove</button>
      </div>
      <div className="review-visual">
        <CroppedImage src={preview} crop={item.crop} alt={`Detected piece ${index + 1}`} className="review-crop" />
        {spotlightStyle(item.crop) && (
          // Where this piece is in the whole photo, so a wrong guess is obvious.
          <span className="review-locator" aria-hidden="true">
            <img src={preview} alt="" />
            <span className="spotlight-box" style={spotlightStyle(item.crop)} />
          </span>
        )}
        <span className="crop-label">{item.crop ? 'Found in your photo' : 'Crop preview'}</span>
      </div>
      <CropControls crop={item.crop} idPrefix={`review-${item.id}`} onChange={(crop) => onChange({ crop })} />
      <div className="form-grid review-fields">
        <label>Category<select value={item.category} onChange={(event) => onChange({ category: event.target.value })}>{CATEGORIES.map((category) => <option key={category} value={category}>{displayCategory(category)}</option>)}</select></label>
        <label>Colours<input value={item.colors.join(', ')} placeholder="e.g. navy, white" onChange={(event) => updateList('colors', event.target.value)} /></label>
        <label className="span-two">Style tags<input value={item.styleTags.join(', ')} placeholder="e.g. casual, classic" onChange={(event) => updateList('styleTags', event.target.value)} /></label>
        <label className="span-two">Season / weather<input value={item.seasons.join(', ')} placeholder="e.g. mild, summer" onChange={(event) => updateList('seasons', event.target.value)} /><small className="field-hint">{SEASON_HINT}</small></label>
        <label className="span-two">Notes<input value={item.notes} placeholder="What is this piece?" onChange={(event) => onChange({ notes: event.target.value })} /></label>
      </div>
      <button className="secondary-button full-width review-done" type="button" onClick={() => setIsOpen(false)}>Done</button>
    </article>
  );
}

/**
 * An outfit laid out the way it's worn: top over bottom over shoes (or a
 * dress over shoes) down the middle, with a layer and extras alongside. Each
 * slot's shape suits its garment, tall for trousers and wide for shoes, so a
 * cropped piece fills it naturally.
 */
function OutfitLook({ items, blobUrls, className = '' }) {
  const of = (category) => items.filter((item) => item.category === category);
  const [dress] = of('dress');
  const [top, ...moreTops] = of('top');
  const [bottom, ...moreBottoms] = of('bottom');
  const [shoes, ...moreShoes] = of('shoes');
  const main = dress
    ? [[dress, 'dress']]
    : [top && [top, 'top'], bottom && [bottom, 'bottom']].filter(Boolean);
  if (shoes) main.push([shoes, 'shoes']);
  const side = [...of('outerwear'), ...of('accessory'), ...moreTops, ...moreBottoms, ...moreShoes, ...(dress ? of('top').concat(of('bottom')) : [])]
    .filter((item, index, all) => all.indexOf(item) === index);

  const slot = (item, kind) => (
    <figure className={`look-slot look-${kind}`} key={item.id}>
      <Photo item={item} blobUrls={blobUrls} className="look-photo" alt={`${displayCategory(item.category)}${item.colors.length ? `, ${item.colors.join(' ')}` : ''}`} />
      <figcaption>{displayCategory(item.category)}</figcaption>
    </figure>
  );

  return (
    <div className={`outfit-look ${side.length ? 'has-side' : ''} ${className}`}>
      <div className="look-main">{main.map(([item, kind]) => slot(item, kind))}</div>
      {side.length > 0 && <div className="look-side">{side.map((item) => slot(item, 'side'))}</div>}
    </div>
  );
}

function OutfitView({
  items, blobUrls, repeatDays, onSuggest, onWearOutfit, onRateOutfit, onAdd, onBuildOwn, onOpenPhotoCheck, onToast,
  feedback = EMPTY_FEEDBACK, weatherLocation, isLoading = false, onGoToBackup, onOpenSettings, onQuickAdd,
}) {
  const [showBackupNudge, setShowBackupNudge] = useState(() => shouldNudgeBackup(items.length));
  useEffect(() => { setShowBackupNudge(shouldNudgeBackup(items.length)); }, [items.length]);
  const [preferences, setPreferences] = useState(() => ({
    weather: 'mild',
    temperature: 20,
    rain: false,
    forecastNote: '',
    wantedItemId: '',
    // The occasion and vibe last chosen, so a work week doesn't start from "Everyday" each morning.
    ...getOutfitPreferences(),
  }));
  const [isAdjusting, setIsAdjusting] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [usedItemIds, setUsedItemIds] = useState([]);
  const [isThinking, setIsThinking] = useState(false);
  const [isWorn, setIsWorn] = useState(false);
  const [rating, setRating] = useState('');
  const forecast = useForecast(weatherLocation);
  const today = forecast.days?.find((day) => day.date === localDate()) || null;
  // Live weather fills the weather answer once; after that a tap on a chip wins.
  const [weatherTouched, setWeatherTouched] = useState(false);

  useEffect(() => {
    if (!today || weatherTouched) return;
    setPreferences((current) => ({
      ...current,
      weather: today.weather,
      temperature: today.temperature,
      rain: today.rain,
      forecastNote: forecastNote(today, weatherLocation?.shortName),
    }));
    // The forecast arrived after the first pick: re-pick for the real weather.
    setSuggestion((current) => (current?.isQuick ? null : current));
  }, [today, weatherTouched, weatherLocation?.shortName]);

  // Anything changed in Adjust shows a fresh pick straight away, and the
  // occasion and vibe are remembered for next time.
  const updatePreferences = (changes) => {
    const next = { ...preferences, ...changes };
    setPreferences(next);
    setOutfitPreferences(next);
    setSuggestion(null);
  };

  const pickWeather = (option) => {
    setWeatherTouched(true);
    updatePreferences({ weather: option.value, temperature: option.temperature, rain: false, forecastNote: '' });
  };

  // The outfit shown on arrival: the best-ranked local pick, instant and free.
  // The AI stylist is one tap away rather than the only way to see anything.
  const makeQuickPick = (exclude = []) => ({
    ...localOutfit(
      items.filter((item) => item.id === preferences.wantedItemId || !exclude.includes(item.id)),
      suggestionFilters(preferences, feedback),
      repeatDays,
    ),
    explanation: '',
    isFallback: false,
    source: 'local',
    isQuick: true,
  });

  const suggestionItems = suggestion?.itemIds.map((id) => items.find((item) => item.id === id)).filter(Boolean) || [];
  const availableItems = items.filter(isAvailable);

  // Show a pick on arrival, after any adjustment, and whenever a piece in the
  // current pick is deleted or taken out of rotation.
  useEffect(() => {
    if (isLoading || !items.length) return;
    const stillWearable = suggestion?.itemIds.every((id) => items.some((item) => item.id === id && (isAvailable(item) || id === preferences.wantedItemId)));
    if (suggestion && stillWearable) return;
    setSuggestion(makeQuickPick());
    setUsedItemIds([]);
    setIsWorn(false);
    setRating('');
    // makeQuickPick reads the same inputs listed here.
  }, [isLoading, items, preferences, suggestion]);

  const requestSuggestion = async ({ exclude = [] } = {}) => {
    const candidates = shortlistForSuggestion(items, preferences, repeatDays, exclude, feedback);
    if (!candidates.length) {
      onToast('There are no unused pieces left to try. Change your answers, or start over with "Suggest my outfit".');
      return;
    }
    // The no-AI pick uses the whole wardrobe's ranking (minus what was already
    // shown), with the same feedback rules as the shuffle.
    const makeLocalSuggestion = () => localOutfit(
      items.filter((item) => item.id === preferences.wantedItemId || !exclude.includes(item.id)),
      suggestionFilters(preferences, feedback),
      repeatDays,
    );
    setIsThinking(true);
    setIsWorn(false);
    setRating('');
    try {
      let normalized;
      try {
        const usingAi = Boolean(onSuggest && hasAnyProvider());
        const response = usingAi
          ? await onSuggest({ items: candidates, preferences, excludedItemIds: exclude, avoidRecentDays: repeatDays, feedback })
          : makeLocalSuggestion();
        normalized = {
          itemIds: (response?.itemIds || response?.items || []).map((entry) => typeof entry === 'string' ? entry : entry.id),
          explanation: response?.explanation || 'This combination is ready to wear.',
          isFallback: false,
          source: usingAi ? 'ai' : 'local',
        };
        if (!normalized.itemIds.length) throw new Error('No complete outfit was returned.');
      } catch (error) {
        // A failed AI call should not leave the screen empty — fall back to a
        // simple local pick so there is always something to look at, and say
        // plainly that this one skipped the AI step.
        const local = makeLocalSuggestion();
        if (!local.itemIds.length) throw error;
        onToast(error?.message || 'The AI suggestion failed, so here is a basic pick instead.');
        normalized = { ...local, isFallback: true, source: 'local' };
      }
      setSuggestion(normalized);
      setUsedItemIds(exclude);
    } catch (error) {
      onToast(error?.message || 'I could not put an outfit together this time.');
    } finally {
      setIsThinking(false);
    }
  };

  /**
   * No AI, no network, cannot fail — a randomised pick from the wardrobe.
   * Repeated taps give different results within the same category rules the
   * AI suggestion also respects (weather/style ranking, not worn recently).
   */
  const requestShuffle = ({ exclude = [] } = {}) => {
    const filters = suggestionFilters(preferences, feedback);
    const shuffleWithout = (ids) => shuffleOutfit(
      items.filter((item) => !ids.includes(item.id) || item.id === preferences.wantedItemId),
      filters,
      repeatDays,
    );
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const isComplete = (ids) => isCompleteOutfit(ids, itemsById);

    let result = shuffleWithout(exclude);
    // "Shuffle again" avoids everything already shown, so a small wardrobe soon
    // runs out of bottoms and starts showing a top on its own. When that
    // happens, start a new round that only avoids what's on screen right now.
    if (exclude.length && !isComplete(result.itemIds)) {
      exclude = suggestion?.itemIds || [];
      result = shuffleWithout(exclude);
    }

    if (!result.itemIds.length) {
      onToast('Add a few more pieces so there is something to shuffle.');
      return;
    }
    setIsWorn(false);
    setRating('');
    setSuggestion({ ...result, isFallback: false, source: 'shuffle' });
    setUsedItemIds(exclude);
  };

  // "Another one" stays with whatever made the current pick: the AI asks the
  // AI again, while a quick pick or shuffle shuffles.
  const reroll = () => {
    const exclude = [...usedItemIds, ...suggestion.itemIds];
    if (suggestion.source === 'ai' || suggestion.isFallback) requestSuggestion({ exclude });
    else requestShuffle({ exclude: suggestion.source === 'shuffle' ? exclude : suggestion.itemIds });
  };

  const wearThis = async () => {
    if (!suggestionItems.length) return;
    try {
      await onWearOutfit({
        itemIds: suggestionItems.map((item) => item.id),
        date: localDate(),
        source: suggestion.source,
        explanation: suggestion.explanation,
        message: 'Marked as worn today. Have a great time!',
        onUndone: () => setIsWorn(false),
      });
      setIsWorn(true);
    } catch (error) {
      onToast(error?.message || 'That outfit could not be marked as worn.');
    }
  };

  const rate = async (value) => {
    if (!suggestionItems.length || rating) return;
    try {
      const ruledOut = suggestion;
      await onRateOutfit({
        itemIds: suggestionItems.map((item) => item.id),
        rating: value,
        source: suggestion.source,
        explanation: suggestion.explanation,
        message: value === 'loved'
          ? 'Loved. Pieces from it will come up a little more often.'
          : 'Got it. That pairing won\'t be suggested again.',
        // Undo brings back the outfit that was ruled out, not just the record.
        onUndone: () => {
          setRating('');
          if (value === 'rejected') setSuggestion(ruledOut);
        },
      });
      setRating(value);
      if (value === 'rejected') reroll();
    } catch (error) {
      onToast(error?.message || 'That could not be saved.');
    }
  };

  // Block only on a genuinely empty wardrobe. A wardrobe missing one category
  // (no shoes yet, say) still deserves a suggestion — it just says so, rather
  // than refusing outright.
  if (!items.length && !isLoading) {
    return (
      <section className="screen outfit-screen empty-outfit">
        <div className="screen-heading"><div><p className="eyebrow">WELCOME</p><h1>Let’s set up your wardrobe</h1><p className="heading-copy">Three steps, and Today starts dressing you.</p></div></div>
        <FirstRunGuide onAdd={onAdd} onOpenSettings={onOpenSettings} onQuickAdd={onQuickAdd} />
      </section>
    );
  }

  const missing = missingForCompleteOutfit(availableItems);
  const isAi = suggestion?.source === 'ai' && !suggestion.isFallback;
  const weatherLabel = WEATHER_OPTIONS.find((option) => option.value === preferences.weather)?.label || preferences.weather;

  return (
    <section className="screen outfit-screen today-screen">
      <div className="screen-heading">
        <div>
          <p className="eyebrow">TODAY · {new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short' }).format(new Date()).toUpperCase()}</p>
          <h1>{isAi ? 'Styled for you' : 'Your outfit today'}</h1>
        </div>
      </div>

      {showBackupNudge && (
        <div className="backup-nudge">
          <p><strong>Your wardrobe is only saved on this phone.</strong> {getLastBackupAt() ? `Last backup ${daysAgo(getLastBackupAt())}.` : 'It has never been backed up.'} Phones can clear website data.</p>
          <div>
            <button className="primary-button compact" type="button" onClick={onGoToBackup}>Back up now</button>
            <button className="text-button" type="button" onClick={() => { snoozeBackupNudge(7); setShowBackupNudge(false); }}>Later</button>
          </div>
        </div>
      )}

      {today && !weatherTouched && (
        <p className="forecast-line"><CloudSun className="inline-icon" aria-hidden="true" /> {weatherLocation.shortName}: {describeDay(today)}{today.rain ? ' — rain likely' : ''}</p>
      )}
      {weatherLocation && forecast.error && <p className="forecast-line">Live weather unavailable: {forecast.error}</p>}

      <button className="adjust-summary" type="button" aria-expanded={isAdjusting} onClick={() => setIsAdjusting((current) => !current)}>
        <span>{preferences.occasion}</span>
        <span>{weatherLabel} {preferences.temperature}°{preferences.rain ? ' · rain' : ''}</span>
        <span>{preferences.vibe}</span>
        {preferences.wantedItemId && <span>With a chosen piece</span>}
        <strong>{isAdjusting ? 'Done' : 'Adjust'}</strong>
      </button>

      {isAdjusting && (
        <div className="adjust-panel">
          <fieldset className="question-block">
            <legend>Where are you going?</legend>
            <div className="chip-row">
              {OCCASIONS.map((occasion) => <ChoiceButton key={occasion} active={preferences.occasion === occasion} onClick={() => updatePreferences({ occasion })}>{occasion}</ChoiceButton>)}
            </div>
          </fieldset>
          <fieldset className="question-block">
            <legend>The weather</legend>
            <div className="choice-grid weather-grid">
              {WEATHER_OPTIONS.map((weather) => <ChoiceButton key={weather.value} active={preferences.weather === weather.value} onClick={() => pickWeather(weather)}>{weather.label}<small>{preferences.weather === weather.value && !weatherTouched && today ? `${today.temperature}°` : `${weather.temperature}°`}</small></ChoiceButton>)}
            </div>
            {!weatherLocation && <p className="field-hint">Turn on live weather in Settings and this fills itself in.</p>}
          </fieldset>
          <fieldset className="question-block">
            <legend>How do you want to feel?</legend>
            <div className="chip-row">
              {VIBES.map((vibe) => <ChoiceButton key={vibe} active={preferences.vibe === vibe} onClick={() => updatePreferences({ vibe })}>{vibe}</ChoiceButton>)}
            </div>
          </fieldset>
          <label className="wanted-select">Build it around a piece<select value={preferences.wantedItemId} onChange={(event) => updatePreferences({ wantedItemId: event.target.value })}><option value="">No — surprise me</option>{availableItems.map((item) => <option key={item.id} value={item.id}>{displayCategory(item.category)} · {item.colors.join(', ') || 'untitled item'}</option>)}</select></label>
        </div>
      )}

      {missing.length > 0 && (
        <p className="inline-note">No {missing.join(' or ')} in rotation yet — I’ll style what you have.</p>
      )}

      {isLoading || !suggestion ? (
        <div className="outfit-look look-skeleton" aria-hidden="true"><div className="look-main"><div className="card-skeleton" /><div className="card-skeleton" /></div></div>
      ) : suggestionItems.length ? (
        <OutfitLook items={suggestionItems} blobUrls={blobUrls} />
      ) : (
        <p className="inline-note">Nothing in rotation fits these answers. Adjust them, or bring something back from the wash.</p>
      )}

      {suggestion?.isFallback && (
        <p className="inline-note">The AI stylist didn’t answer this time, so this is the best match from your wardrobe.</p>
      )}
      {isAi && suggestion.explanation && <div className="explanation-card"><span aria-hidden="true"><Sparkles /></span><p>{suggestion.explanation}</p></div>}
      {!isAi && !suggestion?.isFallback && suggestionItems.length > 0 && (
        <p className="pick-source">{suggestion.source === 'shuffle' ? 'Shuffled from your wardrobe.' : `Best match for ${preferences.occasion.toLowerCase()}, ${weatherLabel.toLowerCase()} weather.`} Not worn in the last {repeatDays} days where possible.</p>
      )}

      <button className={`primary-button full-width ${isWorn ? 'success-button' : ''}`} type="button" onClick={wearThis} disabled={isWorn || !suggestionItems.length}>
        {isWorn ? '✓ Worn today' : 'Wear this'}
      </button>
      <div className="outfit-secondary-actions">
        <button className="secondary-button" type="button" disabled={isThinking || !suggestionItems.length} onClick={() => (isAi ? reroll() : requestShuffle({ exclude: suggestion.source === 'shuffle' ? [...usedItemIds, ...suggestion.itemIds] : suggestion.itemIds }))}>
          {isAi ? <>Ask again <span className="button-icon" aria-hidden="true"><RefreshCw /></span></> : <>Shuffle <span className="button-icon" aria-hidden="true"><Shuffle /></span></>}
        </button>
        <button className="secondary-button ai-button" type="button" disabled={isThinking} onClick={() => (hasAnyProvider() ? requestSuggestion({ exclude: isAi ? [...usedItemIds, ...suggestion.itemIds] : [] }) : onToast('Connect the built-in AI or a provider in Settings to use the AI stylist.'))}>
          {isThinking ? <><span className="button-spinner dark" /> Styling…</> : <>AI stylist <span className="button-icon" aria-hidden="true"><Sparkles /></span></>}
        </button>
      </div>
      {suggestionItems.length > 0 && (
        <div className="rating-row">
          <button className={`secondary-button ${rating === 'loved' ? 'is-loved' : ''}`} type="button" disabled={Boolean(rating) || isThinking} onClick={() => rate('loved')}>
            {rating === 'loved' ? <><Heart className="inline-icon" fill="currentColor" aria-hidden="true" /> Loved</> : <><Heart className="inline-icon" aria-hidden="true" /> Love it</>}
          </button>
          <button className="secondary-button" type="button" disabled={Boolean(rating) || isThinking} onClick={() => rate('rejected')}>
            Never suggest this
          </button>
        </div>
      )}

      <button className="photo-check-strip" type="button" onClick={onOpenPhotoCheck}>
        <span aria-hidden="true"><Camera /></span>
        <span><strong>Already dressed?</strong><small>Snap a mirror photo to log it and get honest feedback</small></span>
        <span className="arrow">→</span>
      </button>
      <button className="text-button build-own" type="button" onClick={onBuildOwn}>Or pick the pieces yourself →</button>
    </section>
  );
}

function ChoiceButton({ active, children, onClick }) {
  return <button className={`choice-button ${active ? 'is-selected' : ''}`} type="button" onClick={onClick}>{children}</button>;
}

// Everyday pieces most wardrobes have, for a quick start before any photos.
const BASICS = [
  { key: 'white-tee', label: 'White T-shirt', category: 'top', colors: ['white'], styleTags: ['casual', 'minimal'], seasons: ['all-season'], fill: '#fbfbfb' },
  { key: 'black-tee', label: 'Black T-shirt', category: 'top', colors: ['black'], styleTags: ['casual', 'minimal'], seasons: ['all-season'], fill: '#26262a' },
  { key: 'white-shirt', label: 'White shirt', category: 'top', colors: ['white'], styleTags: ['smart casual', 'work'], seasons: ['all-season'], fill: '#f4f6fa' },
  { key: 'navy-jumper', label: 'Navy jumper', category: 'top', colors: ['navy'], styleTags: ['casual', 'smart casual'], seasons: ['autumn', 'winter', 'cool'], fill: '#22304f' },
  { key: 'blue-jeans', label: 'Blue jeans', category: 'bottom', colors: ['blue', 'denim'], styleTags: ['casual'], seasons: ['all-season'], fill: '#5b7fae' },
  { key: 'black-jeans', label: 'Black jeans', category: 'bottom', colors: ['black'], styleTags: ['casual', 'smart casual'], seasons: ['all-season'], fill: '#1d1d20' },
  { key: 'beige-chinos', label: 'Beige chinos', category: 'bottom', colors: ['beige'], styleTags: ['smart casual', 'work'], seasons: ['spring', 'summer', 'mild'], fill: '#d6c19c' },
  { key: 'white-sneakers', label: 'White sneakers', category: 'shoes', colors: ['white'], styleTags: ['casual', 'minimal'], seasons: ['all-season'], fill: '#fdfdfd' },
  { key: 'black-boots', label: 'Black boots', category: 'shoes', colors: ['black'], styleTags: ['smart casual'], seasons: ['autumn', 'winter', 'cold', 'rainy'], fill: '#222' },
  { key: 'denim-jacket', label: 'Denim jacket', category: 'outerwear', colors: ['denim', 'blue'], styleTags: ['casual'], seasons: ['spring', 'autumn', 'cool'], fill: '#6f8fbd' },
];

// A plain drawn stand-in, so a basic added without a photo still has
// something to show (and works like any other photo: crops, the look, etc.).
function drawBasic({ category, fill }) {
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 440;
  const g = canvas.getContext('2d');
  g.fillStyle = '#f1ede6';
  g.fillRect(0, 0, 360, 440);
  g.fillStyle = fill;
  g.strokeStyle = '#6b665f';
  g.lineWidth = 4;
  g.lineJoin = 'round';
  const shapes = {
    top: [[105, 80], [255, 80], [325, 150], [285, 185], [265, 160], [265, 370], [95, 370], [95, 160], [75, 185], [35, 150]],
    outerwear: [[95, 60], [265, 60], [335, 170], [290, 200], [272, 175], [272, 400], [88, 400], [88, 175], [70, 200], [25, 170]],
    bottom: [[105, 50], [255, 50], [280, 400], [195, 400], [180, 170], [165, 400], [80, 400]],
    shoes: [[50, 270], [170, 245], [300, 300], [300, 345], [50, 345]],
  };
  const points = shapes[category] || shapes.top;
  g.beginPath();
  points.forEach(([x, y], index) => (index ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.fill();
  g.stroke();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
}

/**
 * The first screen for an empty wardrobe: the three things that make the app
 * work, in order, plus a quick start from common basics so Today has
 * something to dress you in before any photos are taken.
 */
function FirstRunGuide({ onAdd, onOpenSettings, onQuickAdd }) {
  const [chosen, setChosen] = useState([]);
  const [isAdding, setIsAdding] = useState(false);
  const hasAi = hasAnyProvider();
  const hasWeather = Boolean(getWeatherLocation());
  const toggle = (key) => setChosen((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]));

  const addBasics = async () => {
    setIsAdding(true);
    try {
      await onQuickAdd(BASICS.filter((basic) => chosen.includes(basic.key)));
      setChosen([]);
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <div className="first-run">
      <ol className="first-run-steps">
        <li className={hasAi ? 'is-done' : ''}>
          <span className="step-mark" aria-hidden="true">{hasAi ? '✓' : '1'}</span>
          <div>
            <strong>Connect the AI</strong>
            <small>{hasAi ? 'Connected.' : 'For tagging photos and styling. Enter the built-in AI passcode in Settings.'}</small>
          </div>
          {!hasAi && <button className="secondary-button compact" type="button" onClick={onOpenSettings}>Settings</button>}
        </li>
        <li>
          <span className="step-mark" aria-hidden="true">2</span>
          <div>
            <strong>Add photos of your clothes</strong>
            <small>One piece, a pile, or a mirror selfie. Each piece is found and cropped for you.</small>
          </div>
          <button className="primary-button compact" type="button" onClick={onAdd}>Add</button>
        </li>
        <li className={hasWeather ? 'is-done' : ''}>
          <span className="step-mark" aria-hidden="true">{hasWeather ? '✓' : '3'}</span>
          <div>
            <strong>Live weather <em>(optional)</em></strong>
            <small>{hasWeather ? 'On.' : 'So Today dresses you for the forecast.'}</small>
          </div>
          {!hasWeather && <button className="secondary-button compact" type="button" onClick={onOpenSettings}>Turn on</button>}
        </li>
      </ol>

      <section className="quick-basics">
        <h3>Or start with the basics you own</h3>
        <p>Tap what you have. Each gets a simple drawing for now; add real photos whenever you like.</p>
        <div className="chip-row">
          {BASICS.map((basic) => (
            <ChoiceButton key={basic.key} active={chosen.includes(basic.key)} onClick={() => toggle(basic.key)}>{basic.label}</ChoiceButton>
          ))}
        </div>
        <button className="primary-button full-width" type="button" disabled={!chosen.length || isAdding} onClick={addBasics}>
          {isAdding ? <><span className="button-spinner" /> Adding…</> : chosen.length ? `Add ${plural(chosen.length, 'piece')}` : 'Choose a few above'}
        </button>
      </section>
    </div>
  );
}

const JOURNAL_BADGES = { worn: 'Worn', planned: 'Planned', loved: 'Loved' };

function mondayOf(dateString) {
  const day = new Date(`${dateString}T12:00:00`).getDay();
  return addDays(dateString, -((day + 6) % 7));
}

/**
 * Mon-Sun at a glance: a thumbnail of what was worn (solid) or planned
 * (dashed) each day. Tapping a day shows just that day's entries below.
 */
function WeekStrip({ outfitRecords, itemsById, blobUrls, selectedDate, onSelectDate }) {
  const [weekStart, setWeekStart] = useState(() => mondayOf(localDate()));
  const today = localDate();
  const days = Array.from({ length: 7 }, (unused, index) => addDays(weekStart, index));
  const forDay = (date) => outfitRecords.find((record) => record.date === date && record.status === 'worn')
    || outfitRecords.find((record) => record.date === date && record.status === 'planned');
  const label = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

  return (
    <div className="week-strip">
      <div className="week-strip-header">
        <button className="icon-text-button" type="button" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week"><ArrowLeft aria-hidden="true" /></button>
        <strong>{weekStart === mondayOf(today) ? 'This week' : `Week of ${label.format(new Date(`${weekStart}T12:00:00`))}`}</strong>
        <button className="icon-text-button" type="button" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week"><ArrowRight aria-hidden="true" /></button>
      </div>
      <div className="week-strip-days">
        {days.map((date) => {
          const record = forDay(date);
          const first = record?.itemIds.map((id) => itemsById.get(id)).find(Boolean);
          return (
            <button
              key={date}
              type="button"
              className={`week-day ${date === today ? 'is-today' : ''} ${record ? `has-${record.status}` : ''} ${selectedDate === date ? 'is-selected' : ''}`}
              onClick={() => onSelectDate(selectedDate === date ? '' : date)}
              aria-pressed={selectedDate === date}
              aria-label={`${weekday(date)} ${formatDate(date)}${record ? `, ${JOURNAL_BADGES[record.status].toLowerCase()}` : ''}`}
            >
              <span>{weekday(date).slice(0, 2)}</span>
              <strong>{Number(date.slice(8))}</strong>
              {first ? <Photo item={first} blobUrls={blobUrls} className="week-day-photo" alt="" /> : <span className="week-day-empty" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function JournalView({
  items, blobUrls, outfitRecords, onPlanOutfit, onDeleteOutfitRecord, onAllowAgain, onOpenPhotoCheck,
  onSavePlan, buildCapsule, onAdd, onToast, feedback, repeatDays, weatherLocation,
}) {
  const [segment, setSegment] = useState('history');
  const [showHidden, setShowHidden] = useState(false);
  const stats = useMemo(() => computeWardrobeStats(items, outfitRecords), [items, outfitRecords]);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const outfitThumbs = (record) => record.itemIds.map((id) => itemsById.get(id)).filter(Boolean);
  const visibleRecords = outfitRecords.filter((record) => record.status !== 'rejected');
  const [dayFilter, setDayFilter] = useState('');
  const shownRecords = dayFilter ? visibleRecords.filter((record) => record.date === dayFilter) : visibleRecords;
  const ruledOut = outfitRecords.filter((record) => record.status === 'rejected');

  if (!items.length) {
    return (
      <section className="screen journal-screen empty-outfit">
        <div className="screen-heading"><div><p className="eyebrow">JOURNAL</p><h1>Your outfit history</h1></div></div>
        <div className="empty-state">
          <div className="empty-illustration" aria-hidden="true"><span><CalendarDays /></span><span><Sparkles /></span><span><Shirt /></span></div>
          <h2>Nothing logged yet</h2>
          <p>Add a few pieces, then wear or plan an outfit and it will show up here.</p>
          <button className="primary-button" type="button" onClick={onAdd}>Add clothes <span>→</span></button>
        </div>
      </section>
    );
  }

  return (
    <section className="screen journal-screen">
      <div className="screen-heading"><div><p className="eyebrow">JOURNAL</p><h1>What you’ve worn</h1></div></div>

      <div className="segment-toggle" role="tablist">
        <button className={`segment-button ${segment === 'history' ? 'is-selected' : ''}`} type="button" role="tab" aria-selected={segment === 'history'} onClick={() => setSegment('history')}>History</button>
        <button className={`segment-button ${segment === 'plan' ? 'is-selected' : ''}`} type="button" role="tab" aria-selected={segment === 'plan'} onClick={() => setSegment('plan')}>Plan ahead</button>
        <button className={`segment-button ${segment === 'stats' ? 'is-selected' : ''}`} type="button" role="tab" aria-selected={segment === 'stats'} onClick={() => setSegment('stats')}>Stats</button>
      </div>

      {segment === 'plan' && (
        <div className="planner-stack">
          <WeekPlanner items={items} blobUrls={blobUrls} feedback={feedback} repeatDays={repeatDays} weatherLocation={weatherLocation} onSavePlan={onSavePlan} />
          <TripPlanner items={items} blobUrls={blobUrls} feedback={feedback} onSavePlan={onSavePlan} onToast={onToast} />
          <CapsuleBuilder items={items} blobUrls={blobUrls} buildCapsule={buildCapsule} onToast={onToast} />
        </div>
      )}

      {segment === 'history' && (
        <>
          <div className="outfit-secondary-actions">
            <button className="secondary-button" type="button" onClick={onPlanOutfit}><Plus className="inline-icon" aria-hidden="true" /> Plan an outfit</button>
            <button className="secondary-button" type="button" onClick={onOpenPhotoCheck}><Camera className="inline-icon" aria-hidden="true" /> Log from a photo</button>
          </div>
          <WeekStrip outfitRecords={visibleRecords} itemsById={itemsById} blobUrls={blobUrls} selectedDate={dayFilter} onSelectDate={setDayFilter} />
          {dayFilter && (
            <p className="day-filter-note">
              Showing {weekday(dayFilter)} {formatDate(dayFilter)} · <button className="text-button" type="button" onClick={() => setDayFilter('')}>Show all</button>
            </p>
          )}
          {shownRecords.length ? (
            <div className="journal-list">
              {shownRecords.map((record) => (
                <div className="journal-row" key={record.id}>
                  <div className="journal-row-photos">
                    {outfitThumbs(record).slice(0, 4).map((item) => (
                      <Photo key={item.id} item={item} blobUrls={blobUrls} className="journal-photo" alt={displayCategory(item.category)} />
                    ))}
                  </div>
                  <div className="journal-row-copy">
                    <strong>{formatDate(record.date)}</strong>
                    <span className={`journal-badge journal-badge-${record.status}`}>{JOURNAL_BADGES[record.status]}</span>
                    {record.occasion && <small>{record.occasion}</small>}
                  </div>
                  <button className="icon-text-button danger-text" type="button" onClick={() => onDeleteOutfitRecord(record.id)} aria-label="Remove this entry"><X aria-hidden="true" /></button>
                </div>
              ))}
            </div>
          ) : (
            <p className="inline-note">{dayFilter ? 'Nothing logged or planned that day.' : 'Nothing logged yet. Wear a suggested outfit, log one from a photo, or plan one ahead.'}</p>
          )}

          {ruledOut.length > 0 && (
            <section className="ruled-out">
              <button className="text-button" type="button" aria-expanded={showHidden} onClick={() => setShowHidden((current) => !current)}>
                {showHidden ? 'Hide' : 'Show'} pairings you ruled out ({ruledOut.length})
              </button>
              {showHidden && (
                <div className="journal-list">
                  {ruledOut.map((record) => (
                    <div className="journal-row" key={record.id}>
                      <div className="journal-row-photos">
                        {outfitThumbs(record).slice(0, 4).map((item) => (
                          <Photo key={item.id} item={item} blobUrls={blobUrls} className="journal-photo" alt={displayCategory(item.category)} />
                        ))}
                      </div>
                      <div className="journal-row-copy"><small>Not suggested again</small></div>
                      <button className="text-button" type="button" onClick={() => onAllowAgain(record.id)}>Allow again</button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {segment === 'stats' && (
        <div className="stats-panel">
          <div className="stats-summary">
            <div><strong>{stats.totalItems}</strong><span>pieces</span></div>
            <div><strong>{stats.totalWornOutfits}</strong><span>outfits worn</span></div>
            <div><strong>{stats.neverWorn.length}</strong><span>never worn</span></div>
          </div>

          {stats.mostWorn.length > 0 && (
            <section className="stats-section">
              <h3>Most worn</h3>
              <div className="stats-item-row">
                {stats.mostWorn.map(({ item, wornCount }) => (
                  <div className="stats-item" key={item.id}>
                    <Photo item={item} blobUrls={blobUrls} className="stats-photo" alt={displayCategory(item.category)} />
                    <span>{wornCount}×</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {stats.neverWorn.length > 0 && (
            <section className="stats-section">
              <h3>Never worn</h3>
              <div className="stats-item-row">
                {stats.neverWorn.slice(0, 8).map((item) => (
                  <div className="stats-item" key={item.id}>
                    <Photo item={item} blobUrls={blobUrls} className="stats-photo" alt={displayCategory(item.category)} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {stats.costPerWear.length > 0 && (
            <section className="stats-section">
              <h3>Cost per wear</h3>
              <ul className="stats-list">
                {stats.costPerWear.map(({ item, costPerWear, wornCount }) => (
                  <li key={item.id}>
                    <span>{displayCategory(item.category)} · {item.colors.join(', ') || 'untitled'}</span>
                    <strong>{costPerWear.toFixed(2)}/wear</strong>
                    <small>{wornCount}×</small>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="stats-section">
            <h3>By category</h3>
            <div className="filter-scroll" aria-label="Category breakdown">
              {stats.categoryBreakdown.map(({ category, count }) => (
                <FilterChip key={category} label={displayCategory(category)} count={count} active={false} onClick={() => {}} />
              ))}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function OutfitThumbs({ itemIds, itemsById, blobUrls, className = 'journal-photo' }) {
  return (
    <div className="journal-row-photos">
      {itemIds.map((id) => itemsById.get(id)).filter(Boolean).map((item) => (
        <Photo key={item.id} item={item} blobUrls={blobUrls} className={className} alt={`${displayCategory(item.category)}${item.colors.length ? `, ${item.colors.join(' ')}` : ''}`} />
      ))}
    </div>
  );
}

const MAIN_CATEGORIES = new Set(['top', 'bottom', 'dress']);

/**
 * Seven days of outfits in one go, with no top, bottom or dress repeated while
 * there's anything else to wear. Uses the live forecast for each day when it's
 * on. Local and instant, so it works with no AI and can't be rate-limited.
 */
function WeekPlanner({ items, blobUrls, feedback, repeatDays, weatherLocation, onSavePlan }) {
  const [start, setStart] = useState(() => addDays(localDate(), 1));
  const [weekdayOccasion, setWeekdayOccasion] = useState('Work');
  const [weekendOccasion, setWeekendOccasion] = useState('Everyday');
  const [plan, setPlan] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const forecast = useForecast(weatherLocation);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  const generate = () => {
    const days = Array.from({ length: 7 }, (unused, index) => {
      const date = addDays(start, index);
      const day = forecast.days?.find((entry) => entry.date === date) || null;
      return {
        date,
        occasion: isWeekend(date) ? weekendOccasion : weekdayOccasion,
        weather: day?.weather || 'any',
        rain: Boolean(day?.rain),
        forecast: day,
      };
    });
    setPlan(planOutfitsForDays(items, days, { repeatDays, feedback }));
  };

  const reshuffleDay = (index) => {
    setPlan((current) => {
      const usedElsewhere = new Set(current.filter((unused, other) => other !== index).flatMap((day) => day.itemIds));
      const thisDay = new Set(current[index].itemIds);
      const without = (ids) => items.filter((item) => !(MAIN_CATEGORIES.has(item.category) && ids.has(item.id)));
      // Most to least picky: nothing worn on any other day and different from
      // this day's pick; then just different from this day's pick; then
      // anything. A small wardrobe can't satisfy the first, and a top on its
      // own is worse than a repeat.
      const pools = [without(new Set([...usedElsewhere, ...thisDay])), without(thisDay), items];
      let next = current[index];
      for (const pool of pools) {
        const [candidate] = planOutfitsForDays(pool, [current[index]], { repeatDays, feedback });
        if (isCompleteOutfit(candidate.itemIds, itemsById)) {
          next = candidate;
          break;
        }
      }
      return current.map((day, other) => (other === index ? next : day));
    });
  };

  const save = async () => {
    setIsSaving(true);
    const saved = await onSavePlan(plan, { source: 'week' });
    setIsSaving(false);
    if (saved) setPlan(null);
  };

  return (
    <section className="settings-card planner-card">
      <div className="settings-card-heading"><span className="settings-icon" aria-hidden="true"><CalendarRange /></span><div><h2>Plan my week</h2><p>Seven outfits, no top or bottom repeated while there are others to wear.</p></div></div>
      {!plan ? (
        <>
          <div className="form-grid">
            <label className="span-two">Starting<input type="date" value={start} onChange={(event) => setStart(event.target.value || addDays(localDate(), 1))} /></label>
            <label>Weekdays<select value={weekdayOccasion} onChange={(event) => setWeekdayOccasion(event.target.value)}>{OCCASIONS.map((option) => <option key={option}>{option}</option>)}</select></label>
            <label>Weekend<select value={weekendOccasion} onChange={(event) => setWeekendOccasion(event.target.value)}>{OCCASIONS.map((option) => <option key={option}>{option}</option>)}</select></label>
          </div>
          <p className="field-hint">{weatherLocation ? (forecast.days ? `Uses the forecast for ${weatherLocation.shortName}.` : 'Loading the forecast…') : 'Turn on live weather in Settings to plan around the forecast.'}</p>
          <button className="primary-button full-width" type="button" disabled={!items.some(isAvailable)} onClick={generate}>Plan 7 days <span>→</span></button>
        </>
      ) : (
        <>
          <div className="plan-list">
            {plan.map((day, index) => (
              <div className="plan-day" key={day.date}>
                <div className="plan-day-label">
                  <strong>{weekday(day.date)} {formatDate(day.date)}</strong>
                  <small>{day.occasion}{day.forecast ? ` · ${describeDay(day.forecast)}` : ''}</small>
                </div>
                {day.itemIds.length
                  ? <OutfitThumbs itemIds={day.itemIds} itemsById={itemsById} blobUrls={blobUrls} />
                  : <small className="plan-empty">Nothing suitable</small>}
                <button className="icon-text-button" type="button" onClick={() => reshuffleDay(index)} aria-label={`Shuffle ${weekday(day.date)}`}><RefreshCw aria-hidden="true" /></button>
              </div>
            ))}
          </div>
          <button className="primary-button full-width" type="button" disabled={isSaving} onClick={save}>{isSaving ? 'Saving…' : 'Save to my journal'}</button>
          <button className="text-button" type="button" onClick={() => setPlan(null)}>Start over</button>
        </>
      )}
    </section>
  );
}

/**
 * A packing list and day-by-day outfits for a trip, sized to the fewest pieces
 * that cover every day. Uses the destination's forecast for any day within
 * the next 16 days, and the chosen climate for the rest.
 */
function TripPlanner({ items, blobUrls, feedback, onSavePlan, onToast }) {
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState([]);
  const [place, setPlace] = useState(null);
  const [start, setStart] = useState(() => addDays(localDate(), 7));
  const [length, setLength] = useState(4);
  const [occasion, setOccasion] = useState('Everyday');
  const [climate, setClimate] = useState('mild');
  const [trip, setTrip] = useState(null);
  const [packed, setPacked] = useState([]);
  const [isBusy, setIsBusy] = useState(false);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  const search = async (event) => {
    event.preventDefault();
    setIsBusy(true);
    try {
      const found = await searchPlaces(query);
      setPlaces(found);
      if (!found.length) onToast('No place by that name. Try a nearby city.');
    } catch (error) {
      onToast(error.message);
    } finally {
      setIsBusy(false);
    }
  };

  const generate = async () => {
    setIsBusy(true);
    let forecastDays = [];
    if (place) {
      try {
        forecastDays = await loadForecast(place);
      } catch (error) {
        onToast(`${error.message} Using the climate you chose instead.`);
      }
    }
    const days = Array.from({ length }, (unused, index) => {
      const date = addDays(start, index);
      const day = forecastDays.find((entry) => entry.date === date) || null;
      return { date, occasion, weather: day?.weather || climate, rain: Boolean(day?.rain), forecast: day };
    });
    const result = packForTrip(items, days, { occasion, feedback });
    setTrip({ ...result, covered: days.filter((day) => day.forecast).length, days: days.length });
    setPacked([]);
    setIsBusy(false);
  };

  const save = async () => {
    setIsBusy(true);
    const saved = await onSavePlan(trip.outfits, { source: 'trip', occasion: place ? `Trip to ${place.shortName}` : 'Trip' });
    setIsBusy(false);
    if (saved) setTrip(null);
  };

  const togglePacked = (id) => setPacked((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  return (
    <section className="settings-card planner-card">
      <div className="settings-card-heading"><span className="settings-icon" aria-hidden="true"><Plane /></span><div><h2>Pack for a trip</h2><p>The fewest pieces that cover every day, with an outfit for each.</p></div></div>
      {!trip ? (
        <>
          <form className="place-search" onSubmit={search}>
            <input value={query} onChange={(event) => { setQuery(event.target.value); setPlace(null); }} placeholder="Where to? (optional)" aria-label="Destination" />
            <button className="secondary-button compact" type="submit" disabled={isBusy || query.trim().length < 2}>Find</button>
          </form>
          {places.length > 0 && !place && (
            <div className="place-results">
              {places.map((option) => (
                <button key={`${option.latitude},${option.longitude}`} className="place-option" type="button" onClick={() => { setPlace(option); setQuery(option.name); setPlaces([]); }}>{option.name}</button>
              ))}
            </div>
          )}
          <div className="form-grid">
            <label>Leaving<input type="date" value={start} onChange={(event) => setStart(event.target.value || localDate())} /></label>
            <label>Days<input type="number" min="1" max="14" value={length} onChange={(event) => setLength(Math.min(14, Math.max(1, Number(event.target.value) || 1)))} /></label>
            <label className="span-two">Mostly for<select value={occasion} onChange={(event) => setOccasion(event.target.value)}>{OCCASIONS.map((option) => <option key={option}>{option}</option>)}</select></label>
          </div>
          <fieldset className="question-block compact-block">
            <legend>{place ? 'Weather for days beyond the forecast' : 'Expected weather'}</legend>
            <div className="choice-grid weather-grid">
              {WEATHER_OPTIONS.map((option) => <ChoiceButton key={option.value} active={climate === option.value} onClick={() => setClimate(option.value)}>{option.label}</ChoiceButton>)}
            </div>
          </fieldset>
          <button className="primary-button full-width" type="button" disabled={isBusy || !items.some(isAvailable)} onClick={generate}>{isBusy ? 'Working…' : 'Make my packing list'}</button>
        </>
      ) : (
        <>
          <p className="plan-summary">
            <strong>{plural(trip.packingList.length, 'piece')}</strong> for {plural(trip.days, 'day')}
            {place ? ` in ${place.shortName}` : ''}.
            {' '}{trip.covered ? `Forecast used for ${plural(trip.covered, 'day')}${trip.covered < trip.days ? '; your chosen weather for the rest' : ''}.` : 'Planned for the weather you chose.'}
          </p>
          <ul className="packing-list">
            {[...trip.packingList].sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category)).map((item) => (
              <li key={item.id}>
                <label>
                  <input type="checkbox" checked={packed.includes(item.id)} onChange={() => togglePacked(item.id)} />
                  <Photo item={item} blobUrls={blobUrls} className="packing-photo" alt="" />
                  <span>{displayCategory(item.category)} · {item.colors.join(', ') || 'untitled'}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="field-hint">{packed.length} of {trip.packingList.length} packed. Ticks aren't saved.</p>
          <div className="plan-list">
            {trip.outfits.map((day) => (
              <div className="plan-day" key={day.date}>
                <div className="plan-day-label">
                  <strong>{weekday(day.date)} {formatDate(day.date)}</strong>
                  <small>{day.forecast ? describeDay(day.forecast) : WEATHER_OPTIONS.find((option) => option.value === day.weather)?.label}</small>
                </div>
                <OutfitThumbs itemIds={day.itemIds} itemsById={itemsById} blobUrls={blobUrls} />
              </div>
            ))}
          </div>
          <button className="primary-button full-width" type="button" disabled={isBusy} onClick={save}>{isBusy ? 'Saving…' : 'Save outfits to my journal'}</button>
          <button className="text-button" type="button" onClick={() => setTrip(null)}>Start over</button>
        </>
      )}
    </section>
  );
}

/**
 * Asks the AI for a capsule: a small set of owned pieces that mix into the
 * most outfits, with example outfits made only from those pieces.
 */
function CapsuleBuilder({ items, blobUrls, buildCapsule, onToast }) {
  const [size, setSize] = useState(12);
  const [season, setSeason] = useState('');
  const [capsule, setCapsule] = useState(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const hasAi = hasAnyProvider();

  const build = async () => {
    setIsBuilding(true);
    try {
      setCapsule(await buildCapsule({ items, size, season }));
    } catch (error) {
      onToast(error?.message || 'The capsule could not be built this time.');
    } finally {
      setIsBuilding(false);
    }
  };

  return (
    <section className="settings-card planner-card">
      <div className="settings-card-heading"><span className="settings-icon" aria-hidden="true"><Gem /></span><div><h2>Build a capsule</h2><p>The pieces you own that mix into the most outfits.</p></div></div>
      {!hasAi && <p className="inline-note">This one uses AI. Connect the built-in AI or a provider in Settings.</p>}
      <div className="form-grid">
        <label>Pieces<select value={size} onChange={(event) => setSize(Number(event.target.value))}>{[10, 12, 15].map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        <label>Season<select value={season} onChange={(event) => setSeason(event.target.value)}><option value="">Any</option>{['spring', 'summer', 'autumn', 'winter'].map((option) => <option key={option} value={option}>{option[0].toUpperCase() + option.slice(1)}</option>)}</select></label>
      </div>
      <button className="primary-button full-width" type="button" disabled={!hasAi || isBuilding || items.filter(isAvailable).length < 4} onClick={build}>
        {isBuilding ? <><span className="button-spinner" /> Building…</> : capsule ? 'Build another' : 'Build my capsule'}
      </button>
      {capsule && (
        <div className="capsule-result">
          <OutfitThumbs itemIds={capsule.itemIds} itemsById={itemsById} blobUrls={blobUrls} className="capsule-photo" />
          {capsule.explanation && <div className="explanation-card"><span aria-hidden="true"><Sparkles /></span><p>{capsule.explanation}</p></div>}
          {capsule.outfits.length > 0 && (
            <>
              <h3>{plural(capsule.outfits.length, 'example outfit')}</h3>
              <div className="plan-list">
                {capsule.outfits.map((ids, index) => (
                  <div className="plan-day" key={ids.join('-') || index}>
                    <OutfitThumbs itemIds={ids} itemsById={itemsById} blobUrls={blobUrls} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Escape closes, Tab stays inside, and focus goes back where it was on close. */
function useModalKeyboard(dialogRef, onClose) {
  // Held in a ref so a parent re-render (a toast, say) handing down a new
  // onClose doesn't re-run the effect and yank focus back to the dialog.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), select, textarea, [href]');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [dialogRef]);
}

/**
 * Today's outfit, from one photo: the AI says which saved pieces are being
 * worn (each one can be corrected before logging) and gives honest written
 * feedback. No score: a number from a model looking at one photo would be
 * made up, and the research on other apps found people don't trust it.
 */
function OutfitPhotoModal({ items, blobUrls, analyze, weatherLocation, onClose, onLog, onToast }) {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [occasion, setOccasion] = useState('Everyday');
  const [result, setResult] = useState(null);
  const [matches, setMatches] = useState([]);
  const [isReading, setIsReading] = useState(false);
  const [isLogged, setIsLogged] = useState(false);
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const forecast = useForecast(weatherLocation);
  const today = forecast.days?.find((day) => day.date === localDate()) || null;
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const hasAi = hasAnyProvider();
  useModalKeyboard(dialogRef, onClose);

  useEffect(() => {
    if (!file) {
      setPreviewUrl('');
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const choose = (event) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    setFile(picked);
    setResult(null);
    setReadError('');
    setIsLogged(false);
  };

  const [readError, setReadError] = useState('');
  const [waitingNote, setWaitingNote] = useState('');
  // Which "Change" row is open; corrections are there if needed, out of the way if not.
  const [changingIndex, setChangingIndex] = useState(-1);

  const read = async () => {
    setIsReading(true);
    setReadError('');
    try {
      const analysis = await retryWhenBusy(
        () => analyze(file, { items, occasion, forecastNote: forecastNote(today, weatherLocation?.shortName) }),
        () => setWaitingNote('Google is busy. Trying again in a few seconds…'),
      );
      setResult(analysis);
      // Each piece is a saved one, or new (added when logging), or skipped.
      // When the AI didn't recognise a piece, a saved one of the same category
      // sharing a colour is taken as it, so logging doesn't add a duplicate.
      // "Change" fixes a wrong guess either way.
      const taken = new Set(analysis.wearing.map((entry) => entry.itemId).filter(Boolean));
      const colourWords = (colors = []) => colors.map((color) => String(color).toLowerCase());
      const likelyMine = (entry) => {
        const wanted = colourWords(entry.piece?.colors);
        if (!wanted.length) return '';
        const match = items.find((item) => item.category === entry.category && !taken.has(item.id)
          && colourWords(item.colors).some((color) => wanted.some((word) => color.includes(word) || word.includes(color))));
        if (match) taken.add(match.id);
        return match?.id || '';
      };
      setMatches(analysis.wearing.map((entry) => entry.itemId || likelyMine(entry) || (entry.piece ? 'new' : 'skip')));
      setChangingIndex(-1);
    } catch (error) {
      setReadError(error?.message || 'That photo could not be read.');
    } finally {
      setIsReading(false);
      setWaitingNote('');
    }
  };

  const savedIds = [...new Set(matches.filter((value) => value && value !== 'new' && value !== 'skip'))];
  const newPieces = result ? result.wearing.filter((entry, index) => matches[index] === 'new' && entry.piece).map((entry) => entry.piece) : [];
  const total = savedIds.length + newPieces.length;

  const log = async () => {
    try {
      await onLog({ itemIds: savedIds, newPieces, file, verdict: result?.verdict || '', onUndone: () => setIsLogged(false) });
      setIsLogged(true);
    } catch (error) {
      onToast(error?.message || 'That outfit could not be logged.');
    }
  };

  const describe = (item) => `${displayCategory(item.category)} · ${item.colors.join(', ') || 'untitled'}`;
  const setMatch = (index, value) => {
    setMatches((current) => current.map((entry, other) => (other === index ? value : entry)));
    setChangingIndex(-1);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="item-editor photo-check" role="dialog" aria-modal="true" aria-labelledby="photo-check-title" ref={dialogRef} tabIndex={-1}>
        <div className="modal-handle" />
        <div className="editor-header">
          <div><p className="eyebrow">TODAY'S OUTFIT</p><h2 id="photo-check-title">Log it and get feedback</h2></div>
          <button className="close-button" type="button" onClick={onClose} aria-label="Close"><X aria-hidden="true" /></button>
        </div>

        <input ref={inputRef} type="file" accept="image/*" hidden onChange={choose} />
        {previewUrl
          ? <img className="photo-check-preview" src={previewUrl} alt="Your outfit photo" />
          : (
            <button className="photo-check-pick" type="button" onClick={() => inputRef.current?.click()}>
              <span aria-hidden="true"><Camera /></span>
              <strong>Take or choose a photo</strong>
              <small>A mirror selfie works best. Only this photo is sent to your AI provider.</small>
            </button>
          )}

        {!hasAi && <p className="inline-note">This uses AI. Connect the built-in AI or a provider in Settings.</p>}

        {file && !result && (
          <>
            {readError && (
              <div className="retry-box" role="alert">
                <p>{readError}</p>
                <button className="secondary-button compact" type="button" disabled={isReading} onClick={read}>
                  {isReading ? <><span className="button-spinner dark" /> {waitingNote || 'Trying…'}</> : <><RefreshCw className="inline-icon" aria-hidden="true" /> Try again</>}
                </button>
              </div>
            )}
            {!readError && <label className="wanted-select">Dressed for<select value={occasion} onChange={(event) => setOccasion(event.target.value)}>{OCCASIONS.map((option) => <option key={option}>{option}</option>)}</select></label>}
            {!readError && (
              <button className="primary-button full-width" type="button" disabled={!hasAi || isReading} onClick={read}>
                {isReading ? <><span className="button-spinner" /> {waitingNote || 'Looking…'}</> : <>Read my outfit <span className="button-icon" aria-hidden="true"><Sparkles /></span></>}
              </button>
            )}
            <button className="text-button" type="button" onClick={() => inputRef.current?.click()}>Use a different photo</button>
          </>
        )}

        {result && (
          <>
            <div className="explanation-card"><span aria-hidden="true"><Sparkles /></span><p>{result.verdict || 'Here\'s what I see.'}</p></div>

            {result.wearing.length ? (
              <ul className="wearing-list">
                {result.wearing.map((entry, index) => {
                  const value = matches[index];
                  const saved = value && value !== 'new' && value !== 'skip' ? itemsById.get(value) : null;
                  const options = items.filter((item) => item.category === entry.category || item.id === value);
                  return (
                    <li key={`${entry.description}-${index}`} className={value === 'skip' ? 'is-skipped' : ''}>
                      {saved
                        ? <Photo item={saved} blobUrls={blobUrls} className="wearing-photo" alt="" />
                        : <CroppedImage src={previewUrl} crop={entry.piece?.crop} className="wearing-photo" />}
                      <div className="wearing-copy">
                        <strong>{entry.description || displayCategory(entry.category)}</strong>
                        <span className={`wearing-badge ${saved ? 'is-saved' : value === 'new' ? 'is-new' : ''}`}>
                          {saved ? 'In your wardrobe' : value === 'new' ? 'New — will be added' : 'Not logged'}
                        </span>
                        {changingIndex === index && !isLogged && (
                          <select value={value} onChange={(event) => setMatch(index, event.target.value)} aria-label={`What ${entry.description || 'this piece'} is`}>
                            {entry.piece && <option value="new">Add as a new piece</option>}
                            {options.map((item) => <option key={item.id} value={item.id}>Mine: {describe(item)}</option>)}
                            <option value="skip">Don’t log this one</option>
                          </select>
                        )}
                      </div>
                      {!isLogged && changingIndex !== index && (
                        <button className="text-button" type="button" onClick={() => setChangingIndex(index)}>Change</button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : <p className="field-hint">No clothes were picked out of this photo.</p>}

            <button className={`primary-button full-width ${isLogged ? 'success-button' : ''}`} type="button" disabled={isLogged || !total} onClick={log}>
              {isLogged
                ? '✓ Logged for today'
                : newPieces.length
                  ? `Log today’s outfit · add ${plural(newPieces.length, 'new piece')}`
                  : 'Log today’s outfit'}
            </button>

            {(result.working.length > 0 || result.tweaks.length > 0) && (
              <details className="feedback-details">
                <summary>What works, and what to try</summary>
                {result.working.length > 0 && (
                  <section className="feedback-section">
                    <h3>Working</h3>
                    <ul>{result.working.map((line) => <li key={line}>{line}</li>)}</ul>
                  </section>
                )}
                {result.tweaks.length > 0 && (
                  <section className="feedback-section">
                    <h3>Worth trying</h3>
                    <ul>
                      {result.tweaks.map((tweak) => {
                        const swap = tweak.swapItemId ? itemsById.get(tweak.swapItemId) : null;
                        return (
                          <li key={tweak.suggestion} className={swap ? 'has-swap' : ''}>
                            <span>{tweak.suggestion}</span>
                            {swap && <span className="swap-chip"><Photo item={swap} blobUrls={blobUrls} className="swap-photo" alt="" />{describe(swap)}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
              </details>
            )}
            {!isLogged && <button className="text-button" type="button" onClick={() => inputRef.current?.click()}>Try another photo</button>}
          </>
        )}
      </section>
    </div>
  );
}

/**
 * Saves a manually built outfit — reached from Outfit's "Build it myself" and
 * Journal's "Plan an outfit," both of which land here through the same
 * wardrobe selection mode. The date field IS the planning mechanism: today
 * saves it as worn, any other date plans it, with no separate calendar UI.
 */
function SaveLookModal({ items, blobUrls, itemIds, onClose, onSave }) {
  const [date, setDate] = useState(() => localDate());
  const [occasion, setOccasion] = useState('');
  const [explanation, setExplanation] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const dialogRef = useRef(null);

  const selectedItems = itemIds.map((id) => items.find((item) => item.id === id)).filter(Boolean);
  const isToday = date === localDate();

  // Same Escape / focus-trap / focus-restore behaviour as the item editor.
  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select, textarea, [href]',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [onClose]);

  const save = async () => {
    setIsSaving(true);
    try {
      await onSave({ itemIds, date, occasion, explanation });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="item-editor" role="dialog" aria-modal="true" aria-labelledby="save-look-title" ref={dialogRef} tabIndex={-1}>
        <div className="modal-handle" />
        <div className="editor-header">
          <div><p className="eyebrow">YOUR LOOK</p><h2 id="save-look-title">Save this outfit</h2></div>
          <button className="close-button" type="button" onClick={onClose} aria-label="Close"><X aria-hidden="true" /></button>
        </div>
        <OutfitLook items={selectedItems} blobUrls={blobUrls} className="look-compact" />
        <div className="form-grid editor-fields">
          <label className="span-two">Date<input type="date" value={date} onChange={(event) => setDate(event.target.value || localDate())} /></label>
          <label className="span-two">Occasion (optional)<input value={occasion} placeholder="e.g. work, date night" onChange={(event) => setOccasion(event.target.value)} /></label>
          <label className="span-two">Notes (optional)<input value={explanation} placeholder="Why this works, what to remember…" onChange={(event) => setExplanation(event.target.value)} /></label>
        </div>
        <p className="inline-note">{isToday ? 'Saved as worn today.' : `Planned for ${formatDate(date)} — not marked as worn until then.`}</p>
        <button className="primary-button full-width" type="button" disabled={isSaving || !selectedItems.length} onClick={save}>
          {isSaving ? 'Saving…' : isToday ? 'Save — wear it today' : 'Save for later'}
        </button>
      </section>
    </div>
  );
}

function daysAgo(timestamp) {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

const formatMegabytes = (bytes) => `${(bytes / 1_048_576).toFixed(1)} MB`;

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Backup and restore. On desktop, Android and an iOS Safari tab a normal
 * download works, so saving is one tap. In an app launched from an iPhone's
 * home screen a blob download is widely reported to fail, so saving goes
 * through the share sheet instead — in two taps, because Safari only lets
 * share() start straight from a tap, and building a backup is too slow to
 * await first: "Prepare" builds the file, "Save" opens the sheet.
 */
function BackupCard({ exportBackup, onRestore, onToast, dataKey }) {
  const useShareSheet = useMemo(() => isIosStandalone() && canUseShareSheet(), []);
  const [prepared, setPrepared] = useState(null);
  const [isBusy, setIsBusy] = useState(false);
  const [lastBackup, setLastBackup] = useState(getLastBackupAt);

  // Clearing, restoring or editing the wardrobe makes a prepared file stale.
  useEffect(() => { setPrepared(null); }, [dataKey]);

  const build = async () => {
    if (!exportBackup) throw new Error('Backups are not available here.');
    return exportBackup();
  };

  const downloadBackup = async () => {
    setIsBusy(true);
    try {
      const { blob, fileName, counts } = await build();
      downloadBlob(blob, fileName);
      setLastBackupAt();
      setLastBackup(Date.now());
      onToast(`Backup saved: ${describeCounts(counts)} (${formatMegabytes(blob.size)}).`);
    } catch (error) {
      onToast(error?.message || 'The backup could not be made.');
    } finally {
      setIsBusy(false);
    }
  };

  const prepareBackup = async () => {
    setIsBusy(true);
    try {
      const { blob, fileName, counts } = await build();
      setPrepared({ blob, fileName, counts, shareable: pickShareableFile(shareCandidates(blob, fileName)) });
    } catch (error) {
      onToast(error?.message || 'The backup could not be made.');
    } finally {
      setIsBusy(false);
    }
  };

  // Deliberately not async, with nothing awaited before it: share() has to
  // start inside the tap itself or Safari refuses it.
  const saveBackup = () => {
    if (!prepared?.shareable) return;
    const { counts } = prepared;
    shareFile(prepared.shareable)
      .then((outcome) => {
        if (outcome === 'shared') {
          setLastBackupAt();
          setLastBackup(Date.now());
        }
        onToast(outcome === 'shared'
          ? `Backup sent to the share sheet: ${describeCounts(counts)}.`
          : 'Cancelled. Your backup is still ready if you want to save it.');
      })
      .catch((error) => {
        onToast(`The share sheet would not open (${error?.name || 'error'}). Tap Save backup again.`);
      });
  };

  return (
    <section className="settings-card" id="backup">
      <div className="settings-card-heading"><span className="settings-icon" aria-hidden="true"><Archive /></span><div><h2>Backup</h2><p>Your wardrobe lives only in this browser. Save a backup file now and then, and restore it here or on another device. Keys are never included.</p><p className={`backup-age ${!lastBackup || Date.now() - lastBackup > 30 * 86_400_000 ? 'is-stale' : ''}`}>{lastBackup ? `Last backup: ${daysAgo(lastBackup)}.` : 'No backup saved from this device yet.'}</p></div></div>
      <div className="backup-actions">
        {!useShareSheet && (
          <button className="secondary-button" type="button" disabled={isBusy} onClick={downloadBackup}>{isBusy ? 'Preparing…' : 'Download backup'}</button>
        )}
        {useShareSheet && !prepared && (
          <button className="secondary-button" type="button" disabled={isBusy} onClick={prepareBackup}>{isBusy ? 'Preparing…' : 'Prepare backup'}</button>
        )}
        {useShareSheet && prepared?.shareable && (
          <button className="primary-button" type="button" onClick={saveBackup}>Save backup ({formatMegabytes(prepared.blob.size)})</button>
        )}
        {useShareSheet && prepared && !prepared.shareable && (
          <button className="secondary-button" type="button" onClick={() => downloadBlob(prepared.blob, prepared.fileName)}>Try a direct download</button>
        )}
        <label className="secondary-button">
          Restore from a backup
          <input className="visually-hidden" type="file" accept="application/json,.json,text/plain,.txt" onChange={(event) => { onRestore(event.target.files?.[0]); event.target.value = ''; }} />
        </label>
      </div>
      {useShareSheet && !prepared && (
        <p className="field-hint">In the home-screen app, saving takes two taps: Prepare builds the file, then Save opens the share sheet. Choose Save to Files.</p>
      )}
      {useShareSheet && prepared?.shareable && (
        <p className="field-hint">{describeCounts(prepared.counts)}. Tap Save, then choose Save to Files.</p>
      )}
      {useShareSheet && prepared && !prepared.shareable && (
        <p className="inline-note">This phone would not offer the share sheet for a backup file. A direct download may still work; if the app jumps to a page of text, close and reopen it — nothing is lost.</p>
      )}
    </section>
  );
}

/**
 * Live weather is off until switched on here. A typed city never touches the
 * device's location; "use my location" rounds it to about 10 km first.
 */
function WeatherCard({ location, onChange, onToast }) {
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState([]);
  const [isBusy, setIsBusy] = useState(false);
  const forecast = useForecast(location);
  const today = forecast.days?.find((day) => day.date === localDate()) || null;

  const choose = (place) => {
    onChange(place);
    setPlaces([]);
    setQuery('');
    onToast(`Live weather on for ${place.name}.`);
  };

  const search = async (event) => {
    event.preventDefault();
    setIsBusy(true);
    try {
      const found = await searchPlaces(query);
      setPlaces(found);
      if (!found.length) onToast('No place by that name. Try a nearby city.');
    } catch (error) {
      onToast(error.message);
    } finally {
      setIsBusy(false);
    }
  };

  const useDevice = async () => {
    setIsBusy(true);
    try {
      choose(await currentRoundedPosition());
    } catch (error) {
      onToast(error.message);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <section className="settings-card">
      <div className="settings-card-heading"><span className="settings-icon" aria-hidden="true"><CloudSun /></span><div><h2>Live weather</h2><p>Fills in the weather on the Today screen, and plans your week around the forecast.</p></div></div>
      {location ? (
        <>
          <p className="forecast-line"><strong>{location.name}</strong>{today ? ` · today ${describeDay(today)}` : forecast.error ? ` · ${forecast.error}` : ''}</p>
          <button className="secondary-button full-width" type="button" onClick={() => { onChange(null); onToast('Live weather off.'); }}>Turn off live weather</button>
        </>
      ) : (
        <>
          <form className="place-search" onSubmit={search}>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Your city" aria-label="City for live weather" />
            <button className="secondary-button compact" type="submit" disabled={isBusy || query.trim().length < 2}>Find</button>
          </form>
          {places.length > 0 && (
            <div className="place-results">
              {places.map((place) => <button key={`${place.latitude},${place.longitude}`} className="place-option" type="button" onClick={() => choose(place)}>{place.name}</button>)}
            </div>
          )}
          <button className="text-button" type="button" disabled={isBusy} onClick={useDevice}>Or use my location (rounded to about 10 km)</button>
        </>
      )}
      <p className="privacy-note"><span aria-hidden="true"><Lock /></span>Forecasts come from Open-Meteo, free and with no account. Only the rounded place is sent, never your wardrobe.</p>
    </section>
  );
}

function SettingsView({ onClear, exportBackup, onRestore, onToast, dataKey, weatherLocation, onWeatherLocationChange }) {
  const [providers, setProviders] = useState(getProviders);
  const [activeId, setActiveId] = useState(getActiveProviderId);
  // null = nothing open, 'new' = the add-provider form, or a provider id being edited.
  const [openFormId, setOpenFormId] = useState(null);
  const [repeatDays, setRepeatDaysDraft] = useState(getRepeatDays);

  const refresh = () => {
    setProviders(getProviders());
    setActiveId(getActiveProviderId());
  };

  const makeActive = (id) => {
    setActiveProviderId(id);
    refresh();
  };

  const removeProvider = (id, label) => {
    if (!window.confirm(`Remove ${label || 'this provider'}? Its saved key will be deleted from this device.`)) return;
    deleteProvider(id);
    refresh();
    onToast('Provider removed.');
  };

  const changeRepeatDays = (value) => {
    setRepeatDaysDraft(value);
    if (!setRepeatDays(value)) {
      onToast('This browser is blocking local storage, so this could not be saved.');
    }
  };

  return (
    <section className="screen settings-screen">
      <div className="screen-heading"><div><p className="eyebrow">SETTINGS</p><h1>Your private closet</h1><p className="heading-copy">Everything lives in this browser, on this device.</p></div></div>

      <section className="settings-card">
        <div className="settings-card-heading">
          <span className="settings-icon" aria-hidden="true"><Sparkles /></span>
          <div><h2>AI providers</h2><p>Add any OpenAI-compatible API. Used only to tag photos and make outfit suggestions.</p></div>
        </div>

        {!providers.some((item) => item.presetId === BUILTIN_PRESET_ID) && (
          <BuiltInAiSetup
            onConnected={(passcode) => {
              const preset = getPreset(BUILTIN_PRESET_ID);
              const entry = addProvider({ ...preset, presetId: preset.id, apiKey: passcode });
              setActiveProviderId(entry.id);
              refresh();
              onToast('Built-in AI connected.');
            }}
          />
        )}

        {providers.length === 0 && (
          <p className="inline-note">Or bring your own key: add any provider below. Everything else in the app works without AI.</p>
        )}

        {providers.length > 0 && (
          <div className="provider-list" role="radiogroup" aria-label="Active AI provider">
            {providers.map((item) => (
              openFormId === item.id ? (
                <ProviderForm
                  key={item.id}
                  mode="edit"
                  initial={item}
                  onCancel={() => setOpenFormId(null)}
                  onSave={(changes) => {
                    updateProvider(item.id, changes);
                    refresh();
                    setOpenFormId(null);
                    onToast('Provider updated.');
                  }}
                  onToast={onToast}
                />
              ) : (
                <div className={`provider-row ${item.id === activeId ? 'is-active' : ''}`} key={item.id}>
                  <label className="provider-row-radio">
                    <input type="radio" checked={item.id === activeId} onChange={() => makeActive(item.id)} />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.model || 'no model set'} · {JSON_MODE_LABELS[item.jsonMode] || item.jsonMode}</small>
                      <ProviderUsage provider={item} />
                    </span>
                  </label>
                  <div className="provider-row-actions">
                    <button className="text-button" type="button" onClick={() => setOpenFormId(item.id)}>Edit</button>
                    <button className="icon-text-button danger-text" type="button" onClick={() => removeProvider(item.id, item.label)}>Remove</button>
                  </div>
                </div>
              )
            ))}
          </div>
        )}

        {openFormId === 'new' ? (
          <ProviderForm
            mode="add"
            onCancel={() => setOpenFormId(null)}
            onSave={(values) => {
              addProvider(values);
              refresh();
              setOpenFormId(null);
              onToast('Provider added.');
            }}
            onToast={onToast}
          />
        ) : (
          <button className="secondary-button full-width" type="button" onClick={() => setOpenFormId('new')}><Plus className="inline-icon" aria-hidden="true" /> Add a provider</button>
        )}

        <p className="privacy-note"><span aria-hidden="true"><Lock /></span>Each provider's key is saved locally on this device and is sent only to that provider, and only when you use a feature that needs it.</p>
      </section>

      <WeatherCard location={weatherLocation} onChange={onWeatherLocationChange} onToast={onToast} />

      <section className="settings-card">
        <div className="settings-card-heading"><span className="settings-icon" aria-hidden="true"><History /></span><div><h2>Repeat protection</h2><p>Deprioritise pieces you wore recently.</p></div></div>
        <div className="range-setting">
          <label htmlFor="repeat-days">Avoid repeats for <strong>{repeatDays} days</strong></label>
          <input id="repeat-days" type="range" min="0" max={MAX_REPEAT_DAYS} step="1" value={repeatDays} onChange={(event) => changeRepeatDays(Number(event.target.value))} />
          <div><span>Off</span><span>3 weeks</span></div>
        </div>
      </section>

      <BackupCard exportBackup={exportBackup} onRestore={onRestore} onToast={onToast} dataKey={dataKey} />

      <section className="danger-zone"><p className="eyebrow">DEVICE DATA</p><h2>Start fresh</h2><p>This permanently removes every saved photo and wardrobe item from this browser. Your providers and keys are left alone.</p><button className="danger-button" type="button" onClick={onClear}>Clear wardrobe data</button></section>
    </section>
  );
}

/**
 * One-field setup for the built-in AI: the site holds the Gemini key, so all
 * this asks for is the passcode, and it checks it with a real request before
 * saving so a typo is caught here rather than on the first photo.
 */
function BuiltInAiSetup({ onConnected }) {
  const [passcode, setPasscode] = useState('');
  const [status, setStatus] = useState(null);
  const [isChecking, setIsChecking] = useState(false);

  const connect = async (event) => {
    event.preventDefault();
    const value = passcode.trim();
    if (!value) return;
    setIsChecking(true);
    setStatus(null);
    try {
      const preset = getPreset(BUILTIN_PRESET_ID);
      const result = await testProvider({ ...preset, id: 'builtin-draft', presetId: preset.id, apiKey: value });
      if (result.ok) {
        onConnected(value);
      } else {
        setStatus(result.message);
      }
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <form className="builtin-ai" onSubmit={connect}>
      <h3>Use the built-in AI</h3>
      <p>No API key needed. Enter this site's passcode once on each device.</p>
      <div className="builtin-ai-row">
        <input type="password" value={passcode} onChange={(event) => { setPasscode(event.target.value); setStatus(null); }} placeholder="Passcode" autoComplete="current-password" aria-label="Built-in AI passcode" />
        <button className="primary-button" type="submit" disabled={isChecking || !passcode.trim()}>{isChecking ? 'Checking…' : 'Connect'}</button>
      </div>
      {status && <p className="key-warning" role="alert">{status}</p>}
    </form>
  );
}

/**
 * Today's request count for a provider, and for Gemini (whose free tier was
 * seen capping this app's main model at 20 a day) an estimate of what's left
 * and when a used-up model resets. Requests are counted on this device only.
 */
function ProviderUsage({ provider }) {
  const used = usageToday(provider);
  const until = exhaustedUntil(provider);
  const isGemini = ['gemini', BUILTIN_PRESET_ID].includes(provider.presetId);
  if (until) {
    const hours = Math.max(1, Math.round((until - Date.now()) / 3600_000));
    const hasBackup = provider.fallbackModel && provider.fallbackModel !== provider.model;
    const bothOut = !hasBackup || (isExhausted(provider, provider.model) && isExhausted(provider, provider.fallbackModel));
    return bothOut
      ? <small className="usage-line is-out">Free allowance used up · resets in about {hours}h</small>
      : <small className="usage-line is-out">One model is used up for today, so the other is answering · resets in about {hours}h</small>;
  }
  if (!used) return isGemini ? <small className="usage-line">No AI requests yet today · free tier allows about 20 a day per model</small> : null;
  return (
    <small className="usage-line">
      {plural(used, 'AI request')} today{isGemini ? ` · roughly ${Math.max(0, 40 - used)} left across both models` : ''}
    </small>
  );
}

const JSON_MODE_LABELS = {
  auto: 'auto-detect',
  schema: 'strict schema',
  tools: 'tool calling',
  object: 'JSON object',
  text: 'plain text',
};

/**
 * Add/edit form for one provider. Picking a preset refills every field, since
 * changing presets mid-edit is a deliberate reset, not a merge. "Test
 * connection" runs against the in-progress draft, before it is saved, so a
 * bad key or wrong base URL is caught before it becomes the active provider.
 */
function ProviderForm({ mode, initial, onCancel, onSave, onToast }) {
  const startPreset = initial?.presetId || DEFAULT_PRESET_ID;
  const [presetId, setPresetId] = useState(startPreset);
  const [label, setLabel] = useState(initial?.label ?? getPreset(startPreset).label);
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? getPreset(startPreset).baseUrl);
  const [apiKey, setApiKeyDraft] = useState(initial?.apiKey ?? '');
  const [model, setModel] = useState(initial?.model ?? getPreset(startPreset).model);
  const [fallbackModel, setFallbackModel] = useState(initial?.fallbackModel ?? getPreset(startPreset).fallbackModel);
  const [jsonMode, setJsonMode] = useState(initial?.jsonMode ?? getPreset(startPreset).jsonMode);
  const [taggingMaxTokens, setTaggingMaxTokens] = useState(initial?.taggingMaxTokens ?? getPreset(startPreset).taggingMaxTokens);
  const [outfitMaxTokens, setOutfitMaxTokens] = useState(initial?.outfitMaxTokens ?? getPreset(startPreset).outfitMaxTokens);
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [isTesting, setIsTesting] = useState(false);

  const preset = getPreset(presetId);
  const mismatch = detectKeyMismatch(presetId, apiKey);
  const canTest = baseUrl.trim() && apiKey.trim() && model.trim();

  const applyPreset = (id) => {
    const nextPreset = getPreset(id);
    setPresetId(id);
    setLabel(nextPreset.label);
    setBaseUrl(nextPreset.baseUrl);
    setModel(nextPreset.model);
    setFallbackModel(nextPreset.fallbackModel);
    setJsonMode(nextPreset.jsonMode);
    setTaggingMaxTokens(nextPreset.taggingMaxTokens);
    setOutfitMaxTokens(nextPreset.outfitMaxTokens);
    setTestResult(null);
  };

  const runTest = async (withVision) => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await testProvider(
        { id: initial?.id || 'draft', presetId, label: label || preset.label, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim(), fallbackModel, jsonMode },
        { withVision },
      );
      setTestResult(result);
    } finally {
      setIsTesting(false);
    }
  };

  const save = () => {
    if (!baseUrl.trim() || !apiKey.trim() || !model.trim()) {
      onToast('Base URL, API key and model are all required.');
      return;
    }
    onSave({
      presetId,
      label: label.trim() || preset.label,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
      fallbackModel: fallbackModel.trim(),
      jsonMode,
      taggingMaxTokens,
      outfitMaxTokens,
    });
  };

  return (
    <div className="provider-form">
      <label>Preset
        <select value={presetId} onChange={(event) => applyPreset(event.target.value)}>
          {PROVIDER_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label>Name<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={preset.label} /></label>
      <label>Base URL<input value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setTestResult(null); }} placeholder="https://api.example.com/v1" spellCheck="false" autoComplete="off" /></label>
      <label className="key-field">
        <span>API key</span>
        <div>
          <input type={showKey ? 'text' : 'password'} value={apiKey} placeholder={preset.keyPlaceholder} autoComplete="off" spellCheck="false" onChange={(event) => { setApiKeyDraft(event.target.value); setTestResult(null); }} />
          <button type="button" onClick={() => setShowKey((current) => !current)}>{showKey ? 'Hide' : 'Show'}</button>
        </div>
      </label>
      {mismatch && (
        <p className="key-warning" role="alert">
          That looks like {getPreset(mismatch).article} {getPreset(mismatch).label} key, but this is set up as {label || preset.label}.
        </p>
      )}
      {preset.keyHost && <p className="field-hint">Get a key from {preset.keyHost}</p>}
      <label>Model<input value={model} onChange={(event) => { setModel(event.target.value); setTestResult(null); }} placeholder="model name" /></label>
      <label>Fallback model <span className="field-hint-inline">(used if the first model fails)</span><input value={fallbackModel} onChange={(event) => setFallbackModel(event.target.value)} placeholder="optional" /></label>

      <button className="text-button" type="button" onClick={() => setShowAdvanced((current) => !current)}>{showAdvanced ? 'Hide advanced' : 'Advanced'}</button>
      {showAdvanced && (
        <div className="provider-advanced">
          <label>JSON response mode
            <select value={jsonMode} onChange={(event) => setJsonMode(event.target.value)}>
              <option value="auto">Auto-detect (recommended)</option>
              <option value="schema">Strict schema</option>
              <option value="tools">Tool calling</option>
              <option value="object">JSON object</option>
              <option value="text">Plain text (extract JSON)</option>
            </select>
          </label>
          <p className="field-hint">Auto-detect tries strict schema first and steps down automatically if the provider rejects it, then remembers what worked.</p>
          <label>Tagging token budget<input type="number" min="200" max="8000" step="100" value={taggingMaxTokens} onChange={(event) => setTaggingMaxTokens(Number(event.target.value) || preset.taggingMaxTokens)} /></label>
          <label>Outfit token budget<input type="number" min="200" max="4000" step="100" value={outfitMaxTokens} onChange={(event) => setOutfitMaxTokens(Number(event.target.value) || preset.outfitMaxTokens)} /></label>
        </div>
      )}

      <div className="provider-test-row">
        <button className="secondary-button compact" type="button" disabled={isTesting || !canTest} onClick={() => runTest(false)}>{isTesting ? 'Testing…' : 'Test connection'}</button>
        <button className="secondary-button compact" type="button" disabled={isTesting || !canTest} onClick={() => runTest(true)}>{isTesting ? 'Testing…' : 'Test photo tagging'}</button>
      </div>
      {testResult && (
        <p className={`test-result ${testResult.ok ? 'test-ok' : 'test-bad'}`} role="status">
          {testResult.ok
            ? `✓ ${testResult.model} replied in ${testResult.latencyMs}ms${testResult.visionTested ? ' — it can read a photo.' : '.'}`
            : `✕ ${testResult.message}${testResult.status ? ` (HTTP ${testResult.status})` : ''}`}
        </p>
      )}

      <div className="provider-form-actions">
        <button className="primary-button" type="button" onClick={save}>{mode === 'add' ? 'Add provider' : 'Save changes'}</button>
        <button className="text-button" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ItemEditor({ item, blobUrls, onClose, onSave, onDelete, locate, onToast }) {
  const [draft, setDraft] = useState(() => normalizeItem(item));
  const [isSaving, setIsSaving] = useState(false);
  const [isLocating, setIsLocating] = useState(false);

  // For pieces saved before tagging found each item's position: one AI call
  // finds this piece in its photo and crops to it. Nothing is saved until
  // "Save changes", so a bad guess is undone by closing the editor.
  const findInPhoto = async () => {
    setIsLocating(true);
    try {
      const crop = await locate(draft);
      if (crop) {
        setDraft((current) => ({ ...current, crop }));
        onToast?.('Found it. Save changes to keep the new crop.');
      } else {
        onToast?.('Couldn\'t find this piece in the photo. Crop it by hand below.');
      }
    } catch (error) {
      onToast?.(error?.message || 'That didn\'t work this time.');
    } finally {
      setIsLocating(false);
    }
  };
  const dialogRef = useRef(null);
  useEffect(() => setDraft(normalizeItem(item)), [item]);

  // A modal that cannot be dismissed from the keyboard, and that drops focus
  // back to the top of the page on close, is unusable without a mouse.
  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select, textarea, [href]',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [onClose]);
  const update = (changes) => setDraft((current) => ({ ...current, ...changes }));
  const updateList = (key, value) => update({ [key]: asList(value) });
  const save = async () => {
    setIsSaving(true);
    try {
      await onSave(draft);
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="item-editor" role="dialog" aria-modal="true" aria-labelledby="editor-title" ref={dialogRef} tabIndex={-1}>
        <div className="modal-handle" />
        <div className="editor-header"><div><p className="eyebrow">EDIT PIECE</p><h2 id="editor-title">Make it yours</h2></div><button className="close-button" type="button" onClick={onClose} aria-label="Close editor"><X aria-hidden="true" /></button></div>
        <PhotoSpotlight item={draft} blobUrls={blobUrls} className="editor-photo" />
        {locate && hasAnyProvider() && (draft.photo || draft.imageUrl) && (
          <button className="secondary-button full-width locate-button" type="button" disabled={isLocating} onClick={findInPhoto}>
            {isLocating ? <><span className="button-spinner dark" /> Looking…</> : 'Find it in the photo'}
          </button>
        )}
        <CropControls crop={draft.crop} idPrefix={`editor-${draft.id}`} onChange={(crop) => update({ crop })} />
        <div className="form-grid editor-fields">
          <label>Category<select value={draft.category} onChange={(event) => update({ category: event.target.value })}>{CATEGORIES.map((category) => <option key={category} value={category}>{displayCategory(category)}</option>)}</select></label>
          <label>Colours<input value={draft.colors.join(', ')} placeholder="e.g. olive, cream" onChange={(event) => updateList('colors', event.target.value)} /></label>
          <label className="span-two">Style tags<input value={draft.styleTags.join(', ')} placeholder="e.g. relaxed, smart casual" onChange={(event) => updateList('styleTags', event.target.value)} /></label>
          <label className="span-two">Season / weather<input value={draft.seasons.join(', ')} placeholder="e.g. cool, autumn" onChange={(event) => updateList('seasons', event.target.value)} /><small className="field-hint">{SEASON_HINT}</small></label>
          <label className="span-two">Notes<textarea value={draft.notes} rows="3" placeholder="Fit notes, how you like to wear it…" onChange={(event) => update({ notes: event.target.value })} /></label>
          <label className="span-two">Availability
            <select value={draft.unavailable} onChange={(event) => update({ unavailable: event.target.value })}>
              <option value="">In rotation — can be suggested</option>
              {UNAVAILABLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>Price paid <span className="field-hint-inline">(optional)</span><input type="number" min="0" step="0.01" inputMode="decimal" value={draft.pricePaid ?? ''} placeholder="for cost-per-wear" onChange={(event) => update({ pricePaid: event.target.value === '' ? null : Number(event.target.value) })} /></label>
          <div className="last-worn-row"><span>Last worn</span><strong>{formatDate(draft.lastWornDate)}</strong></div>
        </div>
        <button className="primary-button full-width" type="button" disabled={isSaving} onClick={save}>{isSaving ? 'Saving…' : 'Save changes'}</button>
        <button className="danger-text-button" type="button" onClick={() => onDelete(draft.id)}>Delete this piece</button>
      </section>
    </div>
  );
}
