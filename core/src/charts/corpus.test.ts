import type { AnalysisResult, DifficultyName } from '@tap-tap/shared';
import { DIFFICULTIES, DIFFICULTY_NAMES, effectiveMinGapSec } from '@tap-tap/shared';
import { describe, expect, it } from 'vitest';
import { generateChart } from './generate.js';
import { chartMetrics } from './metrics.js';
import {
  BREAK_END,
  BREAK_START,
  chartCorpus,
  CORPUS_SEED,
  type FixtureName,
} from './testFixtures.js';

/**
 * The chart-generation regression gate.
 *
 * `chartMetrics` measured charts for a while without anything *running* it, so
 * every tuning change was judged by playing one song and forming an impression.
 * This is the missing half: the whole scorecard, recorded across a corpus that
 * stresses four different generation paths, asserted tightly enough that any
 * change to generation shows up as a diff instead of a vibe.
 *
 * **These are recorded observations, not quality targets.** A failure here means
 * "generation changed" — which may be exactly what you intended. The procedure
 * is: read which numbers moved, decide whether the movement is the improvement
 * you were going for, then re-record. Do not loosen a tolerance to make it pass.
 *
 * To re-record: run the corpus, print `chartMetrics` for each fixture and
 * difficulty at `CORPUS_SEED`, and paste the rounded values below. Mention in
 * the commit which numbers moved and why, because that diff is the only lasting
 * evidence of what a change did to the charts.
 *
 * **`fullBoardLeapRate` is recorded but never bounded.** See the long comment on
 * it in metrics.ts: in a lane-per-finger game, crossing the board is alternating
 * hands rather than travelling, and a change built on the opposite assumption was
 * reverted. It is tracked here so a band-classification regression would show,
 * and for no other reason.
 */

interface Row {
  nps: number;
  corr: number;
  entropy: number;
  maxLane: number;
  chord: number;
  onGrid: number;
  stream: number;
  leap: number;
  gapBeats: number;
  rests: number;
  pattern: number;
}

/** Measured at caea3a3 + the layering gate, seed `CORPUS_SEED`. Generation is deterministic. */
const BASELINE: Record<FixtureName, Record<DifficultyName, Row>> = {
  structured: {
    easy: { nps: 0.933, corr: 0.681, entropy: 0.915, maxLane: 0.429, chord: 0, onGrid: 0.982, stream: 1, leap: 0.073, gapBeats: 2, rests: 30, pattern: 0.215 },
    medium: { nps: 1.183, corr: 0.425, entropy: 0.968, maxLane: 0.366, chord: 0, onGrid: 0.986, stream: 1, leap: 0.071, gapBeats: 1.5, rests: 9, pattern: 0.134 },
    hard: { nps: 2.817, corr: 0.84, entropy: 0.843, maxLane: 0.331, chord: 0, onGrid: 0.994, stream: 112, leap: 0.012, gapBeats: 0.5, rests: 3, pattern: 0.073 },
    extreme: { nps: 3.317, corr: 0.687, entropy: 0.961, maxLane: 0.332, chord: 0, onGrid: 0.995, stream: 112, leap: 0.167, gapBeats: 0.5, rests: 1, pattern: 0.069 },
  },
  hatHeavy: {
    easy: { nps: 1.15, corr: 0, entropy: 0.955, maxLane: 0.362, chord: 0, onGrid: 1, stream: 1, leap: 0.044, gapBeats: 2, rests: 50, pattern: 0.355 },
    medium: { nps: 2.017, corr: 0, entropy: 1, maxLane: 0.256, chord: 0, onGrid: 0.992, stream: 1, leap: 0, gapBeats: 1, rests: 0, pattern: 0.2 },
    hard: { nps: 3.533, corr: 0, entropy: 0.949, maxLane: 0.33, chord: 0, onGrid: 0.995, stream: 16, leap: 0.1, gapBeats: 0.5, rests: 0, pattern: 0.084 },
    extreme: { nps: 4, corr: 0, entropy: 0.986, maxLane: 0.333, chord: 0, onGrid: 0.996, stream: 240, leap: 0.163, gapBeats: 0.5, rests: 0, pattern: 0.067 },
  },
  rubato: {
    easy: { nps: 1.2, corr: 0.445, entropy: 0.996, maxLane: 0.278, chord: 0, onGrid: 0.278, stream: 1, leap: 0.07, gapBeats: 1.535, rests: 12, pattern: 0.013 },
    medium: { nps: 1.883, corr: 0.264, entropy: 0.989, maxLane: 0.31, chord: 0, onGrid: 0.274, stream: 2, leap: 0.063, gapBeats: 1.083, rests: 2, pattern: 0.011 },
    hard: { nps: 3.55, corr: 0.857, entropy: 0.952, maxLane: 0.394, chord: 0, onGrid: 0.282, stream: 7, leap: 0.241, gapBeats: 0.551, rests: 0, pattern: 0.001 },
    extreme: { nps: 3.717, corr: 0.878, entropy: 0.961, maxLane: 0.399, chord: 0, onGrid: 0.274, stream: 7, leap: 0.293, gapBeats: 0.531, rests: 0, pattern: 0.001 },
  },
  fullKit: {
    easy: { nps: 1.15, corr: 0, entropy: 0.96, maxLane: 0.362, chord: 0, onGrid: 1, stream: 1, leap: 0.029, gapBeats: 2, rests: 49, pattern: 0.339 },
    medium: { nps: 2.117, corr: 0, entropy: 0.999, maxLane: 0.276, chord: 0.058, onGrid: 1, stream: 1, leap: 0, gapBeats: 1, rests: 0, pattern: 0.203 },
    hard: { nps: 3.783, corr: 0, entropy: 0.964, maxLane: 0.33, chord: 0.071, onGrid: 0.996, stream: 16, leap: 0.137, gapBeats: 0.5, rests: 0, pattern: 0.086 },
    extreme: { nps: 4.633, corr: 0, entropy: 0.981, maxLane: 0.353, chord: 0.158, onGrid: 0.996, stream: 240, leap: 0.247, gapBeats: 0.5, rests: 0, pattern: 0.075 },
  },
  slow: {
    easy: { nps: 1.217, corr: 0.727, entropy: 0.861, maxLane: 0.329, chord: 0, onGrid: 1, stream: 1, leap: 0.056, gapBeats: 1, rests: 6, pattern: 0.207 },
    medium: { nps: 1.35, corr: 0.77, entropy: 0.964, maxLane: 0.346, chord: 0, onGrid: 0.963, stream: 1, leap: 0.163, gapBeats: 1, rests: 0, pattern: 0.188 },
    hard: { nps: 2.667, corr: 0.672, entropy: 0.815, maxLane: 0.331, chord: 0, onGrid: 0.994, stream: 1, leap: 0.006, gapBeats: 0.5, rests: 0, pattern: 0.067 },
    extreme: { nps: 2.667, corr: 0.672, entropy: 0.961, maxLane: 0.331, chord: 0, onGrid: 0.994, stream: 1, leap: 0.17, gapBeats: 0.5, rests: 0, pattern: 0.067 },
  },
  layered: {
    easy: { nps: 1.15, corr: 0, entropy: 0.978, maxLane: 0.319, chord: 0, onGrid: 1, stream: 1, leap: 0, gapBeats: 1, rests: 22, pattern: 0.289 },
    medium: { nps: 2.117, corr: 0, entropy: 0.981, maxLane: 0.307, chord: 0.058, onGrid: 1, stream: 1, leap: 0.008, gapBeats: 1, rests: 0, pattern: 0.203 },
    hard: { nps: 4.033, corr: 0, entropy: 0.941, maxLane: 0.368, chord: 0.142, onGrid: 0.996, stream: 16, leap: 0.038, gapBeats: 0.5, rests: 0, pattern: 0.085 },
    extreme: { nps: 5.25, corr: 0, entropy: 0.998, maxLane: 0.276, chord: 0.313, onGrid: 0.997, stream: 240, leap: 0.109, gapBeats: 0.5, rests: 0, pattern: 0.075 },
  },
  melodic: {
    easy: { nps: 0.967, corr: 0.049, entropy: 0.964, maxLane: 0.379, chord: 0, onGrid: 1, stream: 1, leap: 0.088, gapBeats: 1.5, rests: 8, pattern: 0.073 },
    medium: { nps: 1.167, corr: 0.427, entropy: 0.965, maxLane: 0.386, chord: 0, onGrid: 0.986, stream: 1, leap: 0.232, gapBeats: 1.5, rests: 4, pattern: 0.07 },
    hard: { nps: 3.35, corr: 0.863, entropy: 0.976, maxLane: 0.289, chord: 0, onGrid: 0.99, stream: 201, leap: 0.14, gapBeats: 0.5, rests: 0, pattern: 0.067 },
    extreme: { nps: 3.35, corr: 0.863, entropy: 0.993, maxLane: 0.289, chord: 0, onGrid: 0.99, stream: 201, leap: 0.14, gapBeats: 0.5, rests: 0, pattern: 0.067 },
  },
};

/**
 * Precision for the float comparisons: `toBeCloseTo(x, 2)` fails past a 0.005
 * absolute difference. Generation is deterministic, so this is effectively exact
 * — the slack is only there to absorb last-bit differences in `Math.log` (lane
 * entropy) and `Math.sqrt` (the correlation), which are not guaranteed
 * bit-identical across engines. Counts are compared exactly; they are discrete
 * and a change of one is a real change.
 */
const PRECISION = 2;

function rowFor(analysis: AnalysisResult, difficulty: DifficultyName): Row {
  const m = chartMetrics(generateChart(analysis, DIFFICULTIES[difficulty], CORPUS_SEED), analysis);
  return {
    nps: m.notesPerSec,
    corr: m.densityCorrelation,
    entropy: m.laneShareEntropy,
    maxLane: m.maxLaneShare,
    chord: m.chordRate,
    onGrid: m.onGridShare,
    stream: m.longestStream,
    leap: m.fullBoardLeapRate,
    gapBeats: m.medianGapBeats,
    rests: m.restCount,
    pattern: m.patternConcentration,
  };
}

const corpus = chartCorpus();
const FIXTURE_NAMES = Object.keys(corpus) as FixtureName[];

/** Every fixture × difficulty, measured once and shared by the assertions. */
const measured = new Map<string, Row>();
for (const fixture of FIXTURE_NAMES) {
  for (const difficulty of DIFFICULTY_NAMES) {
    measured.set(`${fixture}/${difficulty}`, rowFor(corpus[fixture], difficulty));
  }
}
const row = (fixture: FixtureName, difficulty: DifficultyName): Row =>
  measured.get(`${fixture}/${difficulty}`)!;

describe('chart corpus — recorded baselines', () => {
  const FLOATS = ['nps', 'corr', 'entropy', 'maxLane', 'chord', 'onGrid', 'leap', 'gapBeats', 'pattern'] as const;
  const COUNTS = ['stream', 'rests'] as const;

  for (const fixture of FIXTURE_NAMES) {
    for (const difficulty of DIFFICULTY_NAMES) {
      it(`${fixture}/${difficulty} matches its recorded scorecard`, () => {
        const actual = row(fixture, difficulty);
        const expected = BASELINE[fixture][difficulty];
        for (const key of FLOATS) {
          expect(actual[key], `${fixture}/${difficulty} ${key}`).toBeCloseTo(
            expected[key],
            PRECISION,
          );
        }
        for (const key of COUNTS) {
          expect(actual[key], `${fixture}/${difficulty} ${key}`).toBe(expected[key]);
        }
      });
    }
  }
});

describe('chart corpus — properties that must hold on every fixture', () => {
  /**
   * The claim "easy and medium are the same chart at different densities" came
   * from one fixture. Whether it is true is a property of *generation*, so it has
   * to be asked of every song shape — which is the whole reason the corpus exists.
   */
  it('escalates rhythm from easy to extreme, not only density', () => {
    for (const fixture of FIXTURE_NAMES) {
      const easy = row(fixture, 'easy');
      const extreme = row(fixture, 'extreme');
      expect(extreme.gapBeats, `${fixture} extreme gapBeats`).toBeLessThan(easy.gapBeats);
    }
  });

  /**
   * Non-decreasing, **not** strictly increasing — and the difference is a real
   * property of beat-relative spacing rather than a loosened assertion.
   *
   * A gap can only be honoured at spacings the song's onsets actually offer. The
   * `slow` fixture is quantised to sixteenths (0.1875s at 80 BPM), and both hard
   * (0.285s) and extreme (0.21s) resolve above that, so both must skip to eighths
   * and land on identical density. Extreme's tighter gap buys nothing because
   * there is no spacing available between the two targets. That is correct: the
   * tiers still differ in `approachSec`, chording and lane usage on that fixture,
   * just not in timing. Asserting strict monotonicity here would encode "a harder
   * tier is always denser", which the corpus disproves.
   *
   * A harder tier being *sparser* would still be a real defect, so that is what
   * this pins.
   */
  it('never makes a harder difficulty sparser than an easier one', () => {
    for (const fixture of FIXTURE_NAMES) {
      for (let i = 1; i < DIFFICULTY_NAMES.length; i++) {
        const prev = DIFFICULTY_NAMES[i - 1]!;
        const next = DIFFICULTY_NAMES[i]!;
        expect(row(fixture, next).nps, `${fixture} ${next} vs ${prev} nps`).toBeGreaterThanOrEqual(
          row(fixture, prev).nps,
        );
      }
    }
  });

  /**
   * The tiers must still be distinguishable *somewhere*, or the spacing change
   * has quietly collapsed them. Density is the wrong thing to demand it in (see
   * above), so this asks the weaker, true question: easy and extreme differ on
   * every fixture.
   */
  it('keeps easy and extreme distinguishable on every fixture', () => {
    for (const fixture of FIXTURE_NAMES) {
      expect(row(fixture, 'extreme').nps, `${fixture} extreme vs easy nps`).toBeGreaterThan(
        row(fixture, 'easy').nps,
      );
    }
  });

  /**
   * The one-lane-collapse alarm. `hatHeavy` is ~94% high-band, which is the
   * fixture that would pile onto a single lane under a fixed `low[0] mid[1,2]
   * high[3]` split — so this assertion is load-bearing for
   * `laneRangesByPopulation` and cannot be made by a balanced fixture.
   */
  it('never lets one lane run away with the chart', () => {
    for (const fixture of FIXTURE_NAMES) {
      for (const difficulty of DIFFICULTY_NAMES) {
        expect(
          row(fixture, difficulty).maxLane,
          `${fixture}/${difficulty} maxLaneShare`,
        ).toBeLessThan(0.6);
      }
    }
  });

  /**
   * Tracked, not bounded — only the degenerate end is asserted, where the chart
   * would have stopped using the board at all. Medium is excluded because two
   * fixtures legitimately record 0 there.
   */
  it('still uses the whole board on the harder charts', () => {
    for (const fixture of FIXTURE_NAMES) {
      for (const difficulty of ['hard', 'extreme'] as const) {
        expect(row(fixture, difficulty).leap, `${fixture}/${difficulty} leap`).toBeGreaterThan(0);
      }
    }
  });
});

describe('chart corpus — what each fixture alone can say', () => {
  /**
   * Only `structured` has both large intensity variation and a real silence, so
   * it is the only fixture that can test phrasing. The others play continuously
   * and are *entitled* to continuous charts — asserting rests on them would be
   * the "a metric is not a quality floor" mistake in a new costume.
   */
  it('structured: tracks intensity, rests, and places nothing in the break', () => {
    for (const difficulty of DIFFICULTY_NAMES) {
      const m = row('structured', difficulty);
      expect(m.corr, `structured/${difficulty} correlation`).toBeGreaterThan(0.4);
      expect(m.rests, `structured/${difficulty} rests`).toBeGreaterThan(0);

      const chart = generateChart(corpus.structured, DIFFICULTIES[difficulty], CORPUS_SEED);
      const inBreak = chart.notes.filter(
        (n) => n.t >= BREAK_START + 0.5 && n.t < BREAK_END - 0.5,
      );
      expect(inBreak, `structured/${difficulty} notes inside the break`).toHaveLength(0);
    }
  });

  /**
   * Below `MIN_GRID_CONFIDENCE` the grid gets no say: notes stay where they were
   * heard rather than being snapped. A high on-grid share here would mean the
   * confidence gate had stopped working, and every other fixture runs the
   * trusted-grid branch and so cannot notice.
   */
  it('rubato: leaves notes off the grid, and trusted fixtures snap to it', () => {
    for (const difficulty of DIFFICULTY_NAMES) {
      expect(row('rubato', difficulty).onGrid, `rubato/${difficulty} onGrid`).toBeLessThan(0.5);
    }
    for (const fixture of ['structured', 'hatHeavy', 'fullKit'] as const) {
      for (const difficulty of DIFFICULTY_NAMES) {
        expect(
          row(fixture, difficulty).onGrid,
          `${fixture}/${difficulty} onGrid`,
        ).toBeGreaterThan(0.98);
      }
    }
  });

  /**
   * `chordChance` is 0.05 / 0.15 / 0.32 on medium / hard / extreme, and until this
   * fixture existed no test produced a single chord: `secondaryBand` needs a
   * non-dominant band above 0.2, and every other fixture gives each onset one
   * clean band. Easy sets `chords: false` and must stay at exactly zero.
   */
  it('fullKit: places chords above easy, and none on easy', () => {
    expect(row('fullKit', 'easy').chord, 'fullKit/easy chordRate').toBe(0);
    for (const difficulty of ['medium', 'hard', 'extreme'] as const) {
      expect(row('fullKit', difficulty).chord, `fullKit/${difficulty} chordRate`).toBeGreaterThan(0);
    }
    // And the share rises with difficulty, as `chordChance` does.
    expect(row('fullKit', 'extreme').chord).toBeGreaterThan(row('fullKit', 'medium').chord);
  });

  /**
   * `slow` is the only fixture whose tempo is far enough from 120 BPM for the
   * beat-relative gap to resolve above its floor, so it is the only one that can
   * see `effectiveMinGapSec` do anything at all.
   */
  it('slow: spaces notes by the beat, not by the wall clock', () => {
    for (const difficulty of DIFFICULTY_NAMES) {
      const params = DIFFICULTIES[difficulty];
      const chart = generateChart(corpus.slow, params, CORPUS_SEED);
      const expected = effectiveMinGapSec(params, corpus.slow.bpm, true);

      // At 80 BPM every difficulty resolves strictly above its own floor.
      expect(expected, `slow/${difficulty} resolved gap`).toBeGreaterThan(params.minGapSec);
      // And the chart records what it was built with, so judgement can cap its
      // windows against the spacing the notes were actually placed at.
      expect(chart.minGapSec, `slow/${difficulty} recorded gap`).toBeCloseTo(expected, 6);

      // No two notes may sit closer than that anywhere on the board.
      const times = [...new Set(chart.notes.map((n) => n.t))].sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        expect(
          times[i]! - times[i - 1]!,
          `slow/${difficulty} gap at t=${times[i]}`,
        ).toBeGreaterThanOrEqual(expected - 1e-6);
      }
    }
  });

  /**
   * The payoff, and the whole reason the gap became beat-relative: a difficulty
   * should ask for the same *musical* figure whatever the tempo.
   *
   * Under the old wall-clock gap this failed on exactly the difficulties whose
   * floor was tightest — extreme measured 0.25 beats on this 80 BPM fixture
   * against 0.5 on a 120 BPM one, so "extreme" meant sixteenth streams on a slow
   * song and eighths on a fast one. Medium was 0.5 against 1.0. Both now agree.
   */
  it('asks for the same musical spacing at 80 BPM as at 120', () => {
    for (const difficulty of ['medium', 'hard', 'extreme'] as const) {
      expect(row('slow', difficulty).gapBeats, `${difficulty} slow vs fullKit gapBeats`).toBe(
        row('fullKit', difficulty).gapBeats,
      );
    }
  });
  /**
   * The layering ladder (§2.10). `layered` is the only fixture whose four
   * `percussive` values straddle all four tier floors, so it is the only place
   * this can be asserted at all.
   *
   * Density is asserted **strictly** increasing here, unlike the shared
   * non-decreasing check: the pool itself grows by a whole layer at every rung,
   * so a tie would mean the gate had stopped separating them.
   */
  it('layered: each tier admits one more layer than the last', () => {
    let previous = 0;
    for (const difficulty of DIFFICULTY_NAMES) {
      const nps = row('layered', difficulty).nps;
      expect(nps, `layered/${difficulty} density over the tier below`).toBeGreaterThan(previous);
      previous = nps;
    }
  });

  /**
   * The gate must never empty a chart — the failure that would look like the
   * generator breaking rather than a threshold being wrong.
   *
   * `melodic` has nothing above 0.18, so easy (0.6), medium (0.4) and hard (0.2)
   * all enter `admitPercussive`'s relaxation branch. No other fixture does.
   */
  it('melodic: charts a song with no percussion at every difficulty', () => {
    for (const difficulty of DIFFICULTY_NAMES) {
      const chart = generateChart(corpus.melodic, DIFFICULTIES[difficulty], CORPUS_SEED);
      expect(chart.notes.length, `melodic/${difficulty} note count`).toBeGreaterThan(0);
      // And not merely non-empty — it should reach a playable density, the same
      // bar any other song gets.
      expect(row('melodic', difficulty).nps, `melodic/${difficulty} density`).toBeGreaterThan(0.5);
    }
  });
});
