/**
 * Local, single-device settings. Nothing here is ever sent anywhere except an
 * API key, which goes only to the provider it belongs to, and only when a
 * feature is actually used.
 */

import { getPreset } from './providers.js';

export const PROVIDERS_STORAGE_KEY = 'outfit-picker-providers';
export const ACTIVE_PROVIDER_STORAGE_KEY = 'outfit-picker-active-provider';
export const REPEAT_DAYS_STORAGE_KEY = 'outfit-picker-repeat-days';
export const DEFAULT_REPEAT_DAYS = 7;
export const MAX_REPEAT_DAYS = 21;

// Pre-list-of-providers storage keys. Only read once, by the migration below.
const LEGACY_PROVIDER_KEY = 'outfit-picker-provider';
const LEGACY_OPENAI_KEY = 'outfit-picker-openai-key';
const LEGACY_GEMINI_KEY = 'outfit-picker-gemini-key';
const LEGACY_MIGRATED_FLAG = 'outfit-picker-providers-migrated';

function readStorage(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? '';
  } catch {
    // Private-browsing modes and locked-down profiles can throw on access.
    return '';
  }
}

function writeStorage(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorage(key) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Nothing useful to do if storage is unavailable; the value will just
    // remain unused rather than actively read again.
  }
}

function uid() {
  return globalThis.crypto?.randomUUID?.() || `provider-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readList() {
  try {
    const raw = readStorage(PROVIDERS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Corrupt JSON should not crash the app; treat it as an empty list.
    return [];
  }
}

function writeList(list) {
  return writeStorage(PROVIDERS_STORAGE_KEY, JSON.stringify(list));
}

/**
 * Folds the old single-OpenAI/single-Gemini storage into the new provider
 * list, exactly once, so nobody's already-saved key goes missing under them
 * when the app updates.
 */
function migrateLegacyKeysIfNeeded() {
  if (readStorage(LEGACY_MIGRATED_FLAG) === '1') return;

  const openaiKey = readStorage(LEGACY_OPENAI_KEY).trim();
  const geminiKey = readStorage(LEGACY_GEMINI_KEY).trim();
  const legacyActive = readStorage(LEGACY_PROVIDER_KEY).trim();

  if (openaiKey || geminiKey) {
    const list = readList();
    let activeId = null;

    if (openaiKey) {
      const preset = getPreset('openai');
      const entry = presetToProvider(preset, openaiKey);
      list.push(entry);
      if (legacyActive === 'openai') activeId = entry.id;
    }
    if (geminiKey) {
      const preset = getPreset('gemini');
      const entry = presetToProvider(preset, geminiKey);
      list.push(entry);
      if (legacyActive === 'gemini') activeId = entry.id;
    }

    writeList(list);
    writeStorage(ACTIVE_PROVIDER_STORAGE_KEY, activeId || list[0].id);
  }

  writeStorage(LEGACY_MIGRATED_FLAG, '1');
  removeStorage(LEGACY_OPENAI_KEY);
  removeStorage(LEGACY_GEMINI_KEY);
  removeStorage(LEGACY_PROVIDER_KEY);
}

function presetToProvider(preset, apiKey = '') {
  return {
    id: uid(),
    presetId: preset.id,
    label: preset.label,
    baseUrl: preset.baseUrl,
    apiKey,
    model: preset.model,
    fallbackModel: preset.fallbackModel,
    jsonMode: preset.jsonMode,
    taggingMaxTokens: preset.taggingMaxTokens,
    outfitMaxTokens: preset.outfitMaxTokens,
  };
}

/**
 * Returns every provider the user has configured, migrating legacy single-key
 * storage in on first call.
 */
export function getProviders() {
  migrateLegacyKeysIfNeeded();
  return readList();
}

export function getProviderById(id) {
  return getProviders().find((provider) => provider.id === id) || null;
}

/**
 * Adds a provider from form input. Returns the saved record (with its id).
 */
export function addProvider({ presetId, label, baseUrl, apiKey, model, fallbackModel, jsonMode, taggingMaxTokens, outfitMaxTokens }) {
  const preset = getPreset(presetId || 'custom');
  const entry = {
    id: uid(),
    presetId: preset.id,
    label: (label || preset.label || 'Provider').trim(),
    baseUrl: (baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: (apiKey || '').trim(),
    model: (model || '').trim(),
    fallbackModel: (fallbackModel || model || '').trim(),
    jsonMode: jsonMode || preset.jsonMode || 'auto',
    taggingMaxTokens: Number(taggingMaxTokens) || preset.taggingMaxTokens || 1500,
    outfitMaxTokens: Number(outfitMaxTokens) || preset.outfitMaxTokens || 800,
  };

  const list = getProviders();
  list.push(entry);
  writeList(list);

  // The first provider added becomes active automatically — otherwise nothing
  // works until the user separately remembers to select it.
  if (list.length === 1) setActiveProviderId(entry.id);

  return entry;
}

export function updateProvider(id, changes) {
  const list = getProviders();
  const index = list.findIndex((provider) => provider.id === id);
  if (index === -1) return null;

  const updated = { ...list[index], ...changes, id };
  list[index] = updated;
  writeList(list);
  return updated;
}

export function deleteProvider(id) {
  const list = getProviders().filter((provider) => provider.id !== id);
  writeList(list);

  if (getActiveProviderId() === id) {
    writeStorage(ACTIVE_PROVIDER_STORAGE_KEY, list[0]?.id || '');
  }
}

export function getActiveProviderId() {
  migrateLegacyKeysIfNeeded();
  const stored = readStorage(ACTIVE_PROVIDER_STORAGE_KEY).trim();
  const list = readList();
  if (stored && list.some((provider) => provider.id === stored)) return stored;
  return list[0]?.id || '';
}

export function setActiveProviderId(id) {
  return writeStorage(ACTIVE_PROVIDER_STORAGE_KEY, id || '');
}

export function getActiveProvider() {
  const id = getActiveProviderId();
  return id ? getProviderById(id) : null;
}

export function hasAnyProvider() {
  return getProviders().length > 0;
}

export function getRepeatDays() {
  // An unset key reads as '', and Number('') is 0, which would silently turn
  // repeat protection off instead of using the default.
  const raw = readStorage(REPEAT_DAYS_STORAGE_KEY).trim();
  if (!raw) return DEFAULT_REPEAT_DAYS;

  const stored = Number(raw);
  if (!Number.isFinite(stored) || stored < 0) return DEFAULT_REPEAT_DAYS;
  return Math.min(MAX_REPEAT_DAYS, Math.round(stored));
}

export function setRepeatDays(value) {
  const days = Number(value);
  const safe = Number.isFinite(days) ? Math.min(MAX_REPEAT_DAYS, Math.max(0, Math.round(days))) : DEFAULT_REPEAT_DAYS;
  return writeStorage(REPEAT_DAYS_STORAGE_KEY, String(safe));
}
