import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatDate, localDate, OutfitLook } from '../ui/shared.jsx';

/**
 * Saves a manually built outfit — reached from Outfit's "Build it myself" and
 * Journal's "Plan an outfit," both of which land here through the same
 * wardrobe selection mode. The date field IS the planning mechanism: today
 * saves it as worn, any other date plans it, with no separate calendar UI.
 */
export function SaveLookModal({ items, blobUrls, itemIds, onClose, onSave }) {
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
