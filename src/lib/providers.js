/**
 * The two AI providers this app can talk to.
 *
 * Google publishes an OpenAI-compatible endpoint, so both providers take the
 * same request shape: a Bearer key, chat completions, `image_url` parts holding
 * a base64 data URL, and `response_format: json_schema` for structured output.
 * Only the base URL, the model names, and the token budgets differ.
 *
 * Both were checked from a browser: each returns permissive CORS headers, which
 * is what makes a no-backend app possible at all.
 */

export const PROVIDER_IDS = Object.freeze(['openai', 'gemini']);
export const DEFAULT_PROVIDER = 'openai';

export const PROVIDERS = Object.freeze({
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    article: 'an',
    baseUrl: 'https://api.openai.com/v1',
    // The smaller model tags first; the larger one gets a retry when it fails.
    primaryModel: 'gpt-4o-mini',
    fallbackModel: 'gpt-4o',
    taggingMaxTokens: 1200,
    outfitMaxTokens: 500,
    storageKey: 'outfit-picker-openai-key',
    keyPlaceholder: 'sk-…',
    keyHost: 'platform.openai.com/api-keys',
    keyPrefixes: ['sk-'],
  }),
  gemini: Object.freeze({
    id: 'gemini',
    label: 'Google Gemini',
    article: 'a',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Google's pro tier answers 429 on a standard key, so the escalation here is
    // to a newer flash model rather than to a larger one.
    primaryModel: 'gemini-3.6-flash',
    fallbackModel: 'gemini-3.8-flash',
    // Gemini 3.x reasons before it answers, and that reasoning is charged
    // against max_tokens. Too small a budget returns an empty message with
    // finish_reason "length", so these are deliberately generous.
    taggingMaxTokens: 4000,
    outfitMaxTokens: 2000,
    storageKey: 'outfit-picker-gemini-key',
    keyPlaceholder: 'AIza… or AQ.…',
    keyHost: 'aistudio.google.com/apikey',
    keyPrefixes: ['AIza', 'AQ.'],
  }),
});

export function getProviderConfig(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}

/**
 * Guesses which provider a key belongs to, or null when the shape says nothing.
 *
 * Pasting one provider's key into the other is the single most likely setup
 * mistake, and the raw 401 that follows blames the key rather than the mismatch.
 */
export function detectProvider(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return null;

  const match = PROVIDER_IDS.find((id) => PROVIDERS[id].keyPrefixes.some((prefix) => trimmed.startsWith(prefix)));
  return match || null;
}
