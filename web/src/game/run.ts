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
}
