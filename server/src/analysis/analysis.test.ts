import { describe, expect, it } from 'vitest';
import { analyze, detectOnsets, gridAlignment } from './index.js';
import { FFT, hannWindow } from './fft.js';
import {
  alternatingClicks,
  clickTrack,
  drumLoop,
  irregularClicks,
  sine,
  tempoRamp,
} from './testAudio.js';
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

  it.each([111, 117, 133])('recovers %i BPM to sub-hop precision', (bpm) => {
    // BPMs chosen to land *between* integer ODF lags. Without parabolic
    // refinement the estimate quantizes to the nearest whole hop, which at
    // these tempos is up to ~1.4 BPM off — and the repo's own rule of thumb is
    // that 0.5 BPM of error is a full beat of drift over three minutes.
    const { pcm } = clickTrack({ bpm, durationSec: 30, sampleRate: SR });
    const result = analyze(pcm, SR);
    expect(Math.abs(result.bpm - bpm)).toBeLessThan(0.5);
  });

  it('keeps the grid on the clicks at the END of a track, not just the start', () => {
    // The drift test. A tempo error too small for the BPM assertion above to
    // catch still walks the grid off the music by the final chorus; asserting
    // only the first few beats (as the test above does) can never see it.
    const { pcm, clickTimes } = clickTrack({ bpm: 117, durationSec: 60, sampleRate: SR });
    const { beatGrid } = analyze(pcm, SR);

    const lastQuarter = beatGrid.filter((b) => b > 45);
    expect(lastQuarter.length).toBeGreaterThan(10);
    for (const beat of lastQuarter) {
      const nearest = Math.min(...clickTimes.map((c) => Math.abs(c - beat)));
      expect(nearest).toBeLessThan(0.04);
    }
  });
});

describe('tempo confidence', () => {
  it('is high when the grid genuinely sits on the music', () => {
    const { pcm } = clickTrack({ bpm: 120, durationSec: 20, sampleRate: SR });
    const result = analyze(pcm, SR);
    // Confidence gates snapping and on-grid selection in chart generation at
    // 0.5, so a metronome-perfect track must clear that line comfortably.
    expect(result.bpmConfidence).toBeGreaterThan(0.7);
  });

  it('stays high for a realistic backbeat, not just a metronome', () => {
    // Alternating kick/hat — hits of very different loudness and character on
    // every beat. The old z-score confidence punished exactly this: real music
    // autocorrelates at every harmonic of its tempo, inflating the field the
    // winner was scored against, so steady songs reported ~0.4 "confidence".
    const { pcm } = alternatingClicks({ bpm: 120, durationSec: 20, sampleRate: SR });
    const result = analyze(pcm, SR);
    expect(Math.abs(result.bpm - 120)).toBeLessThan(0.5);
    expect(result.bpmConfidence).toBeGreaterThan(0.5);
  });

  it('is low for aperiodic audio', () => {
    // Clicks at irregular times: plenty of onsets, no tempo. The beat tracker
    // will happily follow them — that is its job — so energy and alignment
    // measures all pass. Gap steadiness is what must condemn it.
    for (const seed of [7, 13, 42]) {
      const { pcm } = irregularClicks({ durationSec: 20, sampleRate: SR, seed });
      const result = analyze(pcm, SR);
      expect(result.bpmConfidence).toBeLessThan(0.2);
    }
  });

  it('stays high for a humanized drum groove', () => {
    // Jittered kick/snare/hats with sixteenth fills. Also the double-time
    // regression guard: hats sit on every half-beat, so a too-loose tracker
    // halves its gaps and reports ~233 BPM.
    const { pcm } = drumLoop({ bpm: 120, durationSec: 30, sampleRate: SR, seed: 1 });
    const result = analyze(pcm, SR);
    expect(Math.abs(result.bpm - 120)).toBeLessThan(1.5);
    expect(result.bpmConfidence).toBeGreaterThan(0.7);
  });
});

describe('beat tracking follows a human tempo', () => {
  it('keeps beats on the clicks through an 118→126 BPM ramp', () => {
    // No constant grid fits this: extrapolating one tempo from either end is
    // whole beats off by the other. The tracker must follow the player, and
    // confidence must NOT punish the song for having been played by a human —
    // that is the "solid songs read low confidence" complaint in its purest
    // form.
    const { pcm, clickTimes } = tempoRamp({
      fromBpm: 118,
      toBpm: 126,
      durationSec: 45,
      sampleRate: SR,
    });
    const result = analyze(pcm, SR);

    expect(result.bpmConfidence).toBeGreaterThan(0.7);
    // Reported BPM is the honest middle of the ramp.
    expect(result.bpm).toBeGreaterThan(118);
    expect(result.bpm).toBeLessThan(126);

    const lastClick = clickTimes[clickTimes.length - 1]!;
    const beats = result.beatGrid.filter((b) => b > 1 && b <= lastClick);
    expect(beats.length).toBeGreaterThan(60);
    for (const beat of beats) {
      const nearest = Math.min(...clickTimes.map((c) => Math.abs(c - beat)));
      expect(nearest).toBeLessThan(0.03);
    }
  });
});

describe('gridAlignment', () => {
  const grid = Array.from({ length: 121 }, (_, i) => i * 0.5);
  const onset = (t: number) => ({ t, strength: 0.8 });

  it('scores onsets sitting on the grid near 1', () => {
    const onsets = grid.slice(0, 60).map((t) => onset(t));
    expect(gridAlignment(onsets, grid)).toBeGreaterThan(0.9);
  });

  it('accepts half-beat offbeats as aligned', () => {
    // Hats on the offbeat are ON the music; they must not read as drift.
    const onsets = grid.slice(0, 60).map((t) => onset(t + 0.25));
    expect(gridAlignment(onsets, grid)).toBeGreaterThan(0.9);
  });

  it('scores a drifting grid near chance', () => {
    // Onsets at a slightly different tempo than the grid claims — the exact
    // failure this measure exists to expose. Over 60s they sweep through every
    // phase, so alignment collapses to the chance rate, i.e. ~0 after rescaling.
    const onsets = Array.from({ length: 120 }, (_, i) => onset(i * 0.508));
    expect(gridAlignment(onsets, grid)).toBeLessThan(0.3);
  });

  it('declines to judge when there is too little evidence', () => {
    expect(gridAlignment([onset(1)], grid)).toBeNull();
    expect(gridAlignment([], [])).toBeNull();
  });
});
