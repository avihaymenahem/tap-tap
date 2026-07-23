import type { RunResult } from './run.js';

/**
 * Head-to-head match logic, kept pure so the winner rule and the tug-of-war
 * meter are unit-tested without a run. The renderer and the versus screen own
 * no scoring of their own — they ask these.
 */

/** Who won a finished match. `draw` is a genuine dead heat, not a fallback. */
export type VersusOutcome = 'p1' | 'p2' | 'draw';

/**
 * Decide a match from two finished runs.
 *
 * Score decides it; an exact tie breaks on accuracy (cleaner play wins a
 * shootout), and only a tie on *both* is an honest draw. Both runs are scored
 * over the whole chart already, so a mid-song quit cannot read as a win.
 */
export function decideWinner(p1: RunResult, p2: RunResult): VersusOutcome {
  if (p1.score !== p2.score) return p1.score > p2.score ? 'p1' : 'p2';
  if (p1.accuracy !== p2.accuracy) return p1.accuracy > p2.accuracy ? 'p1' : 'p2';
  return 'draw';
}

/**
 * Player 1's share of the tug-of-war bar, 0..1, from the two live scores.
 *
 * Starts dead centre (0.5) while neither has scored, and is clamped away from
 * the ends so a runaway lead still leaves the trailing player's colour visible
 * rather than pushing the marker off the bar entirely.
 */
export function tugRatio(p1Score: number, p2Score: number): number {
  const total = p1Score + p2Score;
  if (total <= 0) return 0.5;
  return Math.min(0.95, Math.max(0.05, p1Score / total));
}
