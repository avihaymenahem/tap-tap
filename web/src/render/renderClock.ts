/**
 * The RENDERING clock — a phase-locked smoother over the audio clock.
 *
 * **Why this exists, measured rather than assumed.** The owner reported that
 * note movement "feels kinda sluggy, not smooth", and the obvious diagnosis —
 * dropped frames — is wrong on the evidence: the real GPU renders play at
 * ~149fps, p50 6.7ms, with **zero** frames over 33ms. The judder is in the
 * *time* the renderer is handed, not in when it is handed it.
 *
 * `AudioContext.currentTime` does not advance continuously. It is republished
 * once per audio render quantum, and sampling it from `requestAnimationFrame`
 * on this machine (Chrome/Windows, 48kHz) shows it stepping in units of
 * **10.667ms** (512 samples) and nothing finer:
 *
 * ```
 *   in play, 75Hz vsync:  10.67 10.67 21.33 21.33 10.67 10.67 21.33 10.67 ...
 *   on the menu, 290fps:  0 10.67 0 0 10.67 0 0 10.67 ...
 * ```
 *
 * So the per-frame *advance* of song time alternates between one quantum and
 * two — or between zero and one — while the frames themselves are perfectly
 * even. A note's on-screen step therefore alternates between 0 and ~2x its
 * average: it freezes for a frame, then jumps double. That is precisely the
 * "not smooth" the player sees, it gets **worse** the higher the frame rate,
 * and no amount of frame-time work can touch it. Measured on the shipped rig,
 * a note near the receptor moves ~15 device px per 120Hz frame on average, so
 * the pulsing is a ±15px oscillation — nothing subtle.
 *
 * **This does not make frame deltas the master clock, and must not become
 * that.** The invariant in CLAUDE.md is about anything the player can *hear or
 * feel*: judgement, note times, tick scheduling. Those all still read
 * `AudioClock.currentTime` directly and are untouched here. What this class
 * does is *interpolate between the audio clock's own updates* for the
 * renderer only, with the audio clock as the anchor:
 *
 *  - the advance rate is **measured from the audio clock itself** (a decaying
 *    ratio of audio time to wall time), so a 0.75x speed modifier or a
 *    lead-in needs no special case and there is no assumed 1.0;
 *  - every frame a fraction of the phase error is fed back, so the estimate
 *    cannot drift — the mean error against the audio clock is zero;
 *  - the result is hard-clamped to `MAX_ERROR_SEC` of the audio clock, so even
 *    a pathological wall clock can only ever be a few milliseconds out, which
 *    is well inside a single quantum and an order of magnitude inside the
 *    tightest hit window;
 *  - any discontinuity larger than `RESYNC_SEC` (start, restart, seek,
 *    pause/resume, the frozen lead-in) snaps rather than slews.
 *
 * Pure and DOM-free, so it is unit-tested like the rest of `game/`.
 */

/**
 * Phase gap past which the smoother stops slewing and simply jumps.
 *
 * Comfortably larger than the observed quantum (10.7ms) and than any plausible
 * frame overrun, and far smaller than a seek. A run start, a restart, an
 * intro skip and the frozen lead-in all land well the other side of it.
 */
const RESYNC_SEC = 0.08;
/**
 * Hard bound on how far the smoothed time may sit from the audio clock.
 *
 * The safety net: whatever the feedback loop does, this is the worst error the
 * renderer can show. One quantum. It also caps how far the estimate can run on
 * while the audio clock is stalled (a paused context republishes the same
 * value), so the board creeps a hair rather than sliding away.
 */
const MAX_ERROR_SEC = 0.011;
/**
 * Fraction of the remaining phase error taken each frame.
 *
 * Low enough that the correction is a few percent of a frame's motion — a
 * smooth breathing of the scroll rate rather than the 0/2x pulsing it
 * replaces — and high enough to re-lock within a few frames after a stall.
 */
const CORRECTION = 0.08;
/**
 * Decay applied to the rate estimator's accumulators each frame: an
 * exponential window of roughly 1/(1-x) frames. ~17 frames spans several audio
 * quanta at any shipped frame rate, which is what makes the estimate steady
 * despite the input being a step function.
 */
const RATE_DECAY = 0.94;
/** Wall-clock deltas above this are a tab stall, not a frame; clamp rather than leap. */
const MAX_DT_SEC = 0.1;

export class RenderClock {
  private started = false;
  private value = 0;
  private lastAudio = 0;
  private lastWall = 0;
  private audioAccum = 0;
  private wallAccum = 0;
  private rate = 1;

  /**
   * Feed the authoritative audio time and the wall time of this frame, both in
   * seconds; returns the time the renderer should draw. Call exactly once per
   * frame.
   */
  update(audioTime: number, wallSec: number): number {
    if (!Number.isFinite(audioTime) || !Number.isFinite(wallSec)) return this.value;

    if (!this.started || Math.abs(audioTime - this.value) > RESYNC_SEC) {
      this.started = true;
      this.value = audioTime;
      this.lastAudio = audioTime;
      this.lastWall = wallSec;
      this.audioAccum = 0;
      this.wallAccum = 0;
      this.rate = 1;
      return this.value;
    }

    const dt = Math.min(MAX_DT_SEC, Math.max(0, wallSec - this.lastWall));

    // The rate the audio clock is actually advancing at, averaged over enough
    // frames to span several of its quanta. Never assumed to be 1: a speed
    // modifier, a paused context and the count-in all show up here for free.
    this.audioAccum = this.audioAccum * RATE_DECAY + (audioTime - this.lastAudio);
    this.wallAccum = this.wallAccum * RATE_DECAY + dt;
    if (this.wallAccum > 1e-4) {
      this.rate = Math.min(4, Math.max(0, this.audioAccum / this.wallAccum));
    }
    this.lastAudio = audioTime;
    this.lastWall = wallSec;

    let next = this.value + this.rate * dt;
    // Phase feedback: this is what stops the extrapolation drifting, and what
    // makes the audio clock — not the wall clock — the thing being followed.
    next += (audioTime - next) * CORRECTION;
    next = Math.min(audioTime + MAX_ERROR_SEC, Math.max(audioTime - MAX_ERROR_SEC, next));
    // Never step backwards: song time only runs forward, and a note twitching
    // back one frame is the very artefact this class exists to remove. A real
    // rewind is a discontinuity and was resynced above.
    if (next < this.value) next = this.value;

    this.value = next;
    return next;
  }

  /** Drop the lock — the next `update` snaps. Used when a run restarts. */
  reset(): void {
    this.started = false;
  }
}
