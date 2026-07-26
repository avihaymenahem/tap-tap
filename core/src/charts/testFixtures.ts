import type { AnalysisResult, Onset } from '@tap-tap/shared';

/**
 * A corpus of synthetic songs for chart-generation tests.
 *
 * **Why a corpus and not one fixture.** Three chart findings once came out of a
 * single throwaway harness — "easy and medium are rhythmically identical",
 * "hard/extreme never rest", and a 35% full-board leap rate — and none of them
 * reproduced on a second synthetic fixture that differed only in how its onsets
 * were built. One of the three had a fix built against it and reverted. A number
 * measured on one fixture describes that fixture; the only way a chart claim
 * earns the word "regression" is by holding across songs that stress different
 * paths. Hence four, each documented with what it exercises that the others
 * cannot.
 *
 * **Why these are `AnalysisResult`s and not audio.** Running the real
 * `analyze` path would couple every chart baseline to the DSP, so bumping
 * `ANALYSIS_VERSION` (a routine analysis improvement) would move all of them at
 * once and mask a genuine chart regression in the noise. Constructing the
 * analysis directly keeps "a chart number moved" meaning "chart generation
 * changed". DSP itself is tested against synthetic *audio* with known ground
 * truth in `analysis/testAudio.ts`, which is the other half of the same idea.
 */

/** A beat grid at a fixed spacing — a metronome, for the trusted-grid fixtures. */
export function beatsEvery(step: number, duration: number): number[] {
  const grid: number[] = [];
  for (let t = 0; t < duration; t += step) grid.push(Number(t.toFixed(4)));
  return grid;
}

/** The break in {@link structuredSong} — eight seconds of nothing playing. */
export const BREAK_START = 24;
export const BREAK_END = 32;

/**
 * A song with structure: a quiet first half, a loud second half, and a real
 * breakdown.
 *
 * The break is the point. Without one, "does the chart rest?" cannot be asked —
 * a fixture that plays continuously is *entitled* to a continuous chart, so a
 * generator with no concept of phrasing would pass for the wrong reason. This is
 * also the only fixture with large intensity variation, which is what makes its
 * density correlation meaningful; the two continuous fixtures below sit at a flat
 * ~0 correlation because there is nothing for note count to track.
 */
export function structuredSong(): AnalysisResult {
  const duration = 60;
  const onsets: Onset[] = [];
  for (let t = 0; t < duration; t += 0.25) {
    if (t >= BREAK_START && t < BREAK_END) continue;
    const loud = t >= 30;
    const phase = Math.round(t / 0.25) % 3;
    onsets.push({
      t: Number(t.toFixed(4)),
      strength: loud ? 0.9 : 0.3,
      low: phase === 0 ? 0.7 : 0.15,
      mid: phase === 1 ? 0.7 : 0.15,
      high: phase === 2 ? 0.7 : 0.15,
    });
  }
  return { duration, bpm: 120, bpmConfidence: 0.9, beatGrid: beatsEvery(0.5, duration), onsets };
}

/**
 * Hat-dominated: a kick every two beats and hats on every eighth, so ~94% of
 * onsets are high-band.
 *
 * This is the "85% of taps on the single high lane" report in fixture form. It
 * exercises `laneRangesByPopulation` — with a fixed `low[0] mid[1,2] high[3]`
 * split this collapses onto one lane, and `maxLaneShare` is the number that
 * catches it. A balanced fixture cannot test that path at all.
 */
export function hatHeavySong(): AnalysisResult {
  const duration = 60;
  const onsets: Onset[] = [];
  for (let t = 0; t < duration; t += 0.125) {
    const eighth = Math.round(t / 0.125);
    const kick = eighth % 8 === 0;
    onsets.push({
      t: Number(t.toFixed(4)),
      strength: kick ? 0.95 : 0.45 + (eighth % 2 === 0 ? 0.12 : 0),
      low: kick ? 0.85 : 0.05,
      mid: kick ? 0.2 : 0.12,
      high: kick ? 0.1 : 0.8,
    });
  }
  return { duration, bpm: 120, bpmConfidence: 0.9, beatGrid: beatsEvery(0.5, duration), onsets };
}

/**
 * Rubato: irregular spacing that no constant tempo explains, with
 * `bpmConfidence` below the grid-trust gate.
 *
 * Below `MIN_GRID_CONFIDENCE` the grid gets no say at all — no snapping, no
 * on-beat selection bonus, no chord gating (PLAN.md §2.2). That is a genuinely
 * different branch of `generateChart`, and every other fixture here runs the
 * trusted-grid side of it. A human performance lands on this path, so it is not
 * a corner case.
 */
export function rubatoSong(): AnalysisResult {
  const duration = 60;
  const onsets: Onset[] = [];
  let t = 0;
  let i = 0;
  while (t < duration) {
    const phase = i % 5;
    onsets.push({
      t: Number(t.toFixed(4)),
      strength: 0.3 + ((i * 37) % 11) / 20,
      low: phase === 0 || phase === 3 ? 0.7 : 0.12,
      mid: phase === 1 ? 0.65 : 0.15,
      high: phase === 2 || phase === 4 ? 0.6 : 0.1,
    });
    t += 0.19 + ((i * 53) % 17) / 100;
    i++;
  }
  return { duration, bpm: 118, bpmConfidence: 0.28, beatGrid: beatsEvery(0.508, duration), onsets };
}

/**
 * A full kit — kick on 1 & 3, snare on 2 & 4, hats between — where every hit
 * carries genuine energy in a *second* band.
 *
 * That last part is the reason this fixture exists. `secondaryBand` requires a
 * non-dominant band above 0.2 before an onset is chord-eligible, and the other
 * three fixtures give each onset one clean dominant band with only background
 * bleed elsewhere. So none of them can ever produce a chord, and `chordChance`
 * (0.05 / 0.15 / 0.32 on medium / hard / extreme) went entirely unexercised by
 * tests until this existed. A real kit has two-band hits; synthetic ones only do
 * if you build them that way on purpose.
 */
export function fullKitSong(): AnalysisResult {
  const duration = 60;
  const onsets: Onset[] = [];
  for (let t = 0; t < duration; t += 0.25) {
    const beat = Math.round(t / 0.25) % 8;
    const kick = beat === 0 || beat === 4;
    const snare = beat === 2 || beat === 6;
    onsets.push({
      t: Number(t.toFixed(4)),
      strength: kick ? 0.92 : snare ? 0.85 : 0.5,
      low: kick ? 0.85 : snare ? 0.3 : 0.08,
      mid: kick ? 0.38 : snare ? 0.72 : 0.25,
      high: kick ? 0.22 : snare ? 0.48 : 0.75,
    });
  }
  return { duration, bpm: 120, bpmConfidence: 0.9, beatGrid: beatsEvery(0.5, duration), onsets };
}

/**
 * A slow song — 80 BPM, trusted grid — with an onset on every sixteenth.
 *
 * The tempo and the onset density are both load-bearing. Spacing is
 * beat-relative (`effectiveMinGapSec`), and every other fixture here is at
 * 120 BPM, where `minGapBeats` resolves to exactly the old flat `minGapSec` by
 * calibration — so none of them can see that conversion happen at all. This one
 * is slow enough that all four difficulties resolve *above* their floor.
 *
 * The sixteenths are what make it bite. A gap only shapes a chart when the onsets
 * are closer together than the gap: at 80 BPM a sixteenth is 0.1875s, so under
 * the old flat 0.19s hard could take very nearly every one of them — a wall of
 * sixteenths on a slow song, which is the inconsistency the beat-relative gap
 * exists to fix. With eighth-note onsets nothing would bind and the fixture would
 * pass whether the feature worked or not.
 */
export function slowSong(): AnalysisResult {
  const duration = 60;
  const beatSec = 60 / 80;
  const sixteenth = beatSec / 4;
  const onsets: Onset[] = [];
  for (let i = 0; i * sixteenth < duration; i++) {
    // Strength cycles with the bar (period 4) and the band with period 3, so the
    // two are deliberately coprime. An earlier version keyed both to `i % 4` and
    // aliased against the every-other-sixteenth selection a tight gap produces:
    // hard locked onto the even phases and extreme onto the odd ones, giving two
    // charts of identical density whose lane entropy differed 0.52 vs 1.00. That
    // is a property of the fixture, not the generator, and it made the recorded
    // baseline sit on a knife edge where any small change flipped it.
    const beatPhase = i % 4;
    const bandPhase = i % 3;
    onsets.push({
      // Downbeats loudest, so selection has a real ordering to follow instead of
      // a flat field where which onsets survive is an artefact of tie-breaking.
      strength: beatPhase === 0 ? 0.9 : beatPhase === 2 ? 0.6 : 0.4,
      t: Number((i * sixteenth).toFixed(4)),
      low: bandPhase === 0 ? 0.7 : 0.12,
      mid: bandPhase === 1 ? 0.65 : 0.15,
      high: bandPhase === 2 ? 0.6 : 0.1,
    });
  }
  return {
    duration,
    bpm: 80,
    bpmConfidence: 0.9,
    beatGrid: beatsEvery(beatSec, duration),
    onsets,
  };
}

export type FixtureName = 'structured' | 'hatHeavy' | 'rubato' | 'fullKit' | 'slow';

/** The corpus, built fresh so a test can never mutate another's fixture. */
export function chartCorpus(): Record<FixtureName, AnalysisResult> {
  return {
    structured: structuredSong(),
    hatHeavy: hatHeavySong(),
    rubato: rubatoSong(),
    fullKit: fullKitSong(),
    slow: slowSong(),
  };
}

/** The seed every corpus test generates with, so baselines are reproducible. */
export const CORPUS_SEED = 5;
