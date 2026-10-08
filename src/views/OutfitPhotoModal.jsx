import { Camera, RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { hasAnyProvider } from '../lib/settings.js';
import { forecastNote } from '../lib/weather.js';
import { CroppedImage, displayCategory, localDate, OCCASIONS, Photo, plural, retryWhenBusy, useForecast, useModalKeyboard } from '../ui/shared.jsx';

/**
 * Today's outfit, from one photo: the AI says which saved pieces are being
 * worn (each one can be corrected before logging) and gives honest written
 * feedback. No score: a number from a model looking at one photo would be
 * made up, and the research on other apps found people don't trust it.
 */
export function OutfitPhotoModal({ items, blobUrls, analyze, weatherLocation, onClose, onLog, onToast }) {
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
