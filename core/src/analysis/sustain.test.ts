import type { Onset, Waveform } from '@tap-tap/shared';
import { describe, expect, it } from 'vitest';
import { detectSustains } from './sustain.js';

/**
 * Synthetic envelopes with known shapes, in keeping with the rest of the DSP
 * tests: a real song cannot tell you whether a span *should* have been called a
 * sustain, so it cannot be the thing under test.
 */
const SECONDS_PER_PEAK = 0.02;

function waveformOf(envelope: (t: number) => number, seconds: number): Waveform {
  const count = Math.round(seconds / SECONDS_PER_PEAK);
  const peaks = Array.from({ length: count }, (_, i) =>
    Math.max(0, Math.min(1, envelope(i * SECONDS_PER_PEAK))),
  );
  return { secondsPerPeak: SECONDS_PER_PEAK, peaks };
}

function onsetAt(t: number): Onset {
  return { t, strength: 0.8, low: 0.4, mid: 0.3, high: 0.3 };
}

/** Level for `hold` seconds from `at`, silence either side. A pad or a held vocal. */
function plateau(at: number, hold: number, level = 0.8) {
  return (t: number): number => (t >= at && t < at + hold ? level : 0.02);
}

/** Struck and left to ring: loud attack, monotonic decay. A cymbal or a piano. */
function decay(at: number, tau: number, level = 0.8) {
  return (t: number): number => (t >= at ? level * Math.exp(-(t - at) / tau) : 0.02);
}

describe('detectSustains', () => {
  it('finds a plateau', () => {
    const wave = waveformOf(plateau(1, 1.5), 4);
    const found = detectSustains(wave, [onsetAt(1)]);

    expect(found).toHaveLength(1);
    expect(found[0]?.t).toBe(1);
    expect(found[0]?.duration).toBeGreaterThan(1.2);
    expect(found[0]?.steadiness).toBeGreaterThan(0.9);
  });

  it('rejects a decay tail of the same length and loudness', () => {
    // **The test this module exists for.** A struck sound stays above any
    // sensible floor for a long time while falling the whole way. Detecting
    // "loud for a while" would turn every cymbal into a hold note.
    const wave = waveformOf(decay(1, 0.6), 4);
    const found = detectSustains(wave, [onsetAt(1)]);

    expect(found).toEqual([]);
  });

  it('separates the two when both are present', () => {
    const wave = waveformOf(
      (t) => Math.max(decay(1, 0.5)(t), plateau(2.5, 1.2)(t)),
      5,
    );
    const found = detectSustains(wave, [onsetAt(1), onsetAt(2.5)]);

    expect(found.map((s) => s.t)).toEqual([2.5]);
  });

  it('ignores a plateau too short to be worth holding', () => {
    const wave = waveformOf(plateau(1, 0.2), 3);
    expect(detectSustains(wave, [onsetAt(1)], { minSec: 0.45 })).toEqual([]);
  });

  it('ignores sustained quiet', () => {
    // A long, level, inaudible passage is not a hold — without the attack floor
    // every quiet stretch of a track would qualify.
    const wave = waveformOf(plateau(1, 2, 0.05), 4);
    expect(detectSustains(wave, [onsetAt(1)])).toEqual([]);
  });

  it('stops at the next onset rather than running through it', () => {
    // Past the next attack the energy belongs to the next sound. Without this a
    // continuous passage would produce one hold swallowing every note in it.
    const wave = waveformOf(plateau(1, 3), 5);
    const found = detectSustains(wave, [onsetAt(1), onsetAt(2)]);

    expect(found[0]?.duration).toBeLessThanOrEqual(1);
  });

  it('clamps to maxSec', () => {
    const wave = waveformOf(plateau(1, 8), 10);
    const found = detectSustains(wave, [onsetAt(1)], { maxSec: 2 });

    expect(found[0]?.duration).toBeLessThanOrEqual(2);
  });

  it('is empty for an empty waveform', () => {
    expect(detectSustains({ secondsPerPeak: 0.02, peaks: [] }, [onsetAt(1)])).toEqual([]);
    expect(detectSustains({ secondsPerPeak: 0, peaks: [1] }, [onsetAt(1)])).toEqual([]);
  });

  it('ignores an onset past the end of the waveform', () => {
    const wave = waveformOf(plateau(0.5, 1), 2);
    expect(detectSustains(wave, [onsetAt(30)])).toEqual([]);
  });

  it('ranks a steadier span above a wobblier one', () => {
    const wave = waveformOf(
      (t) => Math.max(plateau(1, 1.2)(t), plateau(3, 1.2, 0.8)(t) * (1 - (t - 3) * 0.25)),
      6,
    );
    const found = detectSustains(wave, [onsetAt(1), onsetAt(3)]);

    expect(found).toHaveLength(2);
    expect(found[0]!.steadiness).toBeGreaterThan(found[1]!.steadiness);
  });
});
