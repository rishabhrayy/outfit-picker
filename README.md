# Outfit Picker

Outfit Picker is a private, single-person wardrobe app that runs entirely in the browser. Add photos of your clothes, review the automatically suggested tags, browse your wardrobe, and ask for an outfit based on the occasion, weather, vibe, and an item you want to wear.

It is a Progressive Web App (PWA), so a deployed copy can be installed on a phone home screen and opened like an app. There are no accounts, servers, or cloud sync.

## What it does

- Stores uploaded photo blobs and wardrobe records in this browser's IndexedDB database.
- Tags one garment or several visible garments from a casual photo, then lets you review and edit the batch before saving.
- Keeps category, colours, style, season/weather, notes, source-photo, and last-worn information for each item.
- Filters the local wardrobe before requesting an outfit, gives recently worn items a lower priority, and lets you mark a suggestion as worn.
- Works with either OpenAI or Google Gemini, chosen in Settings.

### Choosing a provider

Settings has a provider switch. Google publishes an OpenAI-compatible endpoint, so both take the same request shape and the app only changes the base URL, the model names, and the token budget.

| | OpenAI | Google Gemini |
| --- | --- | --- |
| Tags with | `gpt-4o-mini` | `gemini-3.6-flash` |
| Retries on | `gpt-4o` | `gemini-3.8-flash` |
| Get a key at | platform.openai.com/api-keys | aistudio.google.com/apikey |
| Cost | Paid; needs credit on the account | Has a free tier |

A key is stored separately per provider, so switching back and forth does not mean pasting a key in again. The app only ever sends a key to the provider it belongs to.

Two differences worth knowing. On OpenAI the retry escalates to a genuinely larger model; on Gemini the pro tier answers `429` on a standard key, so the retry goes to a newer flash model of the same class instead. And Gemini 3.x models reason before answering, spending roughly 500 tokens before writing anything, so the app gives Gemini a much larger `max_tokens` budget — too small a budget returns an empty reply with `finish_reason: "length"`.

If a key is pasted while the wrong provider is selected, the app says so directly rather than reporting a rejected key, both in Settings and on the failed request.

### Photos, items, and crops

Several items can be detected in one photo, and all of them point back to that single stored photo rather than getting their own copy of the pixels. Each item keeps its own zoom-and-position crop, applied when the item is displayed, so you can pull the shoes out of a full-length mirror shot without re-uploading anything. Crops can be changed at any time from the item editor, and the original photo is never altered.

Uploaded photos are re-encoded to a resized JPEG before they are stored, which keeps browser storage small and converts iPhone HEIC files into a format every browser can display. A photo is deleted automatically once the last item that referenced it is gone.

### Working without an API key

The key is only needed for the two AI features. Without one you can still add photos, tag items by hand, browse and edit the wardrobe, and get a simple locally assembled outfit suggestion. Tagging and the styled explanation need the key.

### Season and weather vocabulary

**Season / weather** is a controlled list, so words outside it are dropped when an item is saved. The recognised values are `spring`, `summer`, `autumn`, `winter`, `all-season`, `cold`, `cool`, `mild`, `warm`, `hot`, `rainy`, and `windy`. **Style tags** is free text and is the right place for anything else.

## Requirements

- A current Node.js LTS release (Node 20 or newer is recommended) and npm.
- An API key from either OpenAI or Google Gemini for the optional AI features. Tagging and outfit suggestions need an internet connection; viewing your already saved wardrobe does not.

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

## Add an API key

1. Create a personal API key with your chosen provider: the [OpenAI API dashboard](https://platform.openai.com/api-keys) or [Google AI Studio](https://aistudio.google.com/apikey).
2. Open Outfit Picker and go to **Settings**.
3. Pick the matching provider, paste the key into the key field, and save.
4. Upload a photo or request an outfit. The app uses the key only when it makes a request.

The app begins photo tagging with the selected provider's smaller model. If the returned tags are incomplete or malformed, it retries that photo once on the stronger model. Outfit selection is based on structured local item data, not a second upload of the clothing photos.

### Important API-key security trade-off

This project deliberately follows a bring-your-own-key, browser-only design: the key is kept in this browser's `localStorage` and calls the provider directly. That matches the no-backend, one-person scope, but it is **not a secure pattern for a public or multi-user web app**. Both providers advise against exposing an API key in browser or app client code; a production shared app should keep its key on a server-side service instead. See OpenAI's [API authentication guidance](https://developers.openai.com/api/reference/overview) and Google's [API key guidance](https://ai.google.dev/gemini-api/docs/api-key).

Use this only on a device and browser profile you control. Someone with access to the unlocked browser profile, or malicious code running on the same site, could retrieve the key and spend against your account. Do not put a key in source code, a `.env` file committed to Git, Vercel/Netlify public variables, screenshots, a shared link, or a chat message. Prefer a dedicated key with a conservative budget and alerts, and revoke it in the provider's dashboard if you think it has been exposed.

## Privacy and local data

- Wardrobe items and image blobs stay in IndexedDB for the browser profile where they were added. There is no account, backend database, cloud backup, or cross-device sync.
- Saved API keys live separately in `localStorage`, one per provider; they are not bundled into the deployed app.
- When auto-tagging, the selected image is sent to the chosen provider. When suggesting an outfit, the app sends the relevant item metadata and last-worn dates, rather than re-sending the item images.
- **Clear wardrobe data** permanently removes the local wardrobe records and their stored photo blobs. It leaves your saved keys alone. Clearing browser/site data removes the wardrobe and the keys.

Keep a copy of original photos elsewhere if they matter to you. Browser storage can be cleared by browser settings, private-browsing behavior, device cleanup tools, or a profile reset.

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
- `src/lib/ai.js` — the two AI calls, their prompts, and their JSON schemas.
- `src/lib/providers.js` — base URLs, model names, and token budgets per provider.
- `src/lib/image.js` — resize and re-encode a picked photo for storage and upload.
- `src/lib/crop.js` — crop geometry shared by the review, wardrobe, and editor views.
- `src/lib/outfit.js` — local shortlisting before an outfit request.
- `src/lib/settings.js` — the provider choice, per-provider API keys, and repeat window in `localStorage`.
- `src/types.js` — the canonical record shapes and their normalizers.
- `public/` — app icons: `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, and `apple-touch-icon.png` for iOS.
- `vite.config.js` — Vite and PWA manifest/service-worker configuration.

