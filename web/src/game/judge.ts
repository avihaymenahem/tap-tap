/**
 * Hit judgement. Pure functions over time deltas — no audio, no DOM, no React.
 *
 * A hit has two independent properties:
 *
 *   tier    how close it was, ignoring direction (perfect / great / good)
 *   timing  which side it fell on (exact / early / late)
 *
 * Keeping them separate matters. Tier drives the score; timing tells the player
 * *why* they are dropping points, which is the feedback that actually makes
 * someone improve. "You are consistently 40ms early" is actionable in a way
 * that "GOOD" is not.
 */

export type Tier = 'perfect' | 'great' | 'good' | 'miss';
export type Timing = 'exact' | 'early' | 'late';

export const TIERS: readonly Tier[] = ['perfect', 'great', 'good', 'miss'];
export const TIMINGS: readonly Timing[] = ['exact', 'early', 'late'];

/**
 * Absolute seconds of error allowed for each tier.
 *
 * These are the forgiveness knobs. The original values mirrored DDR-style
 * strictness (±45ms for a perfect), which is punishing for a game people play
 * on a phone with one thumb — and phone input latency varies enough between
 * devices that even a calibrated player is fighting some jitter. Widened so a
 * tap that *feels* on the beat scores like it.
 *
 * `good` doubles as the miss threshold, so raising it makes the whole game more
 * forgiving, not just the top tier.
 *
 * **`good` is capped by `minGapSec` on the hardest difficulty (0.19).** Chart
 * spacing is enforced globally, so that is the closest two notes can ever be —
 * including two in the same lane. `hitLane` resolves a tap to the *nearest*
 * candidate, so once the window is wider than the gap, a tap aimed at a note can
 * be closer to the one after it and retire the wrong one, leaving the intended
 * note to miss on its own. Widening past 0.19 trades one kind of miss for a
 * more confusing kind.
 *
 * If fast sections still feel unfair after this, the lever is `minGapSec` — make
 * the dense passages less dense — not a wider window. `engine.test.ts` asserts
 * the cap.
 */
export const HIT_WINDOWS = {
  perfect: 0.085,
  great: 0.14,
  good: 0.19,
} as const;

/**
 * Inside this, a hit counts as dead-on and neither early nor late.
 *
 * Deliberately left tight while the tiers widened. This drives the exact bonus
 * and the EARLY/LATE readout, so it has to mean genuine precision — widening it
 * alongside `perfect` would hand out the bonus for merely-good taps and make
 * the timing feedback useless for spotting a consistent bias.
 */
export const EXACT_WINDOW = 0.022;

/** Past this, a tap does not belong to the note at all. */
export const MISS_WINDOW = HIT_WINDOWS.good;

export const SCORE_VALUES: Record<Tier, number> = {
  perfect: 300,
  great: 200,
  good: 100,
  miss: 0,
};

/** Landing dead-on is worth more than landing early or late in the same tier. */
export const EXACT_BONUS = 1.25;

/** Combo multiplier caps out so long songs do not run away with the score. */
export const MAX_COMBO_MULTIPLIER = 4;

/** Signed seconds: negative = early, positive = late. */
export function tierFor(deltaSec: number): Tier {
  const error = Math.abs(deltaSec);
  if (error <= HIT_WINDOWS.perfect) return 'perfect';
  if (error <= HIT_WINDOWS.great) return 'great';
  if (error <= HIT_WINDOWS.good) return 'good';
  return 'miss';
}

export function timingOf(deltaSec: number): Timing {
  if (Math.abs(deltaSec) <= EXACT_WINDOW) return 'exact';
  return deltaSec < 0 ? 'early' : 'late';
}

/** Points before the combo multiplier. */
export function baseScore(tier: Tier, timing: Timing): number {
  const base = SCORE_VALUES[tier];
  if (base === 0) return 0;
  return Math.round(base * (timing === 'exact' ? EXACT_BONUS : 1));
}

export function comboMultiplier(combo: number): number {
  return Math.min(MAX_COMBO_MULTIPLIER, 1 + Math.floor(combo / 25));
}

// --- holds -----------------------------------------------------------------

/**
 * How early a hold may be released and still count as completed.
 *
 * Generous on purpose. Releasing is not a timing skill the way tapping is —
 * nobody is listening for the *end* of a sustain the way they hear its
 * attack — so punishing it precisely would add difficulty without adding
 * anything a player could practise.
 */
export const HOLD_RELEASE_WINDOW = 0.15;

/**
 * The release window is also capped at this fraction of the hold's own length.
 *
 * Without the cap a 200ms hold would be completable by tapping it, since the
 * flat window covers the whole note — short holds would be free, and the
 * generator produces plenty of short ones.
 */
const HOLD_RELEASE_MAX_SHARE = 0.35;

export function releaseWindowFor(duration: number): number {
  return Math.min(HOLD_RELEASE_WINDOW, duration * HOLD_RELEASE_MAX_SHARE);
}

/** Points per second of a completed hold, before the combo multiplier. */
export const HOLD_BONUS_PER_SEC = 120;

/**
 * Longest stretch of a hold that earns the bonus.
 *
 * A sustain detected across an outro could otherwise be worth more than the
 * rest of the chart. The cap keeps one long note from dominating a score
 * without needing the generator to promise anything about length.
 */
export const MAX_SCORED_HOLD_SEC = 4;

/**
 * The completion bonus. Zero for a broken hold — that is the entire cost of
 * breaking one, by design: the head score and the combo both survive, so a hold
 * can only ever add to what the same note would have scored as a tap.
 */
export function holdBonus(duration: number): number {
  return Math.round(HOLD_BONUS_PER_SEC * Math.min(duration, MAX_SCORED_HOLD_SEC));
}

/**
 * Accuracy as a 0..1 ratio of tier quality. Deliberately excludes the exact
 * bonus: accuracy measures how cleanly notes were hit, while the bonus is a
 * reward layered on the score. Folding the bonus in would make 100% mean
 * "every note dead-on", which is unreachable and stops being a useful signal.
 */
export function accuracyOf(counts: Record<Tier, number>): number {
  const judged = TIERS.reduce((sum, tier) => sum + counts[tier], 0);
  if (judged === 0) return 1;
  const earned = TIERS.reduce((sum, tier) => sum + counts[tier] * SCORE_VALUES[tier], 0);
  return earned / (judged * SCORE_VALUES.perfect);
}

/** Letter grade for the results screen. */
export function gradeFor(accuracy: number): string {
  if (accuracy >= 0.95) return 'S';
  if (accuracy >= 0.9) return 'A';
  if (accuracy >= 0.8) return 'B';
  if (accuracy >= 0.7) return 'C';
  if (accuracy >= 0.6) return 'D';
  return 'F';
}

/**
 * A one-line read on a player's bias, for the results screen.
 * `meanDelta` is in seconds; negative means they tend to hit early.
 */
export function biasAdvice(meanDelta: number, hits: number): string | null {
  if (hits < 8 || Math.abs(meanDelta) < 0.018) return null;
  const ms = Math.round(Math.abs(meanDelta) * 1000);
  const side = meanDelta < 0 ? 'early' : 'late';
  return `You hit ${ms}ms ${side} on average — try calibrating.`;
}
