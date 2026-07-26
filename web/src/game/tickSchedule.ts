import type { Note } from '@tap-tap/shared';

/**
 * Which note times to hand the audio clock, and when.
 *
 * **Why anything is scheduled ahead at all.** A click fired the moment a note
 * passes — from the render loop, or from the player's `pointerdown` — reaches the
 * speaker one full output latency later. That is 10-20ms on a desktop and over
 * 200ms on a phone over Bluetooth, wider than the entire "good" judgement window.
 * A sound that late has no relationship to the beat it belongs to. Handing the
 * time to `AudioBufferSourceNode.start(when)` on the same clock as the music
 * instead makes it land exactly on the beat at any latency, because it never
 * waited on anything.
 *
 * **Why it cannot be conditional on the player hitting the note.** This is worth
 * stating plainly, because "play the click only when they hit it" is the obvious
 * ask and it is not achievable on the beat. A note at time T is judged missed
 * only once T + missWindow has passed, and the player's tap reaches the app a
 * whole output latency after they made it. So at the moment the sound has to be
 * committed to the audio graph — before T — whether it was hit is not merely
 * unknown, it is *unknowable*. Anything conditional therefore has to sound after
 * the window closes, which is late by up to 190ms: precisely the defect that
 * scheduling exists to avoid.
 *
 * So this is a **guide**, not feedback: a tick on every note, the feature other
 * rhythm games ship as an assist tick or assist clap. It teaches a chart and makes
 * timing audible. It is off by default because it adds a percussion layer to
 * somebody's music, and it is named for what it does rather than implying it is
 * reacting to the player.
 *
 * Pure and clock-free so the windowing is unit-testable; `AudioClock.playTickAt`
 * does the sounding.
 */

/**
 * How far ahead of the playhead to schedule.
 *
 * Long enough to survive a dropped frame or two — a 250ms hitch is not rare on a
 * phone, and a tick missed because the window was tight is a hole in the guide
 * exactly where the game was already struggling. Short enough that the ticks
 * still pending when a run pauses are few; they are silenced rather than tracked
 * individually (see `AudioClock.setTicksAudible`), but a shorter horizon keeps
 * that window small either way.
 */
export const TICK_LOOKAHEAD_SEC = 0.35;

export interface TickWindow {
  /** Distinct note times to schedule, ascending. */
  times: number[];
  /** Cursor to pass to the next call. */
  cursor: number;
}

/**
 * The note times falling in `(from, to]`, starting from `cursor`.
 *
 * `notes` must be sorted by time, which `Chart.notes` guarantees. The cursor only
 * ever moves forward, so a time is handed out exactly once however often this is
 * called — the render loop calls it every frame with overlapping windows, and a
 * tick scheduled twice is an audible flam rather than a click.
 *
 * Chord voices share a timestamp, so times are de-duplicated: two oscillators at
 * one instant is the same click at double amplitude, which reads as an accent the
 * chart did not ask for.
 */
export function ticksInWindow(
  notes: readonly Note[],
  cursor: number,
  from: number,
  to: number,
): TickWindow {
  const times: number[] = [];
  let i = Math.max(0, cursor);

  // Skip anything already behind the window. This also absorbs a stall: after a
  // long frame the notes in the gap are dropped rather than fired in a burst,
  // because a handful of clicks crammed into one instant is worse than silence.
  while (i < notes.length && notes[i]!.t <= from) i++;

  while (i < notes.length && notes[i]!.t <= to) {
    const t = notes[i]!.t;
    if (times.length === 0 || times[times.length - 1] !== t) times.push(t);
    i++;
  }

  return { times, cursor: i };
}

/**
 * Where the cursor should sit to begin ticking from `songTime`.
 *
 * Needed because a run does not always start at zero — the intro skip starts
 * playback near the first note — and because resuming from a pause has to
 * re-establish the cursor rather than carry a stale one: the ticks pending across
 * the pause were scheduled against context times that no longer mean anything
 * once the source restarts.
 */
export function cursorAt(notes: readonly Note[], songTime: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (notes[mid]!.t <= songTime) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
