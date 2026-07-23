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
 * **`good` is capped by the chart's own `minGapSec`.** Chart spacing is enforced
 * globally, so that is the closest two notes can ever be — including two in the
 * same lane. `hitLane` resolves a tap to the *nearest* candidate, so once the
 * window is wider than the gap, a tap aimed at a note can be closer to the one
 * after it and retire the wrong one, leaving the intended note to miss on its
 * own. This used to be a single global cap at the hardest difficulty's 0.19s;
 * it is now enforced per difficulty by `hitWindowsFor`, so Extreme can pack
 * notes tighter than 0.19 and simply judges them on a proportionally tighter
 * window — which is what makes it play *extreme* rather than merely fast.
 *
 * These are the *base* (widest) windows, used by every difficulty whose gap is
 * at least 0.19s — easy, medium and hard, i.e. unchanged. `engine.test.ts`
 * asserts each difficulty's effective window never exceeds its own gap.
 */
export interface HitWindows {
  perfect: number;
  great: number;
  good: number;
}

export const HIT_WINDOWS: HitWindows = {
  perfect: 0.085,
  great: 0.14,
  good: 0.19,
};

/**
 * The tier windows scaled so their outer edge fits a chart's note spacing.
 *
 * When `minGapSec` is at or above the base `good` window (easy/medium/hard),
 * the base windows are returned unchanged. When it is tighter (Extreme), all
 * three tiers scale down by the same factor, so their *ratios* are preserved —
 * "perfect" still means "the tightest third of the hittable range" — and the
 * outer edge lands exactly on the gap, which is what keeps `hitLane` from
 * retiring a neighbouring same-lane note.
 */
export function hitWindowsFor(minGapSec: number): HitWindows {
  const good = Math.min(HIT_WINDOWS.good, minGapSec);
  const scale = good / HIT_WINDOWS.good;
  return {
    perfect: HIT_WINDOWS.perfect * scale,
    great: HIT_WINDOWS.great * scale,
    good,
  };
}

/**
 * Inside this, a hit counts as dead-on and neither early nor late.
 *
 * Deliberately left tight while the tiers widened. This drives the exact bonus
 * and the EARLY/LATE readout, so it has to mean genuine precision — widening it
 * alongside `perfect` would hand out the bonus for merely-good taps and make
 * the timing feedback useless for spotting a consistent bias.
 */
export const EXACT_WINDOW = 0.022;

/**
 * Past this, a tap does not belong to the note at all. The base value; the
 * engine uses a per-chart window from `hitWindowsFor` so a tighter difficulty
 * both spaces and judges its notes closer.
 */
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

/**
 * Signed seconds: negative = early, positive = late. `windows` defaults to the
 * base set, so callers that do not care about difficulty (tests, tooling) keep
 * working; the engine passes its per-chart windows.
 */
export function tierFor(deltaSec: number, windows: HitWindows = HIT_WINDOWS): Tier {
  const error = Math.abs(deltaSec);
  if (error <= windows.perfect) return 'perfect';
  if (error <= windows.great) return 'great';
  if (error <= windows.good) return 'good';
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
 * Score ticks while a hold is down — the "juice" that makes holding feel active
 * rather than a chore of keeping a finger pressed. A tick fires every
 * `HOLD_TICK_SEC` of held song-time and is worth `HOLD_TICK_SCORE` before the
 * combo multiplier. Ticks add score and nothing else: they never touch the tap
 * accuracy tally or the combo, so a hold stays *strictly additive* (breaking one
 * simply stops the ticks) while still paying out steadily for holding it.
 */
export const HOLD_TICK_SEC = 0.25;
export const HOLD_TICK_SCORE = 22;

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

/**
 * Fold every note the run never reached into the miss count.
 *
 * The live HUD accuracy divides by the notes *faced so far* — a running read of
 * current form, which is what you want while playing. But the run that gets
 * saved as a personal best, and the grade on the results card, must be scored
 * over the *whole* chart: bailing out of the pause menu after three clean taps
 * is not a flawless run, and without this it read as 100% / S and was crowned a
 * new best. Any note the engine never judged (the player quit early) counts as a
 * miss here, so the final accuracy, grade and tier breakdown all agree and
 * reflect the entire song. On a natural finish every note is already judged, so
 * this is a no-op.
 */
export function foldUnreached(
  counts: Record<Tier, number>,
  totalNotes: number,
): Record<Tier, number> {
  const judged = TIERS.reduce((sum, tier) => sum + counts[tier], 0);
  const unreached = Math.max(0, totalNotes - judged);
  return { ...counts, miss: counts.miss + unreached };
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
