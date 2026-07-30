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
 * Floor on how far the smoothed time may sit from the audio clock.
 *
 * The safety net: whatever the feedback loop does, this is the worst error the
 * renderer can show. It also caps how far the estimate can run on while the
 * audio clock is stalled (a paused context republishes the same value), so the
 * board creeps a hair rather than sliding away.
 *
 * **A floor, not the bound — the bound is learned.** 11ms was one quantum *on
 * the dev machine* (512 samples at 48kHz). The publish granularity is a
 * property of the device's audio path, not of this code, and it was never
 * measured on the S25; a device that republishes every 20-40ms would spend the
 * clamp on ordinary frames and re-quantise the very staircase this class
 * removes. Measured on the shipped constants against a simulated 40ms
 * granularity at 120Hz: **57.9% of frames clamped** and the worst per-frame
 * velocity error back up at 116%. `observedStep` below closes that.
 */
const MAX_ERROR_SEC = 0.011;
/**
 * Ceiling on the learned bound. Renderer/judgement divergence can never exceed
 * this whatever the device does, and it is an order of magnitude inside the
 * base miss window (190ms) — and well inside `RESYNC_SEC`, so a device coarse
 * enough to want more than this resyncs instead of slewing.
 */
const MAX_ERROR_CEILING_SEC = 0.04;
/**
 * Decay on the observed publish granularity, per frame. Slow, because the
 * estimate must survive the long runs of zero-advance frames a coarse audio
 * clock produces; ~0.5% a frame halves it over ~140 frames, which is fast
 * enough that a one-off outlier does not linger for a whole song.
 */
const STEP_DECAY = 0.995;
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
/**
 * The band of rate estimates worth carrying across a resync.
 *
 * Retaining the measured rate is right when the discontinuity was pure phase (a
 * frame hitch), and wrong when the estimator has been watching a clock that was
 * not running: a frozen lead-in, a pause, a tab in the background all decay the
 * accumulators toward zero, and a retained rate of ~0 would leave the board
 * crawling on phase feedback alone for the ~17 frames it takes to re-lock —
 * trading an intermittent stutter for a guaranteed one at every song start.
 * Outside this band the estimate carries no information about *playback* and 1
 * is the only honest prior. Shipped speed modifiers all sit comfortably inside.
 */
const MIN_TRUSTED_RATE = 0.25;
const MAX_TRUSTED_RATE = 2.5;
/**
 * Window length of the rate estimator, in frames — the reciprocal of its decay.
 * Used to seed a cold estimator with a full window's worth of the prior.
 *
 * **Without seeding, the estimator is at its worst exactly where it matters
 * most.** `rate` is `audioAccum / wallAccum`, both decaying accumulators, so
 * while they are cold the ratio is dominated by the *first* sample — and a
 * single sample of the audio clock is the 0 / 1 / 2-quantum step function this
 * whole class exists to hide. Cold happens at every run start and after every
 * resync, which is exactly where a burst of judder is most visible. Starting
 * the window pre-loaded at the prior rate means the first real sample moves the
 * estimate by a seventeenth rather than being the whole of it.
 */
const RATE_WINDOW_FRAMES = 1 / (1 - RATE_DECAY);

export class RenderClock {
  private started = false;
  private value = 0;
  private lastAudio = 0;
  private lastWall = 0;
  private audioAccum = 0;
  private wallAccum = 0;
  private rate = 1;
  /** True while the rate accumulators are empty and want seeding — see RATE_WINDOW_FRAMES. */
  private rateCold = true;
  /**
   * The audio clock's observed publish granularity: a decaying maximum of its
   * per-frame forward steps. Sizes the error clamp to the device instead of to
   * the machine this class was written on. See `MAX_ERROR_SEC`.
   */
  private observedStep = 0;

  /**
   * Feed the authoritative audio time and the wall time of this frame, both in
   * seconds; returns the time the renderer should draw. Call exactly once per
   * frame.
   */
  update(audioTime: number, wallSec: number): number {
    if (!Number.isFinite(audioTime) || !Number.isFinite(wallSec)) return this.value;

    if (!this.started) {
      // Cold: nothing is known about the playback rate, so 1 is the only
      // available prior. A resync is NOT this case — see below.
      this.started = true;
      this.audioAccum = 0;
      this.wallAccum = 0;
      this.rateCold = true;
      this.rate = 1;
      this.observedStep = 0;
      this.value = audioTime;
      this.lastAudio = audioTime;
      this.lastWall = wallSec;
      return this.value;
    }

    if (Math.abs(audioTime - this.value) > RESYNC_SEC) {
      /*
       * **A resync is a PHASE discontinuity, not a rate one — so the rate
       * estimator is kept warm across it. This is the intermittent stutter.**
       *
       * This branch used to zero `audioAccum`/`wallAccum` and force `rate = 1`.
       * Because the estimator's window is a decaying accumulator, that left
       * `rate` computed from a *single* frame's ratio for the following several
       * frames — and a single frame's ratio of a step function is exactly the
       * 0 / 1 / 2-quantum staircase this class exists to hide. So every resync
       * was followed by a short burst of raw, unsmoothed judder.
       *
       * Simulated on the shipped constants at 120Hz with a 512-sample quantum,
       * the frames straight after a resync advance:
       *
       * ```
       *   after a 116ms hitch: 10.7 10.7 10.7 10.7 7.6 8.3 ...   (nominal 8.33)
       *   after a 108ms hitch: 10.7  4.8  7.0  8.2 8.9 6.7 ...
       * ```
       *
       * i.e. 28-43% per-frame velocity error for 3-4 frames, against ~9% in
       * steady state. Keeping the rate takes those to 10-15%.
       *
       * **And a resync is not rare on the phone.** It fires on any frame gap
       * over `RESYNC_SEC`, and the S25 measurements in CLAUDE.md record exactly
       * that: a 108.2ms frame at 31s into a run, plus frames over 50ms. Every
       * one of those was followed by a burst of the old judder — an
       * intermittent stutter in note motion with the frame rate reading fine,
       * which is the report.
       *
       * The rate is a property of playback (1.0, or a speed modifier), not of
       * phase, so carrying it across is also simply the truthful thing to do.
       * Only a cold start genuinely has no estimate.
       */
      if (!(this.rate >= MIN_TRUSTED_RATE && this.rate <= MAX_TRUSTED_RATE)) {
        this.rate = 1;
        this.audioAccum = 0;
        this.wallAccum = 0;
        this.rateCold = true;
      }
      this.value = audioTime;
      this.lastAudio = audioTime;
      this.lastWall = wallSec;
      return this.value;
    }

    const dt = Math.min(MAX_DT_SEC, Math.max(0, wallSec - this.lastWall));
    const advance = audioTime - this.lastAudio;

    // Learn the publish granularity. Only ordinary steps count — anything at
    // resync scale is a stall, not a quantum, and would leave the clamp
    // needlessly loose for hundreds of frames.
    if (advance > 0 && advance < RESYNC_SEC) {
      this.observedStep = Math.max(this.observedStep * STEP_DECAY, advance);
    } else {
      this.observedStep *= STEP_DECAY;
    }

    // The rate the audio clock is actually advancing at, averaged over enough
    // frames to span several of its quanta. Never assumed to be 1: a speed
    // modifier, a paused context and the count-in all show up here for free.
    if (this.rateCold) {
      // Pre-load the window at the prior rather than letting one sample of a
      // step function be the whole estimate. See RATE_WINDOW_FRAMES.
      this.wallAccum = dt * RATE_WINDOW_FRAMES;
      this.audioAccum = this.wallAccum * this.rate;
      this.rateCold = false;
    }
    this.audioAccum = this.audioAccum * RATE_DECAY + advance;
    this.wallAccum = this.wallAccum * RATE_DECAY + dt;
    if (this.wallAccum > 1e-4) {
      this.rate = Math.min(4, Math.max(0, this.audioAccum / this.wallAccum));
    }
    this.lastAudio = audioTime;
    this.lastWall = wallSec;

    const maxError = Math.min(
      MAX_ERROR_CEILING_SEC,
      Math.max(MAX_ERROR_SEC, this.observedStep),
    );

    let next = this.value + this.rate * dt;
    // Phase feedback: this is what stops the extrapolation drifting, and what
    // makes the audio clock — not the wall clock — the thing being followed.
    next += (audioTime - next) * CORRECTION;
    next = Math.min(audioTime + maxError, Math.max(audioTime - maxError, next));
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
