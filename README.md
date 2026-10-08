# Outfit Picker

[![CI](https://github.com/rishabhrayy/outfit-picker/actions/workflows/ci.yml/badge.svg)](https://github.com/rishabhrayy/outfit-picker/actions/workflows/ci.yml) [![Live](https://img.shields.io/badge/live-outfit.rishabhray.me-7fa5ff)](https://outfit.rishabhray.me) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Outfit Picker is a private, single-person wardrobe app that runs entirely in the browser. Add photos of your clothes, review the automatically suggested tags, browse your wardrobe, and ask for an outfit based on the occasion, weather, vibe, and an item you want to wear.

It is a Progressive Web App (PWA), so a deployed copy can be installed on a phone home screen and opened like an app. There are no accounts, servers, or cloud sync.

## What it does

- Stores uploaded photo blobs and wardrobe records in this browser's IndexedDB database.
- Tags one garment or several visible garments from a casual photo, then lets you review and edit the batch before saving.
- Keeps category, colours, style, season/weather, notes, source-photo, and last-worn information for each item.
- Filters the local wardrobe before requesting an outfit, gives recently worn items a lower priority, and lets you mark a suggestion as worn.
- Learns from **Love it** and **Never suggest this**, skips pieces that are **out of rotation** (in the wash, at the cleaner's, being repaired), and can fill in the weather from a **live forecast**.
- Logs **today's outfit from one mirror photo**, matched to your saved pieces, with honest written feedback.
- **Plans a week** of outfits, **packs for a trip**, and **builds a capsule** from what you already own (see [Planning and feedback](#planning-and-feedback)).
- Backs the whole wardrobe up to one file and restores it, here or on another device (see [Backup and restore](#backup-and-restore)).
- Works with any OpenAI-compatible AI provider — add as many as you like in Settings and switch between them.

### Choosing a provider

Settings manages a list of providers rather than one fixed choice: add one from a preset (base URL, a sensible model, and how it returns structured JSON all prefilled) or add a **Custom** one by hand with any base URL, model, and key. Whichever is marked active is the one tagging and outfit suggestions use. A key is stored separately per provider, so switching back and forth never means pasting a key in again, and the app only ever sends a key to the provider it belongs to.

| Preset | Tags with | Retries on | Get a key at |
| --- | --- | --- | --- |
| Anthropic (Claude) | `claude-haiku-4-5-20251001` | `claude-sonnet-5` | platform.claude.com/settings/keys |
| OpenAI | `gpt-4o-mini` | `gpt-4o` | platform.openai.com/api-keys |
| Google Gemini | `gemini-3.6-flash` | `gemini-3.8-flash` | aistudio.google.com/apikey |
| Groq | Qwen 3.6 27B | Qwen 3.8 27B | console.groq.com/keys |
| OpenRouter | `openrouter/free` | — | openrouter.ai/keys |
| Mistral, Together AI, DeepSeek, xAI | see each preset in Settings | | |

Providers vary in how reliably they return the exact JSON shape the app asks for, so each one is tried at the best tier it actually supports, in order: a strict schema (`response_format: json_schema`), a forced tool call, a plain JSON-object request, then a plain-text request with the JSON pulled out of the reply by hand. "Auto-detect" (the default for a new or Custom provider) starts at the top and steps down automatically the first time it's used, then remembers what worked so later calls skip straight to it. A preset with a documented quirk is pinned directly to the tier that actually works for it — Anthropic's OpenAI-compatible endpoint silently ignores `response_format` entirely, for instance, so its preset is pinned to forced tool-calling rather than wasting a call finding that out. Advanced settings on each provider can also override this by hand.

Two other differences worth knowing. On several presets the retry escalates to a genuinely stronger model; on Gemini the pro tier answers `429` on a standard key, so the retry goes to a newer flash model of the same class instead, and Gemini 3.x models reason before answering, spending roughly 500 tokens before writing anything, so the app gives Gemini a much larger `max_tokens` budget than most other presets — too small a budget returns an empty reply with `finish_reason: "length"`. And Anthropic's API refuses direct browser requests unless a request carries `anthropic-dangerous-direct-browser-access: true` — Anthropic's own documented opt-in for exactly this kind of bring-your-own-key client-side app; the app adds it automatically for any provider whose base URL points at `api.anthropic.com`, including a hand-added Custom one.

If a key is pasted that looks like it belongs to a different provider than the one selected, the app says so directly rather than reporting a rejected key, both in Settings and on the failed request. Use **Test connection** (and **Test photo tagging**, which also checks vision support) on a provider before relying on it — it reports the provider's exact status and error text without spending a real photo upload.

### Photos, items, and crops

Several items can be detected in one photo, and all of them point back to that single stored photo rather than getting their own copy of the pixels. Each item keeps its own zoom-and-position crop, applied when the item is displayed, so you can pull the shoes out of a full-length mirror shot without re-uploading anything. Crops can be changed at any time from the item editor, and the original photo is never altered.

Uploaded photos are re-encoded to a resized JPEG before they are stored, which keeps browser storage small and converts iPhone HEIC files into a format every browser can display. A photo is deleted automatically once the last item that referenced it is gone.

### Working without an API key

The key is only needed for the two AI features. Without one you can still add photos, tag items by hand, browse and edit the wardrobe, and get a simple locally assembled outfit suggestion. Tagging and the styled explanation need the key.

### Season and weather vocabulary

**Season / weather** is a controlled list, so words outside it are dropped when an item is saved. The recognised values are `spring`, `summer`, `autumn`, `winter`, `all-season`, `cold`, `cool`, `mild`, `warm`, `hot`, `rainy`, and `windy`. **Style tags** is free text and is the right place for anything else.

## Planning and feedback

These came out of reviewing what other wardrobe apps offer and what reviewers complain about: people stop logging what they wear because it's tedious, and AI suggestions that ignore feedback lose trust.

- **Out of rotation.** Mark a piece as in the wash, at the dry cleaner, needing repair, or away, from the item editor or several at once in **Select pieces**. Suggestions, shuffles, week plans, trips and capsules all skip it until it's back. On laundry day, filter by **Out of rotation**, **Select all**, then **Back in rotation**.
- **Love it / Never suggest this.** On any suggestion. A loved outfit nudges its pieces up the ranking (capped, so it never beats the weather) and is shown to the AI stylist as a guide to your taste. **Never suggest this** rules out the defining pairing (the top with that bottom, or the dress with those shoes), not every piece in the outfit, and the shuffle and local pick avoid it whenever another choice exists. If the AI returns a ruled-out pairing anyway, it isn't shown. Both are ordinary records in the journal, so they're backed up, and **Journal > Show pairings you ruled out > Allow again** undoes one.
- **Live weather** (Settings, off by default). Type a city, or use your location rounded to about 10 km before it's stored or sent. Forecasts come from [Open-Meteo](https://open-meteo.com), which is free and needs no account. The Outfit screen then fills in the weather, shows the day's range and rain chance, and tells the AI stylist the forecast. Tapping a weather chip overrides it for that request.
- **Today's outfit from a photo** (Outfit > **Already dressed?**, or Journal > **Log from a photo**). One AI call reads the photo: which saved pieces you're wearing, each correctable from a list before logging, plus written feedback on what works and what's worth trying, sometimes naming a piece from your wardrobe to swap in. There's deliberately no score; a number from a model looking at one photo would be made up. Only that photo and text about your wardrobe are sent, never your wardrobe photos.
- **Plan my week** (Journal > **Plan ahead**). Seven outfits with no top, bottom or dress repeated until each has been worn, separate occasions for weekdays and the weekend, and each day dressed for its forecast when live weather is on. Local and instant, so it works without AI and can't be rate-limited partway through. ↻ reshuffles one day; **Save to my journal** saves them as planned outfits.
- **Pack for a trip.** The fewest pieces that cover every day: bottoms and shoes are re-worn, tops rotate, neutral colours are preferred because they pair with more, and one layer is packed only if a day is cold or wet. With a destination, its forecast is used for any day in the next 16; otherwise, or beyond that, the weather you pick. Produces a tick-off packing list and an outfit per day.
- **Build a capsule** (needs AI). The AI picks 10, 12 or 15 of your available pieces that mix into the most outfits, with example outfits made only from those pieces. Anything it names that isn't in the capsule is dropped.

## Requirements

- A current Node.js LTS release (Node 20 or newer is recommended) and npm.
- An API key from any supported provider for the optional AI features (see [Choosing a provider](#choosing-a-provider)). Tagging and outfit suggestions need an internet connection; viewing your already saved wardrobe does not.

## Run locally

In PowerShell, from the project folder:

```powershell
Set-Location 'C:\path\to\outfit-picker'
npm install
npm run dev
```

Vite prints the local URL (normally `http://localhost:5173`). Open it in a browser.

To make a production build and inspect it locally:

```powershell
npm run build
npm run preview
```

The production files are written to `dist`.

## The built-in AI (no key in the browser)

The deployed site can hold one Gemini key itself, so nobody pastes a key into the app. A small serverless route, [`api/gemini/chat/completions.js`](api/gemini/chat/completions.js) (logic in [`server/geminiProxy.js`](server/geminiProxy.js)), forwards the app's requests to Gemini with a key read from the host's environment. The key never reaches the browser.

Because the site is public, a **passcode** guards that key: in **Settings > Use the built-in AI**, enter it once per device and it is checked with a real request before saving. The route also only allows the app's own two Gemini models and caps `max_tokens` at 4000, so a leaked passcode can't be pointed at anything pricier. Photos pass through the route only while one is being tagged; nothing is stored.

To set it up on Vercel:

1. Create a Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). A free-tier key (no billing on its Google Cloud project) can't run up a bill, only hit its rate limit.
2. In the Vercel dashboard, open the project, then **Settings > Environment Variables**, and add:
   - `GEMINI_API_KEY`: the key. Mark it **Sensitive**.
   - `APP_PASSCODE`: a long passphrase of your choosing. Mark it **Sensitive**.
   - Optional: `GEMINI_MODELS`, a comma-separated list, only if Google renames the models.
3. Redeploy (**Deployments > ⋯ > Redeploy**). Environment variables only apply to new deployments.
4. In the app, go to **Settings**, type the passcode under **Use the built-in AI**, and select **Connect**.

Until both variables are set, the route answers "not set up yet" and refuses every request. To run it locally, put the same two variables in `.env.local` (git-ignored) and use `npm run dev`. Or, to use the key already on the host without copying it to your machine, put `BUILTIN_AI_UPSTREAM=https://your-deployed-site` in `.env.local` instead, and the dev server forwards the route there. To change the passcode, change `APP_PASSCODE`, redeploy, then remove and reconnect the built-in AI on each device.

Bring-your-own-key providers below still work alongside it.

## Add an API key

1. Create a personal API key with your chosen provider (see the table above for where).
2. Open Outfit Picker, go to **Settings**, and select **＋ Add a provider**.
3. Pick a preset (or **Custom** for anything not listed), paste the key into the key field, and save. The first provider you add becomes active automatically.
4. Upload a photo or request an outfit. The app uses the key only when it makes a request.

The app begins photo tagging with the selected provider's smaller model. If the returned tags are incomplete or malformed, it retries that photo once on the stronger model. Outfit selection is based on structured local item data, not a second upload of the clothing photos.

### Important API-key security trade-off

This project deliberately follows a bring-your-own-key, browser-only design: each key is kept in this browser's `localStorage` and calls its provider directly. That matches the no-backend, one-person scope, but it is **not a secure pattern for a public or multi-user web app**. Every provider here advises against exposing an API key in browser or app client code; a production shared app should keep its key on a server-side service instead. See [OpenAI's](https://developers.openai.com/api/reference/overview), [Google's](https://ai.google.dev/gemini-api/docs/api-key), and [Anthropic's](https://platform.claude.com/docs/en/api/overview) guidance.

Use this only on a device and browser profile you control. Someone with access to the unlocked browser profile, or malicious code running on the same site, could retrieve the key and spend against your account. Do not put a key in source code, a `.env` file committed to Git, Vercel/Netlify public variables, screenshots, a shared link, or a chat message. Prefer a dedicated key with a conservative budget and alerts, and revoke it in the provider's dashboard if you think it has been exposed.

## Privacy and local data

- Wardrobe items and image blobs stay in IndexedDB for the browser profile where they were added. There is no account, backend database, or cloud sync; moving a wardrobe between devices is a backup file you control.
- Saved API keys live separately in `localStorage`, one per provider; they are not bundled into the deployed app.
- When auto-tagging, the selected image is sent to the chosen provider. When suggesting an outfit, the app sends the relevant item metadata and last-worn dates, rather than re-sending the item images. Reading today's outfit photo sends that one photo plus the same kind of text about your wardrobe; building a capsule sends text only.
- Live weather is off until you turn it on. When on, only a city's coordinates, or your location rounded to about 10 km, go to Open-Meteo; nothing about your wardrobe does.
- **Clear wardrobe data** permanently removes the local wardrobe records and their stored photo blobs. It leaves your saved keys alone. Clearing browser/site data removes the wardrobe and the keys.

Browser storage can be cleared by browser settings, private-browsing behaviour, device cleanup tools, or a profile reset, so download a backup now and then.

## Backup and restore

**Settings > Backup** saves everything (items, outfits and journal, and every photo) to a single `outfit-picker-backup-YYYY-MM-DD.json` file. **Restore from a backup** loads one back:

- **Nothing is deleted.** Records are matched by id: ones in the file replace their copies here, and everything else stays, so restoring the same file twice changes nothing.
- **All or nothing.** The restore is one IndexedDB transaction, so a failure part-way leaves the wardrobe exactly as it was.
- **Keys are never included.** They live in `localStorage`, which the backup never reads, so a backup file is safe to keep in cloud storage.
- **A bad file gets a plain reason**: not JSON, not a backup, made by a newer version, or damaged.

### On an iPhone's home screen

A normal download link is widely reported not to work in a web app launched from an iPhone's home screen, so there the backup goes through the share sheet instead, in two taps: **Prepare backup** builds the file, then **Save backup** opens the sheet — choose **Save to Files**. It takes two taps because Safari only lets the share sheet open straight from a tap, and building a backup is too slow to wait for first. Everywhere else (desktop, Android, a Safari tab) it is still one tap and a normal download.

Which file types may be shared is up to the browser, so the app asks it about the actual file: JSON first, then the same bytes as plain text (saved as `….json.txt`) if JSON is refused. **Restore from a backup** accepts both. If the browser will share neither, the card says so and offers a direct download as a last resort.

This was verified against a simulated iPhone home-screen app (user agent, `standalone`, a recording `share()`), including that the sheet is opened while the tap's user activation is still live — but not on a physical iPhone, so try **Prepare backup** then **Save backup** on yours before relying on it.

A backup is built in memory as one file with the photos inside as base64, so a very large wardrobe makes a large file; the size is shown in the toast and on the Save button.

## Tests

```bash
npm test
```

182 tests (Vitest, with `fake-indexeddb` standing in for the browser and a stubbed `fetch` standing in for every AI provider):

- **Backup**: round-trips photo bytes exactly, restores by id without duplicating or deleting, skips items whose photo is missing, never contains a key, and rejects bad files.
- **AI requests**: what each of the four structured-output modes (strict schema, forced tool call, JSON object, plain text) actually sends and how it reads the reply; the auto-detect ladder stepping down in order, and *not* burning four calls on a rejected key or a rate limit; the retry on the stronger model (for outfits too, but never after a rejected key, a timeout or a lost connection); the Anthropic browser-access header; timeouts and cancelling; and the wording of every error message a person can hit.
- **Built-in AI route**: a wrong or missing passcode never reaches Gemini, the server key goes to Google and the passcode doesn't, only the allowed models get through, `max_tokens` is capped, and Google rejecting the server's key (which it reports as a 400) reads as a host setup problem rather than a wrong passcode.
- **Provider settings**: the provider list, the active-provider fallback, corrupt or blocked storage, and the move from the old one-key-per-provider storage that must never lose a saved key.
- **Bulk edit**: adding a tag merges into each item's own tags rather than replacing them, and a season change is split back into stored season and weather.
- **Share sheet**: iPhone home-screen detection, the JSON-then-text fallback, and that `share()` starts before anything is awaited.
- **Outfit logic and key detection**: weather ranking that never drops a category, a requested item always kept, no dress mixed with separates, and key mismatch warnings that fire for a real mismatch but not for providers that share a prefix.
- **Planning and feedback**: out-of-rotation pieces never suggested unless asked for by name; a ruled-out pairing never shuffled while another exists, but an outfit still made when every pairing is ruled out; loved pieces nudged up but never past the weather; a week plan with every day complete and no top or bottom repeated early; a trip packing fewer pieces than days, wearing only what's packed, and adding a layer only for cold or wet days.
- **Weather**: the forecast turned into the app's weather words; a location sent and stored only rounded to about 10 km; place search; and plain messages when the service is down.
- **Photo check and capsule**: invented ids dropped, one saved piece never matched twice, capsule outfits limited to capsule pieces, and the fallback-model retry on both.

The suite was also checked the other way round: deliberately breaking the code in eight specific ways (for example, skipping the tool-call tier or letting `share()` wait) makes tests fail each time, so a green run means something. CI runs the tests and a production build on every push.

## Install it as an app

Install from a deployed HTTPS site. Browsers treat `localhost` as a development exception, but a normal deployed PWA needs HTTPS for its service worker and install experience.

- **Android (Chrome/Edge):** open the site, then use the browser's **Install app** / **Add to Home screen** prompt or menu.
- **iPhone/iPad (Safari):** open the site in Safari, choose **Share**, then **Add to Home Screen**.
- **Desktop Chrome/Edge:** use the install icon in the address bar or the browser menu.

The included manifest and service worker cache the application shell for an app-like launch. AI calls still require a connection, and the wardrobe remains tied to that browser's local storage.

## Deploy as a PWA

Build and deploy the static `dist` folder. There are no server-side environment variables to set for this app: you enter your own API key locally after opening it, and it never leaves your device except to go to the provider.

### Vercel

1. Push the project to a Git repository and import it in Vercel.
2. Select the **Vite** preset (or leave automatic detection enabled).
3. Use `npm run build` as the build command and `dist` as the output directory.
4. Deploy, then open the HTTPS URL on a phone and install it using the steps above.

### Netlify

1. Create a new site from the Git repository in Netlify.
2. Set the build command to `npm run build`.
3. Set the publish directory to `dist`.
4. Deploy and use the generated HTTPS address to install the PWA.

The current manifest uses `/` as its start URL, so deploy it at the root of a domain. If you later host it below a subpath, update the Vite base/manifest start URL to match before building.

## Useful checks

| Symptom | What to check |
| --- | --- |
| Tagging or suggestions fail immediately | Confirm that a valid API key is saved in **Settings** and that the device is online. |
| The key is rejected | Check that the selected provider matches the key you pasted; the app warns when they disagree. Otherwise create a fresh key and check the account's billing/usage. |
| The install option is missing | Use the deployed HTTPS URL in a supported browser; a localhost development page is not a useful installation test. |
| Saved items disappeared | Check whether browser/site data was cleared or whether you opened the app in a different browser profile/device. Local data does not sync. |

## Project structure

- `src/App.jsx` — every screen, plus `src/App.css` for the styling.
- `src/services.js` — the only module that joins storage and the API to the UI.
- `src/lib/db.js` — IndexedDB reads and writes for photos and items.
- `src/lib/ai.js` — the AI calls (tagging, outfit suggestion, outfit photo, capsule), their prompts, and their JSON schemas.
- `src/lib/providers.js` — base URLs, model names, and token budgets per provider.
- `src/lib/image.js` — resize and re-encode a picked photo for storage and upload.
- `src/lib/crop.js` — crop geometry shared by the review, wardrobe, and editor views.
- `src/lib/outfit.js` — local ranking, shuffle, feedback rules, the week planner and the trip packer.
- `src/lib/weather.js` — Open-Meteo forecasts and place search, with locations rounded to about 10 km.
- `src/lib/settings.js` — the provider choice, per-provider API keys, repeat window and weather location in `localStorage`.
- `src/types.js` — the canonical record shapes and their normalizers.
- `public/` — app icons: `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, and `apple-touch-icon.png` for iOS.
- `api/gemini/chat/completions.js` and `server/geminiProxy.js` — the built-in AI route, holding the Gemini key on the host behind a passcode.
- `vite.config.js` — Vite and PWA manifest/service-worker configuration, plus the built-in AI route for `npm run dev`.

## Licence

[MIT](LICENSE)
