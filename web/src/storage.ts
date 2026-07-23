import { type DifficultyName, DIFFICULTY_NAMES } from '@tap-tap/shared';
import { DEFAULT_MODIFIERS, type Modifiers } from './game/modifiers.js';
import {
  type Achievement,
  type AchievementStats,
  applyRun,
  emptyStats,
  newlyUnlocked,
  unlockedIds,
} from './game/achievements.js';
import type { RunResult } from './game/run.js';

/** Local persistence: calibration offset and per-chart best scores. */

const CALIBRATION_KEY = 'tap-tap.calibration';
const SCORES_KEY = 'tap-tap.scores';
const FAVORITES_KEY = 'tap-tap.favorites';
const SORT_KEY = 'tap-tap.sort';
const LAST_SONG_KEY = 'tap-tap.lastSong';
const MODIFIERS_KEY = 'tap-tap.modifiers';
const ACHIEVEMENTS_KEY = 'tap-tap.achievements';
const TUTORIAL_SEEN_KEY = 'tap-tap.tutorialSeen';
const PREVIEW_KEY = 'tap-tap.previews';

export interface BestScore {
  score: number;
  accuracy: number;
  maxCombo: number;
  grade: string;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full quota — scores are a nicety, not a requirement.
  }
}

/** Seconds. Positive means the player's taps register late and need pulling back. */
/**
 * The stored offset, or null when this device has never been calibrated.
 *
 * The distinction matters: "calibrated to exactly zero" is a deliberate choice
 * that must be respected, while "never calibrated" is an invitation to fall
 * back to the audio hardware's reported latency. Collapsing both to 0 meant
 * every uncalibrated phone played with no latency compensation at all.
 */
export function getStoredCalibration(): number | null {
  const value = read<number | null>(CALIBRATION_KEY, null);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function getCalibration(): number {
  return getStoredCalibration() ?? 0;
}

export function setCalibration(seconds: number): void {
  write(CALIBRATION_KEY, seconds);
}

function scoreKey(songId: string, difficulty: DifficultyName): string {
  return `${songId}:${difficulty}`;
}

export function getBestScore(songId: string, difficulty: DifficultyName): BestScore | null {
  const all = read<Record<string, BestScore>>(SCORES_KEY, {});
  return all[scoreKey(songId, difficulty)] ?? null;
}

/** Records the run if it beats the stored best. Returns true when it did. */
export function recordScore(
  songId: string,
  difficulty: DifficultyName,
  result: BestScore,
): boolean {
  const all = read<Record<string, BestScore>>(SCORES_KEY, {});
  const key = scoreKey(songId, difficulty);
  const previous = all[key];
  if (previous && previous.score >= result.score) return false;

  all[key] = result;
  write(SCORES_KEY, all);
  return true;
}

// --- menu state ------------------------------------------------------------

/** The list sort the player last chose, so it survives leaving and returning. */
export function getStoredSort(): string | null {
  const value = read<string | null>(SORT_KEY, null);
  return typeof value === 'string' ? value : null;
}

export function setStoredSort(sort: string): void {
  write(SORT_KEY, sort);
}

/** The song the player last selected or played, restored and highlighted on return. */
export function getLastSong(): string | null {
  const value = read<string | null>(LAST_SONG_KEY, null);
  return typeof value === 'string' ? value : null;
}

export function setLastSong(songId: string): void {
  write(LAST_SONG_KEY, songId);
}

// --- modifiers -------------------------------------------------------------

/**
 * The play modifiers last chosen, so a player who always turns on Fail (or plays
 * mirrored) does not re-set them every song. Per-device like the rest of this
 * file. Merged over `DEFAULT_MODIFIERS` on read, so a stored blob from an older
 * build that predates a field still resolves to a complete, valid set rather
 * than an object missing `speed` or `visibility`.
 */
export function getStoredModifiers(): Modifiers {
  const stored = read<Partial<Modifiers>>(MODIFIERS_KEY, {});
  return { ...DEFAULT_MODIFIERS, ...stored };
}

export function setStoredModifiers(mods: Modifiers): void {
  write(MODIFIERS_KEY, mods);
}

// --- onboarding + previews -------------------------------------------------

/** Whether the player has been through the first-run tutorial. */
export function getTutorialSeen(): boolean {
  return read<boolean>(TUTORIAL_SEEN_KEY, false) === true;
}

export function setTutorialSeen(seen: boolean): void {
  write(TUTORIAL_SEEN_KEY, seen);
}

/**
 * Whether selecting a song in the menu auto-plays a preview clip. On by default;
 * a player who finds it noisy (or is on mobile data) can switch it off.
 */
export function getPreviewEnabled(): boolean {
  return read<boolean>(PREVIEW_KEY, true) !== false;
}

export function setPreviewEnabled(enabled: boolean): void {
  write(PREVIEW_KEY, enabled);
}

// --- achievements ----------------------------------------------------------

/**
 * Career achievement state: the running stats aggregate and the ids earned so
 * far. Per-device like scores and favorites. The `unlocked` list is stored
 * alongside the stats (rather than recomputed) so that renaming or removing a
 * badge definition never silently strips a player of one they earned.
 */
interface AchievementState {
  stats: AchievementStats;
  unlocked: string[];
}

function readAchievementState(): AchievementState {
  const stored = read<Partial<AchievementState>>(ACHIEVEMENTS_KEY, {});
  return {
    stats: { ...emptyStats(), ...stored.stats },
    unlocked: Array.isArray(stored.unlocked) ? stored.unlocked : [],
  };
}

export function getAchievementStats(): AchievementStats {
  return readAchievementState().stats;
}

/** Every badge id the player has earned. */
export function getUnlockedAchievements(): Set<string> {
  return new Set(readAchievementState().unlocked);
}

/**
 * Fold one finished run into the career total and return the badges it just
 * earned. Called **once per run**, from `App.onFinish` — never from the results
 * screen, which can re-mount and would double-count. The freshly earned list is
 * carried to results on the stored run, so re-visiting results re-shows the
 * banner without re-recording.
 */
export function recordRunAchievements(
  songId: string,
  difficulty: DifficultyName,
  run: RunResult,
): Achievement[] {
  const { stats, unlocked } = readAchievementState();
  const nextStats = applyRun(stats, run, songId, difficulty);
  const fresh = newlyUnlocked(unlocked, nextStats);
  const nextUnlocked = fresh.length > 0 ? unlockedIds(nextStats) : unlocked;
  write(ACHIEVEMENTS_KEY, { stats: nextStats, unlocked: nextUnlocked });
  return fresh;
}

// --- favorites -------------------------------------------------------------

/**
 * Starred songs, per device.
 *
 * Deliberately local rather than a field on the beatmap. That means favorites
 * do **not** follow you between desktop and phone — the trade taken knowingly,
 * because it keeps starring instant and working offline. A server-side flag
 * would be a PATCH, and the service worker never fakes writes, so it would be
 * the one library action that failed with no connection.
 *
 * Stored as an array because `Set` does not survive `JSON.stringify`, and read
 * back as one because every caller wants membership tests.
 */
export function getFavorites(): Set<string> {
  const ids = read<unknown>(FAVORITES_KEY, []);
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
}

export function isFavorite(songId: string): boolean {
  return getFavorites().has(songId);
}

/** Flips the star. Returns the new state so callers need not re-read. */
export function toggleFavorite(songId: string): boolean {
  const favorites = getFavorites();
  const next = !favorites.has(songId);
  if (next) favorites.add(songId);
  else favorites.delete(songId);
  write(FAVORITES_KEY, [...favorites]);
  return next;
}

// --- deletion --------------------------------------------------------------

/**
 * Erase every per-device trace of a song when it is deleted.
 *
 * Deleting a track removes its files server-side, but its `localStorage` residue
 * is keyed by `songId` and nothing else clears it: a best score for every
 * difficulty, a favorite star, and the last-selected pointer. Left behind, a
 * re-ingested id would inherit a stale high score, and the menu would try to
 * restore a song that no longer exists. This is the client half of the delete
 * cascade — call it whenever a song is removed.
 */
export function forgetSong(songId: string): void {
  const scores = read<Record<string, BestScore>>(SCORES_KEY, {});
  let scoresChanged = false;
  for (const difficulty of DIFFICULTY_NAMES) {
    const key = scoreKey(songId, difficulty);
    if (key in scores) {
      delete scores[key];
      scoresChanged = true;
    }
  }
  if (scoresChanged) write(SCORES_KEY, scores);

  const favorites = getFavorites();
  if (favorites.delete(songId)) write(FAVORITES_KEY, [...favorites]);

  if (getLastSong() === songId) {
    try {
      localStorage.removeItem(LAST_SONG_KEY);
    } catch {
      // Private mode — nothing was persisted to remove.
    }
  }
}
