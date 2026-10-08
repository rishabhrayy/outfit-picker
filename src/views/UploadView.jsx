import { Camera, Plus, RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { spotlightStyle } from '../lib/crop.js';
import { asList, CATEGORIES, CropControls, CroppedImage, displayCategory, MAX_BATCH_PHOTOS, normalizeItem, plural, retryWhenBusy, SEASON_HINT, uid } from '../ui/shared.jsx';

export function UploadView({ tagPhoto, onSaveBatch, onCancel, onToast }) {
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

export function ReviewItemCard({ item, index, preview, selected, onToggleMerge, onChange, onRemove }) {
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
