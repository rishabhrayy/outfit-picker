/**
 * Direct browser calls to whichever AI provider is active in Settings.
 * Nothing is proxied through a server, because this app has none.
 *
 * Providers vary in how they'll return structured JSON. Three tiers are tried,
 * in order, the first time a provider is used:
 *   1. schema — response_format: json_schema, strict. Best, not universal.
 *   2. object — response_format: json_object, with the shape spelled out in
 *      the prompt instead of enforced.
 *   3. text   — no response_format at all; the shape is only in the prompt,
 *      and the first balanced {...} in the reply is extracted by hand.
 * A provider set to "auto" starts at (1) and steps down on a 4xx that looks
 * like an unsupported-response-format error. Once a tier works, the caller
 * persists it on the provider record, so later calls go straight there
 * instead of re-probing every time.
 */

import { detectPresetFromKey, getPreset } from './providers.js';
import { normalizeDetectedItem } from '../types.js';
import { prepareImage } from './image.js';

// Vision calls on a reasoning model routinely take 7-10s; this is the point at
// which the request is considered hung rather than slow.
const REQUEST_TIMEOUT_MS = 90_000;

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
          },
          required: ['category', 'description', 'colors', 'styleTags', 'seasons', 'weather'],
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
    return new Error(statusMessage(error.status, error.rawDetail ?? error.message, provider));
  }
  if (error instanceof SyntaxError) {
    return new Error(`${provider.label} returned a reply this app could not read. Try again.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function statusMessage(status, detail, provider) {
  if (status === 401 || status === 403) {
    // Using one provider's key against another is the likeliest cause of a
    // rejected key, and a bare "key rejected" message sends people off
    // checking a perfectly good key instead of the provider selection.
    const detectedId = detectPresetFromKey(provider.apiKey);
    if (detectedId && detectedId !== provider.presetId) {
      const detected = getPreset(detectedId);
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

  let response;
  try {
    response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(`${provider.label} did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds. Try again.`);
    }
    if (error?.name === 'AbortError') throw error;
    throw new Error(`Could not reach ${provider.label}. Check your internet connection, and that its base URL is correct.`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }

  const rawText = await response.text();
  let parsedBody = null;
  try {
    parsedBody = rawText ? JSON.parse(rawText) : null;
  } catch {
    // A non-JSON body (an HTML error page, a plain-text 502) is handled below.
  }

  if (!response.ok) {
    const detail = extractErrorMessage(parsedBody) || rawText.slice(0, 300);
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

  return choice?.message?.content ?? '';
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

function buildRequestBody(mode, model, messages, schemaWrapper, maxTokens) {
  const base = { model, temperature: 0.2, max_tokens: maxTokens };

  if (mode === 'schema') {
    return { ...base, messages, response_format: { type: 'json_schema', json_schema: schemaWrapper } };
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
  const modes = pinned ? [pinned] : ['schema', 'object', 'text'];
  let lastError;

  for (let index = 0; index < modes.length; index += 1) {
    const mode = modes[index];
    const body = buildRequestBody(mode, model, messages, schema, maxTokens);

    try {
      const content = await requestOnce({ provider, body, signal });
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
  };
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
    return { items: found.map(toReviewItem).filter(Boolean), jsonMode };
  };

  const fallbackModel = provider.fallbackModel || provider.model;
  let primary;
  try {
    primary = await attempt(provider.model);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // A failed first call is still worth one retry on the fallback model.
    const fallback = await attempt(fallbackModel);
    return { items: fallback.items, model: fallbackModel, usedFallback: true, jsonMode: fallback.jsonMode };
  }

  if (primary.items.length) {
    return { items: primary.items, model: provider.model, usedFallback: false, jsonMode: primary.jsonMode };
  }

  const fallback = await attempt(fallbackModel);
  return { items: fallback.items, model: fallbackModel, usedFallback: true, jsonMode: fallback.jsonMode };
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

  const request = [
    `Occasion: ${preferences.occasion || 'Everyday'}`,
    `Weather: ${preferences.weather || 'mild'}, around ${preferences.temperature ?? 20} degrees Celsius`,
    `Desired vibe: ${preferences.vibe || 'Easy'}`,
    today ? `Today: ${today}` : '',
    `Strongly prefer pieces not worn in the last ${avoidRecentDays} days.`,
    wanted
      ? `This item must be in the outfit: ${wanted.id} (${wanted.category}).`
      : 'No specific item was requested.',
    excludedItemIds.length
      ? `These ids were already suggested and must not be used again: ${excludedItemIds.join(', ')}`
      : '',
    '',
    'Wardrobe available right now:',
    candidates.map(describeCandidate).join('\n'),
  ]
    .filter(Boolean)
    .join('\n');

  const { data, jsonMode } = await callChatJson({
    provider,
    model: provider.model,
    maxTokens: provider.outfitMaxTokens,
    schema: OUTFIT_SCHEMA,
    signal,
    messages: [
      { role: 'system', content: OUTFIT_SYSTEM_PROMPT },
      { role: 'user', content: request },
    ],
  });

  const known = new Set(candidates.map((item) => item.id));
  const itemIds = [...new Set(Array.isArray(data?.itemIds) ? data.itemIds : [])]
    .filter((id) => known.has(id));

  if (!itemIds.length) {
    throw new Error('No wearable combination came back. Try adjusting your answers.');
  }

  return {
    itemIds,
    explanation: String(data?.explanation || '').trim() || 'This combination is ready to wear.',
    jsonMode,
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

    const content = await requestOnce({
      provider,
      body: { model: provider.model, messages, max_tokens: 20, temperature: 0 },
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
