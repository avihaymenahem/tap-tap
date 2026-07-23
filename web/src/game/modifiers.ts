import type { Note } from '@tap-tap/shared';

/**
 * Per-run play modifiers.
 *
 * Runtime-only: a modifier changes how *this* run plays, not the chart on disk,
 * so it deliberately never crosses the wire and lives here rather than in
 * `shared/`. The chart the beatmap stores is untouched — mirror transforms a
 * copy, speed bends the clock, visibility is a render choice, and fail is an
 * engine flag. None of them mutate the `Beatmap`.
 *
 * Pure over its inputs so the whole set is unit-testable without a game running.
 */

/**
 * How notes reveal on the highway.
 *  - `normal`  — always visible.
 *  - `hidden`  — fade *out* as they near the receptor (read early, commit blind).
 *  - `fadeout` — hidden until they are close, then appear (read late).
 */
export type Visibility = 'normal' | 'hidden' | 'fadeout';

export interface Modifiers {
  /**
   * When true, running out of health ends the run. Off by default: the charts
   * are machine-generated, so failing has to be a choice the player opts into
   * rather than something an over-eager generator inflicts. See PLAN — health.
   */
  fail: boolean;
  /** Flip the board left-to-right: lane `l` becomes `laneCount - 1 - l`. */
  mirror: boolean;
  visibility: Visibility;
  /**
   * Playback rate, 1 = normal. Bends the audio clock and, with it, the whole
   * timeline; the chart's note times are unchanged. Bounded by `SPEED_CHOICES`.
   */
  speed: number;
  /**
   * Whether hold notes play as holds. On by default; turning it off demotes
   * every hold to a plain tap, for players who would rather the chart were all
   * taps. Applied at engine build, like mirror.
   */
  holds: boolean;
}

export const DEFAULT_MODIFIERS: Modifiers = {
  fail: false,
  mirror: false,
  visibility: 'normal',
  speed: 1,
  holds: true,
};

/** The speeds the UI offers. 1 is centre; the extremes are deliberately modest. */
export const SPEED_CHOICES: readonly number[] = [0.75, 1, 1.25, 1.5];

/** True when nothing is changed from a plain run — used to hide "modified" UI. */
export function isDefaultModifiers(mods: Modifiers): boolean {
  return (
    !mods.fail &&
    !mods.mirror &&
    mods.visibility === 'normal' &&
    mods.speed === 1 &&
    mods.holds
  );
}

/**
 * A copy of the notes with lanes flipped across the board.
 *
 * Pure: returns a new array of new notes, so the caller can mirror the played
 * chart without disturbing the beatmap it came from. Applied once at chart-build
 * time (like the intro-offset filter) so the engine and the renderer both see
 * the same mirrored lanes — the physical keymap and tap-to-lane mapping never
 * move, only *which* notes land in which lane.
 */
export function mirrorNotes(notes: readonly Note[], laneCount: number): Note[] {
  return notes.map((note) => ({ ...note, lane: laneCount - 1 - note.lane }));
}

/**
 * Score multiplier for a modified run.
 *
 * A seam for later: harder settings (higher speed, hidden) could pay more and
 * easier ones less. In v1 every run scores the same — the scores are personal
 * and local, so there is no ladder to protect — and this returns 1. Kept so the
 * call site exists the day that changes.
 */
export function scoreMultiplierFor(_mods: Modifiers): number {
  return 1;
}
