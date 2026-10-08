/**
 * The built-in AI: a pass-through to Gemini's OpenAI-compatible endpoint, so
 * the app can work without anyone pasting an API key into the browser.
 *
 * The Gemini key lives only in the host's environment (GEMINI_API_KEY) and is
 * never sent to the browser. Because the site is public, a passcode
 * (APP_PASSCODE) stands between the internet and that key: the app sends it
 * as its "API key", which lets the existing provider pipeline in lib/ai.js
 * talk to this endpoint unchanged.
 *
 * Kept free of any host framework so the same function serves the Vercel
 * route (api/gemini/chat/completions.js), the Vite dev server, and the tests.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// Only these models may be requested, so a leaked passcode can't be pointed at
// a pricier model than the app itself uses. Override with GEMINI_MODELS
// (comma-separated) when Google renames them.
export const DEFAULT_ALLOWED_MODELS = ['gemini-3.6-flash', 'gemini-3.8-flash'];

// The app asks for at most 4000; anything above that isn't the app.
const MAX_TOKENS_CEILING = 4000;

function error(status, message) {
  return { status, body: { error: { message } } };
}

function sameSecret(given, expected) {
  // Hashing first gives equal-length buffers, which timingSafeEqual requires,
  // without leaking the passcode's length through an early return.
  const a = createHash('sha256').update(String(given)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

function allowedModels(env) {
  const configured = String(env.GEMINI_MODELS || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_ALLOWED_MODELS;
}

/**
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleGeminiProxy({ method, authorization, body, env = {}, fetchImpl = globalThis.fetch }) {
  if (method !== 'POST') return error(405, 'Use POST.');

  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  const passcode = String(env.APP_PASSCODE || '').trim();
  if (!apiKey || !passcode) {
    return error(503, 'The built-in AI is not set up on this site yet: GEMINI_API_KEY and APP_PASSCODE both need to be set on the host.');
  }

  const given = String(authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !sameSecret(given, passcode)) {
    return error(401, 'Wrong passcode for the built-in AI.');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return error(400, 'Expected a JSON chat request.');
  }

  const models = allowedModels(env);
  if (!models.includes(body.model)) {
    return error(400, `The built-in AI only allows these models: ${models.join(', ')}.`);
  }

  const forwarded = { ...body };
  if (typeof forwarded.max_tokens !== 'number' || forwarded.max_tokens > MAX_TOKENS_CEILING) {
    forwarded.max_tokens = MAX_TOKENS_CEILING;
  }

  let response;
  try {
    response = await fetchImpl(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(forwarded),
    });
  } catch {
    return error(502, 'Could not reach Gemini from the server. Try again.');
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: { message: text.slice(0, 300) } };
  }

  // Gemini rejecting the server's own key is a setup problem on the host, not
  // a wrong passcode — passing a 401 straight through would tell the person to
  // check the passcode they typed correctly. Google reports an invalid key as
  // a 400 "Please pass a valid API key", so that counts too (seen live).
  const message = String((Array.isArray(parsed) ? parsed[0] : parsed)?.error?.message || '');
  const badServerKey = response.status === 401 || response.status === 403
    || (response.status === 400 && /api key/i.test(message));
  if (badServerKey) {
    return error(502, 'Gemini rejected the key saved on the host. Check GEMINI_API_KEY in the Vercel project settings.');
  }

  return { status: response.status, body: parsed };
}
