import type { Tier, Timing } from './judge.js';

/** The outcome of one playthrough. */
export interface RunResult {
  score: number;
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
}
