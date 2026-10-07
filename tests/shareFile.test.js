import { describe, expect, it, vi } from 'vitest';

import {
  canUseShareSheet,
  isIosStandalone,
  pickShareableFile,
  shareCandidates,
  shareFile,
} from '../src/lib/shareFile.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const media = (matches) => () => ({ matches });

describe('isIosStandalone', () => {
  it('is true for an iPhone launched from the home screen', () => {
    expect(isIosStandalone({ navigator: { userAgent: IPHONE, standalone: true }, matchMedia: media(false) })).toBe(true);
  });

  it('is true when only the display-mode media query reports standalone', () => {
    expect(isIosStandalone({ navigator: { userAgent: IPHONE }, matchMedia: media(true) })).toBe(true);
  });

  it('is false for an iPhone in an ordinary Safari tab, where a normal download works', () => {
    expect(isIosStandalone({ navigator: { userAgent: IPHONE, standalone: false }, matchMedia: media(false) })).toBe(false);
  });

  it('is false on Android and desktop even when the app is installed there', () => {
    expect(isIosStandalone({ navigator: { userAgent: ANDROID, standalone: true }, matchMedia: media(true) })).toBe(false);
    expect(isIosStandalone({ navigator: { userAgent: WINDOWS }, matchMedia: media(true) })).toBe(false);
  });

  it('recognises an iPad, which reports itself as a Mac, but not a real Mac', () => {
    const ipad = { userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5, standalone: true };
    const mac = { userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 };
    expect(isIosStandalone({ navigator: ipad, matchMedia: media(false) })).toBe(true);
    expect(isIosStandalone({ navigator: mac, matchMedia: media(true) })).toBe(false);
  });

  it('is false rather than throwing when there is no navigator', () => {
    expect(isIosStandalone({ navigator: null })).toBe(false);
  });
});

describe('share candidates', () => {
  it('offers the same bytes as JSON first, then as plain text with an honest extension', () => {
    const blob = new Blob(['{"hello":"wardrobe"}'], { type: 'application/json' });
    const [json, text] = shareCandidates(blob, 'outfit-picker-backup-2026-10-07.json');

    expect(json.name).toBe('outfit-picker-backup-2026-10-07.json');
    expect(json.type).toBe('application/json');
    expect(text.name).toBe('outfit-picker-backup-2026-10-07.json.txt');
    expect(text.type).toBe('text/plain');
    expect(json.size).toBe(blob.size);
    expect(text.size).toBe(blob.size);
  });

  it('picks the first file the browser says it will share', () => {
    const files = shareCandidates(new Blob(['x']), 'b.json');
    const acceptsEverything = { share: vi.fn(), canShare: () => true };
    expect(pickShareableFile(files, acceptsEverything)).toBe(files[0]);
  });

  it('falls back to plain text when JSON is refused, as Chrome does', () => {
    const files = shareCandidates(new Blob(['x']), 'b.json');
    const textOnly = { share: vi.fn(), canShare: ({ files: [file] }) => file.type === 'text/plain' };
    expect(pickShareableFile(files, textOnly)).toBe(files[1]);
  });

  it('returns null when every type is refused, or the API is missing', () => {
    const files = shareCandidates(new Blob(['x']), 'b.json');
    expect(pickShareableFile(files, { share: vi.fn(), canShare: () => false })).toBeNull();
    expect(pickShareableFile(files, {})).toBeNull();
    expect(pickShareableFile(files, { share: vi.fn() })).toBeNull();
    expect(canUseShareSheet({ share: vi.fn(), canShare: () => true })).toBe(true);
    expect(canUseShareSheet(undefined)).toBe(false);
  });

  it('treats a canShare that throws as a refusal instead of crashing', () => {
    const files = shareCandidates(new Blob(['x']), 'b.json');
    const flaky = { share: vi.fn(), canShare: () => { throw new TypeError('nope'); } };
    expect(pickShareableFile(files, flaky)).toBeNull();
  });
});

describe('shareFile', () => {
  const file = new File(['x'], 'b.json', { type: 'application/json' });

  it('starts share() before it first awaits, so it keeps the tap that called it', () => {
    const nav = { share: vi.fn(() => new Promise(() => {})) };
    shareFile(file, nav); // deliberately not awaited
    expect(nav.share).toHaveBeenCalledTimes(1);
    expect(nav.share).toHaveBeenCalledWith({ files: [file] });
  });

  it('resolves "shared" when the share completes', async () => {
    await expect(shareFile(file, { share: vi.fn().mockResolvedValue(undefined) })).resolves.toBe('shared');
  });

  it('treats dismissing the sheet as a cancel, not an error', async () => {
    const dismissed = Object.assign(new Error('Share canceled'), { name: 'AbortError' });
    await expect(shareFile(file, { share: vi.fn().mockRejectedValue(dismissed) })).resolves.toBe('cancelled');
  });

  it('passes on anything else the browser throws, such as a lost user activation', async () => {
    const denied = Object.assign(new Error('Must be handling a user gesture'), { name: 'NotAllowedError' });
    await expect(shareFile(file, { share: vi.fn().mockRejectedValue(denied) })).rejects.toMatchObject({ name: 'NotAllowedError' });
  });
});
