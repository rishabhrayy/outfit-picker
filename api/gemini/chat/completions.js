// Vercel serverless route for the built-in AI. All the logic lives in
// server/geminiProxy.js; this only adapts Vercel's request and response.
import { handleGeminiProxy } from '../../../server/geminiProxy.js';

export default async function handler(req, res) {
  const { status, body } = await handleGeminiProxy({
    method: req.method,
    authorization: req.headers.authorization,
    body: req.body,
    env: process.env,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}
