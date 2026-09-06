/**
 * Direct browser calls to whichever AI provider is selected in Settings.
 * Nothing is proxied through a server, because this app has none.
 *
 * Tagging starts on the provider's cheaper model and retries a photo on its
 * stronger one when the first returns nothing usable.
 */

import { detectProvider, getProviderConfig, PROVIDERS } from './providers.js';
import { normalizeDetectedItem } from '../types.js';
import { prepareImage } from './image.js';

const CATEGORY_ENUM = ['top', 'bottom', 'dress', 'outerwear', 'shoes', 'accessory'];
const SEASON_ENUM = ['spring', 'summer', 'autumn', 'winter', 'all-season'];
const WEATHER_ENUM = ['cold', 'cool', 'mild', 'warm', 'hot', 'rainy', 'windy'];

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

function requireKey(apiKey, provider) {
  const key = String(apiKey || '').trim();
  if (!key) {
    throw new Error(`Add your ${provider.label} API key in Settings to use this feature.`);
  }
  return key;
}

/**
 * Both providers report errors as { error: { message } }, but Google wraps that
 * object in an array.
 */
function extractErrorMessage(body) {
  const payload = Array.isArray(body) ? body[0] : body;
  return payload?.error?.message || '';
}

async function readErrorMessage(response, provider, apiKey) {
  let detail = '';
  try {
    detail = extractErrorMessage(await response.json());
  } catch {
    // A non-JSON error body carries nothing worth showing.
  }

  if (response.status === 401 || response.status === 403) {
    // Using one provider's key against the other is the likeliest cause, and the
    // plain "key rejected" message sends people off checking a perfectly good key.
    const looksLike = detectProvider(apiKey);
    if (looksLike && looksLike !== provider.id) {
      return `That looks like a ${PROVIDERS[looksLike].label} key, but the provider is set to ${provider.label}. `
        + `Switch the provider in Settings, or paste ${provider.article} ${provider.label} key.`;
    }
    return `${provider.label} rejected that API key. Check the key saved in Settings.`;
  }
  if (response.status === 404 && detail.toLowerCase().includes('not found')) {
    return `${provider.label} no longer offers the model this app requests. The app needs updating.`;
  }
  if (response.status === 429) {
    return detail.toLowerCase().includes('quota')
      ? `Your ${provider.label} project is out of credit. Check its billing and usage.`
      : `${provider.label} is rate-limiting these requests. Wait a moment and try again.`;
  }
  if (response.status >= 500) {
    return `${provider.label} had a temporary problem. Try again in a moment.`;
  }

  return detail || `${provider.label} returned an error (${response.status}).`;
}

async function callChatCompletion({ apiKey, provider, model, messages, schema, maxTokens, signal }) {
  const key = requireKey(apiKey, provider);
  let response;

  try {
    response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: 'json_schema', json_schema: schema },
      }),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error(`Could not reach ${provider.label}. Check your internet connection and try again.`);
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, provider, apiKey));
  }

  const body = await response.json();
  const choice = body?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    // Reasoning models can spend the whole budget before writing any answer.
    throw new Error(`The reply from ${provider.label} was cut short before it finished. Try again.`);
  }
  if (choice?.message?.refusal) {
    throw new Error(choice.message.refusal);
  }

  try {
    return JSON.parse(choice?.message?.content ?? '');
  } catch {
    throw new Error(`${provider.label} returned a reply this app could not read. Try again.`);
  }
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
 * Sends one photo for tagging and returns { items, model, usedFallback }.
 *
 * An empty result is a valid answer (the photo held no clothing), but it is also
 * what a struggling model returns, so the stronger model gets one attempt before
 * that answer is accepted.
 */
export async function tagPhoto(file, { apiKey, providerId, signal } = {}) {
  const provider = getProviderConfig(providerId);
  requireKey(apiKey, provider);

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
    const parsed = await callChatCompletion({
      apiKey,
      provider,
      model,
      messages,
      schema: TAGGING_SCHEMA,
      maxTokens: provider.taggingMaxTokens,
      signal,
    });
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items.map(toReviewItem).filter(Boolean);
  };

  let items;
  try {
    items = await attempt(provider.primaryModel);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // A failed first call is still worth one retry on the stronger model.
    return { items: await attempt(provider.fallbackModel), model: provider.fallbackModel, usedFallback: true };
  }

  if (items.length) {
    return { items, model: provider.primaryModel, usedFallback: false };
  }

  return { items: await attempt(provider.fallbackModel), model: provider.fallbackModel, usedFallback: true };
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
  apiKey,
  providerId,
  signal,
} = {}) {
  const provider = getProviderConfig(providerId);
  requireKey(apiKey, provider);

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

  const parsed = await callChatCompletion({
    apiKey,
    provider,
    model: provider.primaryModel,
    maxTokens: provider.outfitMaxTokens,
    schema: OUTFIT_SCHEMA,
    signal,
    messages: [
      { role: 'system', content: OUTFIT_SYSTEM_PROMPT },
      { role: 'user', content: request },
    ],
  });

  const known = new Set(candidates.map((item) => item.id));
  const itemIds = [...new Set(Array.isArray(parsed?.itemIds) ? parsed.itemIds : [])]
    .filter((id) => known.has(id));

  if (!itemIds.length) {
    throw new Error('No wearable combination came back. Try adjusting your answers.');
  }

  return {
    itemIds,
    explanation: String(parsed?.explanation || '').trim() || 'This combination is ready to wear.',
  };
}
