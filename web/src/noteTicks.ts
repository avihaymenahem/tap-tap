/**
 * The player's switch for note ticks — a click scheduled on every note.
 *
 * The mechanism, and why it is a guide rather than feedback, is documented on
 * `game/tickSchedule.ts`. The short version: a click can be made to land exactly
 * on the beat at any output latency, but only by committing it to the audio graph
 * *before* the note — at which point whether the player hit it is unknowable, not
 * merely unknown. So it ticks for every note either way.
 *
 * **Off by default.** Unlike the other audio settings this one adds a percussion
 * layer to somebody's music rather than adjusting the game's own sounds, so it has
 * to be asked for. The players it helps — anyone learning a chart, or working out
 * whether a passage feels off because of the chart or because of their timing —
 * will go looking for it.
 *
 * Cached exactly as `flash.ts` and `haptics.ts` cache theirs: this is read from
 * the render loop, and a `localStorage.getItem` there is a synchronous
 * disk-backed read on the hottest path in the app.
 */

const STORAGE_KEY = 'tap-tap.noteTicks';

let cached: boolean | null = null;

export function noteTicksEnabled(): boolean {
  if (cached !== null) return cached;
  try {
    cached = localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    cached = false;
  }
  return cached;
}

export function setNoteTicks(enabled: boolean): void {
  cached = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Private mode — the setting just will not persist.
  }
}
