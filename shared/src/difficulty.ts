import type { DifficultyName } from './beatmap.js';

export interface DifficultyParams {
  name: DifficultyName;
  laneCount: number;
  /** Beat subdivision notes snap to. 1 = quarter notes, 4 = sixteenths. */
  subdivision: number;
  /** Minimum seconds between consecutive notes anywhere on the board. */
  minGapSec: number;
  /** Whether two notes may share a timestamp. */
  chords: boolean;
  /** 0..1 — how often an eligible strong onset becomes a chord. */
  chordChance: number;
  /** Upper bound on average notes per second across the song. */
  targetNps: number;
  /** Seconds a note is visible before it reaches the hit line. */
  approachSec: number;

  /**
   * 0..1 — the most of a chart's notes that may become holds.
   *
   * A ceiling, not a target: a song with no sustained sounds gets no holds, and
   * that is the correct chart for it. The generator takes the steadiest
   * candidates up to this share rather than manufacturing holds to fill a quota.
   *
   * **Currently 0 everywhere — holds are switched off.** They did not play well
   * enough to keep on. Zero is the whole off-switch: `applyHolds` returns
   * immediately on a zero budget, so no chart gains a hold and every other part
   * of the feature simply never fires. The tuned values are recorded beside each
   * difficulty below; restoring them re-enables it with no other change.
   */
  holdShare: number;
  /** Shorter than this is a tap. Below ~0.35s a hold reads as a sloppy tap. */
  minHoldSec: number;
  /** Longer than this is trimmed, so one sustain cannot occupy a lane forever. */
  maxHoldSec: number;
  /**
   * How many holds may be down at once.
   *
   * A physical limit, not a taste one. The keymaps are one left hand and touch
   * is two thumbs, so a third simultaneous hold cannot be honoured at all —
   * and any note in a fourth lane during it becomes unreachable. The generator
   * happily produced stacks of them before this existed, because sustains in
   * different frequency bands land in different lanes at the same moment.
   */
  maxConcurrentHolds: number;
}

/**
 * Difficulty calibration.
 *
 * `minGapSec` matters more than `targetNps`. The target only sets the average
 * across the song; the gap sets the hard ceiling on a sustained stream, at
 * `1 / minGapSec` notes per second. A generous target with a tight gap produces
 * a chart that sits permanently on the spacing floor — a wall of evenly spaced
 * notes rather than a rhythm — which is what made medium unplayable at a 0.2s
 * gap: on a 126 BPM track that is a note on every eighth note, forever.
 *
 * A useful check against a real song: quarter note = 60/BPM seconds, eighth =
 * half that. Medium's gap should sit *between* the two, so it can place eighths
 * as accents without being able to place every single one.
 */
export const DIFFICULTIES: Record<DifficultyName, DifficultyParams> = {
  easy: {
    name: 'easy',
    // Four lanes at every difficulty — the board is always `A S D F`. Only the
    // density, spacing, speed and chording change between tiers, so a player's
    // hand position never has to be relearned moving up. (Charts generated
    // before this change keep their old lane count until regenerated.)
    laneCount: 4,
    subdivision: 1,
    // ~2.2 notes/sec ceiling: roughly quarter notes at typical tempos.
    minGapSec: 0.45,
    chords: false,
    chordChance: 0,
    targetNps: 1.2,
    approachSec: 1.9,
    // Holds off; 0.1 when enabled. Few and long — on easy a hold is a rest,
    // not a demand.
    holdShare: 0,
    minHoldSec: 0.6,
    maxHoldSec: 4,
    maxConcurrentHolds: 2,
  },
  medium: {
    name: 'medium',
    laneCount: 4,
    subdivision: 2,
    // ~3.3 notes/sec ceiling: between quarters and eighths, so streams breathe.
    minGapSec: 0.3,
    chords: true,
    chordChance: 0.05,
    targetNps: 2,
    approachSec: 1.6,
    // Holds off; 0.14 when enabled.
    holdShare: 0,
    minHoldSec: 0.5,
    maxHoldSec: 3.5,
    maxConcurrentHolds: 2,
  },
  hard: {
    name: 'hard',
    laneCount: 4,
    subdivision: 4,
    // ~5.2 notes/sec ceiling: comfortable eighths with sixteenth-note bursts.
    minGapSec: 0.19,
    chords: true,
    chordChance: 0.15,
    targetNps: 3.6,
    approachSec: 1.3,
    // Holds off; 0.18 when enabled. More and shorter than easy/medium.
    holdShare: 0,
    minHoldSec: 0.4,
    maxHoldSec: 3,
    maxConcurrentHolds: 2,
  },
  /**
   * Extreme is hard turned up on every axis, spacing included.
   *
   * `minGapSec` is 0.14 — tighter than hard's 0.19, which lifts the sustained-
   * stream ceiling from ~5.2 to ~7.1 notes/sec, so genuinely more pills come
   * through in a dense passage. This is only safe because judging windows are
   * now **per difficulty** (`hitWindowsFor` in `judge.ts`): the `good`/miss
   * window is capped to the chart's own gap, so `hitLane` still cannot retire a
   * neighbouring same-lane note. The cost is that Extreme is judged on a
   * proportionally tighter window (~0.14s good vs 0.19s) — which is exactly
   * what an extreme tier should feel like: less room to be sloppy.
   *
   * The other levers stack on top of the tighter gap:
   *
   *   - `approachSec` 0.95 vs hard's 1.3 — notes cover the highway ~27% faster,
   *     so there is far less time to read each one.
   *   - `targetNps` 5.4 vs 3.6 — the average sits near the new ceiling, so the
   *     dense passages actually fill in rather than breathe.
   *   - `chordChance` 0.32 vs 0.15 — roughly double the two-hand hits.
   */
  extreme: {
    name: 'extreme',
    laneCount: 4,
    subdivision: 4,
    minGapSec: 0.14,
    chords: true,
    chordChance: 0.32,
    targetNps: 5.4,
    approachSec: 0.95,
    // Holds off; 0.2 when enabled. Same shape as hard, a touch shorter.
    holdShare: 0,
    minHoldSec: 0.35,
    maxHoldSec: 2.5,
    maxConcurrentHolds: 2,
  },
};

/**
 * Lane -> keyboard key, left hand, scaling outward from the home row.
 * Desktop-first; touch input derives lane geometry independently.
 */
export const KEYMAPS: Record<number, readonly string[]> = {
  3: ['s', 'd', 'f'],
  4: ['a', 's', 'd', 'f'],
  5: ['a', 's', 'd', 'f', 'g'],
};

export function keymapFor(laneCount: number): readonly string[] {
  const keys = KEYMAPS[laneCount];
  if (!keys) throw new Error(`No keymap defined for ${laneCount} lanes`);
  return keys;
}
