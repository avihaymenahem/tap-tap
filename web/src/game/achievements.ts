import type { DifficultyName } from '@tap-tap/shared';
import { DIFFICULTY_NAMES } from '@tap-tap/shared';
import type { RunResult } from './run.js';

/**
 * Achievements — badges earned across a career of runs.
 *
 * Pure and data-first, the same discipline as `uisfx`/`haptics`: the badge set
 * is data (`ACHIEVEMENTS`) and the career total is a plain reducer over runs
 * (`applyRun`), so the whole thing is unit-testable without a game, a DOM, or
 * localStorage. Persistence lives in `storage.ts`; the *rules* live here.
 *
 * Everything is derived from one growing `AchievementStats` aggregate rather than
 * inspecting individual runs at unlock time, for one important reason: a badge
 * must not un-earn itself. "Best combo 300" stays earned even after a bad run, so
 * the aggregate only ever climbs, and an achievement is unlocked the moment the
 * aggregate first satisfies it.
 */

export interface AchievementStats {
  /** Every finished run, win or lose. */
  runs: number;
  /** Runs that finished without failing — a genuine clear (a quit still counts). */
  clears: number;
  /** Runs with zero misses. */
  fullCombos: number;
  /** Runs where every note was a perfect. */
  allPerfects: number;
  /** Highest combo ever reached. */
  bestCombo: number;
  /** Runs graded S. */
  sRanks: number;
  clearsByDifficulty: Record<DifficultyName, number>;
  fullCombosByDifficulty: Record<DifficultyName, number>;
  /** Distinct songs played, for "variety" badges. */
  songIds: string[];
}

export interface Achievement {
  id: string;
  name: string;
  /** One line, present tense — what you did to earn it. */
  description: string;
  /** A single emoji, its face on the badge. */
  icon: string;
  /** True once the career total satisfies it. Monotonic in the stats. */
  test: (s: AchievementStats) => boolean;
}

function zeroByDifficulty(): Record<DifficultyName, number> {
  return Object.fromEntries(DIFFICULTY_NAMES.map((d) => [d, 0])) as Record<DifficultyName, number>;
}

export function emptyStats(): AchievementStats {
  return {
    runs: 0,
    clears: 0,
    fullCombos: 0,
    allPerfects: 0,
    bestCombo: 0,
    sRanks: 0,
    clearsByDifficulty: zeroByDifficulty(),
    fullCombosByDifficulty: zeroByDifficulty(),
    songIds: [],
  };
}

/** Did this run clear the chart — finish without failing, with notes actually played? */
function isClear(run: RunResult): boolean {
  return run.failed !== true && run.totalNotes > 0;
}

/** No misses across the whole chart (only meaningful on a clear). */
export function isFullCombo(run: RunResult): boolean {
  return isClear(run) && run.counts.miss === 0;
}

/** Every note a perfect (the strongest possible run). */
export function isAllPerfect(run: RunResult): boolean {
  return isClear(run) && run.counts.great === 0 && run.counts.good === 0 && run.counts.miss === 0;
}

/**
 * Fold one finished run into the career total. Pure — returns a new aggregate,
 * never mutates. Missing/legacy fields are read defensively so an old stored
 * blob still folds in.
 */
export function applyRun(
  stats: AchievementStats,
  run: RunResult,
  songId: string,
  difficulty: DifficultyName,
): AchievementStats {
  const cleared = isClear(run);
  const fc = isFullCombo(run);
  const ap = isAllPerfect(run);

  const bump = (rec: Record<DifficultyName, number>, add: number): Record<DifficultyName, number> =>
    add ? { ...rec, [difficulty]: (rec[difficulty] ?? 0) + add } : rec;

  return {
    runs: stats.runs + 1,
    clears: stats.clears + (cleared ? 1 : 0),
    fullCombos: stats.fullCombos + (fc ? 1 : 0),
    allPerfects: stats.allPerfects + (ap ? 1 : 0),
    bestCombo: Math.max(stats.bestCombo, run.maxCombo),
    sRanks: stats.sRanks + (cleared && run.grade === 'S' ? 1 : 0),
    clearsByDifficulty: bump(stats.clearsByDifficulty, cleared ? 1 : 0),
    fullCombosByDifficulty: bump(stats.fullCombosByDifficulty, fc ? 1 : 0),
    songIds: stats.songIds.includes(songId) ? stats.songIds : [...stats.songIds, songId],
  };
}

/**
 * The badge set. Ordered roughly easy → hard so the list reads as a ladder.
 * Ids are stable strings — they are what gets persisted, so renaming one must
 * keep its id.
 */
export const ACHIEVEMENTS: readonly Achievement[] = [
  { id: 'first-clear', name: 'First Steps', description: 'Clear your first song', icon: '🎯', test: (s) => s.clears >= 1 },
  { id: 'combo-100', name: 'Century', description: 'Reach a 100 combo', icon: '💯', test: (s) => s.bestCombo >= 100 },
  { id: 's-rank', name: 'Top Marks', description: 'Earn an S grade', icon: '⭐', test: (s) => s.sRanks >= 1 },
  { id: 'full-combo', name: 'Unbroken', description: 'Full-combo any chart', icon: '🔗', test: (s) => s.fullCombos >= 1 },
  { id: 'songs-5', name: 'Getting Into It', description: 'Play 5 different songs', icon: '🎵', test: (s) => s.songIds.length >= 5 },
  { id: 'hard-clear', name: 'Stepping Up', description: 'Clear a Hard chart', icon: '⚡', test: (s) => s.clearsByDifficulty.hard >= 1 },
  { id: 'combo-300', name: 'On Fire', description: 'Reach a 300 combo', icon: '🔥', test: (s) => s.bestCombo >= 300 },
  { id: 'all-perfect', name: 'Flawless', description: 'All-Perfect any chart', icon: '💎', test: (s) => s.allPerfects >= 1 },
  { id: 'clears-25', name: 'Regular', description: 'Clear 25 runs', icon: '🏅', test: (s) => s.clears >= 25 },
  { id: 'extreme-clear', name: 'No Limits', description: 'Clear an Extreme chart', icon: '☠️', test: (s) => s.clearsByDifficulty.extreme >= 1 },
  { id: 'songs-15', name: 'Collector', description: 'Play 15 different songs', icon: '📚', test: (s) => s.songIds.length >= 15 },
  { id: 'combo-500', name: 'Untouchable', description: 'Reach a 500 combo', icon: '⚡', test: (s) => s.bestCombo >= 500 },
  { id: 'extreme-fc', name: 'Machine', description: 'Full-combo an Extreme chart', icon: '👑', test: (s) => s.fullCombosByDifficulty.extreme >= 1 },
  { id: 'clears-100', name: 'Devoted', description: 'Clear 100 runs', icon: '🏆', test: (s) => s.clears >= 100 },
];

export function achievementById(id: string): Achievement | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}

/** The ids currently satisfied by these stats. */
export function unlockedIds(stats: AchievementStats): string[] {
  return ACHIEVEMENTS.filter((a) => a.test(stats)).map((a) => a.id);
}

/**
 * Achievements satisfied by `stats` but not present in `prev` — the ones that
 * just popped. Given the aggregate only climbs, this is exactly the set to
 * celebrate on the results screen.
 */
export function newlyUnlocked(prev: readonly string[], stats: AchievementStats): Achievement[] {
  const had = new Set(prev);
  return ACHIEVEMENTS.filter((a) => !had.has(a.id) && a.test(stats));
}
