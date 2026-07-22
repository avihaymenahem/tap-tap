import type { DifficultyName } from '@tap-tap/shared';
import type { RunResult } from './game/run.js';

/**
 * The most recent run, kept in sessionStorage.
 *
 * A score breakdown cannot live in a URL, but `/results/:songId/:difficulty`
 * still has to survive a reload — otherwise the one screen a player is most
 * likely to sit on and refresh is also the one that loses its contents. Session
 * scope is deliberate: results are per-visit, and they should not linger into a
 * new session pretending to be current.
 */

export interface StoredRun extends RunResult {
  songId: string;
  difficulty: DifficultyName;
  title: string;
  /** The song theme's accent colour, so the results screen keeps its palette. */
  accent?: number;
}

const KEY = 'tap-tap.lastRun';

export function saveRun(run: StoredRun): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(run));
  } catch {
    // Private mode or full quota — the in-memory copy still drives this session.
  }
}

/** Returns the stored run only if it matches the chart being asked for. */
export function loadRun(songId: string, difficulty: DifficultyName): StoredRun | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const run = JSON.parse(raw) as StoredRun;
    if (run.songId !== songId || run.difficulty !== difficulty) return null;
    return run;
  } catch {
    return null;
  }
}
