import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetSong,
  getBestScore,
  getFavorites,
  getLastSong,
  getPreviewEnabled,
  getTutorialSeen,
  recordScore,
  setLastSong,
  setPreviewEnabled,
  setTutorialSeen,
  toggleFavorite,
} from './storage.js';

/**
 * `forgetSong` is the client half of the delete cascade: the server drops a
 * song's files, this drops its per-device residue. The residue is keyed by
 * `songId` across three stores, so the test exercises all three and — the part
 * that actually matters — asserts a *different* song is left untouched.
 */

function stubLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
}

beforeEach(stubLocalStorage);
afterEach(() => vi.unstubAllGlobals());

describe('forgetSong', () => {
  it('erases every difficulty score, the star, and the last-selected pointer', () => {
    const best = { score: 1000, accuracy: 0.9, maxCombo: 50, grade: 'A' };
    recordScore('doomed', 'easy', best);
    recordScore('doomed', 'hard', best);
    toggleFavorite('doomed');
    setLastSong('doomed');

    forgetSong('doomed');

    expect(getBestScore('doomed', 'easy')).toBeNull();
    expect(getBestScore('doomed', 'hard')).toBeNull();
    expect(getFavorites().has('doomed')).toBe(false);
    expect(getLastSong()).toBeNull();
  });

  it('leaves other songs entirely alone', () => {
    const best = { score: 2000, accuracy: 0.95, maxCombo: 80, grade: 'S' };
    recordScore('keeper', 'medium', best);
    recordScore('doomed', 'medium', best);
    toggleFavorite('keeper');
    setLastSong('keeper');

    forgetSong('doomed');

    expect(getBestScore('keeper', 'medium')).toEqual(best);
    expect(getFavorites().has('keeper')).toBe(true);
    expect(getLastSong()).toBe('keeper');
  });

  it('is a no-op for a song with no residue', () => {
    setLastSong('keeper');
    expect(() => forgetSong('never-existed')).not.toThrow();
    expect(getLastSong()).toBe('keeper');
  });
});

/**
 * The rank rule. There is exactly one best slot per chart, so an assisted run
 * that overwrote a clean record destroyed it — `scoreMultiplierFor` returns 1
 * for every modifier set, which is what let a 0.75x run post a competitive
 * score in the first place.
 */
describe('recordScore assist ranking', () => {
  // `normalized` is what every run written by the app now carries. Without it a
  // record is a legacy one on the retired raw scale, which is a different
  // comparison entirely — covered in its own block below.
  const clean = { score: 1000, accuracy: 0.9, maxCombo: 50, grade: 'A', normalized: true };
  const assisted = { ...clean, assisted: true };

  it('still takes the higher score between two clean runs', () => {
    expect(recordScore('s', 'hard', clean)).toBe(true);
    expect(recordScore('s', 'hard', { ...clean, score: 1500 })).toBe(true);
    expect(getBestScore('s', 'hard')?.score).toBe(1500);
    expect(recordScore('s', 'hard', { ...clean, score: 900 })).toBe(false);
  });

  it('never lets an assisted run displace a clean record, however high it scores', () => {
    recordScore('s', 'hard', clean);
    expect(recordScore('s', 'hard', { ...assisted, score: 999_999 })).toBe(false);
    expect(getBestScore('s', 'hard')).toEqual(clean);
  });

  it('lets a clean run displace an assisted record, however low it scores', () => {
    recordScore('s', 'hard', { ...assisted, score: 999_999 });
    expect(recordScore('s', 'hard', { ...clean, score: 1 })).toBe(true);
    expect(getBestScore('s', 'hard')?.assisted).toBeUndefined();
  });

  it('ranks assisted runs against each other on score', () => {
    expect(recordScore('s', 'hard', assisted)).toBe(true);
    expect(recordScore('s', 'hard', { ...assisted, score: 500 })).toBe(false);
    expect(recordScore('s', 'hard', { ...assisted, score: 2000 })).toBe(true);
    expect(getBestScore('s', 'hard')?.score).toBe(2000);
  });

  it('treats a record with no assisted field as clean', () => {
    // Written by a build that predates the field. It cannot be classified after
    // the fact, so it keeps its standing rather than being silently demoted.
    recordScore('s', 'hard', clean);
    expect(getBestScore('s', 'hard')?.assisted).toBeUndefined();
    expect(recordScore('s', 'hard', { ...assisted, score: 999_999 })).toBe(false);
  });
});

describe('onboarding + preview flags', () => {
  it('has never seen the tutorial by default, then remembers it was seen', () => {
    expect(getTutorialSeen()).toBe(false);
    setTutorialSeen(true);
    expect(getTutorialSeen()).toBe(true);
  });

  it('enables previews by default, and can be turned off', () => {
    expect(getPreviewEnabled()).toBe(true);
    setPreviewEnabled(false);
    expect(getPreviewEnabled()).toBe(false);
    setPreviewEnabled(true);
    expect(getPreviewEnabled()).toBe(true);
  });
});

/**
 * Migrating the score scale.
 *
 * Raw scores scaled with a chart's length, so a flawless run on a 962-note chart
 * earned 1,387,875 — above the normalised ceiling of 1,000,000. Comparing across
 * the two scales would therefore reject every future clean run on that chart
 * forever, with one slot and no second copy. That is the failure these cover.
 */
describe('recordScore scale migration', () => {
  const legacy = { score: 1_387_875, accuracy: 0.99, maxCombo: 900, grade: 'S' };
  const fresh = { score: 500_000, accuracy: 0.8, maxCombo: 400, grade: 'B', normalized: true };

  it('rescales a legacy record instead of comparing it raw', () => {
    recordScore('s', 'hard', legacy);
    // The legacy 1,387,875 was flawless on this chart, so it rescales to the
    // ceiling and a mid-table run must not beat it. Compared raw, 500,000 would
    // have lost too — but for the wrong reason, and a *better* run would also
    // have lost, forever.
    expect(recordScore('s', 'hard', fresh, 1_387_875)).toBe(false);
  });

  it('lets a genuinely better run through, which raw comparison never would', () => {
    recordScore('s', 'hard', { ...legacy, score: 700_000 });
    // 700,000 raw out of a 1,387,875 ideal is ~504,000 normalised, so a 600,000
    // normalised run is better and must take the slot. Compared raw, 600,000 would
    // have lost to 700,000 and the record would have been stuck.
    expect(recordScore('s', 'hard', { ...fresh, score: 600_000 }, 1_387_875)).toBe(true);
    expect(getBestScore('s', 'hard')?.score).toBe(600_000);
    expect(getBestScore('s', 'hard')?.normalized).toBe(true);
  });

  it('treats a legacy record as beatable when it cannot be rescaled', () => {
    // Chosen deliberately: with no ideal to rescale against, an unbeatable slot is
    // a worse outcome than restating one old number. Only reachable from a caller
    // that omits `scoreMax`.
    recordScore('s', 'hard', legacy);
    expect(recordScore('s', 'hard', { ...fresh, score: 1 })).toBe(true);
  });

  it('still refuses an assisted run against a legacy clean record', () => {
    // Assist rank outranks the scale question — it is checked first, so a
    // migration can never be the loophole that lets an assisted run in.
    recordScore('s', 'hard', legacy);
    expect(
      recordScore('s', 'hard', { ...fresh, score: 999_999, assisted: true }, 1_387_875),
    ).toBe(false);
  });

  it('marks what it stores, so the next comparison is same-scale', () => {
    recordScore('s', 'hard', { ...fresh, score: 400_000 }, 1_387_875);
    expect(getBestScore('s', 'hard')?.normalized).toBe(true);
    // And now a plain higher/lower comparison applies again.
    expect(recordScore('s', 'hard', { ...fresh, score: 399_999 }, 1_387_875)).toBe(false);
    expect(recordScore('s', 'hard', { ...fresh, score: 400_001 }, 1_387_875)).toBe(true);
  });
});
