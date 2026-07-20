/**
 * How much to shift judgement to account for output latency.
 *
 * Rendering is driven by the audio clock, which tracks what has been
 * *scheduled*. The player taps to what they *hear*, which arrives one output
 * latency later. So every tap is recorded late by that amount, and the engine —
 * which subtracts the calibration offset from tap time — needs it as a positive
 * number.
 *
 * On a Mac this is 10-20ms and nobody notices. Over Bluetooth on a phone it can
 * exceed 200ms, which is wider than the entire "good" window: the chart is
 * correct, the audio is correct, and every note still reads as late. That is
 * exactly the "feels offbeat with the UI" report, and it is why an uncalibrated
 * phone felt broken while a Mac felt fine.
 */

/** Nothing plausible is above this; a larger reading means a lying browser. */
const MAX_AUTO_SEC = 0.5;

/**
 * How far *before* a click a tap may land and still be read as anticipation.
 *
 * Beyond this, an apparently-early tap is treated as a late one belonging to the
 * previous click. See `foldTapDelta` for why that distinction cannot be skipped.
 */
export const MAX_LEAD_SEC = 0.12;

/**
 * Floor on a stored calibration.
 *
 * A player genuinely anticipating the beat is the only reason for a negative
 * offset, and `MAX_LEAD_SEC` is already this file's estimate of how far that
 * plausibly goes. Anything below it is a corrupt measurement rather than a
 * choice, and it is corrupt in the one direction that makes the game
 * unplayable rather than merely wrong.
 */
export const MIN_STORED_SEC = -MAX_LEAD_SEC;

/**
 * Resolve a tap-to-click error into a signed latency.
 *
 * **This exists because nearest-click matching aliases, and the aliasing lands
 * exactly where Bluetooth does.** A metronome repeats every `beatSec`, so a tap
 * is equidistant from two clicks at half a period and the naive "nearest click"
 * answer flips sign there. At 120 BPM that boundary is 250ms: a player on
 * Bluetooth headphones tapping a genuine 300ms late is *nearer* to the next
 * click, and gets measured as 200ms **early**. That produced a reported −200ms
 * calibration — a number with the wrong sign and the wrong magnitude, which
 * would then shift every note in the game the wrong way.
 *
 * Latency is physically non-negative — you cannot hear a click before it plays —
 * so the ambiguity is broken asymmetrically rather than at the midpoint. A tap
 * is read as early only within `MAX_LEAD_SEC`; everything else is late. That
 * makes the measurable range `[-MAX_LEAD_SEC, beatSec - MAX_LEAD_SEC)`, which is
 * why the metronome runs slowly: the period has to comfortably clear the worst
 * Bluetooth latency, or the same wrap comes back.
 *
 * @param delta   raw seconds from the tap to any nearby click (sign: late positive)
 * @param beatSec the metronome period
 */
export function foldTapDelta(delta: number, beatSec: number): number {
  // Into [0, beatSec), surviving negative inputs and taps more than a full
  // period out.
  const phase = ((delta % beatSec) + beatSec) % beatSec;
  return phase >= beatSec - MAX_LEAD_SEC ? phase - beatSec : phase;
}

export function resolveCalibration(stored: number | null, outputLatency: number): number {
  // A stored value wins. The player measured their own device by ear, and that
  // measurement already contains the output latency — adding it again would
  // double-count and push everything the other way.
  //
  // Floored, though, and only in the region that is physically impossible.
  // Calibration shifts tap times, so a *negative* offset judges every tap later
  // than it landed; once it passes the miss window, nothing can ever be hit and
  // the game reports 100% misses with no clue why. Large *positive* values are
  // left alone — 300ms is an ordinary Bluetooth reading and clamping those
  // would break the players this feature exists for.
  //
  // This is not hypothetical: the metronome aliasing that `foldTapDelta` fixes
  // produced a stored -200ms, and every tap on that device missed.
  if (stored !== null) return Math.max(stored, MIN_STORED_SEC);

  // Anything outside the plausible range is a browser lying rather than a
  // genuinely enormous latency. Fall back to no compensation: shifting every
  // note by a wrong constant is indistinguishable from a broken chart, and it
  // would be blamed on the chart generator rather than on this.
  if (!Number.isFinite(outputLatency)) return 0;
  if (outputLatency <= 0 || outputLatency > MAX_AUTO_SEC) return 0;
  return outputLatency;
}
