/**
 * Local, single-device settings. Nothing here is ever sent anywhere except the
 * API key, which goes only to the selected provider when a feature needs it.
 */

import { DEFAULT_PROVIDER, PROVIDER_IDS, getProviderConfig } from './providers.js';

export const PROVIDER_STORAGE_KEY = 'outfit-picker-provider';
export const REPEAT_DAYS_STORAGE_KEY = 'outfit-picker-repeat-days';
export const DEFAULT_REPEAT_DAYS = 7;
export const MAX_REPEAT_DAYS = 21;

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

export function getProvider() {
  const stored = readStorage(PROVIDER_STORAGE_KEY).trim();
  return PROVIDER_IDS.includes(stored) ? stored : DEFAULT_PROVIDER;
}

export function setProvider(id) {
  const next = PROVIDER_IDS.includes(id) ? id : DEFAULT_PROVIDER;
  return writeStorage(PROVIDER_STORAGE_KEY, next);
}

/**
 * Keys are stored per provider, so switching back and forth does not mean
 * pasting a key in again each time.
 */
export function getApiKey(providerId = getProvider()) {
  return readStorage(getProviderConfig(providerId).storageKey).trim();
}

export function setApiKey(value, providerId = getProvider()) {
  return writeStorage(getProviderConfig(providerId).storageKey, String(value ?? '').trim());
}

export function hasApiKey(providerId = getProvider()) {
  return getApiKey(providerId).length > 0;
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
