import type { Theme } from '@tap-tap/shared';
import type { Tier, Timing } from '../game/judge.js';

/**
 * Lane colours, left to right, read from the song's theme.
 *
 * The theme is passed in rather than read from a module-level "current theme".
 * A global would be one line shorter and wrong: the play screen and the editor
 * could disagree about it, and making this impure would leave the editor's
 * coordinate tests depending on load order.
 *
 * The modulo is defence, not design — every theme is required to carry at least
 * `MIN_THEME_LANES` and a test enforces it, because two lanes sharing a colour
 * is unplayable rather than ugly.
 */
export function laneColor(theme: Theme, lane: number): number {
  return theme.lanes[lane % theme.lanes.length] ?? 0xffffff;
}

export const TIER_COLORS: Record<Tier, string> = {
  perfect: '#00e5ff',
  great: '#00ff9d',
  good: '#ffd60a',
  miss: '#ff2e88',
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
