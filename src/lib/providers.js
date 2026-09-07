/**
 * Presets for the "add a provider" form in Settings.
 *
 * These are NOT the runtime provider config any more — the app supports an
 * arbitrary list of user-added providers, stored by lib/settings.js. A preset
 * only prefills the add-provider form (base URL, model, token budgets) for
 * nine providers known to publish an OpenAI-compatible chat/completions
 * endpoint. Picking "Custom" in that form leaves every field blank instead.
 *
 * Every preset here was checked from the deployed origin: a POST with a
 * deliberately invalid key returned a JSON error body rather than a CORS
 * failure, which is what makes a browser-only app viable against it at all.
 * Cerebras was tested and excluded — it blocks the browser outright.
 * Anthropic needed one extra header to pass that same check — see
 * ANTHROPIC_BROWSER_HOST in lib/ai.js.
 */

export const DEFAULT_PRESET_ID = 'openai';

export const PROVIDER_PRESETS = Object.freeze([
  Object.freeze({
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    article: 'an',
    // Anthropic's OpenAI-compatible endpoint. Calling it from a browser needs
    // one extra header beyond the usual Bearer key — lib/ai.js adds it
    // automatically for any base URL on this host, matching Anthropic's own
    // documented opt-in for bring-your-own-key client-side apps.
    baseUrl: 'https://api.anthropic.com/v1',
    // Fast and inexpensive, with vision support — a sensible default for a
    // wardrobe-photo-tagging workload. Escalates to a stronger model on
    // failure, the same shape as every other preset here.
    model: 'claude-haiku-4-5-20251001',
    fallbackModel: 'claude-sonnet-5',
    taggingMaxTokens: 1200,
    outfitMaxTokens: 800,
    keyPlaceholder: 'sk-ant-…',
    keyHost: 'platform.claude.com/settings/keys',
    keyPrefixes: ['sk-ant-'],
    // response_format is silently ignored on this endpoint — schema/object
    // modes would look configured but never actually constrain anything.
    // Forced tool-calling is what Anthropic's docs list as fully supported.
    jsonMode: 'tools',
  }),
  Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    article: 'an',
    baseUrl: 'https://api.openai.com/v1',
    // The smaller model tags first; the larger one gets a retry when it fails.
    model: 'gpt-4o-mini',
    fallbackModel: 'gpt-4o',
    taggingMaxTokens: 1200,
    outfitMaxTokens: 500,
    keyPlaceholder: 'sk-…',
    keyHost: 'platform.openai.com/api-keys',
    keyPrefixes: ['sk-'],
    jsonMode: 'schema',
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Google Gemini',
    article: 'a',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Google's pro tier answers 429 on a standard key, so the escalation here is
    // to a newer flash model rather than to a larger one.
    model: 'gemini-3.6-flash',
    fallbackModel: 'gemini-3.8-flash',
    // Gemini 3.x reasons before it answers, and that reasoning is charged
    // against max_tokens. Too small a budget returns an empty message with
    // finish_reason "length", so these are deliberately generous.
    taggingMaxTokens: 4000,
    outfitMaxTokens: 2000,
    keyPlaceholder: 'AIza… or AQ.…',
    keyHost: 'aistudio.google.com/apikey',
    keyPrefixes: ['AIza', 'AQ.'],
    jsonMode: 'schema',
  }),
  Object.freeze({
    id: 'groq',
    label: 'Groq',
    article: 'a',
    baseUrl: 'https://api.groq.com/openai/v1',
    // Groq's strict json_schema support is documented only for its text-only
    // models (GPT-OSS, Qwen), not its vision models, so this starts in the
    // looser json_object mode rather than probing schema first and failing.
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    fallbackModel: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    taggingMaxTokens: 1200,
    outfitMaxTokens: 800,
    keyPlaceholder: 'gsk_…',
    keyHost: 'console.groq.com/keys',
    keyPrefixes: ['gsk_'],
    jsonMode: 'object',
  }),
  Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    article: 'an',
    baseUrl: 'https://openrouter.ai/api/v1',
    // openrouter/free auto-routes to whichever free backend is up, and has
    // confirmed vision + structured-output support.
    model: 'openrouter/free',
    fallbackModel: 'openrouter/free',
    taggingMaxTokens: 1500,
    outfitMaxTokens: 800,
    keyPlaceholder: 'sk-or-v1-…',
    keyHost: 'openrouter.ai/keys',
    keyPrefixes: ['sk-or-'],
    jsonMode: 'schema',
  }),
  Object.freeze({
    id: 'mistral',
    label: 'Mistral',
    article: 'a',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'pixtral-12b-2409',
    fallbackModel: 'pixtral-large-latest',
    taggingMaxTokens: 1200,
    outfitMaxTokens: 800,
    keyPlaceholder: 'paste your Mistral API key',
    keyHost: 'console.mistral.ai/api-keys',
    keyPrefixes: [],
    jsonMode: 'object',
  }),
  Object.freeze({
    id: 'together',
    label: 'Together AI',
    article: 'a',
    baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
    fallbackModel: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
    taggingMaxTokens: 1200,
    outfitMaxTokens: 800,
    keyPlaceholder: 'paste your Together API key',
    keyHost: 'api.together.ai/settings/api-keys',
    keyPrefixes: [],
    jsonMode: 'object',
  }),
  Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek',
    article: 'a',
    baseUrl: 'https://api.deepseek.com',
    // DeepSeek has no vision model on this endpoint at the time of writing —
    // tagging will fail there even though outfit suggestions work fine.
    model: 'deepseek-chat',
    fallbackModel: 'deepseek-chat',
    taggingMaxTokens: 1200,
    outfitMaxTokens: 800,
    keyPlaceholder: 'sk-…',
    keyHost: 'platform.deepseek.com/api_keys',
    keyPrefixes: ['sk-'],
    jsonMode: 'object',
  }),
  Object.freeze({
    id: 'xai',
    label: 'xAI (Grok)',
    article: 'an',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4-fast',
    fallbackModel: 'grok-4',
    taggingMaxTokens: 1200,
    outfitMaxTokens: 800,
    keyPlaceholder: 'xai-…',
    keyHost: 'console.x.ai',
    keyPrefixes: ['xai-'],
    jsonMode: 'schema',
  }),
  Object.freeze({
    id: 'custom',
    label: 'Custom',
    article: 'a',
    baseUrl: '',
    model: '',
    fallbackModel: '',
    taggingMaxTokens: 1500,
    outfitMaxTokens: 800,
    keyPlaceholder: 'paste your API key',
    keyHost: '',
    keyPrefixes: [],
    jsonMode: 'auto',
  }),
]);

export function getPreset(id) {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) || PROVIDER_PRESETS.find((preset) => preset.id === 'custom');
}

/**
 * Guesses which preset a pasted key belongs to, purely to warn when a key's
 * shape clearly doesn't match the provider currently selected in the form.
 * Custom providers and prefix-less providers (Mistral, Together) return null
 * and are simply never second-guessed.
 */
export function detectPresetFromKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return null;

  // OpenRouter keys ("sk-or-…") also satisfy OpenAI's plain "sk-" prefix, so
  // the longest matching prefix wins rather than the first preset in the list.
  let best = null;
  let bestLength = 0;
  for (const preset of PROVIDER_PRESETS) {
    for (const prefix of preset.keyPrefixes) {
      if (trimmed.startsWith(prefix) && prefix.length > bestLength) {
        best = preset.id;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}
