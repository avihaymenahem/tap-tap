import { describe, expect, it } from 'vitest';
import { FFT, RealFFT, hannWindow } from './fft.js';

/**
 * The real-input transform is a pure optimisation, so the test is equivalence: it
 * must agree with the full complex transform bin for bin. A subtly wrong spectrum
 * would not throw — it would quietly shift every onset in the library, which is the
 * kind of regression nobody traces back to an FFT.
 */

/** Deterministic pseudo-random signal, so a failure is reproducible. */
function noise(n: number, seed = 1): Float64Array {
  const out = new Float64Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 0xffffffff) * 2 - 1;
  }
  return out;
}

/** Bins 0..n/2-1 via the existing full complex transform. */
function referenceSpectrum(signal: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = signal.length;
  const fft = new FFT(n);
  const re = Float64Array.from(signal);
  const im = new Float64Array(n);
  fft.transform(re, im);
  return { re: re.slice(0, n / 2), im: im.slice(0, n / 2) };
}

describe('RealFFT', () => {
  it('matches the complex transform on random input', () => {
    for (const size of [4, 8, 64, 1024, 2048]) {
      const signal = noise(size, size);
      const want = referenceSpectrum(signal);

      const real = new RealFFT(size);
      const gotRe = new Float64Array(size / 2);
      const gotIm = new Float64Array(size / 2);
      real.transform(Float64Array.from(signal), gotRe, gotIm);

      for (let b = 0; b < size / 2; b++) {
        // Scaled tolerance: the transform sums `size` terms, so absolute error
        // grows with size and a fixed epsilon would pass trivially at 4 and fail
        // spuriously at 2048.
        const tolerance = 1e-9 * size;
        expect(Math.abs(gotRe[b]! - want.re[b]!), `size ${size} bin ${b} re`).toBeLessThan(
          tolerance,
        );
        expect(Math.abs(gotIm[b]! - want.im[b]!), `size ${size} bin ${b} im`).toBeLessThan(
          tolerance,
        );
      }
    }
  });

  it('matches on a windowed sine, the shape analysis actually feeds it', () => {
    const size = 2048;
    const window = hannWindow(size);
    const signal = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      signal[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * window[i]!;
    }
    const want = referenceSpectrum(signal);

    const real = new RealFFT(size);
    const gotRe = new Float64Array(size / 2);
    const gotIm = new Float64Array(size / 2);
    real.transform(Float64Array.from(signal), gotRe, gotIm);

    for (let b = 0; b < size / 2; b++) {
      expect(Math.hypot(gotRe[b]!, gotIm[b]!)).toBeCloseTo(
        Math.hypot(want.re[b]!, want.im[b]!),
        6,
      );
    }
  });

  it('puts a pure tone in the bin it belongs to', () => {
    // Ground truth rather than cross-checking: an exact bin frequency must land in
    // exactly that bin, so a packing error that happened to be self-consistent
    // would still be caught.
    const size = 1024;
    const bin = 64;
    const signal = new Float64Array(size);
    for (let i = 0; i < size; i++) signal[i] = Math.cos((2 * Math.PI * bin * i) / size);

    const real = new RealFFT(size);
    const re = new Float64Array(size / 2);
    const im = new Float64Array(size / 2);
    real.transform(signal, re, im);

    const mags = Array.from({ length: size / 2 }, (_, b) => Math.hypot(re[b]!, im[b]!));
    const peak = mags.indexOf(Math.max(...mags));
    expect(peak).toBe(bin);
    // And the peak dominates: a mispacked transform smears energy across bins.
    expect(mags[bin]!).toBeGreaterThan(100 * (mags[bin + 4] ?? 0));
  });

  it('puts a DC signal entirely in bin 0', () => {
    const size = 256;
    const signal = new Float64Array(size).fill(1);
    const real = new RealFFT(size);
    const re = new Float64Array(size / 2);
    const im = new Float64Array(size / 2);
    real.transform(signal, re, im);

    expect(re[0]!).toBeCloseTo(size, 6);
    expect(im[0]!).toBeCloseTo(0, 6);
    for (let b = 1; b < size / 2; b++) {
      expect(Math.hypot(re[b]!, im[b]!), `bin ${b}`).toBeLessThan(1e-9 * size);
    }
  });

  it('rejects sizes it cannot transform', () => {
    for (const bad of [0, 1, 2, 3, 6, 100]) {
      expect(() => new RealFFT(bad), `size ${bad}`).toThrow();
    }
  });

  it('rejects a mismatched input length and an undersized output', () => {
    const real = new RealFFT(64);
    expect(() => real.transform(new Float64Array(32), new Float64Array(32), new Float64Array(32)))
      .toThrow();
    expect(() => real.transform(new Float64Array(64), new Float64Array(16), new Float64Array(32)))
      .toThrow();
  });

  it('can be reused across frames without state leaking between them', () => {
    // The packing buffers are reused per instance; if they were not fully rewritten
    // each call, frame N would contaminate frame N+1 and onsets would drift.
    const size = 512;
    const real = new RealFFT(size);
    const re = new Float64Array(size / 2);
    const im = new Float64Array(size / 2);

    const a = noise(size, 7);
    real.transform(Float64Array.from(a), re, im);
    const firstPass = Array.from(re);

    real.transform(noise(size, 99), re, im);
    real.transform(Float64Array.from(a), re, im);
    expect(Array.from(re)).toEqual(firstPass);
  });
});
