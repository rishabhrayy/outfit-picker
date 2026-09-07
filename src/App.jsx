import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  controlsFromCrop,
  cropFromControls,
  cropStyle,
  spotlightStyle,
} from './lib/crop.js';
import {
  computeWardrobeStats,
  filterWardrobeForOutfit,
  missingForCompleteOutfit,
  occasionKey,
  shuffleOutfit,
} from './lib/outfit.js';
import { DEFAULT_PRESET_ID, PROVIDER_PRESETS, detectPresetFromKey, getPreset } from './lib/providers.js';
import { testProvider } from './lib/ai.js';
import {
  MAX_REPEAT_DAYS,
  addProvider,
  deleteProvider,
  getActiveProviderId,
  getProviders,
  getRepeatDays,
  hasAnyProvider,
  setActiveProviderId,
  setRepeatDays,
  updateProvider,
} from './lib/settings.js';
import './App.css';

const EMPTY_SERVICES = {};
const CATEGORIES = ['top', 'bottom', 'dress', 'outerwear', 'shoes', 'accessory'];
const CATEGORY_META = {
  top: { label: 'Tops', icon: '⌁' },
  bottom: { label: 'Bottoms', icon: '⌄' },
  dress: { label: 'Dresses', icon: '◒' },
  outerwear: { label: 'Layers', icon: '◔' },
  shoes: { label: 'Shoes', icon: '◌' },
  accessory: { label: 'Extras', icon: '✦' },
};
const OCCASIONS = ['Everyday', 'Work', 'Dinner', 'Date night', 'Event', 'Active'];
const VIBES = ['Easy', 'Polished', 'Playful', 'Minimal', 'Sporty', 'Bold'];
const WEATHER_OPTIONS = [
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
    status: record.status === 'planned' ? 'planned' : 'worn',
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

function isPastOrToday(dateString) {
  return Boolean(dateString) && dateString <= localDate();
}

function formatDate(value) {
  if (!value) return 'Never worn';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function itemImage(item, blobUrls) {
  return item.imageUrl || blobUrls[item.id] || '';
}

/**
 * Narrows the wardrobe before anything is sent for styling: season and weather
 * first, then occasion and vibe overlap, with recently worn pieces pushed down.
 */
function shortlistForSuggestion(items, preferences, repeatDays, excludedItemIds) {
  const wanted = preferences.wantedItemId;
  const shortlist = filterWardrobeForOutfit(
    items,
    {
      weather: preferences.weather,
      occasion: occasionKey(preferences.occasion),
      vibe: preferences.vibe,
      requiredItemId: wanted,
    },
    repeatDays,
  );

  // A re-roll skips the previous suggestion, but never a piece the user asked for.
  return shortlist.filter((item) => item.id === wanted || !excludedItemIds.includes(item.id));
}

function makeLocalSuggestion(items) {
  const pick = (category) => items.find((item) => item.category === category);
  const dress = pick('dress');
  const selected = dress
    ? [dress, pick('shoes'), pick('outerwear'), pick('accessory')]
    : [pick('top'), pick('bottom'), pick('shoes'), pick('outerwear'), pick('accessory')];
  const outfit = selected.filter(Boolean);
  return {
    itemIds: outfit.map((item) => item.id),
    explanation: outfit.length
      ? 'Here is a balanced starting point from the pieces that match your answers. Add your API key in Settings for a tailored AI explanation.'
      : 'Add a few more pieces so I can build a complete outfit.',
  };
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
        <span>{CATEGORY_META[item.category]?.icon || '✦'}</span>
      </div>
    );
  }
  return (
    <span className={`photo-frame ${className}`}>
      <img src={src} alt={alt} style={cropStyle(item.crop)} />
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
        <span>{CATEGORY_META[item.category]?.icon || '✦'}</span>
      </div>
    );
  }

  if (!box) {
    return <Photo item={item} blobUrls={blobUrls} className={className} alt={alt} />;
  }

  return (
    <span className={`photo-spotlight ${className}`}>
      <img src={src} alt={`${alt}, highlighted within the photo it was tagged from`} />
      <span className="spotlight-box" style={box} />
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
 */
export default function App({ services = EMPTY_SERVICES, initialItems = [], reloadKey = 0 }) {
  const [items, setItems] = useState(() => initialItems.map(normalizeItem));
  // Reading a wardrobe out of IndexedDB is async, so without this the empty
  // state flashes on every cold launch and tells a stocked wardrobe it is empty.
  const [isLoading, setIsLoading] = useState(() => Boolean(services.listItems));
  const [outfitRecords, setOutfitRecords] = useState([]);
  const [activeTab, setActiveTab] = useState('wardrobe');
  const [editingItem, setEditingItem] = useState(null);
  const [toast, setToast] = useState('');
  const [blobUrls, setBlobUrls] = useState({});
  // null | 'edit' | 'build' — the wardrobe grid's multi-select mode. Bulk-edit
  // and the manual outfit builder share this one mode rather than each having
  // their own selection UI; which action bar shows depends on the purpose.
  const [wardrobeMode, setWardrobeMode] = useState(null);
  // The ids a manually built outfit is being saved from, or null when the
  // save-a-look modal is closed.
  const [buildingItemIds, setBuildingItemIds] = useState(null);

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
  }, [services, reloadKey]);

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
  }, [services, reloadKey]);

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

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(''), 3400);
    return () => window.clearTimeout(timeout);
  }, [toast]);

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

  const deleteItem = async (id) => {
    if (!window.confirm('Delete this wardrobe item? This cannot be undone.')) return;
    try {
      await services.deleteItem?.(id);
      setItems((current) => current.filter((item) => item.id !== id));
      setEditingItem(null);
      setToast('Item deleted.');
    } catch (error) {
      setToast(error?.message || 'That item could not be deleted.');
    }
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

  /**
   * Marks a suggested (AI, local, or shuffled) outfit as worn today. Updates
   * each item's lastWornDate exactly as before, and now also records the
   * outfit itself so it shows up in the Journal.
   */
  const wearOutfit = async ({ itemIds, date, source, explanation }) => {
    const wornDate = date || localDate();
    const record = await services.recordOutfitWorn?.({ itemIds, date: wornDate, source, explanation });
    setItems((current) => current.map((item) => (itemIds.includes(item.id) ? { ...item, lastWornDate: wornDate } : item)));
    if (record) setOutfitRecords((current) => [normalizeOutfitEntry(record), ...current]);
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
        await wearOutfit({ itemIds, date, source: 'manual', explanation });
        setToast('Saved — marked as worn today.');
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

  const deleteOutfitEntry = async (id) => {
    if (!window.confirm('Remove this outfit from your journal? This cannot be undone.')) return;
    try {
      await services.deleteOutfitRecord?.(id);
      setOutfitRecords((current) => current.filter((record) => record.id !== id));
    } catch (error) {
      setToast(error?.message || 'That outfit could not be removed.');
    }
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

  const bulkDeleteWardrobe = async (ids) => {
    if (!window.confirm(`Delete ${ids.length} selected ${ids.length === 1 ? 'item' : 'items'}? This cannot be undone.`)) return;
    try {
      for (const id of ids) {
        await services.deleteItem?.(id);
      }
      setItems((current) => current.filter((item) => !ids.includes(item.id)));
      setToast(`${ids.length} ${ids.length === 1 ? 'item' : 'items'} deleted.`);
      setWardrobeMode(null);
    } catch (error) {
      setToast(error?.message || 'Those items could not be deleted.');
    }
  };

  return (
    <div className="outfit-app">
      <header className="app-header">
        <button className="brand" type="button" onClick={() => goToTab('wardrobe')} aria-label="Go to wardrobe">
          <span className="brand-mark">◐</span>
          <span>Outfit Picker</span>
        </button>
        <button className="header-action" type="button" onClick={() => goToTab('upload')} aria-label="Add clothes">
          <span>＋</span>
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
            onAdd={() => goToTab('upload')}
            onBuildOwn={startBuildingOutfit}
            onToast={setToast}
          />
        )}
        {activeTab === 'journal' && (
          <JournalView
            items={items}
            blobUrls={blobUrls}
            outfitRecords={outfitRecords}
            onPlanOutfit={startBuildingOutfit}
            onDeleteOutfitRecord={deleteOutfitEntry}
            onAdd={() => goToTab('upload')}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsView onClear={clearWardrobe} onToast={setToast} />
        )}
      </main>

      <nav className="bottom-nav" aria-label="Primary navigation">
        <NavButton icon="▦" label="Wardrobe" active={activeTab === 'wardrobe'} onClick={() => goToTab('wardrobe')} />
        <NavButton icon="＋" label="Add" active={activeTab === 'upload'} onClick={() => goToTab('upload')} />
        <NavButton icon="✦" label="Outfit" active={activeTab === 'outfit'} onClick={() => goToTab('outfit')} />
        <NavButton icon="◷" label="Journal" active={activeTab === 'journal'} onClick={() => goToTab('journal')} />
        <NavButton icon="⚙" label="Settings" active={activeTab === 'settings'} onClick={() => goToTab('settings')} />
      </nav>

      {editingItem && (
        <ItemEditor
          item={editingItem}
          blobUrls={blobUrls}
          onClose={() => setEditingItem(null)}
          onSave={updateItem}
          onDelete={deleteItem}
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
        {toast && <div className="toast">{toast}</div>}
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

function WardrobeView({
  items, blobUrls, onOpenItem, onAdd, onSuggest, isLoading,
  mode, onSetMode, onBulkUpdate, onBulkDelete, onBuildOutfit,
}) {
  const [filter, setFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkTag, setBulkTag] = useState('');
  const [bulkSeason, setBulkSeason] = useState(SEASON_WEATHER_VALUES[0]);
  const filteredItems = useMemo(
    () => (filter === 'all' ? items : items.filter((item) => item.category === filter)),
    [filter, items],
  );

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
            <span className="sparkle">✦</span>
            <span><strong>Pick an outfit for me</strong><small>Tell me the plan, I’ll do the styling</small></span>
            <span className="arrow">→</span>
          </button>
          <button className="secondary-button full-width select-toggle" type="button" onClick={() => onSetMode('edit')}>
            Select pieces to edit or delete
          </button>
        </>
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
      </div>

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
                className={`wardrobe-card ${isSelected ? 'is-selected' : ''}`}
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
                {item.lastWornDate && <span className="worn-badge">Worn {formatDate(item.lastWornDate)}</span>}
              </button>
            );
          })}
          {!selecting && (
            <button className="add-card" type="button" onClick={onAdd}>
              <span>＋</span>
              <strong>Add a piece</strong>
            </button>
          )}
        </div>
      ) : (
        <EmptyWardrobe filter={filter} onAdd={onAdd} />
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

function EmptyWardrobe({ filter, onAdd }) {
  const filtered = filter !== 'all';
  return (
    <div className="empty-state wardrobe-empty">
      <div className="empty-illustration"><span>✦</span><span>⌁</span><span>◌</span></div>
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
      const entry = queue[index];
      patchEntry(entry.id, { status: 'tagging', error: '' });

      try {
        if (!tagPhoto) throw new Error('Add an API key in Settings to auto-tag.');
        const response = await tagPhoto(entry.file);
        const found = (Array.isArray(response) ? response : response?.items) || [];
        const items = found.map((item) => normalizeItem({ ...item, id: uid(), sourcePhotoId: 'pending' }));
        detected += items.length;
        patchEntry(entry.id, {
          status: 'done',
          model: response?.model || '',
          items: items.length ? items : [blankItem()],
          note: items.length ? '' : 'Nothing wearable was found here. Add it by hand or remove the photo.',
        });
      } catch (error) {
        failures += 1;
        patchEntry(entry.id, {
          status: 'failed',
          error: error?.message || 'Tagging failed for this photo.',
          items: [blankItem()],
        });
      }

      setProgress({ done: index + 1, total: queue.length });
    }

    setStage('review');
    setTaggingNote(
      failures
        ? `${detected} ${detected === 1 ? 'piece' : 'pieces'} found. ${failures} ${failures === 1 ? 'photo' : 'photos'} could not be tagged — fill those in by hand below, or remove them.`
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

  const totalItems = entries.reduce((count, entry) => count + entry.items.length, 0);

  const save = async () => {
    const groups = entries
      .filter((entry) => entry.items.length)
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
          <div className="camera-orb">◉</div>
          <h2>Choose your photos</h2>
          <p>Pick one or many. Single pieces, mirror selfies, and whole outfits all work. We’ll find the wearable items, not the background.</p>
          <button className="primary-button" type="button" onClick={() => inputRef.current?.click()}>Choose photos <span>→</span></button>
          <small>Up to {MAX_BATCH_PHOTOS} at a time · JPG, PNG, HEIC and more</small>
        </div>
        <div className="tip-card"><span>✦</span><p><strong>Tip:</strong> Natural photos are perfect. You don’t need product shots or a plain background.</p></div>
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
                <button className="batch-remove" type="button" aria-label="Remove this photo" onClick={() => removeEntry(entry.id)}>×</button>
              )}
            </figure>
          ))}
          {!busy && entries.length < MAX_BATCH_PHOTOS && (
            <button className="batch-tile batch-add" type="button" onClick={() => inputRef.current?.click()}>
              <span>＋</span><small>Add more</small>
            </button>
          )}
        </div>

        {busy ? (
          <>
            <div className="batch-progress" role="status" aria-live="polite">
              <div className="batch-progress-bar"><span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
              <p>Tagging photo {Math.min(progress.done + 1, progress.total)} of {progress.total}…</p>
            </div>
            <p className="inline-note">One at a time, so a free API tier doesn’t rate-limit the batch.</p>
          </>
        ) : (
          <>
            <button className="primary-button full-width" type="button" onClick={analyseAll}>
              Auto-tag {entries.length === 1 ? 'this photo' : `all ${entries.length} photos`} <span>✦</span>
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
              <small>{entry.items.length} {entry.items.length === 1 ? 'piece' : 'pieces'} · all link back to this photo</small>
            </span>
            <button className="icon-text-button danger-text" type="button" onClick={() => removeEntry(entry.id)}>Remove</button>
          </div>
          {entry.error && <p className="key-warning" role="alert">{entry.error}</p>}
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
          <button className="secondary-button compact" type="button" onClick={() => addItem(entry.id)}>＋ Split / add a piece</button>
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
  return (
    <article className="review-card">
      <div className="review-card-topline">
        <label className="merge-toggle"><input type="checkbox" checked={selected} onChange={onToggleMerge} /> <span>Merge</span></label>
        <span>Piece {index + 1}</span>
        <button className="icon-text-button danger-text" type="button" onClick={onRemove}>Remove</button>
      </div>
      <div className="review-visual">
        <img src={preview} alt={`Source photo for detected item ${index + 1}`} style={cropStyle(item.crop)} />
        <span className="crop-label">Crop preview</span>
      </div>
      <CropControls crop={item.crop} idPrefix={`review-${item.id}`} onChange={(crop) => onChange({ crop })} />
      <div className="form-grid review-fields">
        <label>Category<select value={item.category} onChange={(event) => onChange({ category: event.target.value })}>{CATEGORIES.map((category) => <option key={category} value={category}>{displayCategory(category)}</option>)}</select></label>
        <label>Colours<input value={item.colors.join(', ')} placeholder="e.g. navy, white" onChange={(event) => updateList('colors', event.target.value)} /></label>
        <label className="span-two">Style tags<input value={item.styleTags.join(', ')} placeholder="e.g. casual, classic" onChange={(event) => updateList('styleTags', event.target.value)} /></label>
        <label className="span-two">Season / weather<input value={item.seasons.join(', ')} placeholder="e.g. mild, summer" onChange={(event) => updateList('seasons', event.target.value)} /><small className="field-hint">{SEASON_HINT}</small></label>
        <label className="span-two">Notes<input value={item.notes} placeholder="What is this piece?" onChange={(event) => onChange({ notes: event.target.value })} /></label>
      </div>
    </article>
  );
}

function OutfitView({ items, blobUrls, repeatDays, onSuggest, onWearOutfit, onAdd, onBuildOwn, onToast }) {
  const [preferences, setPreferences] = useState({
    occasion: 'Everyday',
    weather: 'mild',
    temperature: 20,
    vibe: 'Easy',
    wantedItemId: '',
  });
  const [suggestion, setSuggestion] = useState(null);
  const [usedItemIds, setUsedItemIds] = useState([]);
  const [isThinking, setIsThinking] = useState(false);
  const [isWorn, setIsWorn] = useState(false);

  const suggestionItems = suggestion?.itemIds.map((id) => items.find((item) => item.id === id)).filter(Boolean) || [];

  const requestSuggestion = async ({ exclude = [] } = {}) => {
    const candidates = shortlistForSuggestion(items, preferences, repeatDays, exclude);
    if (!candidates.length) {
      onToast('There are no unused pieces left to try. Change your answers, or start over with "Suggest my outfit".');
      return;
    }
    setIsThinking(true);
    setIsWorn(false);
    try {
      let normalized;
      try {
        const usingAi = Boolean(onSuggest && hasAnyProvider());
        const response = usingAi
          ? await onSuggest({ items: candidates, preferences, excludedItemIds: exclude, avoidRecentDays: repeatDays })
          : makeLocalSuggestion(candidates);
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
        const local = makeLocalSuggestion(candidates);
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
    const pool = items.filter((item) => !exclude.includes(item.id) || item.id === preferences.wantedItemId);
    const result = shuffleOutfit(pool, {
      weather: preferences.weather,
      occasion: occasionKey(preferences.occasion),
      vibe: preferences.vibe,
      requiredItemId: preferences.wantedItemId,
    }, repeatDays);

    if (!result.itemIds.length) {
      onToast('Add a few more pieces so there is something to shuffle.');
      return;
    }
    setIsWorn(false);
    setSuggestion({ ...result, isFallback: false, source: 'shuffle' });
    setUsedItemIds(exclude);
  };

  const reroll = () => {
    const exclude = [...usedItemIds, ...suggestion.itemIds];
    if (suggestion.source === 'shuffle') requestShuffle({ exclude });
    else requestSuggestion({ exclude });
  };

  const wearThis = async () => {
    if (!suggestionItems.length) return;
    try {
      await onWearOutfit({
        itemIds: suggestionItems.map((item) => item.id),
        date: localDate(),
        source: suggestion.source,
        explanation: suggestion.explanation,
      });
      setIsWorn(true);
      onToast('Marked as worn today. Have a great time!');
    } catch (error) {
      onToast(error?.message || 'That outfit could not be marked as worn.');
    }
  };

  // Block only on a genuinely empty wardrobe. A wardrobe missing one category
  // (no shoes yet, say) still deserves a suggestion — it just says so, rather
  // than refusing outright.
  if (!items.length) {
    return (
      <section className="screen outfit-screen empty-outfit">
        <div className="screen-heading"><div><p className="eyebrow">OUTFIT PICKER</p><h1>Let’s get dressed</h1></div></div>
        <div className="empty-state">
          <div className="empty-illustration warm"><span>✦</span><span>◐</span><span>⌁</span></div>
          <h2>Add a few pieces first</h2>
          <p>Once you have added some clothes, I can start assembling outfits.</p>
          <button className="primary-button" type="button" onClick={onAdd}>Add clothes <span>→</span></button>
        </div>
      </section>
    );
  }

  if (suggestion) {
    return (
      <section className="screen outfit-screen result-screen">
        <button className="text-button back-button" type="button" onClick={() => setSuggestion(null)}>← Change answers</button>
        <p className="eyebrow">YOUR OUTFIT</p>
        <h1>Here’s the move</h1>
        <div className="answer-summary"><span>{preferences.occasion}</span><span>{preferences.vibe}</span><span>{preferences.temperature}°</span></div>
        <div className="outfit-row">
          {suggestionItems.map((item) => (
            <div className="outfit-piece" key={item.id}>
              <Photo item={item} blobUrls={blobUrls} className="outfit-photo" alt={`${displayCategory(item.category)} in suggested outfit`} />
              <span>{displayCategory(item.category)}</span>
            </div>
          ))}
        </div>
        {suggestion.isFallback && (
          <p className="inline-note">This is a basic pick, not an AI suggestion — styling failed this time.</p>
        )}
        <div className="explanation-card"><span>✦</span><p>{suggestion.explanation}</p></div>
        <div className="recent-note">Avoiding pieces worn in the last {repeatDays} days where possible.</div>
        <button className={`primary-button full-width ${isWorn ? 'success-button' : ''}`} type="button" onClick={wearThis} disabled={isWorn}>
          {isWorn ? '✓ Worn today' : 'Wear this'}
        </button>
        <button className="secondary-button full-width" type="button" disabled={isThinking} onClick={reroll}>
          {isThinking ? <><span className="button-spinner dark" /> Finding another…</> : <>{suggestion.source === 'shuffle' ? 'Shuffle again' : 'Suggest another'} <span>↻</span></>}
        </button>
      </section>
    );
  }

  const missing = missingForCompleteOutfit(items);

  return (
    <section className="screen outfit-screen question-screen">
      <div className="screen-heading"><div><p className="eyebrow">OUTFIT PICKER</p><h1>What’s the plan?</h1><p className="heading-copy">A few details and I’ll pull a look from your closet.</p></div></div>
      {missing.length > 0 && (
        <p className="inline-note">
          No {missing.join(' or ')} in your wardrobe yet — I’ll style what you have.
        </p>
      )}
      <fieldset className="question-block">
        <legend>Where are you going?</legend>
        <div className="choice-grid occasion-grid">
          {OCCASIONS.map((occasion) => <ChoiceButton key={occasion} active={preferences.occasion === occasion} onClick={() => setPreferences((current) => ({ ...current, occasion }))}>{occasion}</ChoiceButton>)}
        </div>
      </fieldset>
      <fieldset className="question-block">
        <legend>What’s the weather?</legend>
        <div className="choice-grid weather-grid">
          {WEATHER_OPTIONS.map((weather) => <ChoiceButton key={weather.value} active={preferences.weather === weather.value} onClick={() => setPreferences((current) => ({ ...current, weather: weather.value, temperature: weather.temperature }))}>{weather.label}<small>{weather.temperature}°</small></ChoiceButton>)}
        </div>
      </fieldset>
      <fieldset className="question-block">
        <legend>How do you want to feel?</legend>
        <div className="vibe-row">
          {VIBES.map((vibe) => <ChoiceButton key={vibe} active={preferences.vibe === vibe} onClick={() => setPreferences((current) => ({ ...current, vibe }))}>{vibe}</ChoiceButton>)}
        </div>
      </fieldset>
      <label className="wanted-select">Want to wear something specific?<select value={preferences.wantedItemId} onChange={(event) => setPreferences((current) => ({ ...current, wantedItemId: event.target.value }))}><option value="">No preference — surprise me</option>{items.map((item) => <option key={item.id} value={item.id}>{displayCategory(item.category)} · {item.colors.join(', ') || 'untitled item'}</option>)}</select></label>
      <button className="primary-button full-width suggest-button" type="button" disabled={isThinking} onClick={() => requestSuggestion()}>{isThinking ? <><span className="button-spinner" /> Styling your look…</> : <>Suggest my outfit <span>✦</span></>}</button>
      <div className="outfit-secondary-actions">
        <button className="secondary-button" type="button" onClick={() => requestShuffle()}>Shuffle instead <span>↻</span></button>
        <button className="secondary-button" type="button" onClick={onBuildOwn}>Build it myself <span>→</span></button>
      </div>
    </section>
  );
}

function ChoiceButton({ active, children, onClick }) {
  return <button className={`choice-button ${active ? 'is-selected' : ''}`} type="button" onClick={onClick}>{children}</button>;
}

function JournalView({ items, blobUrls, outfitRecords, onPlanOutfit, onDeleteOutfitRecord, onAdd }) {
  const [segment, setSegment] = useState('history');
  const stats = useMemo(() => computeWardrobeStats(items, outfitRecords), [items, outfitRecords]);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const outfitThumbs = (record) => record.itemIds.map((id) => itemsById.get(id)).filter(Boolean);

  if (!items.length) {
    return (
      <section className="screen journal-screen empty-outfit">
        <div className="screen-heading"><div><p className="eyebrow">JOURNAL</p><h1>Your outfit history</h1></div></div>
        <div className="empty-state">
          <div className="empty-illustration"><span>◷</span><span>✦</span><span>◐</span></div>
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
        <button className={`segment-button ${segment === 'history' ? 'is-selected' : ''}`} type="button" role="tab" aria-selected={segment === 'history'} onClick={() => setSegment('history')}>History &amp; plans</button>
        <button className={`segment-button ${segment === 'stats' ? 'is-selected' : ''}`} type="button" role="tab" aria-selected={segment === 'stats'} onClick={() => setSegment('stats')}>Stats</button>
      </div>

      {segment === 'history' ? (
        <>
          <button className="secondary-button full-width" type="button" onClick={onPlanOutfit}>＋ Plan an outfit</button>
          {outfitRecords.length ? (
            <div className="journal-list">
              {outfitRecords.map((record) => (
                <div className="journal-row" key={record.id}>
                  <div className="journal-row-photos">
                    {outfitThumbs(record).slice(0, 4).map((item) => (
                      <Photo key={item.id} item={item} blobUrls={blobUrls} className="journal-photo" alt={displayCategory(item.category)} />
                    ))}
                  </div>
                  <div className="journal-row-copy">
                    <strong>{formatDate(record.date)}</strong>
                    <span className={`journal-badge journal-badge-${record.status}`}>{record.status === 'worn' ? 'Worn' : 'Planned'}</span>
                    {record.occasion && <small>{record.occasion}</small>}
                  </div>
                  <button className="icon-text-button danger-text" type="button" onClick={() => onDeleteOutfitRecord(record.id)} aria-label="Remove this entry">×</button>
                </div>
              ))}
            </div>
          ) : (
            <p className="inline-note">Nothing logged yet. Wear a suggested outfit, or plan one ahead.</p>
          )}
        </>
      ) : (
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
          <button className="close-button" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="outfit-row">
          {selectedItems.map((item) => (
            <div className="outfit-piece" key={item.id}>
              <Photo item={item} blobUrls={blobUrls} className="outfit-photo" alt={displayCategory(item.category)} />
              <span>{displayCategory(item.category)}</span>
            </div>
          ))}
        </div>
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

function SettingsView({ onClear, onToast }) {
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
          <span className="settings-icon">✦</span>
          <div><h2>AI providers</h2><p>Add any OpenAI-compatible API. Used only to tag photos and make outfit suggestions.</p></div>
        </div>

        {providers.length === 0 && (
          <p className="inline-note">No providers added yet. Add one below to turn on auto-tagging and AI outfit suggestions — everything else works without one.</p>
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
          <button className="secondary-button full-width" type="button" onClick={() => setOpenFormId('new')}>＋ Add a provider</button>
        )}

        <p className="privacy-note"><span>⌁</span>Each provider's key is saved locally on this device and is sent only to that provider, and only when you use a feature that needs it.</p>
      </section>

      <section className="settings-card">
        <div className="settings-card-heading"><span className="settings-icon">◷</span><div><h2>Repeat protection</h2><p>Deprioritise pieces you wore recently.</p></div></div>
        <div className="range-setting">
          <label htmlFor="repeat-days">Avoid repeats for <strong>{repeatDays} days</strong></label>
          <input id="repeat-days" type="range" min="0" max={MAX_REPEAT_DAYS} step="1" value={repeatDays} onChange={(event) => changeRepeatDays(Number(event.target.value))} />
          <div><span>Off</span><span>3 weeks</span></div>
        </div>
      </section>

      <section className="danger-zone"><p className="eyebrow">DEVICE DATA</p><h2>Start fresh</h2><p>This permanently removes every saved photo and wardrobe item from this browser. Your providers and keys are left alone.</p><button className="danger-button" type="button" onClick={onClear}>Clear wardrobe data</button></section>
    </section>
  );
}

const JSON_MODE_LABELS = {
  auto: 'auto-detect',
  schema: 'strict schema',
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
  const mismatch = detectPresetFromKey(apiKey);
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
      {mismatch && mismatch !== presetId && (
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

function ItemEditor({ item, blobUrls, onClose, onSave, onDelete }) {
  const [draft, setDraft] = useState(() => normalizeItem(item));
  const [isSaving, setIsSaving] = useState(false);
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
        <div className="editor-header"><div><p className="eyebrow">EDIT PIECE</p><h2 id="editor-title">Make it yours</h2></div><button className="close-button" type="button" onClick={onClose} aria-label="Close editor">×</button></div>
        <PhotoSpotlight item={draft} blobUrls={blobUrls} className="editor-photo" />
        <CropControls crop={draft.crop} idPrefix={`editor-${draft.id}`} onChange={(crop) => update({ crop })} />
        <div className="form-grid editor-fields">
          <label>Category<select value={draft.category} onChange={(event) => update({ category: event.target.value })}>{CATEGORIES.map((category) => <option key={category} value={category}>{displayCategory(category)}</option>)}</select></label>
          <label>Colours<input value={draft.colors.join(', ')} placeholder="e.g. olive, cream" onChange={(event) => updateList('colors', event.target.value)} /></label>
          <label className="span-two">Style tags<input value={draft.styleTags.join(', ')} placeholder="e.g. relaxed, smart casual" onChange={(event) => updateList('styleTags', event.target.value)} /></label>
          <label className="span-two">Season / weather<input value={draft.seasons.join(', ')} placeholder="e.g. cool, autumn" onChange={(event) => updateList('seasons', event.target.value)} /><small className="field-hint">{SEASON_HINT}</small></label>
          <label className="span-two">Notes<textarea value={draft.notes} rows="3" placeholder="Fit notes, how you like to wear it…" onChange={(event) => update({ notes: event.target.value })} /></label>
          <label>Price paid <span className="field-hint-inline">(optional)</span><input type="number" min="0" step="0.01" inputMode="decimal" value={draft.pricePaid ?? ''} placeholder="for cost-per-wear" onChange={(event) => update({ pricePaid: event.target.value === '' ? null : Number(event.target.value) })} /></label>
          <div className="last-worn-row"><span>Last worn</span><strong>{formatDate(draft.lastWornDate)}</strong></div>
        </div>
        <button className="primary-button full-width" type="button" disabled={isSaving} onClick={save}>{isSaving ? 'Saving…' : 'Save changes'}</button>
        <button className="danger-text-button" type="button" onClick={() => onDelete(draft.id)}>Delete this piece</button>
      </section>
    </div>
  );
}
