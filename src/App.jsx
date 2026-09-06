import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  controlsFromCrop,
  cropFromControls,
  cropStyle,
} from './lib/crop.js';
import { filterWardrobeForOutfit, hasEnoughForSuggestion, occasionKey } from './lib/outfit.js';
import { PROVIDERS, PROVIDER_IDS, detectProvider } from './lib/providers.js';
import {
  MAX_REPEAT_DAYS,
  getApiKey,
  getProvider,
  getRepeatDays,
  hasApiKey,
  setApiKey,
  setProvider,
  setRepeatDays,
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
const SEASON_HINT = 'Recognised: spring, summer, autumn, winter, all-season, cold, cool, mild, warm, hot, rainy, windy';

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
    crop: item.crop || null,
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
  const [activeTab, setActiveTab] = useState('wardrobe');
  const [editingItem, setEditingItem] = useState(null);
  const [toast, setToast] = useState('');
  const [blobUrls, setBlobUrls] = useState({});

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
      setToast('Your wardrobe has been cleared.');
    } catch (error) {
      setToast(error?.message || 'Your wardrobe could not be cleared.');
    }
  };

  return (
    <div className="outfit-app">
      <header className="app-header">
        <button className="brand" type="button" onClick={() => setActiveTab('wardrobe')} aria-label="Go to wardrobe">
          <span className="brand-mark">◐</span>
          <span>Outfit Picker</span>
        </button>
        <button className="header-action" type="button" onClick={() => setActiveTab('upload')} aria-label="Add clothes">
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
            onAdd={() => setActiveTab('upload')}
            onSuggest={() => setActiveTab('outfit')}
          />
        )}
        {activeTab === 'upload' && (
          <UploadView
            tagPhoto={services.tagPhoto}
            onSaveBatch={saveBatch}
            onCancel={() => setActiveTab('wardrobe')}
            onToast={setToast}
          />
        )}
        {activeTab === 'outfit' && (
          <OutfitView
            items={items}
            blobUrls={blobUrls}
            repeatDays={getRepeatDays()}
            onSuggest={services.suggestOutfit}
            onMarkWorn={async (ids, date) => {
              await services.markItemsWorn?.(ids, date);
              setItems((current) => current.map((item) => (ids.includes(item.id) ? { ...item, lastWornDate: date } : item)));
            }}
            onAdd={() => setActiveTab('upload')}
            onToast={setToast}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsView onClear={clearWardrobe} onToast={setToast} />
        )}
      </main>

      <nav className="bottom-nav" aria-label="Primary navigation">
        <NavButton icon="▦" label="Wardrobe" active={activeTab === 'wardrobe'} onClick={() => setActiveTab('wardrobe')} />
        <NavButton icon="＋" label="Add" active={activeTab === 'upload'} onClick={() => setActiveTab('upload')} />
        <NavButton icon="✦" label="Outfit" active={activeTab === 'outfit'} onClick={() => setActiveTab('outfit')} />
        <NavButton icon="⚙" label="Settings" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
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

function WardrobeView({ items, blobUrls, onOpenItem, onAdd, onSuggest, isLoading }) {
  const [filter, setFilter] = useState('all');
  const filteredItems = useMemo(
    () => (filter === 'all' ? items : items.filter((item) => item.category === filter)),
    [filter, items],
  );

  return (
    <section className="screen wardrobe-screen">
      <div className="screen-heading wardrobe-heading">
        <div>
          <p className="eyebrow">YOUR CLOSET</p>
          <h1>What are we wearing?</h1>
        </div>
        <span className="item-count">{items.length} {items.length === 1 ? 'piece' : 'pieces'}</span>
      </div>

      {items.length > 0 && (
        <button className="suggest-strip" type="button" onClick={onSuggest}>
          <span className="sparkle">✦</span>
          <span><strong>Pick an outfit for me</strong><small>Tell me the plan, I’ll do the styling</small></span>
          <span className="arrow">→</span>
        </button>
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
          {filteredItems.map((item) => (
            <button className="wardrobe-card" type="button" key={item.id} onClick={() => onOpenItem(item)}>
              <Photo item={item} blobUrls={blobUrls} className="wardrobe-photo" alt={`${displayCategory(item.category)} item`} />
              <span className="card-copy">
                <span className="card-category">{displayCategory(item.category)}</span>
                <span className="card-colors">{item.colors.length ? item.colors.join(' · ') : 'Untitled piece'}</span>
              </span>
              {item.lastWornDate && <span className="worn-badge">Worn {formatDate(item.lastWornDate)}</span>}
            </button>
          ))}
          <button className="add-card" type="button" onClick={onAdd}>
            <span>＋</span>
            <strong>Add a piece</strong>
          </button>
        </div>
      ) : (
        <EmptyWardrobe filter={filter} onAdd={onAdd} />
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

function OutfitView({ items, blobUrls, repeatDays, onSuggest, onMarkWorn, onAdd, onToast }) {
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
      onToast('There are no unused matching pieces left. Try changing your answers.');
      return;
    }
    setIsThinking(true);
    setIsWorn(false);
    try {
      const response = onSuggest && hasApiKey()
        ? await onSuggest({ items: candidates, preferences, excludedItemIds: exclude, avoidRecentDays: repeatDays })
        : makeLocalSuggestion(candidates);
      const normalized = {
        itemIds: (response?.itemIds || response?.items || []).map((entry) => typeof entry === 'string' ? entry : entry.id),
        explanation: response?.explanation || 'This combination is ready to wear.',
      };
      if (!normalized.itemIds.length) throw new Error('No complete outfit was returned. Try a different set of answers.');
      setSuggestion(normalized);
      setUsedItemIds(exclude);
    } catch (error) {
      onToast(error?.message || 'I could not put an outfit together this time.');
    } finally {
      setIsThinking(false);
    }
  };

  const wearThis = async () => {
    if (!suggestionItems.length) return;
    try {
      await onMarkWorn(suggestionItems.map((item) => item.id), localDate());
      setIsWorn(true);
      onToast('Marked as worn today. Have a great time!');
    } catch (error) {
      onToast(error?.message || 'That outfit could not be marked as worn.');
    }
  };

  if (!hasEnoughForSuggestion(items)) {
    return (
      <section className="screen outfit-screen empty-outfit">
        <div className="screen-heading"><div><p className="eyebrow">OUTFIT PICKER</p><h1>Let’s get dressed</h1></div></div>
        <div className="empty-state">
          <div className="empty-illustration warm"><span>✦</span><span>◐</span><span>⌁</span></div>
          <h2>Add a few pieces first</h2>
          <p>Once your wardrobe has a top, bottom or dress, and shoes, I can start assembling outfits.</p>
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
        <div className="explanation-card"><span>✦</span><p>{suggestion.explanation}</p></div>
        <div className="recent-note">Avoiding pieces worn in the last {repeatDays} days where possible.</div>
        <button className={`primary-button full-width ${isWorn ? 'success-button' : ''}`} type="button" onClick={wearThis} disabled={isWorn}>
          {isWorn ? '✓ Worn today' : 'Wear this'}
        </button>
        <button className="secondary-button full-width" type="button" disabled={isThinking} onClick={() => requestSuggestion({ exclude: [...usedItemIds, ...suggestion.itemIds] })}>
          {isThinking ? <><span className="button-spinner dark" /> Finding another…</> : <>Suggest another <span>↻</span></>}
        </button>
      </section>
    );
  }

  return (
    <section className="screen outfit-screen question-screen">
      <div className="screen-heading"><div><p className="eyebrow">OUTFIT PICKER</p><h1>What’s the plan?</h1><p className="heading-copy">A few details and I’ll pull a look from your closet.</p></div></div>
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
    </section>
  );
}

function ChoiceButton({ active, children, onClick }) {
  return <button className={`choice-button ${active ? 'is-selected' : ''}`} type="button" onClick={onClick}>{children}</button>;
}

function SettingsView({ onClear, onToast }) {
  const [providerId, setProviderDraft] = useState(getProvider);
  // Keys are kept per provider, so switching does not throw the other one away.
  const [keys, setKeys] = useState(() => Object.fromEntries(PROVIDER_IDS.map((id) => [id, getApiKey(id)])));
  const [showKey, setShowKey] = useState(false);
  const [repeatDays, setRepeatDaysDraft] = useState(getRepeatDays);
  const [saved, setSaved] = useState(false);

  const provider = PROVIDERS[providerId];
  const apiKey = keys[providerId] || '';
  const mismatch = detectProvider(apiKey);

  const saveSettings = () => {
    const stored = PROVIDER_IDS.every((id) => setApiKey(keys[id] || '', id))
      && setProvider(providerId)
      && setRepeatDays(repeatDays);
    if (!stored) {
      onToast('This browser is blocking local storage, so settings could not be saved.');
      return;
    }
    setSaved(true);
    onToast('Settings saved on this device.');
    window.setTimeout(() => setSaved(false), 2200);
  };

  return (
    <section className="screen settings-screen">
      <div className="screen-heading"><div><p className="eyebrow">SETTINGS</p><h1>Your private closet</h1><p className="heading-copy">Everything lives in this browser, on this device.</p></div></div>
      <section className="settings-card">
        <div className="settings-card-heading"><span className="settings-icon">✦</span><div><h2>AI provider</h2><p>Used only to tag photos and make outfit suggestions.</p></div></div>
        <div className="provider-choice" role="radiogroup" aria-label="AI provider">
          {PROVIDER_IDS.map((id) => (
            <button
              key={id}
              className={`choice-button ${providerId === id ? 'is-selected' : ''}`}
              type="button"
              role="radio"
              aria-checked={providerId === id}
              onClick={() => setProviderDraft(id)}
            >
              {PROVIDERS[id].label}
            </button>
          ))}
        </div>
        <label className="key-field"><span>{provider.label} API key</span><div><input type={showKey ? 'text' : 'password'} value={apiKey} placeholder={provider.keyPlaceholder} autoComplete="off" spellCheck="false" onChange={(event) => setKeys((current) => ({ ...current, [providerId]: event.target.value }))} /><button type="button" onClick={() => setShowKey((current) => !current)}>{showKey ? 'Hide' : 'Show'}</button></div></label>
        {mismatch && mismatch !== providerId && (
          <p className="key-warning" role="alert">
            That looks like a {PROVIDERS[mismatch].label} key. Either switch the provider above, or paste {provider.article} {provider.label} key.
          </p>
        )}
        <p className="field-hint">Get a key from {provider.keyHost} · tags with {provider.primaryModel}, retries on {provider.fallbackModel}</p>
        <p className="privacy-note"><span>⌁</span>Each provider's key is saved locally on this device and is sent only to {provider.label}, and only when you use a feature.</p>
      </section>
      <section className="settings-card">
        <div className="settings-card-heading"><span className="settings-icon">◷</span><div><h2>Repeat protection</h2><p>Deprioritise pieces you wore recently.</p></div></div>
        <div className="range-setting"><label htmlFor="repeat-days">Avoid repeats for <strong>{repeatDays} days</strong></label><input id="repeat-days" type="range" min="0" max={MAX_REPEAT_DAYS} step="1" value={repeatDays} onChange={(event) => setRepeatDaysDraft(Number(event.target.value))} /><div><span>Off</span><span>3 weeks</span></div></div>
      </section>
      <button className={`primary-button full-width ${saved ? 'success-button' : ''}`} type="button" onClick={saveSettings}>{saved ? '✓ Saved locally' : 'Save settings'}</button>
      <section className="danger-zone"><p className="eyebrow">DEVICE DATA</p><h2>Start fresh</h2><p>This permanently removes every saved photo and wardrobe item from this browser.</p><button className="danger-button" type="button" onClick={onClear}>Clear wardrobe data</button></section>
    </section>
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
        <Photo item={draft} blobUrls={blobUrls} className="editor-photo" alt={`${displayCategory(draft.category)} item`} />
        <CropControls crop={draft.crop} idPrefix={`editor-${draft.id}`} onChange={(crop) => update({ crop })} />
        <div className="form-grid editor-fields">
          <label>Category<select value={draft.category} onChange={(event) => update({ category: event.target.value })}>{CATEGORIES.map((category) => <option key={category} value={category}>{displayCategory(category)}</option>)}</select></label>
          <label>Colours<input value={draft.colors.join(', ')} placeholder="e.g. olive, cream" onChange={(event) => updateList('colors', event.target.value)} /></label>
          <label className="span-two">Style tags<input value={draft.styleTags.join(', ')} placeholder="e.g. relaxed, smart casual" onChange={(event) => updateList('styleTags', event.target.value)} /></label>
          <label className="span-two">Season / weather<input value={draft.seasons.join(', ')} placeholder="e.g. cool, autumn" onChange={(event) => updateList('seasons', event.target.value)} /><small className="field-hint">{SEASON_HINT}</small></label>
          <label className="span-two">Notes<textarea value={draft.notes} rows="3" placeholder="Fit notes, how you like to wear it…" onChange={(event) => update({ notes: event.target.value })} /></label>
          <div className="last-worn-row span-two"><span>Last worn</span><strong>{formatDate(draft.lastWornDate)}</strong></div>
        </div>
        <button className="primary-button full-width" type="button" disabled={isSaving} onClick={save}>{isSaving ? 'Saving…' : 'Save changes'}</button>
        <button className="danger-text-button" type="button" onClick={() => onDelete(draft.id)}>Delete this piece</button>
      </section>
    </div>
  );
}
