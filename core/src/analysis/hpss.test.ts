import { describe, expect, it } from 'vitest';
import { RealFFT, hannWindow } from './fft.js';
import { DEFAULT_HPSS_OPTIONS, PercussiveMask } from './hpss.js';
import { clickTrack, vibratoTone } from './testAudio.js';

/**
 * Ground truth, not cross-checking: a click track is entirely percussive and a
 * sustained vibrato tone is entirely harmonic, so the mask has a right answer on
 * each. Anything in between would only tell us the code is self-consistent.
 */

const FRAME = 2048;
const HOP = 512;
const BINS = FRAME / 2;

function spectrogram(pcm: Float32Array): Float64Array[] {
  const fft = new RealFFT(FRAME);
  const window = hannWindow(FRAME);
  const frame = new Float64Array(FRAME);
  const re = new Float64Array(BINS);
  const im = new Float64Array(BINS);
  const frames: Float64Array[] = [];
  const count = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1);
  for (let f = 0; f < count; f++) {
    const start = f * HOP;
    for (let i = 0; i < FRAME; i++) frame[i] = pcm[start + i]! * window[i]!;
    fft.transform(frame, re, im);
    const mag = new Float64Array(BINS);
    for (let b = 0; b < BINS; b++) mag[b] = Math.hypot(re[b]!, im[b]!);
    frames.push(mag);
  }
  return frames;
}

function energy(frame: Float64Array): number {
  let sum = 0;
  for (const v of frame) sum += v * v;
  return sum;
}

/** Share of the input's energy the mask lets through, over the frames it covers. */
function keptShare(pcm: Float32Array): number {
  const spec = spectrogram(pcm);
  const mask = new PercussiveMask(BINS);
  let after = 0;
  for (const f of spec) {
    const out = mask.push(f);
    if (out) after += energy(out);
  }
  for (const out of mask.flush()) after += energy(out);

  let before = 0;
  for (const f of spec.slice(mask.lag, spec.length - mask.lag)) before += energy(f);
  return before > 0 ? after / before : 0;
}

describe('PercussiveMask', () => {
  it('passes a click track through almost untouched', () => {
    // Clicks are broadband and brief: the frequency median keeps them and the time
    // median has nothing steady to find.
    expect(keptShare(clickTrack({ bpm: 120, durationSec: 8 }).pcm)).toBeGreaterThan(0.9);
  });

  it('removes a sustained tone almost entirely', () => {
    // A vibrato tone is narrowband and continuous, which is the exact opposite, and
    // the case a plain spectral flux cannot tell from an attack.
    expect(keptShare(vibratoTone({ durationSec: 8 }).pcm)).toBeLessThan(0.05);
  });

  it('separates the two by a wide margin, not a hair', () => {
    // A threshold has to sit somewhere between them; if the gap were narrow the
    // whole method would be a tuning exercise rather than a discriminator.
    const percussive = keptShare(clickTrack({ bpm: 120, durationSec: 8 }).pcm);
    const harmonic = keptShare(vibratoTone({ durationSec: 8 }).pcm);
    expect(percussive - harmonic).toBeGreaterThan(0.8);
  });

  it('covers every frame but the first `lag`, which have no centred window', () => {
    // The window has to be centred on the frame it describes, so nothing is emitted
    // until `timeFrames` frames have arrived — and the first output describes frame
    // `lag`, not frame 0. `flush` pads the tail, so the total is `n - lag`: the head
    // is the one gap, ~93ms at this hop. Every real song opens on silence or an
    // intro that `startOffsetFor` discards anyway, so this is documented rather
    // than padded.
    const spec = spectrogram(clickTrack({ bpm: 120, durationSec: 4 }).pcm);
    const mask = new PercussiveMask(BINS);
    let emitted = 0;
    for (const f of spec) if (mask.push(f)) emitted++;
    expect(emitted).toBe(spec.length - 2 * mask.lag);

    let drained = 0;
    for (const _ of mask.flush()) drained++;
    expect(drained).toBe(mask.lag);
    // Frames `lag`..n-1 inclusive.
    expect(emitted + drained).toBe(spec.length - mask.lag);
  });

  it('lags by half the time window', () => {
    const mask = new PercussiveMask(BINS);
    expect(mask.lag).toBe((DEFAULT_HPSS_OPTIONS.timeFrames - 1) / 2);
  });

  it('yields nothing from flush when the window never filled', () => {
    // A clip shorter than the median window has no centred frame at all. It must
    // return empty rather than emit a partial-window mask, which would be measurably
    // different from every other frame's.
    const mask = new PercussiveMask(BINS);
    mask.push(new Float64Array(BINS).fill(1));
    expect([...mask.flush()]).toHaveLength(0);
  });

  it('rejects even median widths', () => {
    // An even window has no middle element, so "the median" would be a choice rather
    // than a value.
    expect(() => new PercussiveMask(BINS, { ...DEFAULT_HPSS_OPTIONS, timeFrames: 16 })).toThrow();
    expect(() => new PercussiveMask(BINS, { ...DEFAULT_HPSS_OPTIONS, freqBins: 8 })).toThrow();
  });

  it('never amplifies — the mask is a fraction of what went in', () => {
    // A soft mask multiplies by a value in [0, 1], so no bin may come out larger
    // than it went in. Counted rather than asserted per bin: 1024 bins across
    // hundreds of frames is a third of a million `expect` calls, which is slow
    // enough to time the test out on its own.
    const spec = spectrogram(clickTrack({ bpm: 140, durationSec: 4 }).pcm);
    const mask = new PercussiveMask(BINS);
    let checked = 0;
    let violations = 0;
    for (let i = 0; i < spec.length; i++) {
      const out = mask.push(spec[i]!);
      if (!out) continue;
      const source = spec[i - mask.lag]!;
      for (let b = 0; b < BINS; b++) {
        if (out[b]! > source[b]! + 1e-9 || out[b]! < 0) violations++;
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(violations).toBe(0);
  });
});
