/**
 * Vibration feedback.
 *
 * Three lessons shaped this, all learned the hard way:
 *
 * 1. **Do not vibrate on a miss by default.** A miss is a note the player did
 *    not tap, so the buzz has no causal link to anything they did. It reads as
 *    random, and it is the single most confusing thing haptics can do here.
 *
 * 2. **All hits feel the same.** The first version made worse hits buzz longer
 *    (perfect 8ms, good 22ms), which is backwards — a clean hit should feel
 *    crisp and decisive, not quieter than a sloppy one.
 *
 * 3. **Short pulses do not exist.** Phone vibration motors need roughly 20-30ms
 *    to spin up and down, so an 8ms request renders as weak mush, and pulses
 *    closer than a couple hundred milliseconds smear together. Encoding detail
 *    finer than the motor can reproduce just produces inconsistency.
 *
 * Not supported on iOS Safari at all — there is no web haptics API there.
 */

export type HapticMode = 'off' | 'hits' | 'misses';

export const HAPTIC_MODES: readonly HapticMode[] = ['off', 'hits', 'misses'];

export const HAPTIC_MODE_LABELS: Record<HapticMode, string> = {
  off: 'Off',
  hits: 'On hits',
  misses: 'On misses',
};

const STORAGE_KEY = 'tap-tap.hapticMode';

/**
 * Short on purpose.
 *
 * A longer pulse is stronger but its sensation peaks later and lingers, which
 * reads as the buzz arriving *late*. Perceived onset barely moves with
 * duration, so trimming it buys crispness at a little strength.
 *
 * Roughly 25-40ms of latency remains regardless — event dispatch plus the
 * motor's own spin-up — and no web API can shorten that.
 */
const HIT_PULSE_MS = 12;
/** Firmer and longer, so a dropped note cannot be mistaken for a hit. */
const MISS_PULSE_MS = 45;

/** Misses arrive in bursts when a combo drops; without this it is one long buzz. */
const MISS_THROTTLE_MS = 320;
/**
 * Negative infinity, not 0. Zero reads as "a miss just happened at time zero",
 * which swallows the very first miss — and since `performance.now()` starts
 * near zero, that silently covers the opening moments of a page too.
 */
let lastMissAt = Number.NEGATIVE_INFINITY;

/*
 * Both of these are cached, because `vibrateTap` runs on the *tap* — the most
 * latency-sensitive path in the app — and a `localStorage.getItem` there is a
 * synchronous disk-backed read that measurably delays the buzz. The setting
 * changes rarely (only via `setHapticMode`, which refreshes the cache), and
 * support never changes, so reading them once is safe.
 */
let cachedSupported: boolean | null = null;
let cachedMode: HapticMode | null = null;

export function hapticsSupported(): boolean {
  if (cachedSupported === null) {
    cachedSupported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }
  return cachedSupported;
}

function isMode(value: string | null): value is HapticMode {
  return value !== null && (HAPTIC_MODES as readonly string[]).includes(value);
}

export function getHapticMode(): HapticMode {
  if (cachedMode !== null) return cachedMode;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    cachedMode = isMode(stored) ? stored : 'hits';
  } catch {
    cachedMode = 'hits';
  }
  return cachedMode;
}

export function setHapticMode(mode: HapticMode): void {
  cachedMode = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Private mode — the setting just will not persist.
  }
}

/** Next mode in the cycle, for a single-button toggle. */
export function nextHapticMode(mode: HapticMode): HapticMode {
  return HAPTIC_MODES[(HAPTIC_MODES.indexOf(mode) + 1) % HAPTIC_MODES.length] ?? 'off';
}

function fire(durationMs: number): void {
  try {
    navigator.vibrate(durationMs);
  } catch {
    // Some browsers throw when the document lacks user activation.
  }
}

/**
 * Acknowledge a lane press.
 *
 * Fires on the *input*, not on the judgement, and deliberately before any
 * scoring work happens. Two reasons: nothing sits between the keypress and the
 * buzz, and every tap feels the same whether or not it connected. Vibrating
 * only on successful hits means a slightly-off tap produces nothing at all, and
 * feedback that appears only sometimes reads as feedback that arrives late.
 *
 * Reads the setting on every call so a change takes effect immediately.
 */
export function vibrateTap(): void {
  if (!hapticsSupported() || getHapticMode() !== 'hits') return;
  fire(HIT_PULSE_MS);
}

/**
 * A rolling buzz while a hold is down.
 *
 * Call it every frame a lane is held; it self-throttles. Each pulse is longer
 * than a tap and re-fires *before* the motor fully spins down, so the string of
 * pulses smears into a near-continuous hum — exactly the "still holding it"
 * sensation, which the same smearing that ruins fast distinct pulses gives for
 * free here. Gated to `hits` mode, the same family as the tap buzz.
 */
const HOLD_PULSE_MS = 55;
const HOLD_BUZZ_INTERVAL_MS = 150;
let lastHoldBuzzAt = Number.NEGATIVE_INFINITY;

export function vibrateHold(): void {
  if (!hapticsSupported() || getHapticMode() !== 'hits') return;
  const now = performance.now();
  if (now - lastHoldBuzzAt < HOLD_BUZZ_INTERVAL_MS) return;
  lastHoldBuzzAt = now;
  fire(HOLD_PULSE_MS);
}

/** Feedback for a dropped note. Only in `misses` mode, and throttled. */
export function vibrateMiss(): void {
  if (!hapticsSupported() || getHapticMode() !== 'misses') return;

  const now = performance.now();
  if (now - lastMissAt < MISS_THROTTLE_MS) return;
  lastMissAt = now;

  fire(MISS_PULSE_MS);
}

/** A one-off pulse, for confirming a setting change. */
export function vibratePreview(): void {
  if (!hapticsSupported()) return;
  try {
    navigator.vibrate(HIT_PULSE_MS);
  } catch {
    // Ignored.
  }
}

/** Stop any in-flight pattern, e.g. when leaving the play screen. */
export function cancelHaptics(): void {
  if (!hapticsSupported()) return;
  try {
    navigator.vibrate(0);
  } catch {
    // Nothing to cancel.
  }
}
