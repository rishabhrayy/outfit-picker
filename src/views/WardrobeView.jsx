import { Footprints, Plus, Shirt, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { isAvailable, isRecentlyWorn } from '../lib/outfit.js';
import { CATEGORIES, CATEGORY_META, displayCategory, FilterChip, formatDate, Photo, SEASON_WEATHER_VALUES, UNAVAILABLE_OPTIONS, unavailableLabel } from '../ui/shared.jsx';

// "Not worn in a while" means this many days, or never.
export const STALE_DAYS = 30;

export function WardrobeView({
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

export function EmptyWardrobe({ filter, onAdd, hasItems }) {
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
