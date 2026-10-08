import { Archive, CloudSun, History, Lock, Plus, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { exhaustedUntil, isExhausted, testProvider, usageToday } from '../lib/ai.js';
import { BUILTIN_PRESET_ID, DEFAULT_PRESET_ID, detectKeyMismatch, getPreset, PROVIDER_PRESETS } from '../lib/providers.js';
import { addProvider, deleteProvider, getActiveProviderId, getLastBackupAt, getProviders, getRepeatDays, MAX_REPEAT_DAYS, setActiveProviderId, setLastBackupAt, setRepeatDays, updateProvider } from '../lib/settings.js';
import { canUseShareSheet, isIosStandalone, pickShareableFile, shareCandidates, shareFile } from '../lib/shareFile.js';
import { currentRoundedPosition, describeDay, searchPlaces } from '../lib/weather.js';
import { daysAgo, describeCounts, localDate, plural, useForecast } from '../ui/shared.jsx';

export const formatMegabytes = (bytes) => `${(bytes / 1_048_576).toFixed(1)} MB`;

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Backup and restore. On desktop, Android and an iOS Safari tab a normal
 * download works, so saving is one tap. In an app launched from an iPhone's
 * home screen a blob download is widely reported to fail, so saving goes
 * through the share sheet instead — in two taps, because Safari only lets
 * share() start straight from a tap, and building a backup is too slow to
 * await first: "Prepare" builds the file, "Save" opens the sheet.
 */
export function BackupCard({ exportBackup, onRestore, onToast, dataKey }) {
  const useShareSheet = useMemo(() => isIosStandalone() && canUseShareSheet(), []);
  const [prepared, setPrepared] = useState(null);
  const [isBusy, setIsBusy] = useState(false);
  const [lastBackup, setLastBackup] = useState(getLastBackupAt);

  // Clearing, restoring or editing the wardrobe makes a prepared file stale.
  useEffect(() => { setPrepared(null); }, [dataKey]);

  const build = async () => {
    if (!exportBackup) throw new Error('Backups are not available here.');
    return exportBackup();
  };

  const downloadBackup = async () => {
    setIsBusy(true);
    try {
      const { blob, fileName, counts } = await build();
      downloadBlob(blob, fileName);
      setLastBackupAt();
      setLastBackup(Date.now());
      onToast(`Backup saved: ${describeCounts(counts)} (${formatMegabytes(blob.size)}).`);
    } catch (error) {
      onToast(error?.message || 'The backup could not be made.');
    } finally {
      setIsBusy(false);
    }
  };

  const prepareBackup = async () => {
    setIsBusy(true);
    try {
      const { blob, fileName, counts } = await build();
      setPrepared({ blob, fileName, counts, shareable: pickShareableFile(shareCandidates(blob, fileName)) });
    } catch (error) {
      onToast(error?.message || 'The backup could not be made.');
    } finally {
      setIsBusy(false);
    }
  };

  // Deliberately not async, with nothing awaited before it: share() has to
  // start inside the tap itself or Safari refuses it.
  const saveBackup = () => {
    if (!prepared?.shareable) return;
    const { counts } = prepared;
    shareFile(prepared.shareable)
      .then((outcome) => {
        if (outcome === 'shared') {
          setLastBackupAt();
          setLastBackup(Date.now());
        }
        onToast(outcome === 'shared'
          ? `Backup sent to the share sheet: ${describeCounts(counts)}.`
          : 'Cancelled. Your backup is still ready if you want to save it.');
      })
      .catch((error) => {
        onToast(`The share sheet would not open (${error?.name || 'error'}). Tap Save backup again.`);
      });
  };

  return (
    <section className="settings-card" id="backup">
      <div className="settings-card-heading"><span className="settings-icon" aria-hidden="true"><Archive /></span><div><h2>Backup</h2><p>Your wardrobe lives only in this browser. Save a backup file now and then, and restore it here or on another device. Keys are never included.</p><p className={`backup-age ${!lastBackup || Date.now() - lastBackup > 30 * 86_400_000 ? 'is-stale' : ''}`}>{lastBackup ? `Last backup: ${daysAgo(lastBackup)}.` : 'No backup saved from this device yet.'}</p></div></div>
      <div className="backup-actions">
        {!useShareSheet && (
          <button className="secondary-button" type="button" disabled={isBusy} onClick={downloadBackup}>{isBusy ? 'Preparing…' : 'Download backup'}</button>
        )}
        {useShareSheet && !prepared && (
          <button className="secondary-button" type="button" disabled={isBusy} onClick={prepareBackup}>{isBusy ? 'Preparing…' : 'Prepare backup'}</button>
        )}
        {useShareSheet && prepared?.shareable && (
          <button className="primary-button" type="button" onClick={saveBackup}>Save backup ({formatMegabytes(prepared.blob.size)})</button>
        )}
        {useShareSheet && prepared && !prepared.shareable && (
          <button className="secondary-button" type="button" onClick={() => downloadBlob(prepared.blob, prepared.fileName)}>Try a direct download</button>
        )}
        <label className="secondary-button">
          Restore from a backup
          <input className="visually-hidden" type="file" accept="application/json,.json,text/plain,.txt" onChange={(event) => { onRestore(event.target.files?.[0]); event.target.value = ''; }} />
        </label>
      </div>
      {useShareSheet && !prepared && (
        <p className="field-hint">In the home-screen app, saving takes two taps: Prepare builds the file, then Save opens the share sheet. Choose Save to Files.</p>
      )}
      {useShareSheet && prepared?.shareable && (
        <p className="field-hint">{describeCounts(prepared.counts)}. Tap Save, then choose Save to Files.</p>
      )}
      {useShareSheet && prepared && !prepared.shareable && (
        <p className="inline-note">This phone would not offer the share sheet for a backup file. A direct download may still work; if the app jumps to a page of text, close and reopen it — nothing is lost.</p>
      )}
    </section>
  );
}

/**
 * Live weather is off until switched on here. A typed city never touches the
 * device's location; "use my location" rounds it to about 10 km first.
 */
export function WeatherCard({ location, onChange, onToast }) {
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState([]);
  const [isBusy, setIsBusy] = useState(false);
  const forecast = useForecast(location);
  const today = forecast.days?.find((day) => day.date === localDate()) || null;

  const choose = (place) => {
    onChange(place);
    setPlaces([]);
    setQuery('');
    onToast(`Live weather on for ${place.name}.`);
  };

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

  const useDevice = async () => {
    setIsBusy(true);
    try {
      choose(await currentRoundedPosition());
    } catch (error) {
      onToast(error.message);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <section className="settings-card">
      <div className="settings-card-heading"><span className="settings-icon" aria-hidden="true"><CloudSun /></span><div><h2>Live weather</h2><p>Fills in the weather on the Today screen, and plans your week around the forecast.</p></div></div>
      {location ? (
        <>
          <p className="forecast-line"><strong>{location.name}</strong>{today ? ` · today ${describeDay(today)}` : forecast.error ? ` · ${forecast.error}` : ''}</p>
          <button className="secondary-button full-width" type="button" onClick={() => { onChange(null); onToast('Live weather off.'); }}>Turn off live weather</button>
        </>
      ) : (
        <>
          <form className="place-search" onSubmit={search}>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Your city" aria-label="City for live weather" />
            <button className="secondary-button compact" type="submit" disabled={isBusy || query.trim().length < 2}>Find</button>
          </form>
          {places.length > 0 && (
            <div className="place-results">
              {places.map((place) => <button key={`${place.latitude},${place.longitude}`} className="place-option" type="button" onClick={() => choose(place)}>{place.name}</button>)}
            </div>
          )}
          <button className="text-button" type="button" disabled={isBusy} onClick={useDevice}>Or use my location (rounded to about 10 km)</button>
        </>
      )}
      <p className="privacy-note"><span aria-hidden="true"><Lock /></span>Forecasts come from Open-Meteo, free and with no account. Only the rounded place is sent, never your wardrobe.</p>
    </section>
  );
}

export function SettingsView({ onClear, exportBackup, onRestore, onToast, dataKey, weatherLocation, onWeatherLocationChange }) {
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
          <span className="settings-icon" aria-hidden="true"><Sparkles /></span>
          <div><h2>AI providers</h2><p>Add any OpenAI-compatible API. Used only to tag photos and make outfit suggestions.</p></div>
        </div>

        {!providers.some((item) => item.presetId === BUILTIN_PRESET_ID) && (
          <BuiltInAiSetup
            onConnected={(passcode) => {
              const preset = getPreset(BUILTIN_PRESET_ID);
              const entry = addProvider({ ...preset, presetId: preset.id, apiKey: passcode });
              setActiveProviderId(entry.id);
              refresh();
              onToast('Built-in AI connected.');
            }}
          />
        )}

        {providers.length === 0 && (
          <p className="inline-note">Or bring your own key: add any provider below. Everything else in the app works without AI.</p>
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
                      <ProviderUsage provider={item} />
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
          <button className="secondary-button full-width" type="button" onClick={() => setOpenFormId('new')}><Plus className="inline-icon" aria-hidden="true" /> Add a provider</button>
        )}

        <p className="privacy-note"><span aria-hidden="true"><Lock /></span>Each provider's key is saved locally on this device and is sent only to that provider, and only when you use a feature that needs it.</p>
      </section>

      <WeatherCard location={weatherLocation} onChange={onWeatherLocationChange} onToast={onToast} />

      <section className="settings-card">
        <div className="settings-card-heading"><span className="settings-icon" aria-hidden="true"><History /></span><div><h2>Repeat protection</h2><p>Deprioritise pieces you wore recently.</p></div></div>
        <div className="range-setting">
          <label htmlFor="repeat-days">Avoid repeats for <strong>{repeatDays} days</strong></label>
          <input id="repeat-days" type="range" min="0" max={MAX_REPEAT_DAYS} step="1" value={repeatDays} onChange={(event) => changeRepeatDays(Number(event.target.value))} />
          <div><span>Off</span><span>3 weeks</span></div>
        </div>
      </section>

      <BackupCard exportBackup={exportBackup} onRestore={onRestore} onToast={onToast} dataKey={dataKey} />

      <section className="danger-zone"><p className="eyebrow">DEVICE DATA</p><h2>Start fresh</h2><p>This permanently removes every saved photo and wardrobe item from this browser. Your providers and keys are left alone.</p><button className="danger-button" type="button" onClick={onClear}>Clear wardrobe data</button></section>
    </section>
  );
}

/**
 * One-field setup for the built-in AI: the site holds the Gemini key, so all
 * this asks for is the passcode, and it checks it with a real request before
 * saving so a typo is caught here rather than on the first photo.
 */
export function BuiltInAiSetup({ onConnected }) {
  const [passcode, setPasscode] = useState('');
  const [status, setStatus] = useState(null);
  const [isChecking, setIsChecking] = useState(false);

  const connect = async (event) => {
    event.preventDefault();
    const value = passcode.trim();
    if (!value) return;
    setIsChecking(true);
    setStatus(null);
    try {
      const preset = getPreset(BUILTIN_PRESET_ID);
      const result = await testProvider({ ...preset, id: 'builtin-draft', presetId: preset.id, apiKey: value });
      if (result.ok) {
        onConnected(value);
      } else {
        setStatus(result.message);
      }
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <form className="builtin-ai" onSubmit={connect}>
      <h3>Use the built-in AI</h3>
      <p>No API key needed. Enter this site's passcode once on each device.</p>
      <div className="builtin-ai-row">
        <input type="password" value={passcode} onChange={(event) => { setPasscode(event.target.value); setStatus(null); }} placeholder="Passcode" autoComplete="current-password" aria-label="Built-in AI passcode" />
        <button className="primary-button" type="submit" disabled={isChecking || !passcode.trim()}>{isChecking ? 'Checking…' : 'Connect'}</button>
      </div>
      {status && <p className="key-warning" role="alert">{status}</p>}
    </form>
  );
}

/**
 * Today's request count for a provider, and for Gemini (whose free tier was
 * seen capping this app's main model at 20 a day) an estimate of what's left
 * and when a used-up model resets. Requests are counted on this device only.
 */
export function ProviderUsage({ provider }) {
  const used = usageToday(provider);
  const until = exhaustedUntil(provider);
  const isGemini = ['gemini', BUILTIN_PRESET_ID].includes(provider.presetId);
  if (until) {
    const hours = Math.max(1, Math.round((until - Date.now()) / 3600_000));
    const hasBackup = provider.fallbackModel && provider.fallbackModel !== provider.model;
    const bothOut = !hasBackup || (isExhausted(provider, provider.model) && isExhausted(provider, provider.fallbackModel));
    return bothOut
      ? <small className="usage-line is-out">Free allowance used up · resets in about {hours}h</small>
      : <small className="usage-line is-out">One model is used up for today, so the other is answering · resets in about {hours}h</small>;
  }
  // Google doesn't publish fixed free limits (Flash-Lite's is reported in the
  // hundreds a day, Flash's at about 20), so this counts rather than guesses
  // what's left, and points at the real figures.
  if (!used) return isGemini ? <small className="usage-line">No AI requests yet today · your free limits are at ai.dev/rate-limit</small> : null;
  return (
    <small className="usage-line">
      {plural(used, 'AI request')} today{isGemini ? ' · your free limits are at ai.dev/rate-limit' : ''}
    </small>
  );
}

export const JSON_MODE_LABELS = {
  auto: 'auto-detect',
  schema: 'strict schema',
  tools: 'tool calling',
  object: 'JSON object',
  text: 'plain text',
};

/**
 * Add/edit form for one provider. Picking a preset refills every field, since
 * changing presets mid-edit is a deliberate reset, not a merge. "Test
 * connection" runs against the in-progress draft, before it is saved, so a
 * bad key or wrong base URL is caught before it becomes the active provider.
 */
export function ProviderForm({ mode, initial, onCancel, onSave, onToast }) {
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
  const mismatch = detectKeyMismatch(presetId, apiKey);
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
      {mismatch && (
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
              <option value="tools">Tool calling</option>
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
