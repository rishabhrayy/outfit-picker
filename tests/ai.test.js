import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Tagging resizes the photo on a canvas, which does not exist here. Everything
// downstream of it (the request, the retries, the parsing) is what is under test.
vi.mock('../src/lib/image.js', () => ({
  prepareImage: vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,PHOTOBYTES' })),
}));

import { analyzeOutfitPhoto, buildCapsule, locateItem, suggestOutfit, tagPhoto, testProvider } from '../src/lib/ai.js';

// Fresh storage per test: the app remembers models whose daily allowance ran
// out, and that memory must not leak from one test into the next.
beforeEach(() => {
  const store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------- fixtures

function makeProvider(overrides = {}) {
  return {
    id: 'provider-1',
    presetId: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-123',
    model: 'gpt-4o-mini',
    fallbackModel: 'gpt-4o',
    jsonMode: 'schema',
    taggingMaxTokens: 3000,
    outfitMaxTokens: 1200,
    ...overrides,
  };
}

const PHOTO = new Blob(['x'], { type: 'image/jpeg' });

const TOP = {
  category: 'top',
  description: 'linen camp-collar shirt',
  colors: ['sage'],
  styleTags: ['casual'],
  seasons: ['summer'],
  weather: ['warm'],
};
const SHOES = { ...TOP, category: 'shoes', description: 'canvas plimsolls', colors: ['white'] };

const CANDIDATES = [
  { id: 'a', category: 'top', colors: ['navy'], styleTags: ['casual'], seasons: ['mild'], lastWornDate: null, recentlyWorn: false },
  { id: 'b', category: 'bottom', colors: ['black'], styleTags: [], seasons: [], lastWornDate: '2026-10-01', recentlyWorn: true, notes: 'tapered' },
  { id: 'c', category: 'shoes', colors: ['white'], styleTags: [], seasons: [], lastWornDate: null, recentlyWorn: false },
];

// A responder is a function, not a Response, because a body can only be read once
// and the same responder may be asked for again.
const respond = (status, payload) => () =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const chat = (message, finish = 'stop') =>
  respond(200, { choices: [{ finish_reason: finish, message: { role: 'assistant', ...message } }] });
const asJson = (data) => chat({ content: JSON.stringify(data) });
const asProse = (content) => chat({ content });
const asToolCall = (data, name = 'some_tool') => chat({
  content: null,
  tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(data) } }],
}, 'tool_calls');
const failWith = (status, message) => respond(status, { error: { message } });

/** Replaces fetch; the Nth call gets the Nth responder, the last one repeats. */
function stubFetch(...responders) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body, signal: init.signal });
    return responders[Math.min(calls.length - 1, responders.length - 1)]();
  }));
  return calls;
}

const modeOf = (body) => {
  if (body.tools) return 'tools';
  if (body.response_format?.type === 'json_schema') return 'schema';
  if (body.response_format?.type === 'json_object') return 'object';
  return 'text';
};

const outfitCall = (provider, extra = {}) => suggestOutfit({ candidates: CANDIDATES, provider, ...extra });
const PICK = { itemIds: ['a', 'c'], explanation: 'Easy and clean.' };

// ------------------------------------------------- the four structured-output tiers

describe('how each JSON mode asks for structure', () => {
  it('schema: sends a strict json_schema and reads the message content', async () => {
    const calls = stubFetch(asJson({ items: [TOP] }));
    const result = await tagPhoto(PHOTO, { provider: makeProvider({ jsonMode: 'schema' }) });

    const { url, headers, body } = calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(headers.Authorization).toBe('Bearer sk-test-123');
    expect(body).toMatchObject({ model: 'gpt-4o-mini', max_tokens: 3000 });
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'wardrobe_items', strict: true } });
    expect(body.tools).toBeUndefined();
    expect(result).toMatchObject({ jsonMode: 'schema', usedFallback: false, model: 'gpt-4o-mini' });
    expect(result.items).toHaveLength(1);
  });

  it('tools: forces a call to a function whose parameters are the schema, with no response_format', async () => {
    const calls = stubFetch(asToolCall({ items: [TOP] }));
    const result = await tagPhoto(PHOTO, { provider: makeProvider({ jsonMode: 'tools' }) });

    const { body } = calls[0];
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('wardrobe_items');
    expect(body.tools[0].function.parameters).toMatchObject({ type: 'object', required: ['items'] });
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'wardrobe_items' } });
    expect('response_format' in body).toBe(false);
    expect(result.items[0]).toMatchObject({ category: 'top', colors: ['sage'] });
    expect(result.jsonMode).toBe('tools');
  });

  it('tools: names the function after the request, so outfits get their own', async () => {
    const calls = stubFetch(asToolCall(PICK));
    await outfitCall(makeProvider({ jsonMode: 'tools' }));
    expect(calls[0].body.tools[0].function.name).toBe('outfit_choice');
    expect(calls[0].body.tool_choice.function.name).toBe('outfit_choice');
  });

  it('object: asks for json_object and spells the shape out in the system prompt instead', async () => {
    const calls = stubFetch(asProse(`\`\`\`json\n${JSON.stringify({ items: [TOP] })}\n\`\`\``));
    const result = await tagPhoto(PHOTO, { provider: makeProvider({ jsonMode: 'object' }) });

    const { body } = calls[0];
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).toContain('ONLY a single JSON object');
    expect(body.messages[0].content).toContain('"additionalProperties"');
    expect(body.tools).toBeUndefined();
    expect(result.items).toHaveLength(1); // a fenced reply is still understood
    expect(result.jsonMode).toBe('object');
  });

  it('text: sends no format hints at all and finds the object inside chatty prose', async () => {
    const reply = `Sure! Here you go: ${JSON.stringify({ items: [{ ...TOP, description: 'a {curly} shirt' }] })} Hope that helps.`;
    const calls = stubFetch(asProse(reply));
    const result = await tagPhoto(PHOTO, { provider: makeProvider({ jsonMode: 'text' }) });

    const { body } = calls[0];
    expect('response_format' in body).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.messages[0].content).toContain('ONLY a single JSON object');
    expect(result.items[0].notes).toBe('a {curly} shirt'); // braces inside a string do not end the object early
  });

  it('sends the photo exactly once, as a data URL, behind a system prompt that says photos are casual', async () => {
    const calls = stubFetch(asJson({ items: [TOP] }));
    await tagPhoto(PHOTO, { provider: makeProvider() });

    const [system, user] = calls[0].body.messages;
    expect(system.role).toBe('system');
    expect(system.content).toMatch(/casual/i);
    expect(system.content).toMatch(/background/i);
    expect(user.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,PHOTOBYTES', detail: 'high' },
    });
  });
});

// ------------------------------------------------------------ auto-detect ladder

describe('auto-detect', () => {
  // One model, so these test the format ladder alone; the retry on a second
  // model is tested under suggestOutfit.
  const auto = () => makeProvider({ jsonMode: 'auto', fallbackModel: '' });

  it('moves past a provider that ignores response_format and answers in prose, and reports where it landed', async () => {
    // This is what Anthropic's OpenAI-compatible endpoint does: 200 OK, format ignored.
    const calls = stubFetch(asProse('Sure, here are some thoughts.'), asToolCall(PICK));
    const result = await outfitCall(auto());

    expect(calls.map((call) => modeOf(call.body))).toEqual(['schema', 'tools']);
    expect(result.jsonMode).toBe('tools'); // services.js pins this so the probe is paid once
    expect(result.itemIds).toEqual(['a', 'c']);
  });

  it('steps down when a provider rejects response_format outright', async () => {
    const calls = stubFetch(failWith(400, "Unknown parameter: 'response_format.json_schema'"), asToolCall(PICK));
    const result = await outfitCall(auto());
    expect(calls.map((call) => modeOf(call.body))).toEqual(['schema', 'tools']);
    expect(result.jsonMode).toBe('tools');
  });

  it('treats a tools reply with no tool call as unusable and carries on to json_object', async () => {
    const calls = stubFetch(asProse('words'), asProse('I decline to call a tool.'), asJson(PICK));
    const result = await outfitCall(auto());
    expect(calls.map((call) => modeOf(call.body))).toEqual(['schema', 'tools', 'object']);
    expect(result.jsonMode).toBe('object');
  });

  it('reaches plain text as the last resort, trying all four tiers in order', async () => {
    const calls = stubFetch(
      asProse('prose'),
      asProse('no tool call'),
      failWith(400, 'response_format json_object is not supported by this model'),
      asProse(`Here: ${JSON.stringify(PICK)} Bye!`),
    );
    const result = await outfitCall(auto());
    expect(calls.map((call) => modeOf(call.body))).toEqual(['schema', 'tools', 'object', 'text']);
    expect(result.jsonMode).toBe('text');
    expect(result.explanation).toBe('Easy and clean.');
  });

  it('gives up after the fourth tier with a plain message instead of looping', async () => {
    const calls = stubFetch(asProse('no json anywhere'));
    await expect(outfitCall(auto())).rejects.toThrow('OpenAI returned a reply this app could not read');
    expect(calls).toHaveLength(4);
  });

  it.each([
    ['a rejected key', 401, 'Incorrect API key provided.'],
    ['a rate limit', 429, 'Rate limit reached.'],
    ['a server error', 500, 'Internal error.'],
    ['a missing model', 404, 'The model `nope` does not exist.'],
  ])('does not burn four calls on %s, which no tier could fix', async (_label, status, message) => {
    const calls = stubFetch(failWith(status, message));
    await expect(outfitCall(auto())).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('never steps down once a tier is pinned, even on a response_format error', async () => {
    const calls = stubFetch(failWith(400, 'response_format is not supported'), asToolCall(PICK));
    await expect(outfitCall(makeProvider({ jsonMode: 'schema', fallbackModel: '' }))).rejects.toThrow('OpenAI error 400');
    expect(calls).toHaveLength(1);
  });

  it('does not treat a cut-off reply as a format problem', async () => {
    const calls = stubFetch(chat({ content: '{"itemIds":["a"' }, 'length'));
    await expect(outfitCall(auto())).rejects.toThrow('The reply from OpenAI was cut short before it finished');
    expect(calls).toHaveLength(1);
  });

  it('passes a refusal through in the model’s own words', async () => {
    stubFetch(chat({ content: null, refusal: 'I cannot help with that.' }));
    await expect(outfitCall(auto())).rejects.toThrow('I cannot help with that.');
  });
});

// ---------------------------------------------------------------- the Anthropic host

describe('Anthropic', () => {
  const anthropic = (extra = {}) => makeProvider({
    presetId: 'anthropic',
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-test',
    model: 'claude-haiku-4-5-20251001',
    jsonMode: 'tools',
    ...extra,
  });

  it('adds the browser-access header its API requires, and only for its own host', async () => {
    const calls = stubFetch(asToolCall(PICK));
    await outfitCall(anthropic());
    expect(calls[0].headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(calls[0].headers.Authorization).toBe('Bearer sk-ant-test');

    const other = stubFetch(asJson(PICK));
    await outfitCall(makeProvider());
    expect(other[0].headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
  });

  it('adds it for a hand-typed Custom provider pointed at the same host too', async () => {
    const calls = stubFetch(asToolCall(PICK));
    await outfitCall(anthropic({ presetId: 'custom', label: 'My Claude' }));
    expect(calls[0].headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });
});

// ------------------------------------------------------------- error messages

describe('error messages', () => {
  const run = (responder, provider = makeProvider()) => {
    stubFetch(responder);
    return outfitCall(provider);
  };

  it('quotes the provider’s own reason for a rejected key', async () => {
    await expect(run(failWith(401, 'Incorrect API key provided.')))
      .rejects.toThrow('OpenAI rejected that API key: Incorrect API key provided.');
  });

  it('still says something useful when the provider gives no reason', async () => {
    await expect(run(respond(401, {}))).rejects.toThrow('OpenAI rejected that API key. Check the key saved in Settings.');
  });

  it('points at the provider choice when a key plainly belongs to another provider', async () => {
    await expect(run(failWith(401, 'bad key'), makeProvider({ apiKey: 'gsk_abc123' })))
      .rejects.toThrow('That looks like a Groq key, but this provider is set up as OpenAI');
  });

  describe('the built-in AI', () => {
    const builtin = () => makeProvider({ presetId: 'builtin', label: 'Built-in AI (Gemini)', baseUrl: '/api/gemini', apiKey: 'passcode', model: 'gemini-3.6-flash' });

    it('calls this site\'s own route, with the passcode as the bearer token', async () => {
      const calls = stubFetch(asJson({ itemIds: ['a', 'c'], explanation: 'ok' }));
      await outfitCall(builtin());
      expect(calls[0].url).toBe('/api/gemini/chat/completions');
      expect(calls[0].headers.Authorization).toBe('Bearer passcode');
    });

    it('calls a 401 a wrong passcode, not a rejected API key', async () => {
      await expect(run(failWith(401, 'Wrong passcode for the built-in AI.'), builtin()))
        .rejects.toThrow('Wrong passcode for the built-in AI. Check it in Settings.');
    });

    it('shows the server\'s setup instructions instead of "a temporary problem"', async () => {
      await expect(run(failWith(503, 'The built-in AI is not set up on this site yet: GEMINI_API_KEY and APP_PASSCODE both need to be set on the host.'), builtin()))
        .rejects.toThrow(/GEMINI_API_KEY and APP_PASSCODE/);
    });

    it('says plainly when Google is busy on both models, rather than quoting it', async () => {
      await expect(run(failWith(503, 'This model is currently experiencing high demand.'), builtin()))
        .rejects.toThrow('Google\'s AI is busy right now. Wait a minute and try again.');
    });
  });

  it.each([
    ['Anthropic with its own key', { presetId: 'anthropic', label: 'Anthropic (Claude)', apiKey: 'sk-ant-abc' }],
    ['OpenRouter with its own key', { presetId: 'openrouter', label: 'OpenRouter', apiKey: 'sk-or-v1-abc' }],
    ['DeepSeek, whose keys share OpenAI’s "sk-" prefix', { presetId: 'deepseek', label: 'DeepSeek', apiKey: 'sk-abc123' }],
    ['a Custom provider with a key shaped like a known one', { presetId: 'custom', label: 'My proxy', apiKey: 'sk-ant-abc' }],
  ])('does not accuse %s of using the wrong provider', async (_label, extra) => {
    await expect(run(failWith(401, 'revoked'), makeProvider(extra)))
      .rejects.toThrow(/rejected that API key: revoked/);
  });

  it('calls a rate limit a rate limit, and only blames billing when the provider does', async () => {
    await expect(run(failWith(429, 'Rate limit reached for requests per minute.')))
      .rejects.toThrow(/rate-limiting these requests/);
    await expect(run(failWith(429, 'You exceeded your current quota, please check your plan and billing details.')))
      .rejects.toThrow(/out of credit/);
  });

  it('shows a missing model in the provider’s words, which is how a retired model gets noticed', async () => {
    await expect(run(failWith(404, 'The model `meta-llama/llama-4-scout` does not exist or you do not have access to it.')))
      .rejects.toThrow('OpenAI error 404: The model `meta-llama/llama-4-scout` does not exist');
  });

  it('understands Google wrapping its error in an array', async () => {
    await expect(run(respond(400, [{ error: { message: 'API key not valid. Please pass a valid API key.' } }])))
      .rejects.toThrow('API key not valid. Please pass a valid API key.');
  });

  it('calls a 5xx, even one with an HTML body, a temporary problem', async () => {
    await expect(run(failWith(503, 'overloaded'))).rejects.toThrow('had a temporary problem');
    await expect(run(() => new Response('<html>Bad gateway</html>', { status: 502 }))).rejects.toThrow('had a temporary problem');
  });

  it('says it could not reach the provider when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(outfitCall(makeProvider())).rejects.toThrow('Could not reach OpenAI');
  });

  it('refuses to send anything without a provider, key, model or URL', async () => {
    const calls = stubFetch(asJson(PICK));
    await expect(outfitCall(undefined)).rejects.toThrow('Add an AI provider in Settings');
    await expect(outfitCall(makeProvider({ apiKey: '' }))).rejects.toThrow('Add an API key for OpenAI');
    await expect(outfitCall(makeProvider({ model: '' }))).rejects.toThrow('no model set');
    await expect(outfitCall(makeProvider({ baseUrl: '' }))).rejects.toThrow('no base URL set');
    expect(calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------ timeout and abort

describe('timeouts and cancelling', () => {
  const hangsUntilAborted = () => vi.fn((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));

  it('gives up on a request that never answers, and says how long it waited', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangsUntilAborted());

    const outcome = expect(outfitCall(makeProvider())).rejects.toThrow('did not respond within 90 seconds');
    await vi.advanceTimersByTimeAsync(90_000);
    await outcome;
  });

  it('stops when the caller aborts mid-request, without retrying on the fallback model', async () => {
    const fetchStub = hangsUntilAborted();
    vi.stubGlobal('fetch', fetchStub);
    const controller = new AbortController();

    const pending = tagPhoto(PHOTO, { provider: makeProvider(), signal: controller.signal });
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalled());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('honours a signal that was already aborted before the request began', async () => {
    const fetchStub = vi.fn(async (url, init) => {
      if (init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return asJson(PICK)();
    });
    vi.stubGlobal('fetch', fetchStub);
    const controller = new AbortController();
    controller.abort();

    await expect(outfitCall(makeProvider(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// -------------------------------------------------------------------- tagPhoto

describe('tagPhoto', () => {
  it('turns what the model found into review items, dropping what it cannot place', async () => {
    stubFetch(asJson({
      items: [
        { category: 'spaceship', description: 'not clothing', colors: [], styleTags: [], seasons: [], weather: [] },
        { ...TOP, description: ` ${'x'.repeat(300)} ` },
        { ...SHOES, seasons: ['all-season'], weather: ['rainy'] },
      ],
    }));
    const { items } = await tagPhoto(PHOTO, { provider: makeProvider() });

    expect(items.map((item) => item.category)).toEqual(['top', 'shoes']);
    expect(items[0].notes).toHaveLength(200);
    // the edit form has one season/weather field, so both vocabularies are folded into it
    expect(items[0].seasons).toEqual(['summer', 'warm']);
    expect(items[1].seasons).toEqual(['all-season', 'rainy']);
  });

  it('asks the stronger model once when the first finds nothing, since an empty answer is also what a weak model gives', async () => {
    const calls = stubFetch(asJson({ items: [] }), asJson({ items: [TOP] }));
    const result = await tagPhoto(PHOTO, { provider: makeProvider() });

    expect(calls.map((call) => call.body.model)).toEqual(['gpt-4o-mini', 'gpt-4o']);
    expect(result).toMatchObject({ usedFallback: true, model: 'gpt-4o' });
    expect(result.items).toHaveLength(1);
  });

  it('retries on the fallback model after a failed first call', async () => {
    const calls = stubFetch(failWith(500, 'boom'), asJson({ items: [TOP] }));
    const result = await tagPhoto(PHOTO, { provider: makeProvider() });
    expect(calls.map((call) => call.body.model)).toEqual(['gpt-4o-mini', 'gpt-4o']);
    expect(result.usedFallback).toBe(true);
  });

  it('does not call the fallback when the first answer is good', async () => {
    const calls = stubFetch(asJson({ items: [TOP] }));
    const result = await tagPhoto(PHOTO, { provider: makeProvider() });
    expect(calls).toHaveLength(1);
    expect(result.usedFallback).toBe(false);
  });

  it('reports the fallback’s failure when both attempts fail', async () => {
    const calls = stubFetch(failWith(500, 'boom'), failWith(401, 'Incorrect API key provided.'));
    await expect(tagPhoto(PHOTO, { provider: makeProvider() })).rejects.toThrow('rejected that API key');
    expect(calls).toHaveLength(2);
  });

  it('does not ask the same model twice when there is no separate fallback', async () => {
    const calls = stubFetch(asJson({ items: [] }), asJson({ items: [TOP] }));
    const result = await tagPhoto(PHOTO, { provider: makeProvider({ fallbackModel: '' }) });
    expect(calls.map((call) => call.body.model)).toEqual(['gpt-4o-mini']);
    expect(result.items).toEqual([]);
  });

  it('uses the provider’s own tagging token budget', async () => {
    const calls = stubFetch(asJson({ items: [TOP] }));
    await tagPhoto(PHOTO, { provider: makeProvider({ taggingMaxTokens: 4321 }) });
    expect(calls[0].body.max_tokens).toBe(4321);
  });

  it('reports a reply that was cut short, rather than a vague parse error', async () => {
    stubFetch(chat({ content: '{"items":[{"category":"to' }, 'length'));
    await expect(tagPhoto(PHOTO, { provider: makeProvider() })).rejects.toThrow('cut short');
  });
});

// ---------------------------------------------------------------- suggestOutfit

describe('suggestOutfit', () => {
  it('keeps only ids it was actually given, once each, in the order chosen', async () => {
    stubFetch(asJson({ itemIds: ['c', 'ghost', 'a', 'c'], explanation: 'Nice.' }));
    const result = await outfitCall(makeProvider());
    expect(result.itemIds).toEqual(['c', 'a']);
  });

  it('fails clearly when the model names nothing real', async () => {
    stubFetch(asJson({ itemIds: ['ghost', 'phantom'], explanation: 'Trust me.' }));
    await expect(outfitCall(makeProvider())).rejects.toThrow('No wearable combination came back');
  });

  it('retries once on the fallback model when the first is overloaded', async () => {
    const calls = stubFetch(failWith(503, 'This model is currently experiencing high demand.'), asJson(PICK));
    const result = await outfitCall(makeProvider());
    expect(calls.map((call) => call.body.model)).toEqual(['gpt-4o-mini', 'gpt-4o']);
    expect(result.itemIds).toEqual(['a', 'c']);
  });

  it('reports the second model\'s failure if both fail, without a third try', async () => {
    const calls = stubFetch(failWith(429, 'slow down'));
    await expect(outfitCall(makeProvider())).rejects.toThrow('rate-limiting');
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['a rejected key', () => failWith(401, 'bad key')],
    ['a lost connection', () => { throw new TypeError('Failed to fetch'); }],
  ])('does not retry on the other model after %s, which no model could fix', async (_label, responder) => {
    const calls = stubFetch(responder);
    await expect(outfitCall(makeProvider())).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('does not retry when there is no distinct fallback model', async () => {
    const calls = stubFetch(failWith(503, 'busy'));
    await expect(outfitCall(makeProvider({ fallbackModel: 'gpt-4o-mini' }))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('does not call out at all with nothing to choose from', async () => {
    const calls = stubFetch(asJson(PICK));
    await expect(suggestOutfit({ candidates: [], provider: makeProvider() })).rejects.toThrow('no matching pieces');
    expect(calls).toHaveLength(0);
  });

  it('tells the model what was asked: the occasion, the item that must appear, what is off limits, and what was worn lately', async () => {
    const calls = stubFetch(asJson(PICK));
    await outfitCall(makeProvider(), {
      preferences: { occasion: 'Dinner', weather: 'cool', temperature: 14, vibe: 'Polished', wantedItemId: 'c' },
      excludedItemIds: ['x1', 'x2'],
      avoidRecentDays: 10,
      today: '2026-10-07',
    });

    const prompt = calls[0].body.messages[1].content;
    expect(prompt).toContain('Occasion: Dinner');
    expect(prompt).toContain('Weather: cool, around 14 degrees Celsius');
    expect(prompt).toContain('Desired vibe: Polished');
    expect(prompt).toContain('Today: 2026-10-07');
    expect(prompt).toContain('not worn in the last 10 days');
    expect(prompt).toContain('This item must be in the outfit: c (shoes).');
    expect(prompt).toContain('must not be used again: x1, x2');
    expect(prompt).toMatch(/id: b \|.*last worn: 2026-10-01 \(RECENTLY WORN\)/);
    expect(prompt).toContain('notes: tapered');
    expect(prompt).not.toContain('photo'); // only structured text goes up, never the pictures
  });

  it('falls back to a plain explanation when the model sends a blank one', async () => {
    stubFetch(asJson({ itemIds: ['a'], explanation: '   ' }));
    const result = await outfitCall(makeProvider());
    expect(result.explanation).toBe('This combination is ready to wear.');
  });

  it('uses the outfit token budget and reports the tier that worked', async () => {
    const calls = stubFetch(asJson(PICK));
    const result = await outfitCall(makeProvider({ outfitMaxTokens: 777 }));
    expect(calls[0].body.max_tokens).toBe(777);
    expect(result.jsonMode).toBe('schema');
  });
});

// ---------------------------------------------------------------- testProvider

describe('testProvider', () => {
  it('reports success with the model, the latency and what it replied', async () => {
    const calls = stubFetch(asProse('  OK  '));
    const result = await testProvider(makeProvider());

    expect(result).toMatchObject({ ok: true, status: 200, model: 'gpt-4o-mini', reply: 'OK', visionTested: false });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls[0].body.max_tokens).toBe(20); // a cheap probe: it does not exercise the real token budget
  });

  it('can include a tiny image to find out whether the model accepts photos at all', async () => {
    const calls = stubFetch(asProse('OK'));
    const result = await testProvider(makeProvider(), { withVision: true });
    expect(result.visionTested).toBe(true);
    expect(calls[0].body.messages[0].content.some((part) => part.type === 'image_url')).toBe(true);
  });

  it('turns a failure into a result instead of throwing, keeping the status and the reason', async () => {
    stubFetch(failWith(401, 'Incorrect API key provided.'));
    const result = await testProvider(makeProvider());
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(result.message).toContain('Incorrect API key provided.');
  });

  it('reports a network failure with no status, and a missing key without making a request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await testProvider(makeProvider())).toMatchObject({ ok: false, status: null });

    const calls = stubFetch(asProse('OK'));
    const noKey = await testProvider(makeProvider({ apiKey: '' }));
    expect(noKey).toMatchObject({ ok: false });
    expect(noKey.message).toContain('Add an API key');
    expect(calls).toHaveLength(0);
  });

  it('counts a reply cut short by the tiny token budget as connected, since a reasoning model can think past 20 tokens', async () => {
    stubFetch(chat({ content: '' }, 'length'));
    expect(await testProvider(makeProvider())).toMatchObject({ ok: true, reply: '' });
  });
});

describe('feedback in outfit suggestions', () => {
  it('tells the model which pairings were ruled out and which outfits were loved', async () => {
    const calls = stubFetch(asJson(PICK));
    await outfitCall(makeProvider(), { feedback: { blockedPairs: [['a', 'b'], ['a', 'gone']], lovedOutfits: [['a', 'c'], ['gone']] } });
    const prompt = calls[0].body.messages[1].content;
    expect(prompt).toContain('never to suggest these pairings again');
    expect(prompt).toContain('a with b');
    // A pair or outfit mentioning a piece not on offer is left out.
    expect(prompt).not.toContain('gone');
    expect(prompt).toContain('[a, c]');
  });

  it('never shows a ruled-out pairing, even if the model returns one', async () => {
    stubFetch(asJson({ itemIds: ['a', 'b', 'c'], explanation: 'x' }));
    await expect(outfitCall(makeProvider(), { feedback: { blockedPairs: [['a', 'b']] } })).rejects.toThrow('ruled out');
  });

  it('passes the forecast through to the stylist', async () => {
    const calls = stubFetch(asJson(PICK));
    await outfitCall(makeProvider(), { preferences: { forecastNote: 'Forecast in Melbourne: 4 to 12 degrees Celsius, rain likely (80%).' } });
    expect(calls[0].body.messages[1].content).toContain('rain likely (80%)');
  });
});

describe('analyzeOutfitPhoto', () => {
  const wardrobe = [
    { id: 'a', category: 'top', colors: ['navy'], styleTags: [], seasons: [] },
    { id: 'c', category: 'shoes', colors: ['white'], styleTags: [], seasons: [] },
  ];
  const reply = (overrides = {}) => asJson({
    wearing: [
      { category: 'top', description: 'navy tee', itemId: 'a' },
      { category: 'bottom', description: 'black jeans', itemId: '' },
      { category: 'shoes', description: 'white trainers', itemId: 'c' },
    ],
    verdict: 'Clean and easy.',
    working: ['The navy and white are crisp together.'],
    tweaks: [{ suggestion: 'Roll the sleeves once.', swapItemId: '' }],
    ...overrides,
  });

  it('sends the photo with the wardrobe as text, and returns matches and feedback', async () => {
    const calls = stubFetch(reply());
    const result = await analyzeOutfitPhoto(PHOTO, { provider: makeProvider(), wardrobe, occasion: 'Work', forecastNote: 'Forecast: dry.' });
    const [text, image] = calls[0].body.messages[1].content;
    expect(text.text).toContain('Occasion: Work');
    expect(text.text).toContain('Forecast: dry.');
    expect(text.text).toContain('id: a');
    expect(image.image_url.url).toBe('data:image/jpeg;base64,PHOTOBYTES');
    expect(result.wearing.map((entry) => entry.itemId)).toEqual(['a', '', 'c']);
    expect(result.verdict).toBe('Clean and easy.');
    expect(result.tweaks).toEqual([{ suggestion: 'Roll the sleeves once.', swapItemId: '' }]);
  });

  it('drops invented ids, and never matches one saved piece twice', async () => {
    stubFetch(reply({
      wearing: [
        { category: 'top', description: 'tee', itemId: 'a' },
        { category: 'top', description: 'overshirt', itemId: 'a' },
        { category: 'bottom', description: 'jeans', itemId: 'made-up' },
      ],
      tweaks: [{ suggestion: 'Try other shoes.', swapItemId: 'made-up' }, { suggestion: '', swapItemId: 'c' }],
    }));
    const result = await analyzeOutfitPhoto(PHOTO, { provider: makeProvider(), wardrobe });
    expect(result.wearing.map((entry) => entry.itemId)).toEqual(['a', '', '']);
    expect(result.tweaks).toEqual([{ suggestion: 'Try other shoes.', swapItemId: '' }]);
  });

  it('retries on the fallback model when the first is overloaded', async () => {
    const calls = stubFetch(failWith(503, 'high demand'), reply());
    await analyzeOutfitPhoto(PHOTO, { provider: makeProvider(), wardrobe });
    expect(calls.map((call) => call.body.model)).toEqual(['gpt-4o-mini', 'gpt-4o']);
  });
});

describe('buildCapsule', () => {
  const wardrobe = ['t1', 't2', 'b1', 'b2', 's1'].map((id) => ({ id, category: { t: 'top', b: 'bottom', s: 'shoes' }[id[0]], colors: [], styleTags: [], seasons: [] }));

  it('keeps only real ids, and example outfits made only from the capsule', async () => {
    stubFetch(asJson({
      itemIds: ['t1', 'b1', 's1', 'ghost', 't1'],
      outfits: [{ itemIds: ['t1', 'b1', 's1'] }, { itemIds: ['t2', 'b1', 's1'] }, { itemIds: ['ghost', 's1'] }],
      explanation: 'Neutral and easy to mix.',
    }));
    const result = await buildCapsule({ provider: makeProvider(), wardrobe, size: 3 });
    expect(result.itemIds).toEqual(['t1', 'b1', 's1']);
    // t2 isn't in the capsule, so that outfit shrinks to b1 + s1; the ghost one is dropped.
    expect(result.outfits).toEqual([['t1', 'b1', 's1'], ['b1', 's1']]);
  });

  it('asks for the size and season given', async () => {
    const calls = stubFetch(asJson({ itemIds: ['t1'], outfits: [], explanation: '' }));
    await buildCapsule({ provider: makeProvider(), wardrobe, size: 12, season: 'winter' });
    const prompt = calls[0].body.messages[1].content;
    expect(prompt).toContain('Number of pieces: 5');
    expect(prompt).toContain('Season: winter');
  });

  it('refuses a wardrobe too small to choose from, without a request', async () => {
    const calls = stubFetch(asJson({}));
    await expect(buildCapsule({ provider: makeProvider(), wardrobe: wardrobe.slice(0, 2) })).rejects.toThrow('Add a few more pieces');
    expect(calls).toHaveLength(0);
  });
});

describe('finding each piece in a mirror photo', () => {
  it('asks for a box per item, and gives each item its own crop', async () => {
    const calls = stubFetch(asJson({
      items: [
        { ...TOP, box: [180, 300, 520, 700] },
        { ...SHOES, box: [880, 320, 980, 680] },
        { ...TOP, category: 'bottom', description: 'jeans', box: [] },
      ],
    }));
    const { items } = await tagPhoto(PHOTO, { provider: makeProvider() });

    const schema = calls[0].body.response_format.json_schema.schema.properties.items.items;
    expect(schema.required).toContain('box');
    expect(calls[0].body.messages[0].content).toContain('mirror');

    expect(items[0].crop).toMatchObject({ unit: 'percent' });
    expect(items[0].crop.y).toBeLessThan(18);
    expect(items[1].crop.y).toBeGreaterThan(80);
    // A box it couldn't give leaves the full photo, croppable by hand.
    expect(items[2].crop).toBeNull();
  });

  it('locates an already-saved piece and returns a crop, or null if it is not there', async () => {
    const calls = stubFetch(asJson({ found: true, box: [100, 200, 500, 800] }));
    const crop = await locateItem(PHOTO, { provider: makeProvider(), item: { category: 'top', colors: ['navy'], notes: 'navy crew-neck tee' } });
    expect(crop).toMatchObject({ unit: 'percent' });
    expect(calls[0].body.messages[1].content[0].text).toContain('navy crew-neck tee');

    stubFetch(asJson({ found: false, box: [] }));
    expect(await locateItem(PHOTO, { provider: makeProvider(), item: { category: 'shoes' } })).toBeNull();
  });
});

describe('Gemini reasoning effort', () => {
  it('asks Gemini and the built-in AI to think less, which took tagging from 53s to under 3s', async () => {
    for (const presetId of ['gemini', 'builtin']) {
      const calls = stubFetch(asJson(PICK));
      await outfitCall(makeProvider({ presetId }));
      expect(calls[0].body.reasoning_effort).toBe('low');
    }
  });

  it('never sends it to OpenAI or a Custom provider, which can reject it', async () => {
    for (const presetId of ['openai', 'custom', 'anthropic']) {
      const calls = stubFetch(asJson(PICK));
      await outfitCall(makeProvider({ presetId }));
      expect(calls[0].body).not.toHaveProperty('reasoning_effort');
    }
  });
});

describe('photo check: pieces that are not in the wardrobe yet', () => {
  it('describes and locates each worn piece, so an unknown one can be added straight away', async () => {
    const calls = stubFetch(asJson({
      wearing: [
        { category: 'top', description: 'grey zip hoodie', itemId: '', colors: ['grey'], styleTags: ['casual'], seasons: ['autumn'], weather: ['cool'], box: [200, 250, 600, 750] },
        { category: 'bottom', description: 'light jeans', itemId: '', colors: [], styleTags: [], seasons: [], weather: [], box: [] },
      ],
      verdict: 'Easy.',
      working: [],
      tweaks: [],
    }));
    const result = await analyzeOutfitPhoto(PHOTO, { provider: makeProvider(), wardrobe: [] });

    expect(calls[0].body.response_format.json_schema.schema.properties.wearing.items.required).toEqual(expect.arrayContaining(['colors', 'box']));
    const [hoodie, jeans] = result.wearing;
    expect(hoodie.itemId).toBe('');
    expect(hoodie.piece).toMatchObject({ category: 'top', colors: ['grey'], notes: 'grey zip hoodie' });
    expect(hoodie.piece.seasons).toEqual(expect.arrayContaining(['autumn', 'cool']));
    expect(hoodie.piece.crop).toMatchObject({ unit: 'percent' });
    // No box: still addable, just shown with the whole photo.
    expect(jeans.piece).toMatchObject({ category: 'bottom', crop: null });
  });
});

describe('free daily allowance used up', () => {
  const QUOTA = 'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash\nPlease retry in 12h26.580473394s.';
  const builtin = () => makeProvider({ presetId: 'builtin', label: 'Built-in AI (Gemini)', baseUrl: '/api/gemini', apiKey: 'passcode', model: 'gemini-3.6-flash', fallbackModel: 'gemini-3.8-flash' });

  it('says the daily allowance is used up and when it resets, not that the account is out of credit', async () => {
    stubFetch(failWith(429, QUOTA));
    const error = await outfitCall(builtin()).catch((caught) => caught);
    expect(error.message).toContain('used up today\'s free allowance; it resets in about 12 hours');
    expect(error.message).not.toContain('out of credit');
    expect(error.dailyQuota).toBe(true);
  });

  it('when the backup model is busy too, says both, and leaves it retryable', async () => {
    stubFetch(failWith(429, QUOTA), failWith(503, 'This model is currently experiencing high demand.'));
    const error = await outfitCall(builtin()).catch((caught) => caught);
    expect(error.message).toContain('used up today\'s free allowance');
    expect(error.message).toContain('backup model is busy');
    expect(error.status).toBe(503);
    expect(error.dailyQuota).toBeFalsy();
  });

  it('still treats a per-minute rate limit as a short wait', async () => {
    stubFetch(failWith(429, 'Rate limit reached for requests per minute.'));
    await expect(outfitCall(makeProvider({ fallbackModel: '' }))).rejects.toThrow('Wait a minute and try again');
  });
});

describe('remembering a used-up daily allowance', () => {
  const QUOTA = 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20\nPlease retry in 2h0m0s.';
  const gemini = () => makeProvider({ presetId: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.6-flash', fallbackModel: 'gemini-3.8-flash' });

  it('stops asking a model once its allowance is used up, and goes straight to the backup', async () => {
    const first = stubFetch(failWith(429, QUOTA), asJson(PICK));
    await outfitCall(gemini());
    expect(first.map((call) => call.body.model)).toEqual(['gemini-3.6-flash', 'gemini-3.8-flash']);

    const second = stubFetch(asJson(PICK));
    await outfitCall(gemini());
    expect(second.map((call) => call.body.model)).toEqual(['gemini-3.8-flash']);
  });

  it('makes no request at all when both models are used up, and says when they reset', async () => {
    stubFetch(failWith(429, QUOTA));
    await outfitCall(gemini()).catch(() => {});
    const calls = stubFetch(asJson(PICK));
    const error = await outfitCall(gemini()).catch((caught) => caught);
    expect(calls).toHaveLength(0);
    expect(error.message).toMatch(/used up today's free allowance; it resets in about 2 hours/);
    expect(error.dailyQuota).toBe(true);
  });

  it('asks again once the reset time has passed', async () => {
    const { markExhausted, isExhausted } = await import('../src/lib/ai.js');
    const provider = gemini();
    markExhausted(provider, 'gemini-3.6-flash', 1000, 0);
    expect(isExhausted(provider, 'gemini-3.6-flash', 500)).toBe(true);
    expect(isExhausted(provider, 'gemini-3.6-flash', 1500)).toBe(false);
  });

  it('without a reset time, assumes midnight Pacific', async () => {
    const { nextPacificMidnight } = await import('../src/lib/ai.js');
    // 2026-10-08 20:00 UTC is 13:00 in Los Angeles (PDT), so 11 hours to midnight.
    const now = new Date('2026-10-08T20:00:00Z');
    expect((nextPacificMidnight(now) - now.getTime()) / 3600_000).toBeCloseTo(11);
  });

  it('a photo with nothing in it costs one look on the other model, but not if that model is used up', async () => {
    const { markExhausted } = await import('../src/lib/ai.js');
    const provider = gemini();
    markExhausted(provider, 'gemini-3.8-flash', 3600_000);
    const calls = stubFetch(asJson({ items: [] }));
    const result = await tagPhoto(PHOTO, { provider });
    expect(calls).toHaveLength(1);
    expect(result.items).toEqual([]);
  });
});
