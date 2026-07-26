import type { Tier, Timing } from './judge.js';
import type { Modifiers } from './modifiers.js';

/** The outcome of one playthrough. */
export interface RunResult {
  /**
   * Normalised against `MAX_SCORE` (`game/score.ts`), not the engine's raw total.
   *
   * The raw total scales with a chart's length, so the same performance posted
   * 292,875 on a short chart and 1,387,875 on a long one — a figure that says
   * nothing on its own. Everything player-facing is on the fixed scale; `scoreMax`
   * below is what it was divided by.
   */
  score: number;
  /**
   * The raw score a flawless run on the played chart would have earned.
   *
   * Kept so a stored record can be re-derived or a legacy one migrated later, and
   * because it is the only honest divisor: it comes from the chart actually played,
   * which the intro skip and start grace make shorter than the stored one.
   * Optional — a run stored by an older build has none.
   */
  scoreMax?: number;
  accuracy: number;
  maxCombo: number;
  grade: string;
  counts: Record<Tier, number>;
  timingCounts: Record<Timing, number>;
  /** Signed mean error in seconds. Negative means hitting early. */
  meanDelta: number;
  totalNotes: number;
  /**
   * True when the run ended because health hit 0 (the `fail` modifier was on).
   * Results shows a FAILED banner and skips the celebration. Absent/false on a
   * normal finish or a plain quit. Score and accuracy are still computed over
   * the whole chart, so a failed run's unreached notes count as misses.
   */
  failed?: boolean;
  /**
   * The modifiers this run was played under.
   *
   * Carried on the result rather than re-read at results time, because the
   * player can change their modifiers on the menu between finishing a run and
   * looking at its card — and a personal best must be judged against how the run
   * was actually played, not against whatever is currently selected. Optional so
   * a run stored by an older build still parses.
   */
  modifiers?: Modifiers;
}
