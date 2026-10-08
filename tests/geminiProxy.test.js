import { describe, expect, it, vi } from 'vitest';

import { GEMINI_ENDPOINT, handleGeminiProxy } from '../server/geminiProxy.js';

const env = { GEMINI_API_KEY: 'AIza-server-key', APP_PASSCODE: 'open sesame' };
const chat = { model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 2000 };

function geminiReplies(status, body) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function call(overrides = {}) {
  return handleGeminiProxy({ method: 'POST', authorization: 'Bearer open sesame', body: chat, env, fetchImpl: geminiReplies(200, { choices: [] }), ...overrides });
}

describe('built-in AI route', () => {
  it('forwards an allowed request to Gemini with the server key, never the passcode', async () => {
    const fetchImpl = geminiReplies(200, { choices: [{ message: { content: '{}' } }] });
    const result = await call({ fetchImpl });

    expect(result.status).toBe(200);
    expect(result.body.choices).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(GEMINI_ENDPOINT);
    expect(init.headers.Authorization).toBe('Bearer AIza-server-key');
    expect(init.body).not.toContain('open sesame');
  });

  it('rejects a missing or wrong passcode without calling Gemini', async () => {
    for (const authorization of [undefined, '', 'Bearer nope', 'Bearer open sesame!']) {
      const fetchImpl = geminiReplies(200, {});
      const result = await call({ authorization, fetchImpl });
      expect(result.status).toBe(401);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('says it is not set up, rather than accepting anything, when either secret is missing', async () => {
    for (const partial of [{}, { GEMINI_API_KEY: 'k' }, { APP_PASSCODE: 'p' }]) {
      const fetchImpl = geminiReplies(200, {});
      const result = await call({ env: partial, fetchImpl });
      expect(result.status).toBe(503);
      expect(result.body.error.message).toMatch(/GEMINI_API_KEY and APP_PASSCODE/);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('only allows the app\'s own models, and GEMINI_MODELS can change the list', async () => {
    const blocked = await call({ body: { ...chat, model: 'gemini-ultra-pro-max' } });
    expect(blocked.status).toBe(400);

    const fetchImpl = geminiReplies(200, { choices: [] });
    const renamed = await call({ env: { ...env, GEMINI_MODELS: 'gemini-4-flash, gemini-4-flash-lite' }, body: { ...chat, model: 'gemini-4-flash' }, fetchImpl });
    expect(renamed.status).toBe(200);
  });

  it('caps max_tokens, and fills it in when missing', async () => {
    const fetchImpl = geminiReplies(200, { choices: [] });
    await call({ body: { ...chat, max_tokens: 999999 }, fetchImpl });
    await call({ body: { model: chat.model, messages: chat.messages }, fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).max_tokens).toBe(4000);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).max_tokens).toBe(4000);
  });

  it('turns Gemini rejecting the server key into a host setup error, not a passcode error', async () => {
    const result = await call({ fetchImpl: geminiReplies(401, { error: { message: 'API key not valid' } }) });
    expect(result.status).toBe(502);
    expect(result.body.error.message).toMatch(/GEMINI_API_KEY/);

    // What Google actually sends for an invalid key: a 400, wrapped in an array.
    const live = await call({ fetchImpl: geminiReplies(400, [{ error: { code: 400, message: 'Please pass a valid API key' } }]) });
    expect(live.status).toBe(502);
    expect(live.body.error.message).toMatch(/GEMINI_API_KEY/);

    // An ordinary bad request is still the app's problem, passed through as-is.
    const other = await call({ fetchImpl: geminiReplies(400, { error: { message: 'Invalid JSON payload' } }) });
    expect(other.status).toBe(400);
  });

  it('passes Gemini\'s own errors (like a rate limit) through unchanged', async () => {
    const result = await call({ fetchImpl: geminiReplies(429, { error: { message: 'Resource exhausted' } }) });
    expect(result.status).toBe(429);
    expect(result.body.error.message).toBe('Resource exhausted');
  });

  it('refuses anything but a JSON POST', async () => {
    expect((await call({ method: 'GET' })).status).toBe(405);
    expect((await call({ body: null })).status).toBe(400);
    expect((await call({ body: [chat] })).status).toBe(400);
  });

  it('reports an unreachable Gemini as a 502', async () => {
    const result = await call({ fetchImpl: vi.fn(async () => { throw new TypeError('fetch failed'); }) });
    expect(result.status).toBe(502);
  });
});
