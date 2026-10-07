/**
 * Hands a file to the operating system's share sheet, for the one place a plain
 * download link is unreliable: a web app installed to an iPhone's home screen.
 * There, a blob `<a download>` is widely reported to do nothing or to navigate
 * the app away to a page of raw text, while Safari's share sheet offers a
 * proper "Save to Files". Everywhere else (desktop, Android, an iOS Safari tab)
 * a normal download works, so this is only used when isIosStandalone() is true.
 *
 * Two rules from Safari shape how callers must use this:
 *   - share() must start synchronously inside a tap. Awaiting anything slow
 *     first (building a backup, reading IndexedDB) can make it fail with
 *     NotAllowedError, so the file is built beforehand and shareFile() is
 *     called straight from the click handler.
 *   - which file types may be shared is up to the browser, so canShare() is
 *     asked about the real file instead of assuming a type is allowed.
 */

const IOS_DEVICE = /iPad|iPhone|iPod/;

/** True only for an app launched from an iPhone/iPad home-screen icon. */
export function isIosStandalone({
  navigator: nav = globalThis.navigator,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  if (!nav) return false;

  // iPadOS 13+ reports itself as a Mac; multi-touch is what gives it away.
  const isIos = IOS_DEVICE.test(nav.userAgent || '')
    || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  if (!isIos) return false;

  return nav.standalone === true || Boolean(matchMedia?.('(display-mode: standalone)')?.matches);
}

export function canUseShareSheet(nav = globalThis.navigator) {
  return typeof nav?.share === 'function' && typeof nav?.canShare === 'function';
}

/**
 * The same bytes offered as JSON first, then as plain text. Plain text is the
 * type browsers are most willing to share, so it is the safety net if JSON is
 * refused. The ".txt" keeps the saved file's extension honest about its type.
 */
export function shareCandidates(blob, fileName) {
  return [
    new File([blob], fileName, { type: 'application/json' }),
    new File([blob], `${fileName}.txt`, { type: 'text/plain' }),
  ];
}

/** The first file the browser says it will share, or null if it refuses all. */
export function pickShareableFile(files, nav = globalThis.navigator) {
  if (!canUseShareSheet(nav)) return null;

  return files.find((file) => {
    try {
      return nav.canShare({ files: [file] });
    } catch {
      return false;
    }
  }) || null;
}

/**
 * Opens the share sheet. share() is invoked before this function first awaits,
 * so calling it directly from a click handler keeps the tap's user activation.
 * Resolves 'shared' or 'cancelled' (the person dismissed the sheet, which is
 * not an error); anything else the browser throws is passed on.
 */
export async function shareFile(file, nav = globalThis.navigator) {
  try {
    await nav.share({ files: [file] });
    return 'shared';
  } catch (error) {
    if (error?.name === 'AbortError') return 'cancelled';
    throw error;
  }
}
