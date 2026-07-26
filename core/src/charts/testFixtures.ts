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
 * paths. Hence seven, each documented with what it exercises that the others
 * cannot — and adding one is the right move whenever a new feature has a branch
 * none of them reach. `layered` and `melodic` were both added for that reason:
 * the harmonic/percussive gate has a difficulty ladder and a relaxation path, and
 * no pre-existing fixture could enter either. **Resist the temptation to add the
 * new feature to an existing fixture instead** — that was tried with `slow`, and
 * a fixture measuring two features at once is a fixture whose failures can no
 * longer be attributed to one.
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
      // Kick and hat are drum hits; the mid phase is a melodic stab. Keyed to the
      // existing band phase rather than a period of its own, because this fixture's
      // job is rests and the density correlation — `layered` carries the ladder.
      percussive: phase === 1 ? 0.3 : phase === 0 ? 0.95 : 0.9,
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
      // Everything here is a drum, so every tier admits every onset. That is the
      // point: this fixture is the negative control proving the layering gate does
      // not quietly thin a chart on a song that is *all* percussion.
      percussive: kick ? 0.96 : 0.9,
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
      // Deliberately *not* sitting on a tier threshold (0.6 / 0.4 / 0.2): a value
      // exactly equal to one would make the baseline turn on the `>=` in the gate,
      // which is the knife-edge the `slow` fixture's aliasing note warns about.
      percussive: phase === 1 ? 0.35 : phase === 0 || phase === 3 ? 0.9 : 0.62,
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
      // A kit, so all of it is percussive — this fixture exists for `secondaryBand`
      // and chords, and holding its layering flat keeps the chord baselines a
      // reading of chording rather than of the gate.
      percussive: kick ? 0.95 : snare ? 0.93 : 0.9,
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
      // **Uniformly percussive on purpose — this fixture must not exercise the
      // layering gate.** A spread was tried here and it was a mistake: the layer
      // period interacted with the every-Nth-onset selection a tight gap produces,
      // and easy lost all six of its rests while its density correlation fell
      // 0.727 → 0.264 and hard's leap rate jumped 0.006 → 0.328. None of that was
      // generation changing — it was one fixture measuring two features at once,
      // so a future failure here could no longer be attributed. Spacing is this
      // fixture's job; `layered` carries the layering ladder.
      percussive: 0.9,
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

/**
 * Four separable layers on a sixteenth grid: drums on the quarters, bass on the
 * off-beat eighths, a pad and a lead filling the rest.
 *
 * **This is the fixture the harmonic/percussive ladder is read off.** Its four
 * `percussive` values (0.95 / 0.5 / 0.3 / 0.1) straddle all four tier floors
 * (0.6 / 0.4 / 0.2 / 0), so each difficulty admits a genuinely different pool and
 * the escalation is *rhythmic* rather than merely denser:
 *
 *     easy     quarters                      (drums)
 *     medium   quarters + off-beat eighths   (+ bass)
 *     hard     three sixteenths in four      (+ pad)
 *     extreme  every sixteenth               (+ lead)
 *
 * Which is the shape deliverable 13 asked for — "escalate rhythm, not just
 * count" — and no other fixture can show it. The layering spread deliberately
 * lives *here* and nowhere else: it was first put on `slow`, where it collided
 * with that fixture's own periods and moved numbers for reasons that had nothing
 * to do with generation. One fixture, one feature.
 */
export function layeredSong(): AnalysisResult {
  const duration = 60;
  const sixteenth = 0.125; // 120 BPM
  const onsets: Onset[] = [];
  for (let i = 0; i * sixteenth < duration; i++) {
    const slot = i % 4;
    // Layer identity drives percussive share, strength and band together, the way
    // it does in real music: the kick is the loudest and the lowest, the lead the
    // brightest and the least percussive.
    const layer =
      slot === 0
        ? { percussive: 0.95, strength: 0.92, low: 0.82, mid: 0.3, high: 0.14 } // drum
        : slot === 2
          ? { percussive: 0.5, strength: 0.7, low: 0.66, mid: 0.42, high: 0.12 } // bass
          : slot === 1
            ? { percussive: 0.3, strength: 0.52, low: 0.16, mid: 0.68, high: 0.2 } // pad
            : { percussive: 0.1, strength: 0.56, low: 0.1, mid: 0.26, high: 0.7 }; // lead
    onsets.push({ t: Number((i * sixteenth).toFixed(4)), ...layer });
  }
  return { duration, bpm: 120, bpmConfidence: 0.9, beatGrid: beatsEvery(0.5, duration), onsets };
}

/**
 * A song with no percussion: solo-piano-shaped, every onset a note or a chord
 * change and nothing above the layering gate's lowest floor.
 *
 * This is the fixture that keeps the harmonic/percussive gate honest in the one
 * direction that could take the library down. Easy asks for `percussive >= 0.6`
 * and there is nothing here above 0.18, so a gate that merely filtered would
 * chart this song **empty** at three of four difficulties — while a human charter
 * would happily chart its melody. `admitPercussive` therefore relaxes toward the
 * most percussive onsets whenever the gate cannot fill the density budget, and
 * this is the only fixture where that branch runs at all.
 *
 * It is also the closest thing in the corpus to a genuine acoustic track, which
 * is a real part of anyone's library and the exact case an absolute threshold is
 * most likely to be wrong about.
 */
export function melodicSong(): AnalysisResult {
  const duration = 60;
  const onsets: Onset[] = [];
  for (let t = 0; t < duration; t += 0.3) {
    const i = Math.round(t / 0.3);
    // A melodic contour rather than a flat field, so lane assignment has real
    // movement to follow and the chart is not an artefact of tie-breaking.
    const step = i % 7;
    onsets.push({
      t: Number(t.toFixed(4)),
      strength: 0.35 + ((i * 29) % 13) / 26,
      low: step < 2 ? 0.62 : 0.14,
      mid: step >= 2 && step < 5 ? 0.6 : 0.18,
      high: step >= 5 ? 0.58 : 0.12,
      // All below even hard's 0.2 floor: a chord change reads as harmonic, and a
      // piano's hammer gives only a slight percussive edge. Nothing here is a drum.
      percussive: step === 0 ? 0.18 : 0.06 + (i % 3) * 0.02,
    });
  }
  return { duration, bpm: 100, bpmConfidence: 0.85, beatGrid: beatsEvery(0.6, duration), onsets };
}

export type FixtureName =
  | 'structured'
  | 'hatHeavy'
  | 'rubato'
  | 'fullKit'
  | 'slow'
  | 'layered'
  | 'melodic';

/** The corpus, built fresh so a test can never mutate another's fixture. */
export function chartCorpus(): Record<FixtureName, AnalysisResult> {
  return {
    structured: structuredSong(),
    hatHeavy: hatHeavySong(),
    rubato: rubatoSong(),
    fullKit: fullKitSong(),
    slow: slowSong(),
    layered: layeredSong(),
    melodic: melodicSong(),
  };
}

/** The seed every corpus test generates with, so baselines are reproducible. */
export const CORPUS_SEED = 5;
