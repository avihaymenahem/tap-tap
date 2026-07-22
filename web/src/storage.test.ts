import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetSong,
  getBestScore,
  getFavorites,
  getLastSong,
  recordScore,
  setLastSong,
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
