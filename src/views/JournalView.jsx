import { ArrowLeft, ArrowRight, CalendarDays, CalendarRange, Camera, Gem, Plane, Plus, RefreshCw, Shirt, Sparkles, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { computeWardrobeStats, isAvailable, isCompleteOutfit, packForTrip, planOutfitsForDays } from '../lib/outfit.js';
import { hasAnyProvider } from '../lib/settings.js';
import { describeDay, searchPlaces } from '../lib/weather.js';
import { addDays, CATEGORIES, ChoiceButton, displayCategory, FilterChip, formatDate, isWeekend, loadForecast, localDate, OCCASIONS, Photo, plural, useForecast, WEATHER_OPTIONS, weekday } from '../ui/shared.jsx';

export const JOURNAL_BADGES = { worn: 'Worn', planned: 'Planned', loved: 'Loved' };

export function mondayOf(dateString) {
  const day = new Date(`${dateString}T12:00:00`).getDay();
  return addDays(dateString, -((day + 6) % 7));
}

/**
 * Mon-Sun at a glance: a thumbnail of what was worn (solid) or planned
 * (dashed) each day. Tapping a day shows just that day's entries below.
 */
export function WeekStrip({ outfitRecords, itemsById, blobUrls, selectedDate, onSelectDate }) {
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

export function JournalView({
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

export function OutfitThumbs({ itemIds, itemsById, blobUrls, className = 'journal-photo' }) {
  return (
    <div className="journal-row-photos">
      {itemIds.map((id) => itemsById.get(id)).filter(Boolean).map((item) => (
        <Photo key={item.id} item={item} blobUrls={blobUrls} className={className} alt={`${displayCategory(item.category)}${item.colors.length ? `, ${item.colors.join(' ')}` : ''}`} />
      ))}
    </div>
  );
}

export const MAIN_CATEGORIES = new Set(['top', 'bottom', 'dress']);

/**
 * Seven days of outfits in one go, with no top, bottom or dress repeated while
 * there's anything else to wear. Uses the live forecast for each day when it's
 * on. Local and instant, so it works with no AI and can't be rate-limited.
 */
export function WeekPlanner({ items, blobUrls, feedback, repeatDays, weatherLocation, onSavePlan }) {
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
export function TripPlanner({ items, blobUrls, feedback, onSavePlan, onToast }) {
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
export function CapsuleBuilder({ items, blobUrls, buildCapsule, onToast }) {
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
