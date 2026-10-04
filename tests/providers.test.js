import { describe, expect, it } from 'vitest';

import { detectPresetFromKey, getPreset, PROVIDER_PRESETS } from '../src/lib/providers.js';

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
});
