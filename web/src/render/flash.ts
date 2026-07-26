/**
 * Photosensitivity limits on the beat flash.
 *
 * The backdrop flares on every downbeat — `uPulse` swells the sun, brightens it
 * past the bloom threshold, and lifts the haze, the rails and the hit bar with
 * it. That is a large-area luminance change repeating at exactly the song's
 * tempo, and tempo is not a number this game controls: it comes from whatever
 * the player pasted a link to. At 240 BPM the flare fires four times a second.
 *
 * WCAG 2.3.1 draws its general threshold at **more than three flashes in any
 * one second**. Nothing in the renderer was bounded by that, so the safety of
 * the effect was a property of the music rather than of the code.
 *
 * Two independent mitigations, because they answer different needs:
 *
 *  - `flashStride` caps the *rate*, by pulsing on every Nth beat instead of
 *    every beat. Skipping beats keeps the flash musical — it still lands on the
 *    grid, just on alternate downbeats — where clamping to a fixed 3 Hz would
 *    drift against the song and read as broken.
 *  - `flashEffectsEnabled` is the player's own switch, for anyone who wants the
 *    flare gone entirely. Deliberately separate from `prefers-reduced-motion`:
 *    plenty of people want motion and not flashing, and the reverse.
 *
 * Kept pure and free of three.js so the rate maths is unit-testable, the same
 * split `holdSpan` uses.
 *
 * This bounds a known hazard. It is not a medical guarantee, and nothing in the
 * UI should imply one — see the toggle's copy.
 */

/** Flashes per second the effect may not exceed. The WCAG 2.3.1 threshold. */
export const MAX_FLASH_HZ = 3;

/**
 * How many beats to advance between flashes so the rate stays within
 * `MAX_FLASH_HZ`. 1 means "flash on every beat" — the common case.
 *
 * Derived from the grid's **median** interval rather than its mean or its first
 * gap: the grid is tracked through the song rather than extrapolated from one
 * tempo, so a handful of stretched or clipped beats around a tempo change are
 * expected, and a median ignores them. One stride for the whole song, because a
 * stride that changed as the tempo drifted would itself produce an irregular,
 * stuttering flash — worse than the thing being fixed.
 */
export function flashStride(beatGrid: readonly number[]): number {
  if (beatGrid.length < 2) return 1;

  const gaps: number[] = [];
  for (let i = 1; i < beatGrid.length; i++) {
    const gap = beatGrid[i]! - beatGrid[i - 1]!;
    if (gap > 0 && Number.isFinite(gap)) gaps.push(gap);
  }
  if (gaps.length === 0) return 1;

  gaps.sort((a, b) => a - b);
  const median = gaps[gaps.length >> 1]!;
  return Math.max(1, Math.ceil(1 / median / MAX_FLASH_HZ));
}

// --- the player's switch ----------------------------------------------------

const STORAGE_KEY = 'tap-tap.flashEffects';

/**
 * Cached for the same reason `haptics.ts` caches its mode: this is read once
 * per frame from inside the render loop, and a `localStorage.getItem` there is a
 * synchronous disk-backed read on the hottest path in the app. Refreshed by the
 * setter, so a change from the pause menu takes effect on the very next frame.
 */
let cached: boolean | null = null;

/** On by default — the flare is part of the game's look. */
export function flashEffectsEnabled(): boolean {
  if (cached !== null) return cached;
  try {
    cached = localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    cached = true;
  }
  return cached;
}

export function setFlashEffects(enabled: boolean): void {
  cached = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Private mode — the setting just will not persist.
  }
}
