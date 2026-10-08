import { Footprints, Gem, Layers, Shirt } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { controlsFromCrop, coverLayout, cropFromControls, MAX_ZOOM, MIN_ZOOM, spotlightStyle } from '../lib/crop.js';
import { filterWardrobeForOutfit, occasionKey } from '../lib/outfit.js';
import { fetchForecast, MAX_FORECAST_DAYS } from '../lib/weather.js';

export const CATEGORIES = ['top', 'bottom', 'dress', 'outerwear', 'shoes', 'accessory'];
export const CATEGORY_META = {
  top: { label: 'Tops', Icon: Shirt },
  bottom: { label: 'Bottoms', Icon: TrousersIcon },
  dress: { label: 'Dresses', Icon: DressIcon },
  outerwear: { label: 'Layers', Icon: Layers },
  shoes: { label: 'Shoes', Icon: Footprints },
  accessory: { label: 'Extras', Icon: Gem },
};

// Lucide has no trousers or dress, so these two are drawn on its 24px grid
// with the same 2px rounded strokes.
export function TrousersIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M7 3h10l1.5 18h-4.2L12 10l-2.3 11H5.5Z" />
      <path d="M7 6.5h10" />
    </svg>
  );
}

export function DressIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 3v3.5L7.5 10 4.5 21h15L16.5 10 15 6.5V3" />
      <path d="M9 6.5c1 .8 2 1.2 3 1.2s2-.4 3-1.2" />
    </svg>
  );
}

export function CategoryIcon({ category }) {
  const Icon = CATEGORY_META[category]?.Icon || Shirt;
  return <Icon className="category-icon" strokeWidth={1.5} aria-hidden="true" />;
}
export const OCCASIONS = ['Everyday', 'Work', 'Dinner', 'Date night', 'Event', 'Active'];
export const VIBES = ['Easy', 'Polished', 'Playful', 'Minimal', 'Sporty', 'Bold'];
export const WEATHER_OPTIONS = [
  { value: 'cold', label: 'Cold', temperature: 6 },
  { value: 'cool', label: 'Cool', temperature: 14 },
  { value: 'mild', label: 'Mild', temperature: 20 },
  { value: 'warm', label: 'Warm', temperature: 26 },
  { value: 'hot', label: 'Hot', temperature: 32 },
];

// Season and weather are stored as a controlled vocabulary, so anything outside
// this list is dropped on save. Style tags are the place for free-form words.
// Shared by the item editor's hint text and bulk-edit's "set season" action.
export const SEASON_WEATHER_VALUES = ['spring', 'summer', 'autumn', 'winter', 'all-season', 'cold', 'cool', 'mild', 'warm', 'hot', 'rainy', 'windy'];
export const SEASON_HINT = `Recognised: ${SEASON_WEATHER_VALUES.join(', ')}`;

// Why a piece is out of rotation. Suggestions, shuffles and plans skip it.
export const UNAVAILABLE_OPTIONS = [
  { value: 'laundry', label: 'In the wash', short: 'In the wash' },
  { value: 'cleaning', label: 'At the dry cleaner', short: 'Dry cleaning' },
  { value: 'repair', label: 'Needs repair', short: 'Needs repair' },
  { value: 'away', label: 'Lent out or packed away', short: 'Away' },
];
export const unavailableLabel = (reason) => UNAVAILABLE_OPTIONS.find((option) => option.value === reason)?.short || '';

// Each photo costs one vision call and one decode, so a batch is bounded to keep
// tagging time and peak memory predictable on a phone.
export const MAX_BATCH_PHOTOS = 20;

export function uid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function asList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return [];
}

export function normalizeItem(item = {}) {
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
export function normalizeOutfitEntry(record = {}) {
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

export function displayCategory(category) {
  return CATEGORY_META[category]?.label || category;
}

export function localDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export function formatDate(value) {
  if (!value) return 'Never worn';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

export function addDays(dateString, count) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + count);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function weekday(dateString) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(`${dateString}T12:00:00`));
}

export const isWeekend = (dateString) => [0, 6].includes(new Date(`${dateString}T12:00:00`).getDay());

export const BUSY_RETRY_DELAY_MS = 5000;

/**
 * Runs an AI call, and if the provider says it's busy (503) or rate-limiting
 * (429) even after its own fallback model, waits a few seconds and tries once
 * more. Gemini's free tier gave "high demand" on both models at once during
 * testing, and it usually clears within seconds.
 */
export async function retryWhenBusy(call, onWaiting) {
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
export const forecastCache = new Map();
export const FORECAST_TTL_MS = 30 * 60_000;

export async function loadForecast(location) {
  const key = `${location.latitude},${location.longitude}`;
  const cached = forecastCache.get(key);
  if (cached && Date.now() - cached.at < FORECAST_TTL_MS) return cached.days;
  const days = await fetchForecast(location, { days: MAX_FORECAST_DAYS });
  forecastCache.set(key, { at: Date.now(), days });
  return days;
}

/** The forecast for a saved location: { days, error }, or nothing while off. */
export function useForecast(location) {
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

export function itemImage(item, blobUrls) {
  return item.imageUrl || blobUrls[item.id] || '';
}

/**
 * Narrows the wardrobe before anything is sent for styling: season and weather
 * first, then occasion and vibe overlap, with recently worn pieces pushed down.
 */
export function suggestionFilters(preferences, feedback) {
  return {
    weather: preferences.weather,
    rain: Boolean(preferences.rain),
    occasion: occasionKey(preferences.occasion),
    vibe: preferences.vibe,
    requiredItemId: preferences.wantedItemId,
    feedback,
  };
}

export function shortlistForSuggestion(items, preferences, repeatDays, excludedItemIds, feedback) {
  const wanted = preferences.wantedItemId;
  const shortlist = filterWardrobeForOutfit(items, suggestionFilters(preferences, feedback), repeatDays);

  // A re-roll skips the previous suggestion, but never a piece the user asked for.
  return shortlist.filter((item) => item.id === wanted || !excludedItemIds.includes(item.id));
}

/**
 * Renders one item from its source photo. Several items can share a photo, so
 * the item's own crop is applied here rather than stored as separate pixels.
 */
export function Photo({ item, blobUrls, className = '', alt = '' }) {
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
export function CroppedImage({ src, crop, alt = '', className = '' }) {
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
export function PhotoSpotlight({ item, blobUrls, className = '' }) {
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

export function CropControls({ crop, onChange, idPrefix }) {
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

export const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
export const describeCounts = ({ items, photos, outfits }) =>
  `${plural(items, 'item')}, ${plural(photos, 'photo')} and ${plural(outfits, 'outfit')}`;

export function FilterChip({ label, count, active, onClick }) {
  return (
    <button className={`filter-chip ${active ? 'is-selected' : ''}`} type="button" onClick={onClick}>
      {label}<span>{count}</span>
    </button>
  );
}

/**
 * An outfit laid out the way it's worn: top over bottom over shoes (or a
 * dress over shoes) down the middle, with a layer and extras alongside. Each
 * slot's shape suits its garment, tall for trousers and wide for shoes, so a
 * cropped piece fills it naturally.
 */
export function OutfitLook({ items, blobUrls, className = '' }) {
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

export function ChoiceButton({ active, children, onClick }) {
  return <button className={`choice-button ${active ? 'is-selected' : ''}`} type="button" onClick={onClick}>{children}</button>;
}

/** Escape closes, Tab stays inside, and focus goes back where it was on close. */
export function useModalKeyboard(dialogRef, onClose) {
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

export function daysAgo(timestamp) {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
