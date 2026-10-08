// Vercel serverless route for the built-in AI. All the logic lives in
// server/geminiProxy.js; this only adapts Vercel's request and response.
import { handleGeminiProxy } from '../../../server/geminiProxy.js';

export default async function handler(req, res) {
  const { status, body } = await handleGeminiProxy({
    method: req.method,
    authorization: req.headers.authorization,
    body: req.body,
    env: process.env,
    // Vercel puts the caller's address first in x-forwarded-for.
    client: String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim(),
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}
