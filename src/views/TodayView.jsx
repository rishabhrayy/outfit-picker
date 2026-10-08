import { Camera, CloudSun, Heart, RefreshCw, Shuffle, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EMPTY_FEEDBACK, isAvailable, isCompleteOutfit, localOutfit, missingForCompleteOutfit, shuffleOutfit } from '../lib/outfit.js';
import { getLastBackupAt, getOutfitPreferences, getWeatherLocation, hasAnyProvider, setOutfitPreferences, shouldNudgeBackup, snoozeBackupNudge } from '../lib/settings.js';
import { describeDay, forecastNote } from '../lib/weather.js';
import { ChoiceButton, daysAgo, displayCategory, localDate, OCCASIONS, OutfitLook, plural, shortlistForSuggestion, suggestionFilters, useForecast, VIBES, WEATHER_OPTIONS } from '../ui/shared.jsx';

export function OutfitView({
  items, blobUrls, repeatDays, onSuggest, onWearOutfit, onRateOutfit, onAdd, onBuildOwn, onOpenPhotoCheck, onToast,
  feedback = EMPTY_FEEDBACK, weatherLocation, isLoading = false, onGoToBackup, onOpenSettings, onQuickAdd,
}) {
  const [showBackupNudge, setShowBackupNudge] = useState(() => shouldNudgeBackup(items.length));
  useEffect(() => { setShowBackupNudge(shouldNudgeBackup(items.length)); }, [items.length]);
  const [preferences, setPreferences] = useState(() => ({
    weather: 'mild',
    temperature: 20,
    rain: false,
    forecastNote: '',
    wantedItemId: '',
    // The occasion and vibe last chosen, so a work week doesn't start from "Everyday" each morning.
    ...getOutfitPreferences(),
  }));
  const [isAdjusting, setIsAdjusting] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [usedItemIds, setUsedItemIds] = useState([]);
  const [isThinking, setIsThinking] = useState(false);
  const [isWorn, setIsWorn] = useState(false);
  const [rating, setRating] = useState('');
  const forecast = useForecast(weatherLocation);
  const today = forecast.days?.find((day) => day.date === localDate()) || null;
  // Live weather fills the weather answer once; after that a tap on a chip wins.
  const [weatherTouched, setWeatherTouched] = useState(false);

  useEffect(() => {
    if (!today || weatherTouched) return;
    setPreferences((current) => ({
      ...current,
      weather: today.weather,
      temperature: today.temperature,
      rain: today.rain,
      forecastNote: forecastNote(today, weatherLocation?.shortName),
    }));
    // The forecast arrived after the first pick: re-pick for the real weather.
    setSuggestion((current) => (current?.isQuick ? null : current));
  }, [today, weatherTouched, weatherLocation?.shortName]);

  // Anything changed in Adjust shows a fresh pick straight away, and the
  // occasion and vibe are remembered for next time.
  const updatePreferences = (changes) => {
    const next = { ...preferences, ...changes };
    setPreferences(next);
    setOutfitPreferences(next);
    setSuggestion(null);
  };

  const pickWeather = (option) => {
    setWeatherTouched(true);
    updatePreferences({ weather: option.value, temperature: option.temperature, rain: false, forecastNote: '' });
  };

  // The outfit shown on arrival: the best-ranked local pick, instant and free.
  // The AI stylist is one tap away rather than the only way to see anything.
  const makeQuickPick = (exclude = []) => ({
    ...localOutfit(
      items.filter((item) => item.id === preferences.wantedItemId || !exclude.includes(item.id)),
      suggestionFilters(preferences, feedback),
      repeatDays,
    ),
    explanation: '',
    isFallback: false,
    source: 'local',
    isQuick: true,
  });

  const suggestionItems = suggestion?.itemIds.map((id) => items.find((item) => item.id === id)).filter(Boolean) || [];
  const availableItems = items.filter(isAvailable);

  // Show a pick on arrival, after any adjustment, and whenever a piece in the
  // current pick is deleted or taken out of rotation.
  useEffect(() => {
    if (isLoading || !items.length) return;
    const stillWearable = suggestion?.itemIds.every((id) => items.some((item) => item.id === id && (isAvailable(item) || id === preferences.wantedItemId)));
    if (suggestion && stillWearable) return;
    setSuggestion(makeQuickPick());
    setUsedItemIds([]);
    setIsWorn(false);
    setRating('');
    // makeQuickPick reads the same inputs listed here.
  }, [isLoading, items, preferences, suggestion]);

  const requestSuggestion = async ({ exclude = [] } = {}) => {
    const candidates = shortlistForSuggestion(items, preferences, repeatDays, exclude, feedback);
    if (!candidates.length) {
      onToast('There are no unused pieces left to try. Change your answers, or start over with "Suggest my outfit".');
      return;
    }
    // The no-AI pick uses the whole wardrobe's ranking (minus what was already
    // shown), with the same feedback rules as the shuffle.
    const makeLocalSuggestion = () => localOutfit(
      items.filter((item) => item.id === preferences.wantedItemId || !exclude.includes(item.id)),
      suggestionFilters(preferences, feedback),
      repeatDays,
    );
    setIsThinking(true);
    setIsWorn(false);
    setRating('');
    try {
      let normalized;
      try {
        const usingAi = Boolean(onSuggest && hasAnyProvider());
        const response = usingAi
          ? await onSuggest({ items: candidates, preferences, excludedItemIds: exclude, avoidRecentDays: repeatDays, feedback })
          : makeLocalSuggestion();
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
        const local = makeLocalSuggestion();
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
    const filters = suggestionFilters(preferences, feedback);
    const shuffleWithout = (ids) => shuffleOutfit(
      items.filter((item) => !ids.includes(item.id) || item.id === preferences.wantedItemId),
      filters,
      repeatDays,
    );
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const isComplete = (ids) => isCompleteOutfit(ids, itemsById);

    let result = shuffleWithout(exclude);
    // "Shuffle again" avoids everything already shown, so a small wardrobe soon
    // runs out of bottoms and starts showing a top on its own. When that
    // happens, start a new round that only avoids what's on screen right now.
    if (exclude.length && !isComplete(result.itemIds)) {
      exclude = suggestion?.itemIds || [];
      result = shuffleWithout(exclude);
    }

    if (!result.itemIds.length) {
      onToast('Add a few more pieces so there is something to shuffle.');
      return;
    }
    setIsWorn(false);
    setRating('');
    setSuggestion({ ...result, isFallback: false, source: 'shuffle' });
    setUsedItemIds(exclude);
  };

  // "Another one" stays with whatever made the current pick: the AI asks the
  // AI again, while a quick pick or shuffle shuffles.
  const reroll = () => {
    const exclude = [...usedItemIds, ...suggestion.itemIds];
    if (suggestion.source === 'ai' || suggestion.isFallback) requestSuggestion({ exclude });
    else requestShuffle({ exclude: suggestion.source === 'shuffle' ? exclude : suggestion.itemIds });
  };

  const wearThis = async () => {
    if (!suggestionItems.length) return;
    try {
      await onWearOutfit({
        itemIds: suggestionItems.map((item) => item.id),
        date: localDate(),
        source: suggestion.source,
        explanation: suggestion.explanation,
        message: 'Marked as worn today. Have a great time!',
        onUndone: () => setIsWorn(false),
      });
      setIsWorn(true);
    } catch (error) {
      onToast(error?.message || 'That outfit could not be marked as worn.');
    }
  };

  const rate = async (value) => {
    if (!suggestionItems.length || rating) return;
    try {
      const ruledOut = suggestion;
      await onRateOutfit({
        itemIds: suggestionItems.map((item) => item.id),
        rating: value,
        source: suggestion.source,
        explanation: suggestion.explanation,
        message: value === 'loved'
          ? 'Loved. Pieces from it will come up a little more often.'
          : 'Got it. That pairing won\'t be suggested again.',
        // Undo brings back the outfit that was ruled out, not just the record.
        onUndone: () => {
          setRating('');
          if (value === 'rejected') setSuggestion(ruledOut);
        },
      });
      setRating(value);
      if (value === 'rejected') reroll();
    } catch (error) {
      onToast(error?.message || 'That could not be saved.');
    }
  };

  // Block only on a genuinely empty wardrobe. A wardrobe missing one category
  // (no shoes yet, say) still deserves a suggestion — it just says so, rather
  // than refusing outright.
  if (!items.length && !isLoading) {
    return (
      <section className="screen outfit-screen empty-outfit">
        <div className="screen-heading"><div><p className="eyebrow">WELCOME</p><h1>Let’s set up your wardrobe</h1><p className="heading-copy">Three steps, and Today starts dressing you.</p></div></div>
        <FirstRunGuide onAdd={onAdd} onOpenSettings={onOpenSettings} onQuickAdd={onQuickAdd} />
      </section>
    );
  }

  const missing = missingForCompleteOutfit(availableItems);
  const isAi = suggestion?.source === 'ai' && !suggestion.isFallback;
  const weatherLabel = WEATHER_OPTIONS.find((option) => option.value === preferences.weather)?.label || preferences.weather;

  return (
    <section className="screen outfit-screen today-screen">
      <div className="screen-heading">
        <div>
          <p className="eyebrow">TODAY · {new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short' }).format(new Date()).toUpperCase()}</p>
          <h1>{isAi ? 'Styled for you' : 'Your outfit today'}</h1>
        </div>
      </div>

      {showBackupNudge && (
        <div className="backup-nudge">
          <p><strong>Your wardrobe is only saved on this phone.</strong> {getLastBackupAt() ? `Last backup ${daysAgo(getLastBackupAt())}.` : 'It has never been backed up.'} Phones can clear website data.</p>
          <div>
            <button className="primary-button compact" type="button" onClick={onGoToBackup}>Back up now</button>
            <button className="text-button" type="button" onClick={() => { snoozeBackupNudge(7); setShowBackupNudge(false); }}>Later</button>
          </div>
        </div>
      )}

      {today && !weatherTouched && (
        <p className="forecast-line"><CloudSun className="inline-icon" aria-hidden="true" /> {weatherLocation.shortName}: {describeDay(today)}{today.rain ? ' — rain likely' : ''}</p>
      )}
      {weatherLocation && forecast.error && <p className="forecast-line">Live weather unavailable: {forecast.error}</p>}

      <button className="adjust-summary" type="button" aria-expanded={isAdjusting} onClick={() => setIsAdjusting((current) => !current)}>
        <span>{preferences.occasion}</span>
        <span>{weatherLabel} {preferences.temperature}°{preferences.rain ? ' · rain' : ''}</span>
        <span>{preferences.vibe}</span>
        {preferences.wantedItemId && <span>With a chosen piece</span>}
        <strong>{isAdjusting ? 'Done' : 'Adjust'}</strong>
      </button>

      {isAdjusting && (
        <div className="adjust-panel">
          <fieldset className="question-block">
            <legend>Where are you going?</legend>
            <div className="chip-row">
              {OCCASIONS.map((occasion) => <ChoiceButton key={occasion} active={preferences.occasion === occasion} onClick={() => updatePreferences({ occasion })}>{occasion}</ChoiceButton>)}
            </div>
          </fieldset>
          <fieldset className="question-block">
            <legend>The weather</legend>
            <div className="choice-grid weather-grid">
              {WEATHER_OPTIONS.map((weather) => <ChoiceButton key={weather.value} active={preferences.weather === weather.value} onClick={() => pickWeather(weather)}>{weather.label}<small>{preferences.weather === weather.value && !weatherTouched && today ? `${today.temperature}°` : `${weather.temperature}°`}</small></ChoiceButton>)}
            </div>
            {!weatherLocation && <p className="field-hint">Turn on live weather in Settings and this fills itself in.</p>}
          </fieldset>
          <fieldset className="question-block">
            <legend>How do you want to feel?</legend>
            <div className="chip-row">
              {VIBES.map((vibe) => <ChoiceButton key={vibe} active={preferences.vibe === vibe} onClick={() => updatePreferences({ vibe })}>{vibe}</ChoiceButton>)}
            </div>
          </fieldset>
          <label className="wanted-select">Build it around a piece<select value={preferences.wantedItemId} onChange={(event) => updatePreferences({ wantedItemId: event.target.value })}><option value="">No — surprise me</option>{availableItems.map((item) => <option key={item.id} value={item.id}>{displayCategory(item.category)} · {item.colors.join(', ') || 'untitled item'}</option>)}</select></label>
        </div>
      )}

      {missing.length > 0 && (
        <p className="inline-note">No {missing.join(' or ')} in rotation yet — I’ll style what you have.</p>
      )}

      {isLoading || !suggestion ? (
        <div className="outfit-look look-skeleton" aria-hidden="true"><div className="look-main"><div className="card-skeleton" /><div className="card-skeleton" /></div></div>
      ) : suggestionItems.length ? (
        <OutfitLook items={suggestionItems} blobUrls={blobUrls} />
      ) : (
        <p className="inline-note">Nothing in rotation fits these answers. Adjust them, or bring something back from the wash.</p>
      )}

      {suggestion?.isFallback && (
        <p className="inline-note">The AI stylist didn’t answer this time, so this is the best match from your wardrobe.</p>
      )}
      {isAi && suggestion.explanation && <div className="explanation-card"><span aria-hidden="true"><Sparkles /></span><p>{suggestion.explanation}</p></div>}
      {!isAi && !suggestion?.isFallback && suggestionItems.length > 0 && (
        <p className="pick-source">{suggestion.source === 'shuffle' ? 'Shuffled from your wardrobe.' : `Best match for ${preferences.occasion.toLowerCase()}, ${weatherLabel.toLowerCase()} weather.`} Not worn in the last {repeatDays} days where possible.</p>
      )}

      <button className={`primary-button full-width ${isWorn ? 'success-button' : ''}`} type="button" onClick={wearThis} disabled={isWorn || !suggestionItems.length}>
        {isWorn ? '✓ Worn today' : 'Wear this'}
      </button>
      <div className="outfit-secondary-actions">
        <button className="secondary-button" type="button" disabled={isThinking || !suggestionItems.length} onClick={() => (isAi ? reroll() : requestShuffle({ exclude: suggestion.source === 'shuffle' ? [...usedItemIds, ...suggestion.itemIds] : suggestion.itemIds }))}>
          {isAi ? <>Ask again <span className="button-icon" aria-hidden="true"><RefreshCw /></span></> : <>Shuffle <span className="button-icon" aria-hidden="true"><Shuffle /></span></>}
        </button>
        <button className="secondary-button ai-button" type="button" disabled={isThinking} onClick={() => (hasAnyProvider() ? requestSuggestion({ exclude: isAi ? [...usedItemIds, ...suggestion.itemIds] : [] }) : onToast('Connect the built-in AI or a provider in Settings to use the AI stylist.'))}>
          {isThinking ? <><span className="button-spinner dark" /> Styling…</> : <>AI stylist <span className="button-icon" aria-hidden="true"><Sparkles /></span></>}
        </button>
      </div>
      {suggestionItems.length > 0 && (
        <div className="rating-row">
          <button className={`secondary-button ${rating === 'loved' ? 'is-loved' : ''}`} type="button" disabled={Boolean(rating) || isThinking} onClick={() => rate('loved')}>
            {rating === 'loved' ? <><Heart className="inline-icon" fill="currentColor" aria-hidden="true" /> Loved</> : <><Heart className="inline-icon" aria-hidden="true" /> Love it</>}
          </button>
          <button className="secondary-button" type="button" disabled={Boolean(rating) || isThinking} onClick={() => rate('rejected')}>
            Never suggest this
          </button>
        </div>
      )}

      <button className="photo-check-strip" type="button" onClick={onOpenPhotoCheck}>
        <span aria-hidden="true"><Camera /></span>
        <span><strong>Already dressed?</strong><small>Snap a mirror photo to log it and get honest feedback</small></span>
        <span className="arrow">→</span>
      </button>
      <button className="text-button build-own" type="button" onClick={onBuildOwn}>Or pick the pieces yourself →</button>
    </section>
  );
}

// Everyday pieces most wardrobes have, for a quick start before any photos.
export const BASICS = [
  { key: 'white-tee', label: 'White T-shirt', category: 'top', colors: ['white'], styleTags: ['casual', 'minimal'], seasons: ['all-season'], fill: '#fbfbfb' },
  { key: 'black-tee', label: 'Black T-shirt', category: 'top', colors: ['black'], styleTags: ['casual', 'minimal'], seasons: ['all-season'], fill: '#26262a' },
  { key: 'white-shirt', label: 'White shirt', category: 'top', colors: ['white'], styleTags: ['smart casual', 'work'], seasons: ['all-season'], fill: '#f4f6fa' },
  { key: 'navy-jumper', label: 'Navy jumper', category: 'top', colors: ['navy'], styleTags: ['casual', 'smart casual'], seasons: ['autumn', 'winter', 'cool'], fill: '#22304f' },
  { key: 'blue-jeans', label: 'Blue jeans', category: 'bottom', colors: ['blue', 'denim'], styleTags: ['casual'], seasons: ['all-season'], fill: '#5b7fae' },
  { key: 'black-jeans', label: 'Black jeans', category: 'bottom', colors: ['black'], styleTags: ['casual', 'smart casual'], seasons: ['all-season'], fill: '#1d1d20' },
  { key: 'beige-chinos', label: 'Beige chinos', category: 'bottom', colors: ['beige'], styleTags: ['smart casual', 'work'], seasons: ['spring', 'summer', 'mild'], fill: '#d6c19c' },
  { key: 'white-sneakers', label: 'White sneakers', category: 'shoes', colors: ['white'], styleTags: ['casual', 'minimal'], seasons: ['all-season'], fill: '#fdfdfd' },
  { key: 'black-boots', label: 'Black boots', category: 'shoes', colors: ['black'], styleTags: ['smart casual'], seasons: ['autumn', 'winter', 'cold', 'rainy'], fill: '#222' },
  { key: 'denim-jacket', label: 'Denim jacket', category: 'outerwear', colors: ['denim', 'blue'], styleTags: ['casual'], seasons: ['spring', 'autumn', 'cool'], fill: '#6f8fbd' },
];

// A plain drawn stand-in, so a basic added without a photo still has
// something to show (and works like any other photo: crops, the look, etc.).
export function drawBasic({ category, fill }) {
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 440;
  const g = canvas.getContext('2d');
  g.fillStyle = '#f1ede6';
  g.fillRect(0, 0, 360, 440);
  g.fillStyle = fill;
  g.strokeStyle = '#6b665f';
  g.lineWidth = 4;
  g.lineJoin = 'round';
  const shapes = {
    top: [[105, 80], [255, 80], [325, 150], [285, 185], [265, 160], [265, 370], [95, 370], [95, 160], [75, 185], [35, 150]],
    outerwear: [[95, 60], [265, 60], [335, 170], [290, 200], [272, 175], [272, 400], [88, 400], [88, 175], [70, 200], [25, 170]],
    bottom: [[105, 50], [255, 50], [280, 400], [195, 400], [180, 170], [165, 400], [80, 400]],
    shoes: [[50, 270], [170, 245], [300, 300], [300, 345], [50, 345]],
  };
  const points = shapes[category] || shapes.top;
  g.beginPath();
  points.forEach(([x, y], index) => (index ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.fill();
  g.stroke();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
}

/**
 * The first screen for an empty wardrobe: the three things that make the app
 * work, in order, plus a quick start from common basics so Today has
 * something to dress you in before any photos are taken.
 */
export function FirstRunGuide({ onAdd, onOpenSettings, onQuickAdd }) {
  const [chosen, setChosen] = useState([]);
  const [isAdding, setIsAdding] = useState(false);
  const hasAi = hasAnyProvider();
  const hasWeather = Boolean(getWeatherLocation());
  const toggle = (key) => setChosen((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]));

  const addBasics = async () => {
    setIsAdding(true);
    try {
      await onQuickAdd(BASICS.filter((basic) => chosen.includes(basic.key)));
      setChosen([]);
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <div className="first-run">
      <ol className="first-run-steps">
        <li className={hasAi ? 'is-done' : ''}>
          <span className="step-mark" aria-hidden="true">{hasAi ? '✓' : '1'}</span>
          <div>
            <strong>Connect the AI</strong>
            <small>{hasAi ? 'Connected.' : 'For tagging photos and styling. Enter the built-in AI passcode in Settings.'}</small>
          </div>
          {!hasAi && <button className="secondary-button compact" type="button" onClick={onOpenSettings}>Settings</button>}
        </li>
        <li>
          <span className="step-mark" aria-hidden="true">2</span>
          <div>
            <strong>Add photos of your clothes</strong>
            <small>One piece, a pile, or a mirror selfie. Each piece is found and cropped for you.</small>
          </div>
          <button className="primary-button compact" type="button" onClick={onAdd}>Add</button>
        </li>
        <li className={hasWeather ? 'is-done' : ''}>
          <span className="step-mark" aria-hidden="true">{hasWeather ? '✓' : '3'}</span>
          <div>
            <strong>Live weather <em>(optional)</em></strong>
            <small>{hasWeather ? 'On.' : 'So Today dresses you for the forecast.'}</small>
          </div>
          {!hasWeather && <button className="secondary-button compact" type="button" onClick={onOpenSettings}>Turn on</button>}
        </li>
      </ol>

      <section className="quick-basics">
        <h3>Or start with the basics you own</h3>
        <p>Tap what you have. Each gets a simple drawing for now; add real photos whenever you like.</p>
        <div className="chip-row">
          {BASICS.map((basic) => (
            <ChoiceButton key={basic.key} active={chosen.includes(basic.key)} onClick={() => toggle(basic.key)}>{basic.label}</ChoiceButton>
          ))}
        </div>
        <button className="primary-button full-width" type="button" disabled={!chosen.length || isAdding} onClick={addBasics}>
          {isAdding ? <><span className="button-spinner" /> Adding…</> : chosen.length ? `Add ${plural(chosen.length, 'piece')}` : 'Choose a few above'}
        </button>
      </section>
    </div>
  );
}
