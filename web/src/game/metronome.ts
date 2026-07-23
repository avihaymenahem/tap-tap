/**
 * A WebAudio metronome, shared by calibration and the tutorial.
 *
 * Both need the same thing: a steady beat scheduled *against the audio clock*
 * rather than a timer, so the sound never drifts. The pattern is the one the
 * calibration screen proved — a lookahead loop that queues clicks a little ahead
 * of `ctx.currentTime`, driven by a coarse `setInterval` that only ever decides
 * *what to schedule next*, never *when a beat sounds*. `AudioContext.currentTime`
 * stays the master clock (invariant 1.5); the interval is allowed to be jittery.
 */

/** A short percussive blip at a precise context time. */
export function click(ctx: AudioContext, at: number, frequency = 1400, peak = 0.5): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.08);
}

/** How far ahead of the playhead beats are queued, and how often to top up. */
const LOOKAHEAD_SEC = 0.25;
const SCHEDULE_MS = 25;

export interface MetronomeOptions {
  bpm: number;
  /** Context time of the first beat. Defaults to a short lead so nothing clips. */
  startAt?: number;
  /** Called for every scheduled beat, with its context time. */
  onBeat?: (at: number) => void;
  /** Schedule beats (and fire `onBeat`) without actually clicking. */
  silent?: boolean;
}

export interface Metronome {
  /** Context time of the first beat — the tutorial's time origin. */
  readonly startAt: number;
  stop(): void;
}

/**
 * Start a lookahead metronome. Returns a handle whose `startAt` is the first
 * beat's context time (a natural time origin) and whose `stop()` ends scheduling.
 * Already-scheduled clicks still sound; that is the point of scheduling ahead.
 */
export function startMetronome(ctx: AudioContext, options: MetronomeOptions): Metronome {
  const beatSec = 60 / options.bpm;
  const startAt = options.startAt ?? ctx.currentTime + 0.4;
  let next = startAt;

  const schedule = (): void => {
    while (next < ctx.currentTime + LOOKAHEAD_SEC) {
      if (!options.silent) click(ctx, next);
      options.onBeat?.(next);
      next += beatSec;
    }
  };

  schedule();
  const timer = setInterval(schedule, SCHEDULE_MS) as unknown as number;

  return {
    startAt,
    stop: () => clearInterval(timer),
  };
}
