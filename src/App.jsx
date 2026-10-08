import { CalendarDays, LayoutGrid, Plus, Settings, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { deriveFeedback } from './lib/outfit.js';
import { getRepeatDays, getWeatherLocation, setWeatherLocation } from './lib/settings.js';
import { describeCounts, formatDate, localDate, normalizeItem, normalizeOutfitEntry, plural, uid } from './ui/shared.jsx';
import { ItemEditor } from './views/ItemEditor.jsx';
import { JournalView } from './views/JournalView.jsx';
import { OutfitPhotoModal } from './views/OutfitPhotoModal.jsx';
import { SaveLookModal } from './views/SaveLookModal.jsx';
import { SettingsView } from './views/SettingsView.jsx';
import { drawBasic, OutfitView } from './views/TodayView.jsx';
import { UploadView } from './views/UploadView.jsx';
import { WardrobeView } from './views/WardrobeView.jsx';
import './App.css';

const EMPTY_SERVICES = {};
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
