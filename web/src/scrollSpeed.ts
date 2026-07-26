/**
 * Scroll speed — how fast notes travel the highway, as a player setting.
 *
 * `approachSec` (the seconds a note is visible before the hit line) was purely a
 * property of the difficulty: 1.9s on easy down to 0.95s on extreme. That
 * conflates two unrelated things. How *fast you can read* a moving board is a
 * personal trait — eyesight, screen size, how long you have played rhythm games —
 * while difficulty is a property of the chart. Every game in the genre separates
 * them, and it is consistently the setting whose absence players notice first.
 *
 * **Higher means faster**, the universal convention, so the multiplier *divides*
 * the approach time: at 2x a note covers the same highway in half the seconds.
 *
 * **This is not an assist.** `isAssisted` in `game/modifiers.ts` must classify
 * every new *modifier*, and the tempting reading is that more approach time is
 * easier and therefore assisted. It is not, for two reasons. Nothing about
 * judgement changes — note times, `HIT_WINDOWS` and `hitWindowsFor` are all
 * untouched, so a hit is worth exactly what it was. And the effect on difficulty
 * is not even monotonic: a *low* scroll speed crams more seconds of chart into the
 * same physical highway, so a dense passage arrives as an unreadable clump. High
 * scroll speed is what experienced players choose precisely because it spreads
 * notes out. There is no direction here that reliably makes a run easier, which is
 * why the genre shares leaderboards across scroll speeds and why this stays out of
 * `Modifiers` entirely.
 */

/**
 * The offered multipliers.
 *
 * Bounded at both ends by what stays readable rather than by round numbers. Below
 * 0.75 the clumping described above starts to hurt on hard and extreme; above 2
 * an extreme chart's approach falls under half a second (0.95 / 2 = 0.475s),
 * which is about the floor for reading a note's lane and reacting to it.
 */
export const SCROLL_SPEEDS: readonly number[] = [0.75, 1, 1.25, 1.5, 2];

/** The default, and deliberately exactly 1: every chart behaves as it always has. */
export const DEFAULT_SCROLL_SPEED = 1;

const STORAGE_KEY = 'tap-tap.scrollSpeed';

/** Float equality slack — these are stored and re-parsed as decimal strings. */
const EPSILON = 1e-6;

/**
 * Cached like the haptics mode and the quality setting. This is resolved once per
 * run rather than per frame, but the cache also keeps the menu and any other
 * reader consistent the instant the setter runs.
 */
let cached: number | null = null;

function isOffered(value: number): boolean {
  return SCROLL_SPEEDS.some((s) => Math.abs(s - value) < EPSILON);
}

export function getScrollSpeed(): number {
  if (cached !== null) return cached;
  try {
    const stored = Number.parseFloat(localStorage.getItem(STORAGE_KEY) ?? '');
    // A value no longer offered falls back rather than being clamped: the list is
    // a set of deliberate choices, and silently snapping someone to a neighbour
    // they did not pick is worse than returning them to the default.
    cached = Number.isFinite(stored) && isOffered(stored) ? stored : DEFAULT_SCROLL_SPEED;
  } catch {
    cached = DEFAULT_SCROLL_SPEED;
  }
  return cached;
}

export function setScrollSpeed(speed: number): void {
  cached = isOffered(speed) ? speed : DEFAULT_SCROLL_SPEED;
  try {
    localStorage.setItem(STORAGE_KEY, String(cached));
  } catch {
    // Private mode — the choice just will not persist.
  }
}

/** Next speed in the cycle, for a single-button toggle. Wraps. */
export function nextScrollSpeed(speed: number): number {
  const i = SCROLL_SPEEDS.findIndex((s) => Math.abs(s - speed) < EPSILON);
  return SCROLL_SPEEDS[(i + 1) % SCROLL_SPEEDS.length] ?? DEFAULT_SCROLL_SPEED;
}

/**
 * The approach time a run should actually use: the difficulty's own value scaled
 * by the player's speed.
 *
 * Takes the speed as an argument rather than reading it so callers resolve it
 * **once per run** — `visibleNotes` is called every frame from the render loop,
 * and `getScrollSpeed`'s cache would hide a `localStorage` read there rather than
 * remove it.
 */
export function approachSecFor(baseApproachSec: number, speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return baseApproachSec;
  return baseApproachSec / speed;
}

/** `1x`, `1.25x` — the genre's notation. */
export function scrollSpeedLabel(speed: number): string {
  return `${speed}x`;
}
