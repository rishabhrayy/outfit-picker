import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACTIVE_PROVIDER_STORAGE_KEY,
  PROVIDERS_STORAGE_KEY,
  addProvider,
  deleteProvider,
  getActiveProvider,
  getActiveProviderId,
  getProviders,
  getRepeatDays,
  hasAnyProvider,
  setActiveProviderId,
  setRepeatDays,
  updateProvider,
} from '../src/lib/settings.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    dump: () => Object.fromEntries(data),
  };
}

function useStorage(initial) {
  const storage = memoryStorage(initial);
  vi.stubGlobal('localStorage', storage);
  return storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider list', () => {
  it('starts empty, with nothing active', () => {
    useStorage();
    expect(getProviders()).toEqual([]);
    expect(hasAnyProvider()).toBe(false);
    expect(getActiveProviderId()).toBe('');
    expect(getActiveProvider()).toBeNull();
  });

  it('fills a new provider from its preset and tidies what was typed', () => {
    useStorage();
    const entry = addProvider({
      presetId: 'groq',
      baseUrl: ' https://api.groq.com/openai/v1/// ',
      apiKey: '  gsk_x  ',
      model: 'm1',
    });

    expect(entry).toMatchObject({
      presetId: 'groq',
      label: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_x',
      model: 'm1',
      fallbackModel: 'm1', // no separate fallback typed, so it retries on the same model
      jsonMode: 'object',
      taggingMaxTokens: 3000,
      outfitMaxTokens: 1200,
    });
    expect(entry.id).toBeTruthy();
  });

  it('lets typed values override the preset', () => {
    useStorage();
    const entry = addProvider({
      presetId: 'openai',
      label: 'Work key',
      baseUrl: 'https://x.test/v1',
      apiKey: 'k',
      model: 'm',
      fallbackModel: 'big',
      jsonMode: 'tools',
      taggingMaxTokens: 4000,
      outfitMaxTokens: 900,
    });
    expect(entry).toMatchObject({ label: 'Work key', fallbackModel: 'big', jsonMode: 'tools', taggingMaxTokens: 4000, outfitMaxTokens: 900 });
  });

  it('makes only the first provider active automatically', () => {
    useStorage();
    const first = addProvider({ presetId: 'openai', baseUrl: 'https://a.test/v1', apiKey: 'k1', model: 'm' });
    const second = addProvider({ presetId: 'groq', baseUrl: 'https://b.test/v1', apiKey: 'k2', model: 'm' });

    expect(getActiveProviderId()).toBe(first.id);
    setActiveProviderId(second.id);
    expect(getActiveProvider().id).toBe(second.id);
  });

  it('updates a provider in place, keeping its id, and says so when it is gone', () => {
    useStorage();
    const entry = addProvider({ presetId: 'openai', baseUrl: 'https://a.test/v1', apiKey: 'k', model: 'm' });

    expect(updateProvider(entry.id, { model: 'better', id: 'sneaky' })).toMatchObject({ id: entry.id, model: 'better' });
    expect(getProviders()).toHaveLength(1);
    expect(updateProvider('nope', { model: 'x' })).toBeNull();
  });

  it('moves the active provider along when the active one is deleted', () => {
    useStorage();
    const first = addProvider({ presetId: 'openai', baseUrl: 'https://a.test/v1', apiKey: 'k1', model: 'm' });
    const second = addProvider({ presetId: 'groq', baseUrl: 'https://b.test/v1', apiKey: 'k2', model: 'm' });

    deleteProvider(first.id);
    expect(getActiveProviderId()).toBe(second.id);

    deleteProvider(second.id);
    expect(getActiveProviderId()).toBe('');
    expect(getActiveProvider()).toBeNull();
  });

  it('leaves the active provider alone when a different one is deleted', () => {
    useStorage();
    const first = addProvider({ presetId: 'openai', baseUrl: 'https://a.test/v1', apiKey: 'k1', model: 'm' });
    const second = addProvider({ presetId: 'groq', baseUrl: 'https://b.test/v1', apiKey: 'k2', model: 'm' });
    deleteProvider(second.id);
    expect(getActiveProviderId()).toBe(first.id);
  });

  it('ignores an active id that points at nothing', () => {
    const first = { id: 'real', presetId: 'openai', label: 'OpenAI', baseUrl: 'https://a.test/v1', apiKey: 'k', model: 'm' };
    useStorage({
      [PROVIDERS_STORAGE_KEY]: JSON.stringify([first]),
      [ACTIVE_PROVIDER_STORAGE_KEY]: 'ghost',
      'outfit-picker-providers-migrated': '1',
    });
    expect(getActiveProviderId()).toBe('real');
  });

  it('survives corrupt stored data instead of crashing the app', () => {
    useStorage({ [PROVIDERS_STORAGE_KEY]: 'not json at all', 'outfit-picker-providers-migrated': '1' });
    expect(getProviders()).toEqual([]);

    useStorage({ [PROVIDERS_STORAGE_KEY]: '{"a":1}', 'outfit-picker-providers-migrated': '1' });
    expect(getProviders()).toEqual([]);
  });
});

describe('moving from the old one-key-per-provider storage', () => {
  it('carries both saved keys across, keeps the one that was active, and cleans up after itself', () => {
    const storage = useStorage({
      'outfit-picker-openai-key': 'sk-old-openai',
      'outfit-picker-gemini-key': 'AIzaOldGemini',
      'outfit-picker-provider': 'gemini',
    });

    const providers = getProviders();
    expect(providers.map((provider) => [provider.label, provider.apiKey])).toEqual([
      ['OpenAI', 'sk-old-openai'],
      ['Google Gemini', 'AIzaOldGemini'],
    ]);
    expect(getActiveProvider().label).toBe('Google Gemini');

    const left = storage.dump();
    expect(left['outfit-picker-openai-key']).toBeUndefined();
    expect(left['outfit-picker-gemini-key']).toBeUndefined();
    expect(left['outfit-picker-provider']).toBeUndefined();
    expect(left['outfit-picker-providers-migrated']).toBe('1');
  });

  it('happens once: asking again does not duplicate anything', () => {
    useStorage({ 'outfit-picker-openai-key': 'sk-old' });
    expect(getProviders()).toHaveLength(1);
    expect(getProviders()).toHaveLength(1);
    expect(getActiveProviderId()).toBe(getProviders()[0].id);
  });

  it('does nothing when there was never an old key, but remembers it checked', () => {
    const storage = useStorage();
    expect(getProviders()).toEqual([]);
    expect(storage.dump()['outfit-picker-providers-migrated']).toBe('1');
  });

  it('adds to providers already saved rather than replacing them', () => {
    const existing = { id: 'mine', presetId: 'groq', label: 'Groq', baseUrl: 'https://b.test/v1', apiKey: 'k', model: 'm' };
    useStorage({
      [PROVIDERS_STORAGE_KEY]: JSON.stringify([existing]),
      'outfit-picker-openai-key': 'sk-old',
    });

    const providers = getProviders();
    expect(providers.map((provider) => provider.id)).toContain('mine');
    expect(providers).toHaveLength(2);
    expect(getActiveProviderId()).toBe('mine');
  });

  it('ignores old keys once the move is marked done', () => {
    useStorage({ 'outfit-picker-openai-key': 'sk-old', 'outfit-picker-providers-migrated': '1' });
    expect(getProviders()).toEqual([]);
  });
});

describe('repeat window', () => {
  it('defaults to a week when never set, rather than reading the blank as zero days', () => {
    useStorage();
    expect(getRepeatDays()).toBe(7);
  });

  it('reads a stored value, including a deliberate zero', () => {
    useStorage({ 'outfit-picker-repeat-days': '10' });
    expect(getRepeatDays()).toBe(10);
    useStorage({ 'outfit-picker-repeat-days': '0' });
    expect(getRepeatDays()).toBe(0);
  });

  it.each([['99', 21], ['-3', 7], ['abc', 7], ['', 7]])('turns a stored "%s" into %i', (stored, expected) => {
    useStorage({ 'outfit-picker-repeat-days': stored });
    expect(getRepeatDays()).toBe(expected);
  });

  it('clamps and rounds what it saves', () => {
    const storage = useStorage();
    expect(setRepeatDays(99)).toBe(true);
    expect(storage.dump()['outfit-picker-repeat-days']).toBe('21');
    setRepeatDays(-5);
    expect(storage.dump()['outfit-picker-repeat-days']).toBe('0');
    setRepeatDays(3.6);
    expect(storage.dump()['outfit-picker-repeat-days']).toBe('4');
    setRepeatDays('soon');
    expect(storage.dump()['outfit-picker-repeat-days']).toBe('7');
  });
});

describe('when the browser will not let the app use storage', () => {
  const blocked = () => vi.stubGlobal('localStorage', {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => { throw new Error('SecurityError'); },
  });

  it('reads as empty and reports a failed save instead of throwing', () => {
    blocked();
    expect(getProviders()).toEqual([]);
    expect(getRepeatDays()).toBe(7);
    expect(setRepeatDays(5)).toBe(false);
    expect(() => addProvider({ presetId: 'openai', baseUrl: 'https://a.test/v1', apiKey: 'k', model: 'm' })).not.toThrow();
  });
});

describe('moving saved providers off a retired default model', () => {
  it('upgrades a built-in provider still on the old default, and leaves a hand-set model alone', async () => {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    });
    store.set('outfit-picker-providers-migrated', '1');
    store.set('outfit-picker-providers', JSON.stringify([
      { id: 'a', presetId: 'builtin', model: 'gemini-3.6-flash', fallbackModel: 'gemini-3.8-flash' },
      { id: 'b', presetId: 'gemini', model: 'gemini-3.7-flash', fallbackModel: 'gemini-3.8-flash' },
      { id: 'c', presetId: 'openai', model: 'gpt-4o-mini', fallbackModel: 'gpt-4o' },
    ]));
    const { getProviders } = await import('../src/lib/settings.js');
    expect(getProviders().map((provider) => provider.model)).toEqual(['gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gpt-4o-mini']);
    expect(JSON.parse(store.get('outfit-picker-providers'))[0].model).toBe('gemini-3.5-flash-lite');
    vi.unstubAllGlobals();
  });
});
