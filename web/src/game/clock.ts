/**
 * The master clock.
 *
 * Every timing decision in the game reads from here. `AudioContext.currentTime`
 * is sample-accurate and immune to frame-rate jitter, which is the entire reason
 * the audio is served locally instead of played through a YouTube iframe.
 *
 * Never use setTimeout, setInterval, or accumulated frame deltas for game timing.
 */

export class AudioClock {
  private readonly ctx: AudioContext;
  private readonly buffer: AudioBuffer;
  private readonly analyser: AnalyserNode;
  private readonly gain: GainNode;

  private source: AudioBufferSourceNode | null = null;
  private startedAtContextTime = 0;
  private startOffset = 0;
  /**
   * Playback rate, 1 = normal. The Speed modifier sets it before `start`. It
   * scales *song time* against real time: at rate `r`, `r` song-seconds pass per
   * real second, and the buffer source plays at `r` (so pitch rises with speed,
   * the classic rhythm-game speed feel). The chart's note times never change;
   * only how fast the playhead moves through them does.
   */
  private rateValue = 1;
  private playing = false;
  private paused = false;
  private freezeDuringLeadIn = false;
  private endedCallback: (() => void) | null = null;

  private constructor(ctx: AudioContext, buffer: AudioBuffer) {
    this.ctx = ctx;
    this.buffer = buffer;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.75;

    this.gain = ctx.createGain();
    this.gain.connect(this.analyser);
    this.analyser.connect(ctx.destination);
  }

  /**
   * Must be called from a user gesture — browsers block AudioContext otherwise.
   *
   * The whole file is downloaded before playback can start: `decodeAudioData`
   * needs a complete buffer, and the sample-accurate clock this class exists to
   * provide comes from playing a decoded `AudioBuffer`. On a slow link that is
   * a long wait, so the body is streamed to report progress — an honest
   * percentage reads as "working" where an indefinite spinner reads as "hung".
   */
  static async load(
    url: string,
    signal?: AbortSignal,
    onProgress?: (fraction: number) => void,
  ): Promise<AudioClock> {
    const ctx = new AudioContext();
    try {
      const response = await fetch(url, signal ? { signal } : {});
      if (!response.ok) throw new Error(`Could not load audio (${response.status})`);

      const bytes = await readWithProgress(response, onProgress);
      // decodeAudioData detaches the buffer it is given, so this must be the
      // last use of `bytes`.
      const buffer = await ctx.decodeAudioData(bytes);
      return new AudioClock(ctx, buffer);
    } catch (error) {
      // Without this, every failed load leaks an AudioContext, and browsers cap
      // how many a page may have — enough retries and nothing plays again.
      await ctx.close();
      throw error;
    }
  }

  /**
   * Begin playback, optionally after a lead-in.
   *
   * During the lead-in `currentTime` is negative, counting up to zero. That
   * falls out of the same arithmetic rather than needing a separate countdown
   * timer, and it means notes approach the hit line during the count — so the
   * first note is readable instead of arriving the instant the song starts.
   */
  async start(offsetSec = 0, leadInSec = 0, freezeDuringLeadIn = false): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.stop();
    this.freezeDuringLeadIn = freezeDuringLeadIn;

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.rateValue;
    source.connect(this.gain);
    source.onended = () => {
      if (this.source === source) {
        this.playing = false;
        // Park the playhead at the end, not wherever playback began.
        //
        // `currentTime` falls back to `startOffset` once playing stops, so
        // without this a song that reaches its natural end reports a time near
        // the *start* — and the play loop, which finishes on
        // `songTime >= duration`, concludes the song never ended and spins
        // forever on a frozen screen.
        this.startOffset = this.buffer.duration;
        this.endedCallback?.();
      }
    };

    // Undo any fade left over from a previous run.
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.gain.gain.setValueAtTime(1, this.ctx.currentTime);

    this.startOffset = Math.max(0, Math.min(offsetSec, this.buffer.duration));
    this.startedAtContextTime = this.ctx.currentTime + Math.max(0, leadInSec);
    this.playing = true;
    this.source = source;
    source.start(this.startedAtContextTime, this.startOffset);
  }

  /**
   * Set the playback rate. Must be called *before* `start`/`resume`, since the
   * rate is applied to the buffer source as it is created. Clamped defensively.
   */
  setRate(rate: number): void {
    this.rateValue = Number.isFinite(rate) && rate > 0 ? Math.max(0.25, Math.min(4, rate)) : 1;
  }

  /** The current playback rate, 1 = normal. */
  get rate(): number {
    return this.rateValue;
  }

  stop(): void {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // Already stopped; nothing to do.
      }
      this.source.disconnect();
      this.source = null;
    }
    this.playing = false;
  }

  onEnded(callback: () => void): void {
    this.endedCallback = callback;
  }

  /**
   * Seconds elapsed in the song.
   *
   * On the initial start, time runs negative through the lead-in so notes
   * approach during the countdown. On a resume it is frozen at the pause point
   * instead — otherwise the countdown would scroll silently through notes that
   * are still coming, and the engine would judge them all as misses.
   */
  get currentTime(): number {
    if (!this.playing) return this.startOffset;
    const elapsed = this.ctx.currentTime - this.startedAtContextTime;
    if (elapsed < 0 && this.freezeDuringLeadIn) return this.startOffset;
    // Song time runs at `rate` against real time, so notes approach and the
    // playhead advances at the modifier's speed. The lead-in (elapsed < 0)
    // scales the same way, so the scroll speed is constant across the count-in
    // rather than jumping at t=0.
    return this.startOffset + elapsed * this.rateValue;
  }

  /**
   * Ramp the volume to silence over `seconds`.
   *
   * Used for the outro: the last note of a chart usually lands well before the
   * track ends, and stopping there chops the song off mid-phrase. Letting it
   * ride and fading out is far less jarring than a hard cut.
   */
  fadeOut(seconds: number): void {
    const now = this.ctx.currentTime;
    const gain = this.gain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(Math.max(0.0001, gain.value), now);
    // Exponential reads as a more natural fade than linear.
    gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.05, seconds));
  }

  /**
   * Convert a song time to the AudioContext timeline.
   *
   * Needed to schedule sounds *ahead* of the playhead with sample accuracy —
   * firing them from a rAF callback the moment a note passes would inherit all
   * the frame jitter the audio clock exists to avoid.
   */
  contextTimeFor(songTime: number): number {
    // Inverse of `currentTime`: real seconds ahead of the audio start are
    // song-seconds divided by the rate, so a scheduled sound still lands on the
    // right beat at any speed.
    return this.startedAtContextTime + (songTime - this.startOffset) / this.rateValue;
  }

  /**
   * Short percussive tick at an exact context time. Used by the editor to make
   * a chart audible — alignment is judged far more reliably by ear than by eye.
   */
  playTickAt(contextTime: number, frequency = 1800, gainValue = 0.28): void {
    const at = Math.max(contextTime, this.ctx.currentTime);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(gainValue, at + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);

    osc.connect(gain);
    // Straight to the destination, bypassing the fade-out gain the outro uses.
    gain.connect(this.ctx.destination);
    osc.start(at);
    osc.stop(at + 0.06);
  }

  /**
   * Applause, synthesized rather than sampled.
   *
   * A crowd is essentially band-limited noise with a slow amplitude wobble —
   * the wobble is what separates "crowd" from "static", because it stands in
   * for thousands of uncorrelated voices drifting in and out of phase. Building
   * it here avoids shipping a binary asset and worrying about its licence, and
   * matches how the metronome and hit ticks already work.
   *
   * @param intensity 0..1 — scaled by how well the run went, so a poor score
   *                  does not get a stadium ovation.
   */
  playCheer(intensity = 1, durationSec = 1.6): void {
    const now = this.ctx.currentTime;
    const length = Math.max(0.4, durationSec);
    const frames = Math.ceil(length * this.ctx.sampleRate);

    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Random walk over the noise amplitude, updated a few hundred times a
    // second: fast enough to feel alive, slow enough to read as a swell.
    let wobble = 0.55;
    for (let i = 0; i < frames; i++) {
      if (i % 256 === 0) {
        wobble = Math.max(0.3, Math.min(1, wobble + (Math.random() - 0.5) * 0.28));
      }
      data[i] = (Math.random() * 2 - 1) * wobble;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    // Body of the roar.
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1100;
    band.Q.value = 0.65;

    // Lift the top end so it reads as clapping and whistles, not a rumble.
    const bright = this.ctx.createBiquadFilter();
    bright.type = 'highshelf';
    bright.frequency.value = 3200;
    bright.gain.value = 7;

    const gain = this.ctx.createGain();
    const peak = Math.max(0.02, 0.3 * intensity);
    gain.gain.setValueAtTime(0.0001, now);
    // Quick swell, then a long decay — crowds arrive fast and thin out slowly.
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.16);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + length);

    source.connect(band);
    band.connect(bright);
    bright.connect(gain);
    // Straight to the destination, past the fade-out gain the outro uses.
    gain.connect(this.ctx.destination);

    source.start(now);
    source.stop(now + length);
  }

  /** Seconds left before audio begins. 0 once playing. Drives the countdown. */
  get leadInRemaining(): number {
    if (!this.playing) return 0;
    return Math.max(0, this.startedAtContextTime - this.ctx.currentTime);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Freeze at the current position. `currentTime` holds there until resumed. */
  pause(): void {
    if (!this.playing) return;
    const position = Math.max(0, Math.min(this.currentTime, this.buffer.duration));
    this.stop();
    this.startOffset = position;
    this.paused = true;
  }

  /** Restart from the paused position, after an optional countdown. */
  async resume(leadInSec = 0): Promise<void> {
    if (this.playing) return;
    this.paused = false;
    await this.start(this.startOffset, leadInSec, true);
  }

  /**
   * Seconds between a sample being scheduled and the player actually hearing it.
   *
   * This is the gap that makes an uncalibrated phone feel wrong. Rendering is
   * driven by `currentTime`, which tracks what has been *scheduled*, while the
   * player taps to what they *hear* — so every tap lands late by this much. On a
   * Mac it is 10-20ms and invisible; over Bluetooth on a phone it can exceed
   * 200ms, which is wider than the entire "good" judgement window.
   *
   * `outputLatency` is the honest number but is missing on Safari and reported
   * as a flat 0 by some engines — a real device is never exactly zero, so treat
   * that as "not implemented" and fall back to `baseLatency`, which at least
   * accounts for the graph's own buffering. Using `??` here would not do it:
   * `0 ?? x` is 0, so a reported zero would swallow the fallback.
   */
  get outputLatency(): number {
    const ctx = this.ctx as AudioContext & { outputLatency?: number };
    const reported = ctx.outputLatency && ctx.outputLatency > 0
      ? ctx.outputLatency
      : (ctx.baseLatency ?? 0);
    // A garbage reading is worse than none: silently shifting every note by a
    // wrong constant is indistinguishable from a broken chart.
    return Number.isFinite(reported) && reported > 0 && reported < 0.5 ? reported : 0;
  }

  get duration(): number {
    return this.buffer.duration;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Fills `target` with the current frequency spectrum, for the reactive visuals. */
  readSpectrum(target: Uint8Array<ArrayBuffer>): void {
    this.analyser.getByteFrequencyData(target);
  }

  get spectrumSize(): number {
    return this.analyser.frequencyBinCount;
  }

  async dispose(): Promise<void> {
    this.stop();
    this.gain.disconnect();
    this.analyser.disconnect();
    await this.ctx.close();
  }
}

/**
 * Read a response body to completion, reporting progress as it goes.
 *
 * Falls back to a plain `arrayBuffer()` when the stream or its length is
 * unavailable — a compressed or chunked response has no `Content-Length`, and a
 * fabricated percentage would be worse than none.
 */
export async function readWithProgress(
  response: Response,
  onProgress?: (fraction: number) => void,
): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('Content-Length') ?? 0);
  if (!onProgress || !response.body || declared <= 0) {
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    // Clamped: a body longer than advertised must not report above 100%.
    onProgress(Math.min(1, received / declared));
  }

  const out = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out.buffer;
}

/** Average of a slice of the spectrum, normalized to 0..1. */
export function bandLevel(spectrum: Uint8Array, from: number, to: number): number {
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(spectrum.length, Math.ceil(to));
  if (hi <= lo) return 0;
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += spectrum[i] ?? 0;
  return sum / (hi - lo) / 255;
}
