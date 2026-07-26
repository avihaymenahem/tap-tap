import { describe, expect, it } from 'vitest';
import {
  MAX_BOOST_DB,
  MAX_CUT_DB,
  SILENT_LUFS,
  TARGET_LUFS,
  dbToGain,
  integratedLoudness,
  kWeight,
  replayGainDb,
} from './loudness.js';

const SR = 48000;

function sine(freq: number, seconds: number, amplitude: number, sampleRate = SR): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return pcm;
}

/** RMS of the second half, so the filter's start-up transient is excluded. */
function settledRms(pcm: Float32Array): number {
  const from = pcm.length >> 1;
  let sum = 0;
  for (let i = from; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
  return Math.sqrt(sum / (pcm.length - from));
}

/** The K-weighting filter's gain at a frequency, in dB. Measured, not assumed. */
function filterGainDb(freq: number): number {
  const input = sine(freq, 2, 0.5);
  return 20 * Math.log10(settledRms(kWeight(input, SR)) / settledRms(input));
}

/**
 * The filter and the gating are the two halves that can each be wrong on their
 * own, so they are tested separately — a test that only checks the final number
 * cannot say which one broke.
 */
describe('K-weighting', () => {
  it('rolls off sub-bass and lifts treble, which is the whole point', () => {
    // The RLB high-pass sits at ~38Hz: 20Hz rumble is heavily attenuated.
    expect(filterGainDb(20)).toBeLessThan(-8);
    // Above the ~1.7kHz shelf it settles near the spec's +4dB.
    expect(filterGainDb(8000)).toBeGreaterThan(3);
    expect(filterGainDb(8000)).toBeLessThan(5);
    // Treble is boosted relative to bass — the direction that makes a hi-hat
    // count for more than a kick, which is why loudness != RMS.
    expect(filterGainDb(8000)).toBeGreaterThan(filterGainDb(100));
  });

  it('is designed per sample rate, not tabulated at 48k', () => {
    // Same tone, different rates: the corner must land at the same *frequency*,
    // so the gain must agree. Tabulated 48k coefficients reused at 44.1k would
    // shift the shelf and break this.
    const at48 = kWeight(sine(8000, 2, 0.5, 48000), 48000);
    const at44 = kWeight(sine(8000, 2, 0.5, 44100), 44100);
    const g48 = 20 * Math.log10(settledRms(at48) / settledRms(sine(8000, 2, 0.5, 48000)));
    const g44 = 20 * Math.log10(settledRms(at44) / settledRms(sine(8000, 2, 0.5, 44100)));
    expect(Math.abs(g48 - g44)).toBeLessThan(0.5);
  });
});

describe('integratedLoudness', () => {
  it('reports silence as silent rather than as a very small number', () => {
    expect(integratedLoudness(new Float32Array(SR * 2), SR)).toBe(SILENT_LUFS);
    expect(integratedLoudness(new Float32Array(0), SR)).toBe(SILENT_LUFS);
  });

  it('is safe on a buffer shorter than one 400ms block', () => {
    expect(integratedLoudness(sine(1000, 0.1, 0.5), SR)).toBe(SILENT_LUFS);
  });

  /**
   * The property normalisation actually depends on: *differences* must be
   * exact. An absolute calibration error shifts every track equally and is
   * invisible; a scaling error makes every stored gain wrong.
   */
  it('tracks amplitude exactly — doubling is +6.02 LU', () => {
    const quiet = integratedLoudness(sine(1000, 4, 0.1), SR);
    const loud = integratedLoudness(sine(1000, 4, 0.2), SR);
    expect(loud - quiet).toBeCloseTo(20 * Math.log10(2), 2);
  });

  it('matches the level predicted from the measured filter gain', () => {
    // Derived from the spec's own formula rather than a recalled convention:
    //   L = -0.691 + 10log10(2 * meanSquare) with meanSquare = (A^2/2)*|H|^2
    // Checks the block, gate and offset arithmetic against the filter measured
    // above, so the two halves are pinned together without circularity.
    const amplitude = 0.5;
    const expected =
      -0.691 + 10 * Math.log10(2 * ((amplitude * amplitude) / 2)) + filterGainDb(1000);
    expect(integratedLoudness(sine(1000, 4, amplitude), SR)).toBeCloseTo(expected, 1);
  });

  it('weights by frequency, so equal-amplitude tones are not equally loud', () => {
    const bass = integratedLoudness(sine(60, 4, 0.3), SR);
    const treble = integratedLoudness(sine(6000, 4, 0.3), SR);
    expect(treble).toBeGreaterThan(bass);
  });

  /**
   * The gate is the part most likely to be silently wrong, and the failure is
   * ugly: a track with quiet passages measures far below how it sounds, so
   * normalisation boosts it until the loud parts clip.
   */
  it('ignores silence rather than averaging it in', () => {
    const loudOnly = sine(1000, 4, 0.4);

    const withSilence = new Float32Array(SR * 12);
    withSilence.set(loudOnly, SR * 4); // 4s silence, 4s tone, 4s silence

    const a = integratedLoudness(loudOnly, SR);
    const b = integratedLoudness(withSilence, SR);
    // Padding a track with silence must barely move its loudness. Averaging the
    // silence in would drop it by many LU.
    expect(Math.abs(b - a)).toBeLessThan(1);
  });

  it('still counts a genuinely quiet passage, unlike true silence', () => {
    // -10 LU relative gate: a passage this close to the loud one must survive
    // it, or the measurement becomes "loudest section only".
    const pcm = new Float32Array(SR * 8);
    pcm.set(sine(1000, 4, 0.4), 0);
    pcm.set(sine(1000, 4, 0.4 * Math.pow(10, -5 / 20)), SR * 4); // 5 dB down
    const both = integratedLoudness(pcm, SR);
    const loudAlone = integratedLoudness(sine(1000, 4, 0.4), SR);
    expect(both).toBeLessThan(loudAlone);
  });
});

describe('replayGainDb', () => {
  it('returns the difference to the target for an ordinary track', () => {
    expect(replayGainDb(-20)).toBeCloseTo(TARGET_LUFS - -20, 6);
    expect(replayGainDb(-8)).toBeCloseTo(TARGET_LUFS - -8, 6);
  });

  it('clamps, so a misjudged measurement cannot blow the mix up', () => {
    expect(replayGainDb(-90)).toBe(MAX_BOOST_DB);
    expect(replayGainDb(10)).toBe(MAX_CUT_DB);
    // Cuts are allowed to go further than boosts: turning a track down cannot
    // clip it, turning it up can.
    expect(Math.abs(MAX_CUT_DB)).toBeGreaterThan(MAX_BOOST_DB);
  });

  it('is unity for silence, not a full boost', () => {
    // An unmeasurable track must play at its own level, not be shoved up 6dB.
    expect(replayGainDb(SILENT_LUFS)).toBe(0);
    expect(replayGainDb(Number.NaN)).toBe(0);
  });

  it('round-trips through dbToGain', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 6);
    expect(dbToGain(6.0206)).toBeCloseTo(2, 3);
    expect(dbToGain(-6.0206)).toBeCloseTo(0.5, 3);
  });
});
