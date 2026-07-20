import { describe, expect, it } from 'vitest';
import { analyze, detectOnsets } from './index.js';
import { FFT, hannWindow } from './fft.js';
import { alternatingClicks, clickTrack, sine } from './testAudio.js';
import { dominantBand } from '../charts/lanes.js';

const SR = 44100;

describe('FFT', () => {
  it('places a pure tone in the expected bin', () => {
    const size = 2048;
    const pcm = sine(1000, 0.2, SR);
    const fft = new FFT(size);
    const w = hannWindow(size);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      re[i] = pcm[i]! * w[i]!;
      im[i] = 0;
    }
    fft.transform(re, im);

    let peakBin = 0;
    let peak = 0;
    for (let b = 1; b < size / 2; b++) {
      const m = Math.hypot(re[b]!, im[b]!);
      if (m > peak) {
        peak = m;
        peakBin = b;
      }
    }

    const expected = Math.round(1000 / (SR / size));
    expect(Math.abs(peakBin - expected)).toBeLessThanOrEqual(1);
  });

  it('rejects non-power-of-two sizes', () => {
    expect(() => new FFT(1000)).toThrow(/power of two/);
  });
});

describe('onset detection', () => {
  it('finds a click on nearly every beat', () => {
    const { pcm, clickTimes } = clickTrack({ bpm: 120, durationSec: 12, sampleRate: SR });
    const { onsets } = detectOnsets(pcm, SR);

    // The very first click can be missed: peak picking needs a preceding frame.
    expect(onsets.length).toBeGreaterThanOrEqual(clickTimes.length - 2);
    expect(onsets.length).toBeLessThanOrEqual(clickTimes.length + 2);

    for (const onset of onsets) {
      const nearest = Math.min(...clickTimes.map((c) => Math.abs(c - onset.t)));
      expect(nearest).toBeLessThan(0.06);
    }
  });

  it('reports no onsets for silence', () => {
    const { onsets } = detectOnsets(new Float32Array(SR * 2), SR);
    expect(onsets).toHaveLength(0);
  });
});

describe('band classification', () => {
  /** Split detected onsets by which scripted hit they land on. */
  function classify(pcm: Float32Array, lowTimes: number[], highTimes: number[]) {
    const { onsets } = detectOnsets(pcm, SR);
    const nearest = (t: number, times: number[]): number =>
      Math.min(...times.map((x) => Math.abs(x - t)));

    let lowCorrect = 0;
    let lowTotal = 0;
    let highCorrect = 0;
    let highTotal = 0;

    for (const onset of onsets) {
      const dLow = nearest(onset.t, lowTimes);
      const dHigh = nearest(onset.t, highTimes);
      const band = dominantBand(onset);
      if (dLow < dHigh && dLow < 0.08) {
        lowTotal++;
        if (band === 'low') lowCorrect++;
      } else if (dHigh < dLow && dHigh < 0.08) {
        highTotal++;
        if (band === 'high') highCorrect++;
      }
    }

    return { onsets, lowCorrect, lowTotal, highCorrect, highTotal };
  }

  it('separates bass hits from hi-hats within one track', () => {
    const { pcm, lowTimes, highTimes } = alternatingClicks({
      bpm: 120,
      durationSec: 16,
      sampleRate: SR,
    });
    const r = classify(pcm, lowTimes, highTimes);

    expect(r.lowTotal).toBeGreaterThan(8);
    expect(r.highTotal).toBeGreaterThan(8);
    expect(r.highCorrect / r.highTotal).toBeGreaterThan(0.8);
    expect(r.lowCorrect / r.lowTotal).toBeGreaterThan(0.5);
  });

  it('never collapses every onset into one band', () => {
    // The regression guard for the reported bug — a chart where every note
    // lands in the same lane. Ranking each onset within its own band's
    // distribution makes a constant answer structurally impossible.
    const { pcm, lowTimes, highTimes } = alternatingClicks({
      bpm: 120,
      durationSec: 16,
      sampleRate: SR,
    });
    const { onsets } = classify(pcm, lowTimes, highTimes);

    const counts = { low: 0, mid: 0, high: 0 };
    for (const onset of onsets) counts[dominantBand(onset)]++;
    const biggest = Math.max(counts.low, counts.mid, counts.high);

    expect(onsets.length).toBeGreaterThan(20);
    expect(biggest / onsets.length).toBeLessThan(0.8);
  });

  it('keeps band shares finite and normalized', () => {
    const { pcm } = clickTrack({ bpm: 120, durationSec: 10, sampleRate: SR, freqHz: 300 });
    const { onsets } = detectOnsets(pcm, SR);
    expect(onsets.length).toBeGreaterThan(4);
    for (const onset of onsets) {
      expect(onset.low + onset.mid + onset.high).toBeCloseTo(1, 5);
      expect(Number.isFinite(onset.low)).toBe(true);
      expect(Number.isFinite(onset.high)).toBe(true);
    }
  });
});

describe('tempo estimation', () => {
  it.each([90, 120, 140])('recovers %i BPM from a click track', (bpm) => {
    const { pcm } = clickTrack({ bpm, durationSec: 16, sampleRate: SR });
    const result = analyze(pcm, SR);
    expect(Math.abs(result.bpm - bpm)).toBeLessThan(2);
    expect(result.bpmConfidence).toBeGreaterThan(0.3);
  });

  it('produces a beat grid aligned to the clicks', () => {
    const { pcm, clickTimes } = clickTrack({ bpm: 120, durationSec: 16, sampleRate: SR });
    const { beatGrid } = analyze(pcm, SR);

    expect(beatGrid.length).toBeGreaterThan(clickTimes.length - 3);
    for (const beat of beatGrid.slice(0, 10)) {
      const nearest = Math.min(...clickTimes.map((c) => Math.abs(c - beat)));
      expect(nearest).toBeLessThan(0.05);
    }
  });
});
