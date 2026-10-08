import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLastBackupAt, setLastBackupAt, shouldNudgeBackup, snoozeBackupNudge } from '../src/lib/settings.js';

const DAY = 86_400_000;

describe('backup reminder', () => {
  beforeEach(() => {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stays quiet for a wardrobe too small to worry about', () => {
    expect(shouldNudgeBackup(4)).toBe(false);
  });

  it('asks when there has never been a backup', () => {
    expect(getLastBackupAt()).toBe(0);
    expect(shouldNudgeBackup(5)).toBe(true);
  });

  it('stays quiet for a month after a backup, then asks again', () => {
    const now = 100 * DAY;
    setLastBackupAt(now - 10 * DAY);
    expect(shouldNudgeBackup(20, now)).toBe(false);
    setLastBackupAt(now - 31 * DAY);
    expect(shouldNudgeBackup(20, now)).toBe(true);
  });

  it('"Later" quiets it for a week', () => {
    const now = 100 * DAY;
    snoozeBackupNudge(7, now);
    expect(shouldNudgeBackup(20, now + 6 * DAY)).toBe(false);
    expect(shouldNudgeBackup(20, now + 8 * DAY)).toBe(true);
  });
});
