import type { Tier } from './judge.js';

/**
 * The health model.
 *
 * Pure functions over a `0..1` health value — no audio, no DOM, no React — so
 * the whole thing is unit-testable and the engine can own the state without the
 * rules living in a component. Health is always tracked and always shown; whether
 * reaching 0 actually *ends* a run is the caller's decision (the `fail`
 * modifier), never this module's. Separating "how health moves" from "what
 * happens at 0" keeps both testable in isolation.
 *
 * The one design rule the numbers must satisfy: a struggling run has to trend
 * *down*. A miss must cost clearly more than a good streak heals, or health
 * would drift up no matter how badly the player is doing and the bar would be a
 * lie. The deltas below are written as multiples of one base step so that
 * relationship is visible and stays true if the base is retuned — the same
 * discipline the hit windows use.
 */

export interface HealthConfig {
  /** Where a run begins. Full, so early mistakes are survivable. */
  start: number;
  /** Per-tier change to health. Positive heals, negative drains. */
  delta: Record<Tier, number>;
}

/**
 * One step of health movement. Everything else is a multiple of it, so the
 * balance between healing and draining is legible and survives retuning.
 */
const STEP = 0.02;

export const HEALTH_CONFIG: HealthConfig = {
  start: 1,
  delta: {
    // Healing is small and slow — health is a safety margin the player rebuilds,
    // not a resource that refills the instant they hit a note.
    perfect: STEP,
    great: STEP * 0.5,
    // A `good` is a scrappy hit near the miss edge: neither rewarded nor
    // punished, so a run that is merely imprecise holds steady rather than dying.
    good: 0,
    // A miss costs far more than a perfect heals (5×), so a bad passage drains
    // quickly and a clean one recovers only gradually. This is the asymmetry
    // that makes the bar mean something.
    miss: -STEP * 5,
  },
};

/** Clamp to the playable range. Health never exceeds full or drops below empty. */
export function clampHealth(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Health after judging a note at `tier`. Clamped, so healing never overflows a
 * full bar and draining never runs negative — `failed` is decided by reaching
 * exactly 0, and a value that undershot would still read as 0 but hide how far
 * under it went.
 */
export function applyHealthDelta(
  health: number,
  tier: Tier,
  config: HealthConfig = HEALTH_CONFIG,
): number {
  return clampHealth(health + config.delta[tier]);
}

/** True once health has drained to nothing. The caller decides if that ends the run. */
export function isDead(health: number): boolean {
  return health <= 0;
}
