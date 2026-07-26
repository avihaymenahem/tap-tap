/**
 * Clear lamps — the per-chart completion state shown on every song row.
 *
 * A letter grade already answers "how well did I play this once". A lamp answers
 * the different question a library needs: *what is left to do*. Four states, so a
 * row of four (one per difficulty) turns a flat list into a completion map.
 *
 * Derived from the stored best rather than recorded as a verdict, so the ladder
 * can gain a rung later without a migration — the same reasoning that keeps
 * `gainDb` a number rather than a "normalised" flag.
 *
 * Pure and import-free: the input is described structurally so `BestScore`
 * satisfies it without this module reaching into storage.
 */

export type Lamp = 'none' | 'cleared' | 'fullCombo' | 'perfect';

/** The stored fields a lamp is derived from. `BestScore` satisfies this. */
export interface LampInput {
  /** 0..1, scored over the whole chart (`foldUnreached` guarantees that). */
  accuracy: number;
  maxCombo: number;
  /**
   * Misses in the recorded run, when known.
   *
   * The exact full-combo test, and the reason it is stored at all: the played
   * chart is not the stored chart. `PlayScreen` drops notes before an intro skip
   * and inside the start grace window, so a genuine full combo on a song with a
   * long quiet opening ends with `maxCombo` well below the chart's note count.
   * Counting misses sidesteps the played-length question entirely.
   */
  misses?: number;
}

/**
 * Floating-point slack on the accuracy comparison. `accuracy` is a ratio of sums
 * of integers, so an all-perfect run lands on exactly 1 in practice; this only
 * guards the last bit.
 */
const EPSILON = 1e-9;

/**
 * The lamp for one chart.
 *
 * `chartNotes` is the stored chart's note count (`SongSummary.noteCounts`), used
 * only for the legacy full-combo fallback below.
 */
export function lampFor(best: LampInput | null | undefined, chartNotes: number): Lamp {
  // Only non-failed runs are ever recorded (`ResultsScreen` skips `recordScore`
  // on a fail), so a stored best already means the chart was cleared. There is
  // deliberately no "played" rung: a failed attempt leaves no trace at all, so
  // the app cannot distinguish "tried and failed" from "never touched" and must
  // not pretend otherwise.
  if (!best) return 'none';

  // An empty chart would otherwise read as flawless: `accuracyOf` returns 1 when
  // it judged nothing.
  if (chartNotes <= 0) return 'cleared';

  const full = isFullCombo(best, chartNotes);

  // All-perfect. `accuracy` is 1 only when every judged note scored the perfect
  // value, which already implies no misses — the full-combo check is belt and
  // braces against a future tier whose value ties with perfect.
  if (best.accuracy >= 1 - EPSILON && full) return 'perfect';
  if (full) return 'fullCombo';
  return 'cleared';
}

function isFullCombo(best: LampInput, chartNotes: number): boolean {
  if (typeof best.misses === 'number') return best.misses === 0;

  // Legacy records predate `misses` and cannot be classified after the fact, so
  // fall back to comparing the combo against the whole chart. This **under**-
  // reports — a full combo on an intro-skipped song shows as merely cleared —
  // and can never over-report, because the played chart is only ever a subset of
  // the stored one, so `maxCombo >= chartNotes` requires having hit every note
  // of it. Under-claiming is the right direction for a badge.
  return best.maxCombo >= chartNotes;
}

/** Ordering for "is this run's lamp better than the stored one". */
const RANK: Record<Lamp, number> = { none: 0, cleared: 1, fullCombo: 2, perfect: 3 };

export function lampRank(lamp: Lamp): number {
  return RANK[lamp];
}

/** Short label for the badge's tooltip and its accessible name. */
export const LAMP_LABELS: Record<Lamp, string> = {
  none: 'Not cleared',
  cleared: 'Cleared',
  fullCombo: 'Full combo',
  perfect: 'All perfect',
};
