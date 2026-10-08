/**
 * Direct browser calls to whichever AI provider is active in Settings.
 * Nothing is proxied through a server, because this app has none.
 *
 * Providers vary in how they'll return structured JSON. Four tiers are tried,
 * in order, the first time a provider is used:
 *   1. schema — response_format: json_schema, strict. Best, not universal.
 *   2. tools  — a forced function/tool call whose parameters are the schema.
 *      Widely supported even where response_format is not (Anthropic's
 *      OpenAI-compatible endpoint silently ignores response_format entirely,
 *      but tool_choice-forced calls are a documented, fully supported path).
 *   3. object — response_format: json_object, with the shape spelled out in
 *      the prompt instead of enforced.
 *   4. text   — no response_format at all; the shape is only in the prompt,
 *      and the first balanced {...} in the reply is extracted by hand.
 * A provider set to "auto" starts at (1) and steps down on a 4xx that looks
 * like an unsupported-response-format error, or on a "tools" reply that came
 * back without a tool call at all. Once a tier works, the caller persists it
 * on the provider record, so later calls go straight there instead of
 * re-probing every time.
 *
 * Anthropic also needs one extra header for a browser to call it directly —
 * see ANTHROPIC_BROWSER_HOST below.
 */

import { BUILTIN_PRESET_ID, detectKeyMismatch, getPreset } from './providers.js';
import { normalizeDetectedItem } from '../types.js';
import { cropFromBox } from './crop.js';
import { prepareImage } from './image.js';

// Vision calls on a reasoning model routinely take 7-10s; this is the point at
// which the request is considered hung rather than slow.
const REQUEST_TIMEOUT_MS = 90_000;

// Anthropic's API refuses direct browser requests by default — this header is
// its documented, sanctioned opt-in specifically for bring-your-own-key
// client-side apps like this one (a webapp storing a user's own key and
// calling Anthropic directly, never proxied through a server). Matched on
// host, not a per-provider flag, so a hand-typed Custom provider pointed at
// the same host still works without the user needing to know this exists.
const ANTHROPIC_BROWSER_HOST = 'api.anthropic.com';

// Error bodies that are valid but carry nothing worth quoting back to a person.
const BLANK_BODIES = new Set(['', '{}', '[]', 'null']);

const CATEGORY_ENUM = ['top', 'bottom', 'dress', 'outerwear', 'shoes', 'accessory'];
const SEASON_ENUM = ['spring', 'summer', 'autumn', 'winter', 'all-season'];
const WEATHER_ENUM = ['cold', 'cool', 'mild', 'warm', 'hot', 'rainy', 'windy'];

// A 1x1 transparent PNG, used only to test whether a provider's model accepts
// an image at all — cheap on tokens either way the test comes out.
const TEST_PIXEL_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const TAGGING_SYSTEM_PROMPT = [
  'You are a wardrobe cataloguer working from one person’s own phone photos.',
  '',
  'These are casual, everyday pictures, not studio or flat-lay product shots. A photo may be a',
  'close-up of a single garment, a piece laid out on a bed or chair, or the wearer photographed',
  'in a mirror or by someone else in a full outfit. Expect ordinary rooms, uneven lighting,',
  'shadows, wrinkles, partial views and cropped limbs.',
  '',
  'Identify every distinct wearable item that clearly belongs to the outfit or is the subject of',
  'the photo, and return one object per item.',
  '',
  'Rules:',
  '- Ignore the background entirely. Furniture, walls, plants, bedding, other people, hangers,',
  '  packaging, phones and mirrors are not items.',
  '- A pair of shoes, socks or gloves is ONE item, even though there are two of them; its box',
  '  covers both. A phone held up to a mirror is never an item, not even an accessory.',
  '- Only list a garment you can actually see. Do not infer trousers that are out of frame.',
  '- Report each garment once. A two-piece set is two items; a dress is one item.',
  '- Use "dress" for dresses, jumpsuits and rompers, and "accessory" for bags, hats, scarves,',
  '  belts, jewellery, watches and glasses.',
  '- Skip anything too small, blurred or obscured to describe with confidence.',
  '- colors: one to three plain colour words as a person would say them (navy, cream, olive).',
  '- styleTags: two to four wearing occasions or aesthetics (casual, smart casual, formal,',
  '  sporty, streetwear, relaxed, minimal, party).',
  '- seasons and weather: use "all-season" when a piece genuinely works year round.',
  '- description: a short phrase naming the garment, such as "ribbed knit crew-neck jumper".',
  '- box: where the item is in the photo, as [yMin, xMin, yMax, xMax], each from 0 to 1000',
  '  (0,0 is the top-left corner). Make it tight around the visible part of that one item:',
  '  the jumper, not the whole person. In a mirror photo, box the item as it appears in the',
  '  mirror, once; never the phone, the mirror frame, or the same item seen twice.',
  '',
  'If the photo contains no wearable item at all, return an empty items array.',
].join('\n');

const TAGGING_SCHEMA = {
  name: 'wardrobe_items',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'One entry per distinct wearable item visible in the photo.',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: CATEGORY_ENUM },
            description: { type: 'string' },
            colors: { type: 'array', items: { type: 'string' } },
            styleTags: { type: 'array', items: { type: 'string' } },
            seasons: { type: 'array', items: { type: 'string', enum: SEASON_ENUM } },
            weather: { type: 'array', items: { type: 'string', enum: WEATHER_ENUM } },
            box: {
              type: 'array',
              description: 'Where the item is: [yMin, xMin, yMax, xMax], each 0-1000.',
              items: { type: 'integer' },
            },
          },
          required: ['category', 'description', 'colors', 'styleTags', 'seasons', 'weather', 'box'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

const OUTFIT_SCHEMA = {
  name: 'outfit_choice',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      itemIds: {
        type: 'array',
        description: 'Ids of the chosen items, in the order they should be shown.',
        items: { type: 'string' },
      },
      explanation: {
        type: 'string',
        description: 'Two or three sentences on why this outfit works.',
      },
    },
    required: ['itemIds', 'explanation'],
    additionalProperties: false,
  },
};

const OUTFIT_SYSTEM_PROMPT = [
  'You are a personal stylist choosing one outfit from a specific wardrobe.',
  '',
  'Choose exactly one complete outfit and return only ids from the wardrobe list. A complete',
  'outfit is either a top, a bottom and shoes, or a dress and shoes. Add outerwear when the',
  'weather calls for it, and at most two accessories when they genuinely improve the look.',
  '',
  'Never invent an id, and never name a garment that is not in the list. If the wardrobe cannot',
  'make a complete outfit, return the best partial set you can and say what is missing.',
  '',
  'The explanation is two or three warm, plain sentences addressed to the wearer about why this',
  'works for the occasion, weather and vibe. No bullet points and no headings.',
].join('\n');

function requireProvider(provider) {
  if (!provider) {
    throw new Error('Add an AI provider in Settings to use this feature.');
  }
  if (!provider.apiKey) {
    throw new Error(`Add an API key for ${provider.label} in Settings.`);
  }
  if (!provider.baseUrl) {
    throw new Error(`${provider.label} has no base URL set. Edit it in Settings.`);
  }
  if (!provider.model) {
    throw new Error(`${provider.label} has no model set. Edit it in Settings.`);
  }
  return provider;
}

/**
 * Both providers seen so far report errors as { error: { message } }, but
 * Google wraps that object in an array.
 */
function extractErrorMessage(body) {
  const payload = Array.isArray(body) ? body[0] : body;
  return payload?.error?.message || payload?.detail || payload?.message || '';
}

function isSchemaUnsupportedError(status, message) {
  if (![400, 404, 415, 422].includes(status)) return false;
  const lower = String(message || '').toLowerCase();
  return [
    'response_format',
    'json_schema',
    'not support',
    'unsupported',
    'invalid schema',
    'strict mode',
    'additionalproperties',
  ].some((term) => lower.includes(term));
}

/**
 * Turns a raw fetch/HTTP failure into the message shown in the UI.
 */
function toDisplayError(error, provider) {
  if (error?.name === 'AbortError') return error;
  if (error?.reason === 'length') {
    return new Error(`The reply from ${provider.label} was cut short before it finished. Try again.`);
  }
  if (error?.reason === 'refusal') {
    return new Error(error.message);
  }
  if (typeof error?.status === 'number') {
    const display = new Error(statusMessage(error.status, error.rawDetail ?? error.message, provider));
    // Kept so callers can tell a rejected key (no point retrying) from an
    // overloaded model (worth one try on the other model).
    display.status = error.status;
    display.dailyQuota = error.status === 429 && isDailyQuota(error.rawDetail ?? error.message);
    if (display.dailyQuota) display.retryAfterMs = retryAfterMs(error.rawDetail ?? error.message);
    return display;
  }
  if (error instanceof SyntaxError) {
    return new Error(`${provider.label} returned a reply this app could not read. Try again.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A free tier's daily allowance being used up (Gemini: 20 requests a day per
 * model on a free key, seen live) is not the same as a busy minute: waiting
 * and retrying won't help until it resets.
 */
function isDailyQuota(detail) {
  return /free_tier|per ?day|perday|quota exceeded for metric/i.test(String(detail || ''));
}

/** "Please retry in 12h26.5s" -> milliseconds, or 0 if it doesn't say. */
function retryAfterMs(detail) {
  const match = String(detail || '').match(/retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (!match || !(match[1] || match[2] || match[3])) return 0;
  return ((Number(match[1] || 0) * 60 + Number(match[2] || 0)) * 60 + Number(match[3] || 0)) * 1000;
}

/** Free-tier daily allowances reset at midnight Pacific time. */
export function nextPacificMidnight(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false, hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(now).map((part) => [part.type, Number(part.value)]));
  const elapsed = (((parts.hour % 24) * 60 + parts.minute) * 60 + parts.second) * 1000;
  return now.getTime() + (24 * 3600 * 1000 - elapsed);
}

// Models known to be out of today's allowance, by provider and model, with
// when they reset. Kept in localStorage so a reload doesn't start wasting
// calls again; unavailable storage just means no memory, never an error.
const EXHAUSTED_STORAGE_KEY = 'outfit-picker-ai-exhausted';

function exhaustionKey(provider, model) {
  return `${provider?.baseUrl || ''}|${model}`;
}

function readExhausted() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(EXHAUSTED_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeExhausted(map) {
  try {
    globalThis.localStorage?.setItem(EXHAUSTED_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // No storage: the app just won't remember, and will find out again by asking.
  }
}

export function markExhausted(provider, model, resetInMs = 0, now = Date.now()) {
  const map = readExhausted();
  map[exhaustionKey(provider, model)] = resetInMs > 0 ? now + resetInMs : nextPacificMidnight(new Date(now));
  writeExhausted(map);
}

export function isExhausted(provider, model, now = Date.now()) {
  const until = Number(readExhausted()[exhaustionKey(provider, model)]);
  return Number.isFinite(until) && until > now;
}

/** When the soonest of a provider's exhausted models resets, or 0. */
export function exhaustedUntil(provider, now = Date.now()) {
  const times = [provider?.model, provider?.fallbackModel].filter(Boolean)
    .map((model) => Number(readExhausted()[exhaustionKey(provider, model)]))
    .filter((until) => Number.isFinite(until) && until > now);
  return times.length ? Math.min(...times) : 0;
}

function exhaustedError(provider) {
  const until = exhaustedUntil(provider);
  const hours = until ? Math.max(1, Math.round((until - Date.now()) / 3600_000)) : 0;
  const error = new Error(`${provider.label} has used up today's free allowance${hours ? `; it resets in about ${hours} hour${hours === 1 ? '' : 's'}` : ''}. Adding billing to the key's Google project lifts the limit.`);
  error.status = 429;
  error.dailyQuota = true;
  return error;
}

// Requests sent today, per provider, so Settings can show how much of a free
// tier's daily allowance has gone. "Today" is the Pacific-time day, because
// that's when Google's free allowances reset.
const USAGE_STORAGE_KEY = 'outfit-picker-ai-usage';

export function pacificDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
}

function recordUsage(provider, now = new Date()) {
  try {
    const day = pacificDay(now);
    const stored = JSON.parse(globalThis.localStorage?.getItem(USAGE_STORAGE_KEY) || '{}');
    const counts = stored?.day === day ? stored.counts || {} : {};
    const key = provider?.id || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
    globalThis.localStorage?.setItem(USAGE_STORAGE_KEY, JSON.stringify({ day, counts }));
  } catch {
    // Counting is a nicety; never let it break a request.
  }
}

/** How many requests went to this provider today (Pacific time). */
export function usageToday(provider, now = new Date()) {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(USAGE_STORAGE_KEY) || '{}');
    return stored?.day === pacificDay(now) ? Number(stored.counts?.[provider?.id]) || 0 : 0;
  } catch {
    return 0;
  }
}

/** "Please retry in 12h26.5s" -> "about 12 hours", for a human. */
function resetsIn(detail) {
  const match = String(detail || '').match(/retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (!match) return '';
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  if (hours >= 1) return `about ${hours + (minutes >= 30 ? 1 : 0)} hour${hours === 1 && minutes < 30 ? '' : 's'}`;
  if (minutes >= 1) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  return 'a minute';
}

function statusMessage(status, detail, provider) {
  // The built-in route's "key" is a passcode, and its own 5xx messages are
  // setup instructions ("GEMINI_API_KEY is not set"), not a passing blip.
  if (provider.presetId === BUILTIN_PRESET_ID) {
    if (status === 401) return 'Wrong passcode for the built-in AI. Check it in Settings.';
    // Seen live, on both models at once: Gemini's free tier is sometimes just busy.
    if (status === 503 && /high demand|overloaded|unavailable/i.test(String(detail))) {
      return 'Google\'s AI is busy right now. Wait a minute and try again.';
    }
    if (status >= 500 && detail) return detail;
  }
  if (status === 401 || status === 403) {
    // Using one provider's key against another is the likeliest cause of a
    // rejected key, and a bare "key rejected" message sends people off
    // checking a perfectly good key instead of the provider selection.
    const mismatchedId = detectKeyMismatch(provider.presetId, provider.apiKey);
    if (mismatchedId) {
      const detected = getPreset(mismatchedId);
      return `That looks like ${detected.article} ${detected.label} key, but this provider is set up as ${provider.label}. Check the key in Settings.`;
    }
    // Beyond a plain mismatch, the actual cause varies (revoked key, wrong
    // scope, disabled API, wrong base URL entirely) — the provider's own
    // words are what makes a specific failure diagnosable instead of every
    // 401 looking identical.
    return detail
      ? `${provider.label} rejected that API key: ${detail}`
      : `${provider.label} rejected that API key. Check the key saved in Settings.`;
  }
  if (status === 429 && isDailyQuota(detail)) {
    const when = resetsIn(detail);
    return `${provider.label} has used up today's free allowance${when ? `; it resets in ${when}` : ' (it resets at midnight Pacific time)'}. Adding billing to the key's Google project lifts the limit.`;
  }
  if (status === 429) {
    // A free tier's per-minute rate limit and an exhausted balance both arrive
    // as 429 and both often mention "quota" — only claim a billing problem
    // when the provider's own text actually says so.
    const lower = String(detail || '').toLowerCase();
    const billing = ['billing', 'insufficient', 'credit', 'plan and billing', 'exceeded your current quota']
      .some((phrase) => lower.includes(phrase));
    return billing
      ? `Your ${provider.label} account is out of credit. Check its billing and usage. (${detail})`
      : `${provider.label} is rate-limiting these requests — free tiers cap requests per minute. Wait a minute and try again. (${detail})`;
  }
  if (status >= 500) {
    return `${provider.label} had a temporary problem. Try again in a moment.`;
  }
  return detail
    ? `${provider.label} error ${status}: ${detail}`
    : `${provider.label} returned an error (${status}).`;
}

/**
 * One HTTP round trip. Returns the assistant message's raw text content.
 * Throws an Error carrying .status and .rawDetail on an HTTP failure, or a
 * plain display-ready Error for network/timeout failures.
 */
async function requestOnce({ provider, body, signal }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort);
  // A listener never fires for a signal that was aborted before it was attached.
  if (signal?.aborted) forwardAbort();

  let response;
  try {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    };
    if (provider.baseUrl?.includes(ANTHROPIC_BROWSER_HOST)) {
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }

    response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(`${provider.label} did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds. Try again.`, { cause: error });
    }
    if (error?.name === 'AbortError') throw error;
    throw new Error(`Could not reach ${provider.label}. Check your internet connection, and that its base URL is correct.`, { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }

  recordUsage(provider);
  const rawText = await response.text();
  let parsedBody = null;
  try {
    parsedBody = rawText ? JSON.parse(rawText) : null;
  } catch {
    // A non-JSON body (an HTML error page, a plain-text 502) is handled below.
  }

  if (!response.ok) {
    // The raw body is the fallback for a plain-text or HTML error page. An empty
    // JSON object says nothing, and showing "{}" to someone is worse than the
    // generic message that takes its place.
    const detail = extractErrorMessage(parsedBody) || (BLANK_BODIES.has(rawText.trim()) ? '' : rawText.slice(0, 300));
    const error = new Error(detail || `HTTP ${response.status}`);
    error.status = response.status;
    error.rawDetail = detail;
    throw error;
  }

  const choice = parsedBody?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    const error = new Error('length');
    error.reason = 'length';
    throw error;
  }
  if (choice?.message?.refusal) {
    const error = new Error(choice.message.refusal);
    error.reason = 'refusal';
    throw error;
  }

  return {
    content: choice?.message?.content ?? '',
    toolArguments: choice?.message?.tool_calls?.[0]?.function?.arguments ?? null,
  };
}

/**
 * Appends the target JSON shape to the system message as plain instructions.
 * Used by the "object" and "text" tiers, where response_format cannot enforce
 * the shape by itself.
 */
function withJsonInstructions(messages, schemaWrapper) {
  const instruction = [
    '',
    '',
    'Respond with ONLY a single JSON object — no prose, no markdown code fences — matching',
    'exactly this shape:',
    JSON.stringify(schemaWrapper.schema, null, 2),
  ].join('\n');

  return messages.map((message, index) => (
    index === 0 && message.role === 'system' && typeof message.content === 'string'
      ? { ...message, content: message.content + instruction }
      : message
  ));
}

/**
 * Read from the preset rather than the saved provider record, so providers
 * added before this setting existed get it too.
 */
function reasoningEffortFor(provider) {
  return provider?.presetId ? getPreset(provider.presetId).reasoningEffort || '' : '';
}

function buildRequestBody(mode, model, messages, schemaWrapper, maxTokens, reasoningEffort = '') {
  const base = { model, temperature: 0.2, max_tokens: maxTokens };
  if (reasoningEffort) base.reasoning_effort = reasoningEffort;

  if (mode === 'schema') {
    return { ...base, messages, response_format: { type: 'json_schema', json_schema: schemaWrapper } };
  }

  if (mode === 'tools') {
    // A forced function call whose parameters ARE the schema. Supported far
    // more widely than response_format — notably, Anthropic's
    // OpenAI-compatible endpoint silently ignores response_format outright
    // but fully supports this.
    return {
      ...base,
      messages,
      tools: [{
        type: 'function',
        function: {
          name: schemaWrapper.name,
          description: `Return ${schemaWrapper.name.replace(/_/g, ' ')}.`,
          parameters: schemaWrapper.schema,
        },
      }],
      tool_choice: { type: 'function', function: { name: schemaWrapper.name } },
    };
  }

  const augmented = withJsonInstructions(messages, schemaWrapper);
  if (mode === 'object') {
    return { ...base, messages: augmented, response_format: { type: 'json_object' } };
  }

  // "text": no response_format field at all — the least this app can ask of a
  // provider and still get JSON back.
  return { ...base, messages: augmented };
}

/**
 * Finds and parses the first balanced {...} object in free-form text, after
 * stripping a single ```json fence if the whole reply is wrapped in one. This
 * is what makes the "text" tier usable against a provider that ignores
 * response_format entirely and just talks.
 */
function extractFirstJsonObject(text) {
  const raw = String(text || '');

  try {
    return JSON.parse(raw.trim());
  } catch {
    // Not a bare JSON reply — look for an object inside surrounding text.
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : raw;
  const start = source.indexOf('{');
  if (start === -1) {
    throw new SyntaxError('No JSON object was found in the reply.');
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(source.slice(start, i + 1));
      }
    }
  }

  throw new SyntaxError('The JSON object in the reply was never closed.');
}

/**
 * Requests one JSON object from the provider, trying capability tiers in
 * order for a provider set to "auto" and stopping at the first that works.
 * Returns { data, jsonMode } — jsonMode is what actually worked, so the
 * caller can persist it and skip the probe next time.
 */
async function callChatJson({ provider, model, messages, schema, maxTokens, signal }) {
  const pinned = provider.jsonMode && provider.jsonMode !== 'auto' ? provider.jsonMode : null;
  const modes = pinned ? [pinned] : ['schema', 'tools', 'object', 'text'];
  let lastError;

  for (let index = 0; index < modes.length; index += 1) {
    const mode = modes[index];
    const body = buildRequestBody(mode, model, messages, schema, maxTokens, reasoningEffortFor(provider));

    try {
      const { content, toolArguments } = await requestOnce({ provider, body, signal });

      if (mode === 'tools') {
        if (!toolArguments) {
          // The provider answered but ignored the forced tool_choice — not an
          // HTTP error, but just as unusable, so it steps down the same way.
          throw new SyntaxError('No tool call was returned.');
        }
        return { data: JSON.parse(toolArguments), jsonMode: mode };
      }

      const data = mode === 'schema' ? JSON.parse(content) : extractFirstJsonObject(content);
      return { data, jsonMode: mode };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      lastError = error;

      const canStepDown = !pinned && index < modes.length - 1;
      const worthStepping = isSchemaUnsupportedError(error.status, error.rawDetail ?? error.message)
        || error.status === 400
        || error instanceof SyntaxError;

      if (canStepDown && worthStepping) continue;
      throw toDisplayError(error, provider);
    }
  }

  throw toDisplayError(lastError, provider);
}

/**
 * Folds the model's season and weather words into the single "season / weather"
 * field that the review and edit forms present.
 */
function toReviewItem(raw) {
  const detected = normalizeDetectedItem({
    category: raw?.category,
    colors: raw?.colors,
    styleTags: raw?.styleTags,
    seasons: raw?.seasons,
    weatherSuitability: raw?.weather,
  });

  if (!detected) {
    return null;
  }

  return {
    category: detected.category,
    colors: detected.colors,
    styleTags: detected.styleTags,
    seasons: [...detected.seasons, ...detected.weatherSuitability],
    notes: typeof raw?.description === 'string' ? raw.description.trim().slice(0, 200) : '',
    // Each item from a multi-item photo starts cropped to just itself. A
    // missing or nonsense box leaves the full photo, which can still be
    // cropped by hand.
    crop: cropFromBox(raw?.box),
  };
}

// Things a model sometimes lists from a mirror photo that aren't clothes.
const NOT_CLOTHING = /\b(phone|smartphone|iphone|mobile|camera|mirror|hanger|case)\b/i;

/**
 * Cleans up two slips seen live from Gemini Flash-Lite on a mirror photo,
 * despite the prompt: the left and right shoe listed as two items, and the
 * phone listed as an accessory. Two shoe entries with the same colours and
 * description become one pair with a crop covering both.
 */
export function tidyDetectedItems(items) {
  const kept = items.filter((item) => !(item.category === 'accessory' && NOT_CLOTHING.test(item.notes || '')));
  const result = [];
  for (const item of kept) {
    const twin = item.category === 'shoes' && result.find((other) => other.category === 'shoes'
      && other.notes.toLowerCase() === item.notes.toLowerCase()
      && other.colors.join('|') === item.colors.join('|'));
    if (!twin) {
      result.push(item);
      continue;
    }
    if (twin.crop && item.crop) {
      const x = Math.min(twin.crop.x, item.crop.x);
      const y = Math.min(twin.crop.y, item.crop.y);
      twin.crop = {
        ...twin.crop,
        x,
        y,
        width: Math.max(twin.crop.x + twin.crop.width, item.crop.x + item.crop.width) - x,
        height: Math.max(twin.crop.y + twin.crop.height, item.crop.y + item.crop.height) - y,
      };
    }
  }
  return result;
}

/**
 * Sends one photo for tagging and returns { items, model, usedFallback, jsonMode }.
 *
 * An empty result is a valid answer (the photo held no clothing), but it is also
 * what a struggling model returns, so the stronger model gets one attempt before
 * that answer is accepted.
 */
export async function tagPhoto(file, { provider, signal } = {}) {
  requireProvider(provider);
  const { dataUrl } = await prepareImage(file);
  const messages = [
    { role: 'system', content: TAGGING_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Catalogue every wearable item in this photo.' },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      ],
    },
  ];

  const attempt = async (model) => {
    const { data, jsonMode } = await callChatJson({
      provider,
      model,
      messages,
      schema: TAGGING_SCHEMA,
      maxTokens: provider.taggingMaxTokens,
      signal,
    });
    const found = Array.isArray(data?.items) ? data.items : [];
    return { items: tidyDetectedItems(found.map(toReviewItem).filter(Boolean)), jsonMode };
  };

  // Same rules as every other call: a busy or broken model gets one try on the
  // backup, a rejected key or used-up allowance doesn't.
  let usedModel = provider.model;
  const primary = await withFallbackModel(provider, (model) => {
    usedModel = model;
    return attempt(model);
  });
  const answered = { items: primary.items, model: usedModel, usedFallback: usedModel !== provider.model, jsonMode: primary.jsonMode };

  // An empty answer is also what a struggling model gives, so a different
  // model gets one look. Not the same model twice, and not one that's out of
  // today's allowance: on a free tier those calls are wasted.
  const fallbackModel = provider.fallbackModel;
  const worthAnotherLook = !primary.items.length && fallbackModel && fallbackModel !== usedModel && !isExhausted(provider, fallbackModel);
  if (!worthAnotherLook) return answered;

  try {
    const second = await attempt(fallbackModel);
    return { items: second.items, model: fallbackModel, usedFallback: true, jsonMode: second.jsonMode };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (error?.dailyQuota) markExhausted(provider, fallbackModel, error.retryAfterMs);
    // The first answer stands: "nothing found" beats an error.
    return answered;
  }
}

/**
 * Runs `attempt` on the main model, then once on the fallback model if the
 * first failed. Gemini answers 503 "high demand" often enough (seen twice in
 * three live calls) that one overloaded model shouldn't end a request. Only an
 * error the provider actually answered with is retried: a rejected key or
 * passcode fails the same way on any model, and retrying a timeout or a lost
 * connection would just make someone wait twice as long to see it fail.
 */
async function withFallbackModel(provider, attempt) {
  const fallbackModel = provider.fallbackModel && provider.fallbackModel !== provider.model ? provider.fallbackModel : '';
  const tracked = (model) => attempt(model).catch((error) => {
    if (error?.dailyQuota) markExhausted(provider, model, error.retryAfterMs);
    throw error;
  });

  // A model already known to be out of today's allowance isn't asked again
  // until it resets: on a 20-a-day free tier, every wasted call counts.
  if (isExhausted(provider, provider.model)) {
    if (!fallbackModel || isExhausted(provider, fallbackModel)) throw exhaustedError(provider);
    return tracked(fallbackModel);
  }

  try {
    return await tracked(provider.model);
  } catch (error) {
    const retryable = typeof error?.status === 'number' && error.status !== 401 && error.status !== 403;
    if (!retryable || !fallbackModel) throw error;
    if (isExhausted(provider, fallbackModel)) throw error;
    try {
      return await tracked(fallbackModel);
    } catch (fallbackError) {
      // Main model out of today's allowance, backup busy: say both, since
      // "busy" alone sends people to retry a model that can't answer today.
      if (error.dailyQuota && !fallbackError.dailyQuota && typeof fallbackError.status === 'number') {
        const combined = new Error(`${error.message} The backup model is busy right now too, so try again in a few minutes.`);
        combined.status = fallbackError.status;
        throw combined;
      }
      throw fallbackError;
    }
  }
}

function describeCandidate(item) {
  const parts = [
    `id: ${item.id}`,
    `category: ${item.category}`,
    `colors: ${item.colors?.length ? item.colors.join(', ') : 'unspecified'}`,
    `style: ${item.styleTags?.length ? item.styleTags.join(', ') : 'unspecified'}`,
    `season/weather: ${item.seasons?.length ? item.seasons.join(', ') : 'unspecified'}`,
    `last worn: ${item.lastWornDate || 'never'}${item.recentlyWorn ? ' (RECENTLY WORN)' : ''}`,
  ];

  if (item.notes) {
    parts.push(`notes: ${item.notes}`);
  }

  return `- ${parts.join(' | ')}`;
}

/**
 * Picks one outfit from an already-filtered candidate list.
 *
 * Only structured text goes to the API here. The photos stay on the device.
 */
export async function suggestOutfit({
  candidates,
  preferences = {},
  excludedItemIds = [],
  avoidRecentDays = 7,
  today,
  feedback = {},
  provider,
  signal,
} = {}) {
  requireProvider(provider);

  if (!Array.isArray(candidates) || !candidates.length) {
    throw new Error('There are no matching pieces to build an outfit from.');
  }

  const wanted = preferences.wantedItemId
    ? candidates.find((item) => item.id === preferences.wantedItemId)
    : null;

  const known = new Set(candidates.map((item) => item.id));
  const blockedPairs = (feedback.blockedPairs || [])
    .filter(([a, b]) => known.has(a) && known.has(b));
  const lovedOutfits = (feedback.lovedOutfits || [])
    .map((ids) => ids.filter((id) => known.has(id)))
    .filter((ids) => ids.length > 1)
    .slice(0, 5);

  const request = [
    `Occasion: ${preferences.occasion || 'Everyday'}`,
    `Weather: ${preferences.weather || 'mild'}, around ${preferences.temperature ?? 20} degrees Celsius`,
    preferences.forecastNote || '',
    `Desired vibe: ${preferences.vibe || 'Easy'}`,
    today ? `Today: ${today}` : '',
    `Strongly prefer pieces not worn in the last ${avoidRecentDays} days.`,
    wanted
      ? `This item must be in the outfit: ${wanted.id} (${wanted.category}).`
      : 'No specific item was requested.',
    excludedItemIds.length
      ? `These ids were already suggested and must not be used again: ${excludedItemIds.join(', ')}`
      : '',
    blockedPairs.length
      ? `The wearer said never to suggest these pairings again. Never put both items of a pair in the outfit: ${blockedPairs.map(([a, b]) => `${a} with ${b}`).join('; ')}`
      : '',
    lovedOutfits.length
      ? `Outfits the wearer loved, as a guide to their taste (don't just repeat one): ${lovedOutfits.map((ids) => `[${ids.join(', ')}]`).join('; ')}`
      : '',
    '',
    'Wardrobe available right now:',
    candidates.map(describeCandidate).join('\n'),
  ]
    .filter(Boolean)
    .join('\n');

  const { data, jsonMode } = await withFallbackModel(provider, (model) => callChatJson({
    provider,
    model,
    maxTokens: provider.outfitMaxTokens,
    schema: OUTFIT_SCHEMA,
    signal,
    messages: [
      { role: 'system', content: OUTFIT_SYSTEM_PROMPT },
      { role: 'user', content: request },
    ],
  }));

  const itemIds = [...new Set(Array.isArray(data?.itemIds) ? data.itemIds : [])]
    .filter((id) => known.has(id));

  if (!itemIds.length) {
    throw new Error('No wearable combination came back. Try adjusting your answers.');
  }

  // Told not to, a model can still slip; a ruled-out pairing is never shown.
  const chosen = new Set(itemIds);
  if (blockedPairs.some(([a, b]) => chosen.has(a) && chosen.has(b))) {
    throw new Error('The AI picked a pairing you ruled out, so here is a pick without it.');
  }

  return {
    itemIds,
    explanation: String(data?.explanation || '').trim() || 'This combination is ready to wear.',
    jsonMode,
  };
}

const LOCATE_SCHEMA = {
  name: 'item_location',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      box: {
        type: 'array',
        description: 'Where the item is: [yMin, xMin, yMax, xMax], each 0-1000. Empty if not found.',
        items: { type: 'integer' },
      },
    },
    required: ['found', 'box'],
    additionalProperties: false,
  },
};

/**
 * Finds one already-catalogued garment in its source photo and returns a crop
 * for it, or null if it isn't there. For items saved before tagging returned
 * positions: a full-outfit photo's pieces all showed the whole photo.
 */
export async function locateItem(file, { provider, item, signal } = {}) {
  requireProvider(provider);
  const { dataUrl } = await prepareImage(file);
  const description = [
    item?.notes,
    item?.colors?.length ? `colours: ${item.colors.join(', ')}` : '',
    `category: ${item?.category || 'garment'}`,
  ].filter(Boolean).join('; ');

  const { data } = await withFallbackModel(provider, (model) => callChatJson({
    provider,
    model,
    maxTokens: provider.outfitMaxTokens,
    schema: LOCATE_SCHEMA,
    signal,
    messages: [
      {
        role: 'system',
        content: [
          'Find one specific clothing item in a photo and say where it is.',
          'box is [yMin, xMin, yMax, xMax], each from 0 to 1000, with 0,0 the top-left corner, tight',
          'around the visible part of that item only. In a mirror photo, use the item as it appears',
          'in the mirror. If the item is not in the photo, set found to false and box to [].',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `The item: ${description}` },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
        ],
      },
    ],
  }));

  return data?.found ? cropFromBox(data.box) : null;
}

const OUTFIT_PHOTO_SYSTEM_PROMPT = [
  'You are looking at one photo of a person wearing today\'s outfit, usually a mirror selfie,',
  'together with a list of the clothes they own. Do two things.',
  '',
  '1. wearing: list every garment and accessory you can actually see them wearing, once each.',
  '   For each, give the id of the wardrobe item it is, or an empty string if nothing in the list',
  '   is a convincing match. Match on category first, then colour, then the notes. When two',
  '   items could both be it, pick the closer one; when none really fits, use an empty string.',
  '   Never use an id that is not in the list. Ignore the room, the phone and the mirror.',
  '   Also describe each one as a wardrobe cataloguer would, so a piece that is not in the list',
  '   can be added: colors (one to three plain words), styleTags (two to four, such as casual,',
  '   smart casual, relaxed), seasons and weather, and box: where it is in the photo as',
  '   [yMin, xMin, yMax, xMax] from 0 to 1000, tight around that one item as seen in the mirror.',
  '',
  '2. Give honest, specific feedback, as a friend with a good eye would, for the occasion and',
  '   weather given. No score, rating or percentage. verdict: one plain sentence on how it',
  '   works overall. working: one to three specific things that work. tweaks: zero to three',
  '   specific, doable changes; when a piece from their wardrobe would be a better choice,',
  '   name it in swapItemId (otherwise an empty string). If the outfit works, say so and keep',
  '   tweaks empty rather than inventing problems. Only comment on what is visible.',
].join('\n');

const OUTFIT_PHOTO_SCHEMA = {
  name: 'outfit_photo',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      wearing: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: CATEGORY_ENUM },
            description: { type: 'string' },
            itemId: { type: 'string', description: 'A wardrobe id, or an empty string if none matches.' },
            colors: { type: 'array', items: { type: 'string' } },
            styleTags: { type: 'array', items: { type: 'string' } },
            seasons: { type: 'array', items: { type: 'string', enum: SEASON_ENUM } },
            weather: { type: 'array', items: { type: 'string', enum: WEATHER_ENUM } },
            box: { type: 'array', items: { type: 'integer' } },
          },
          required: ['category', 'description', 'itemId', 'colors', 'styleTags', 'seasons', 'weather', 'box'],
          additionalProperties: false,
        },
      },
      verdict: { type: 'string' },
      working: { type: 'array', items: { type: 'string' } },
      tweaks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            suggestion: { type: 'string' },
            swapItemId: { type: 'string', description: 'A wardrobe id to wear instead, or an empty string.' },
          },
          required: ['suggestion', 'swapItemId'],
          additionalProperties: false,
        },
      },
    },
    required: ['wearing', 'verdict', 'working', 'tweaks'],
    additionalProperties: false,
  },
};

/**
 * Reads a photo of today's outfit: which saved pieces are being worn (so the
 * day can be logged in one step), plus honest written feedback. One call does
 * both, since the model is looking at the same picture either way.
 */
export async function analyzeOutfitPhoto(file, { provider, wardrobe = [], occasion = 'Everyday', forecastNote = '', signal } = {}) {
  requireProvider(provider);
  const { dataUrl } = await prepareImage(file);
  const known = new Set(wardrobe.map((item) => item.id));

  const context = [
    `Occasion: ${occasion}`,
    forecastNote,
    '',
    wardrobe.length ? 'Their wardrobe:' : 'Their wardrobe is empty, so every itemId and swapItemId is an empty string.',
    wardrobe.map(describeCandidate).join('\n'),
  ].filter((line) => line !== null && line !== undefined).join('\n');

  const { data } = await withFallbackModel(provider, (model) => callChatJson({
    provider,
    model,
    maxTokens: provider.taggingMaxTokens,
    schema: OUTFIT_PHOTO_SCHEMA,
    signal,
    messages: [
      { role: 'system', content: OUTFIT_PHOTO_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: context },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
        ],
      },
    ],
  }));

  const validId = (id) => (typeof id === 'string' && known.has(id) ? id : '');
  const text = (value, max = 300) => String(value || '').trim().slice(0, max);
  const seen = new Set();

  const wearing = (Array.isArray(data?.wearing) ? data.wearing : [])
    .map((entry) => {
      // Everything needed to add it as a new wardrobe piece if it isn't one
      // already: the same fields and crop that photo tagging produces.
      const asPiece = toReviewItem(entry);
      return {
        category: CATEGORY_ENUM.includes(entry?.category) ? entry.category : 'accessory',
        description: text(entry?.description, 120),
        itemId: validId(entry?.itemId),
        piece: asPiece ? { ...asPiece, notes: text(entry?.description, 120) } : null,
      };
    })
    // The same saved piece can't be worn twice; keep its first, likeliest match.
    .map((entry) => {
      if (!entry.itemId) return entry;
      if (seen.has(entry.itemId)) return { ...entry, itemId: '' };
      seen.add(entry.itemId);
      return entry;
    });

  return {
    wearing,
    verdict: text(data?.verdict),
    working: (Array.isArray(data?.working) ? data.working : []).map((line) => text(line)).filter(Boolean).slice(0, 3),
    tweaks: (Array.isArray(data?.tweaks) ? data.tweaks : [])
      .map((tweak) => ({ suggestion: text(tweak?.suggestion), swapItemId: validId(tweak?.swapItemId) }))
      .filter((tweak) => tweak.suggestion)
      .slice(0, 3),
  };
}

const CAPSULE_SYSTEM_PROMPT = [
  'You are building a capsule wardrobe from clothes a person already owns: a small set of',
  'pieces that mix and match into as many complete outfits as possible.',
  '',
  'Choose the requested number of pieces from the list, using only ids from the list. A',
  'complete outfit is a top, a bottom and shoes, or a dress and shoes, optionally with a layer.',
  'Favour pieces that go with many others (neutral or complementary colours, versatile',
  'styles), include at least one pair of shoes, and fit the season given. Avoid pieces that',
  'only go with one other piece.',
  '',
  'Then list four to eight example outfits made only from the chosen pieces. The explanation',
  'is two or three plain sentences on why these pieces work together. No bullet points.',
].join('\n');

const CAPSULE_SCHEMA = {
  name: 'capsule_wardrobe',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      itemIds: { type: 'array', items: { type: 'string' } },
      outfits: {
        type: 'array',
        items: {
          type: 'object',
          properties: { itemIds: { type: 'array', items: { type: 'string' } } },
          required: ['itemIds'],
          additionalProperties: false,
        },
      },
      explanation: { type: 'string' },
    },
    required: ['itemIds', 'outfits', 'explanation'],
    additionalProperties: false,
  },
};

/**
 * Picks a capsule of `size` owned pieces that combine into the most outfits,
 * with example outfits made only from those pieces. Text only; no photos.
 */
export async function buildCapsule({ provider, wardrobe = [], size = 12, season = '', signal } = {}) {
  requireProvider(provider);
  if (wardrobe.length < 4) {
    throw new Error('Add a few more pieces first. A capsule needs at least a top, a bottom and shoes to choose from.');
  }
  const known = new Set(wardrobe.map((item) => item.id));

  const request = [
    `Number of pieces: ${Math.min(size, wardrobe.length)}`,
    season ? `Season: ${season}` : 'Season: any; favour year-round pieces.',
    '',
    'Wardrobe:',
    wardrobe.map(describeCandidate).join('\n'),
  ].join('\n');

  const { data } = await withFallbackModel(provider, (model) => callChatJson({
    provider,
    model,
    maxTokens: provider.taggingMaxTokens,
    schema: CAPSULE_SCHEMA,
    signal,
    messages: [
      { role: 'system', content: CAPSULE_SYSTEM_PROMPT },
      { role: 'user', content: request },
    ],
  }));

  const itemIds = [...new Set((Array.isArray(data?.itemIds) ? data.itemIds : []).filter((id) => known.has(id)))];
  if (!itemIds.length) throw new Error('No capsule came back. Try again.');
  const inCapsule = new Set(itemIds);

  const outfits = (Array.isArray(data?.outfits) ? data.outfits : [])
    // An example outfit may only use capsule pieces; anything else is dropped.
    .map((outfit) => [...new Set((Array.isArray(outfit?.itemIds) ? outfit.itemIds : []).filter((id) => inCapsule.has(id)))])
    .filter((ids) => ids.length >= 2);

  return {
    itemIds,
    outfits,
    explanation: String(data?.explanation || '').trim().slice(0, 600),
  };
}

/**
 * A trivial connectivity check for the "Test connection" button in Settings.
 * Reports enough detail — status, model, latency, the provider's own error
 * text — to tell a bad key from a rate limit from a wrong base URL without
 * spending a real photo upload finding out.
 */
export async function testProvider(provider, { withVision = false } = {}) {
  const startedAt = Date.now();

  try {
    requireProvider(provider);
    const messages = withVision
      ? [{
        role: 'user',
        content: [
          { type: 'text', text: 'Reply with the single word OK.' },
          { type: 'image_url', image_url: { url: TEST_PIXEL_DATA_URL, detail: 'low' } },
        ],
      }]
      : [{ role: 'user', content: 'Reply with the single word OK.' }];

    const { content } = await requestOnce({
      provider,
      body: { model: provider.model, messages, max_tokens: 20, temperature: 0, ...(reasoningEffortFor(provider) && { reasoning_effort: reasoningEffortFor(provider) }) },
    });

    return {
      ok: true,
      status: 200,
      model: provider.model,
      latencyMs: Date.now() - startedAt,
      reply: content.trim().slice(0, 80),
      visionTested: withVision,
    };
  } catch (error) {
    // Reasoning models (Gemini 3.x) can spend this probe's 20 tokens thinking
    // and stop before saying "OK". The key, endpoint and model all worked to
    // get that far, which is all a connection test is asking.
    if (error?.reason === 'length') {
      return {
        ok: true,
        status: 200,
        model: provider.model,
        latencyMs: Date.now() - startedAt,
        reply: '',
        visionTested: withVision,
      };
    }
    const display = provider ? toDisplayError(error, provider) : error;
    return {
      ok: false,
      status: typeof error?.status === 'number' ? error.status : null,
      model: provider?.model || '',
      latencyMs: Date.now() - startedAt,
      message: display?.message || 'This provider could not be reached.',
      visionTested: withVision,
    };
  }
}
