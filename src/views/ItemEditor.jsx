import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { hasAnyProvider } from '../lib/settings.js';
import { asList, CATEGORIES, CropControls, displayCategory, formatDate, normalizeItem, PhotoSpotlight, SEASON_HINT, UNAVAILABLE_OPTIONS } from '../ui/shared.jsx';

export function ItemEditor({ item, blobUrls, onClose, onSave, onDelete, locate, onToast }) {
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
