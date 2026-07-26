import { describe, expect, it } from 'vitest';
import { DIFFICULTY_NAMES } from './beatmap.js';
import { DIFFICULTIES, effectiveMinGapSec } from './difficulty.js';

/**
 * Note spacing is a musical quantity converted through the song's tempo, floored
 * at an absolute limit. These tests pin the three things that make that safe:
 * the 120 BPM calibration (so the existing library is untouched), the floor (so
 * nothing gets tighter than it is today), and the confidence gate (so a tempo
 * nobody believes cannot scale a whole song's spacing by its own error).
 */
describe('effectiveMinGapSec', () => {
  it('resolves to exactly the nominal gap at 120 BPM, on every difficulty', () => {
    // The calibration the whole migration rests on: at a 0.5s beat every
    // `minGapBeats` lands on its own `minGapSec`, so a 120 BPM song generates the
    // chart it already had and no stored score is invalidated for nothing.
    for (const name of DIFFICULTY_NAMES) {
      const params = DIFFICULTIES[name];
      expect(effectiveMinGapSec(params, 120, true), `${name} at 120 BPM`).toBeCloseTo(
        params.minGapSec,
        6,
      );
    }
  });

  it('widens the gap on slow songs, in proportion to the beat', () => {
    const hard = DIFFICULTIES.hard;
    // 90 BPM: a 0.667s beat, so 0.38 beats is 0.253s — comfortably above the
    // 0.19s floor. This is the case the change exists for: at the old flat 0.19s
    // a 90 BPM hard chart could place notes 0.285 beats apart, nearly every
    // sixteenth.
    expect(effectiveMinGapSec(hard, 90, true)).toBeCloseTo(0.38 * (60 / 90), 6);
    expect(effectiveMinGapSec(hard, 90, true)).toBeGreaterThan(hard.minGapSec);
  });

  it('never returns less than the nominal gap, at any tempo', () => {
    // The floor is what keeps a fast song playable: 0.28 beats at 180 BPM is
    // 93ms, about 10.7 notes/sec, past two thumbs and past any window
    // `hitWindowsFor` has been played at.
    for (const name of DIFFICULTY_NAMES) {
      const params = DIFFICULTIES[name];
      for (const bpm of [60, 90, 100, 120, 128, 140, 170, 180, 200, 240]) {
        expect(
          effectiveMinGapSec(params, bpm, true),
          `${name} at ${bpm} BPM`,
        ).toBeGreaterThanOrEqual(params.minGapSec - 1e-9);
      }
    }
  });

  it('sits exactly on the floor for anything at or above 120 BPM', () => {
    for (const name of DIFFICULTY_NAMES) {
      const params = DIFFICULTIES[name];
      for (const bpm of [120, 140, 170, 200]) {
        expect(effectiveMinGapSec(params, bpm, true), `${name} at ${bpm} BPM`).toBeCloseTo(
          params.minGapSec,
          6,
        );
      }
    }
  });

  it('falls back to the nominal gap when the grid is not trusted', () => {
    const hard = DIFFICULTIES.hard;
    // Same slow tempo as above, but unbelieved: converting through it would scale
    // every gap in the song by the size of the tempo's own error.
    expect(effectiveMinGapSec(hard, 90, false)).toBe(hard.minGapSec);
    expect(effectiveMinGapSec(hard, 45, false)).toBe(hard.minGapSec);
  });

  it('falls back rather than dividing by a nonsense tempo', () => {
    const hard = DIFFICULTIES.hard;
    for (const bpm of [0, -120, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveMinGapSec(hard, bpm, true), `bpm ${bpm}`).toBe(hard.minGapSec);
    }
  });

  it('keeps the difficulties ordered at every tempo', () => {
    // Spacing must still tighten as difficulty rises, or the tiers stop meaning
    // anything. Ordering the *beats* the same way as the seconds is what
    // guarantees this, and it is easy to break by tuning one value alone.
    for (const bpm of [60, 80, 90, 120, 150, 180]) {
      const gaps = DIFFICULTY_NAMES.map((n) => effectiveMinGapSec(DIFFICULTIES[n], bpm, true));
      for (let i = 1; i < gaps.length; i++) {
        expect(gaps[i]!, `${DIFFICULTY_NAMES[i]} vs ${DIFFICULTY_NAMES[i - 1]} at ${bpm} BPM`)
          .toBeLessThan(gaps[i - 1]!);
      }
    }
  });
});
