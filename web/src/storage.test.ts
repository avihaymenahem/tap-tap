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
  const clean = { score: 1000, accuracy: 0.9, maxCombo: 50, grade: 'A' };
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
