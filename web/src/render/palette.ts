import type { Theme } from '@tap-tap/shared';
import { laneTones } from '@tap-tap/shared';
import type { Tier, Timing } from '../game/judge.js';

/**
 * Lane colours, left to right — **one accent hue per song, separated by value.**
 *
 * This used to index `theme.lanes` directly, i.e. five contrasting hues. It now
 * asks `shared/laneTones` for a tonal ramp around the theme's accent, which is
 * the reference look: every lane the same hue, lane identity carried by position
 * (and, for the five-lane case, by value). The reasoning, and why `theme.lanes`
 * is still the wire contract, is on `laneTones` in `shared/src/theme.ts`.
 *
 * The theme is passed in rather than read from a module-level "current theme".
 * A global would be one line shorter and wrong: the play screen and the editor
 * could disagree about it, and making this impure would leave the editor's
 * coordinate tests depending on load order.
 *
 * The ramp is memoised per theme *object*, not per id: it is called per lane in
 * the `Highway` constructor and per note in the editor's timeline draw, and
 * recomputing an HSL conversion on a render path is the kind of cost that hides.
 * A theme is immutable data, so identity is a safe key.
 */
const rampCache = new WeakMap<Theme, readonly number[]>();

export function laneColor(theme: Theme, lane: number): number {
  let ramp = rampCache.get(theme);
  if (!ramp) {
    ramp = laneTones(theme);
    rampCache.set(theme, ramp);
  }
  return ramp[lane % ramp.length] ?? 0xffffff;
}

export const TIER_COLORS: Record<Tier, string> = {
  perfect: '#00e5ff',
  great: '#00ff9d',
  good: '#ffd60a',
  /*
   * A flat, desaturated red, not the neon magenta this was.
   *
   * `MISS` is a callout, not an effect. At #ff2e88 (S~100%) it was measured as
   * the single most saturated object in a frame whose whole premise is that the
   * NOTES are the only high-chroma thing on screen — a judgement string
   * out-shouting the gameplay it is describing. Red still reads as failure and
   * still cannot be confused with any of the three positive tiers, which is the
   * only job this colour has.
   *
   * The size, the placement and the outer glow are DOM (`play__judgement` in
   * PlayScreen/styles.css) and are outside this pass's ownership; the hue is the
   * part that lives here.
   */
  miss: '#e0454a',
};

export const TIER_LABELS: Record<Tier, string> = {
  perfect: 'PERFECT',
  great: 'GREAT',
  good: 'GOOD',
  miss: 'MISS',
};

/**
 * Early and late get distinct colours rather than one "off" colour: the whole
 * point of showing direction is that the player can see a bias at a glance.
 */
export const TIMING_COLORS: Record<Timing, string> = {
  exact: '#ffffff',
  early: '#7cc4ff',
  late: '#ff9f45',
};

export const TIMING_LABELS: Record<Timing, string> = {
  exact: '',
  early: 'EARLY',
  late: 'LATE',
};
