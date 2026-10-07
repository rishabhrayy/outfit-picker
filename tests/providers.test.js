import { describe, expect, it } from 'vitest';

import { detectKeyMismatch, detectPresetFromKey, getPreset, PROVIDER_PRESETS } from '../src/lib/providers.js';

describe('provider presets', () => {
  it('every preset has an https base URL, except the custom slot', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id !== 'custom') expect(preset.baseUrl).toMatch(/^https:\/\//);
    }
  });

  it('unknown ids fall back to custom', () => {
    expect(getPreset('nope').id).toBe('custom');
  });

  it('the longest matching key prefix wins, since OpenRouter keys also start with sk-', () => {
    expect(detectPresetFromKey('sk-or-v1-abc')).toBe('openrouter');
    expect(detectPresetFromKey('sk-ant-abc')).toBe('anthropic');
    expect(detectPresetFromKey('   ')).toBeNull();
  });

  it('every preset pins a JSON mode the app knows how to ask for', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(['auto', 'schema', 'tools', 'object', 'text']).toContain(preset.jsonMode);
    }
  });

  it('every preset leaves generous room for a reply, since a cut-off reply is unusable', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.taggingMaxTokens).toBeGreaterThanOrEqual(3000);
      expect(preset.outfitMaxTokens).toBeGreaterThanOrEqual(1200);
    }
  });
});

describe('detectKeyMismatch', () => {
  it('flags a key that clearly belongs to a different provider', () => {
    expect(detectKeyMismatch('openai', 'gsk_abc123')).toBe('groq');
    expect(detectKeyMismatch('mistral', 'gsk_abc123')).toBe('groq');
    expect(detectKeyMismatch('gemini', 'xai-abc123')).toBe('xai');
  });

  it('flags a more specific prefix inside a shared one, such as an Anthropic or OpenRouter key in an OpenAI slot', () => {
    expect(detectKeyMismatch('openai', 'sk-ant-abc')).toBe('anthropic');
    expect(detectKeyMismatch('openai', 'sk-or-v1-abc')).toBe('openrouter');
    expect(detectKeyMismatch('deepseek', 'sk-ant-abc')).toBe('anthropic');
  });

  it('stays quiet when the key fits the provider it was pasted into', () => {
    expect(detectKeyMismatch('anthropic', 'sk-ant-abc')).toBeNull();
    expect(detectKeyMismatch('openrouter', 'sk-or-v1-abc')).toBeNull();
    expect(detectKeyMismatch('openai', 'sk-proj-abc')).toBeNull();
    expect(detectKeyMismatch('gemini', 'AIzaSyAbc')).toBeNull();
    expect(detectKeyMismatch('groq', 'gsk_abc')).toBeNull();
  });

  it('stays quiet when two providers share a prefix, because that proves nothing either way', () => {
    // DeepSeek and OpenAI keys both start "sk-"; this is a valid DeepSeek-shaped key.
    expect(detectKeyMismatch('deepseek', 'sk-abc123')).toBeNull();
    expect(detectKeyMismatch('openai', 'sk-abc123')).toBeNull();
  });

  it('never second-guesses a Custom provider, or one with no preset at all', () => {
    expect(detectKeyMismatch('custom', 'sk-ant-abc')).toBeNull();
    expect(detectKeyMismatch('custom', 'gsk_abc')).toBeNull();
    expect(detectKeyMismatch(undefined, 'gsk_abc')).toBeNull();
  });

  it('says nothing for an empty key or one with no recognisable prefix', () => {
    expect(detectKeyMismatch('openai', '')).toBeNull();
    expect(detectKeyMismatch('openai', '   ')).toBeNull();
    expect(detectKeyMismatch('openai', 'abcdef123456')).toBeNull();
  });
});
