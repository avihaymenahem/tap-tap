import type { AnalysisResult, Chart, Note, Onset } from '@tap-tap/shared';
import { DIFFICULTIES } from '@tap-tap/shared';
import { describe, expect, it } from 'vitest';
import { generateChart } from './generate.js';
import { chartMetrics } from './metrics.js';

const tap = (t: number, lane: number): Note => ({ t, lane, type: 'tap' });

function beatsEvery(step: number, duration: number): number[] {
  const grid: number[] = [];
  for (let t = 0; t < duration; t += step) grid.push(Number(t.toFixed(4)));
  return grid;
}

function analysisWith(overrides: Partial<AnalysisResult>): AnalysisResult {
  return {
    duration: 10,
    bpm: 120,
    bpmConfidence: 0.9,
    beatGrid: beatsEvery(0.5, 10),
    onsets: [],
    ...overrides,
  };
}

describe('chartMetrics', () => {
  it('returns all-zero metrics for an empty chart without throwing', () => {
    const m = chartMetrics({ laneCount: 4, notes: [] }, analysisWith({}));
    expect(m).toEqual({
      notesPerSec: 0,
      densityCorrelation: 0,
      laneShareEntropy: 0,
      maxLaneShare: 0,
      chordRate: 0,
      onGridShare: 0,
      longestStream: 0,
      patternConcentration: 0,
      fullBoardLeapRate: 0,
      medianGapBeats: 0,
      restCount: 0,
    });
  });

  it('measures an even lane spread as maximal entropy and a collapse as minimal', () => {
    const even: Chart = {
      laneCount: 4,
      notes: [0, 1, 2, 3].flatMap((lane) => [0, 1, 2].map((k) => tap(lane + k * 4, lane))),
    };
    const m = chartMetrics(even, analysisWith({ duration: 16 }));
    expect(m.maxLaneShare).toBeCloseTo(0.25, 5);
    expect(m.laneShareEntropy).toBeCloseTo(1, 5);

    const collapsed: Chart = { laneCount: 4, notes: [0, 1, 2, 3, 4].map((t) => tap(t, 0)) };
    const c = chartMetrics(collapsed, analysisWith({}));
    expect(c.maxLaneShare).toBe(1);
    expect(c.laneShareEntropy).toBe(0);
  });

  it('counts chords by shared timestamp', () => {
    const chart: Chart = {
      laneCount: 4,
      notes: [tap(0, 0), tap(0, 2), tap(1, 1), tap(2, 3)],
    };
    // Three distinct timestamps, one of them chorded.
    expect(chartMetrics(chart, analysisWith({})).chordRate).toBeCloseTo(1 / 3, 5);
  });

  it('scores on-grid notes high and off-grid notes near zero', () => {
    const grid = beatsEvery(0.5, 10);
    const onGrid: Chart = { laneCount: 4, notes: grid.slice(0, 8).map((t, i) => tap(t, i % 4)) };
    expect(chartMetrics(onGrid, analysisWith({ beatGrid: grid })).onGridShare).toBeGreaterThan(0.9);

    // +0.2 sits between the beat (0.5 spacing) and its half-beat, outside tolerance.
    const offGrid: Chart = {
      laneCount: 4,
      notes: grid.slice(0, 8).map((t, i) => tap(Number((t + 0.2).toFixed(4)), i % 4)),
    };
    expect(chartMetrics(offGrid, analysisWith({ beatGrid: grid })).onGridShare).toBeLessThan(0.1);
  });

  it('finds the longest stream of tightly-spaced notes', () => {
    const chart: Chart = {
      laneCount: 4,
      // A run of four within 0.1s, then a gap, then a pair.
      notes: [0, 0.1, 0.2, 0.3, 2, 2.1].map((t, i) => tap(t, i % 4)),
    };
    expect(chartMetrics(chart, analysisWith({})).longestStream).toBe(4);
  });

  it('rates a one-position groove far more concentrated than a scattered one', () => {
    const grid = beatsEvery(0.5, 60);

    // Once per bar, always the same phase (every 2s = 4 beats): maximally repetitive.
    const repetitive: Chart = {
      laneCount: 4,
      notes: Array.from({ length: 30 }, (_, k) => tap(k * 2, k % 4)),
    };
    // Every sixteenth across every bar: uniform over all phases.
    const scattered: Chart = {
      laneCount: 4,
      notes: beatsEvery(0.125, 60).map((t, i) => tap(t, i % 4)),
    };

    const rep = chartMetrics(repetitive, analysisWith({ duration: 60, beatGrid: grid }));
    const sca = chartMetrics(scattered, analysisWith({ duration: 60, beatGrid: grid }));
    expect(rep.patternConcentration).toBeGreaterThan(0.9);
    expect(sca.patternConcentration).toBeLessThan(0.1);
  });
});

describe('chartMetrics on generated charts (regression floors)', () => {
  /**
   * A song with structure: a quiet first half, a loud second half, and a real
   * breakdown — eight seconds with nothing playing at all.
   *
   * The break is the point. Without one, "does the chart rest?" cannot be asked:
   * a fixture that plays continuously is entitled to a continuous chart, and a
   * generator with no concept of phrasing passes for the wrong reason.
   */
  const BREAK_START = 24;
  const BREAK_END = 32;

  function structuredAnalysis(): AnalysisResult {
    const duration = 60;
    const beatGrid = beatsEvery(0.5, duration);
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
    return { duration, bpm: 120, bpmConfidence: 0.9, beatGrid, onsets };
  }

  it('generated charts track intensity, spread lanes and stay on the grid', () => {
    const analysis = structuredAnalysis();
    for (const params of [DIFFICULTIES.medium, DIFFICULTIES.hard]) {
      const chart = generateChart(analysis, params, 5);
      const m = chartMetrics(chart, analysis);

      // Busier where the music is louder — the correlation that caught real bugs.
      expect(m.densityCorrelation).toBeGreaterThan(0.4);
      // No single lane runs away with the chart (the one-lane-collapse alarm).
      expect(m.maxLaneShare).toBeLessThan(0.6);
      // A trusted grid means most notes sit on it.
      expect(m.onGridShare).toBeGreaterThan(0.7);
      expect(m.notesPerSec).toBeGreaterThan(0);
    }
  });

  /**
   * Full-board crossings are *tracked*, not bounded — see `fullBoardLeapRate`.
   * A bound was tried and removed: in a lane-per-finger game, crossing the board
   * is alternating hands, not travelling, so a low number is not a better chart.
   * What is worth catching is the degenerate end, where the chart stops using
   * the board at all.
   */
  it('keeps using the whole board on the harder charts', () => {
    const analysis = structuredAnalysis();
    for (const params of [DIFFICULTIES.hard, DIFFICULTIES.extreme]) {
      const m = chartMetrics(generateChart(analysis, params, 5), analysis);
      expect(m.fullBoardLeapRate, `${params.name} leap rate`).toBeGreaterThan(0);
      expect(m.fullBoardLeapRate, `${params.name} leap rate`).toBeLessThan(0.6);
    }
  });

  it('rests when the music does', () => {
    const analysis = structuredAnalysis();
    for (const params of [DIFFICULTIES.medium, DIFFICULTIES.hard, DIFFICULTIES.extreme]) {
      const chart = generateChart(analysis, params, 5);
      const m = chartMetrics(chart, analysis);

      // The fixture has an eight-second break; a chart that never stops is a
      // chart that is not listening.
      expect(m.restCount, `${params.name} rests`).toBeGreaterThan(0);

      // And specifically: nothing should be placed inside the break itself.
      const inBreak = chart.notes.filter((n) => n.t >= BREAK_START + 0.5 && n.t < BREAK_END - 0.5);
      expect(inBreak, `${params.name} notes inside the break`).toHaveLength(0);
    }
  });

  it('escalates rhythm across difficulties, not only density', () => {
    const analysis = structuredAnalysis();
    const easy = chartMetrics(generateChart(analysis, DIFFICULTIES.easy, 5), analysis);
    const extreme = chartMetrics(generateChart(analysis, DIFFICULTIES.extreme, 5), analysis);

    // Measured in beats, so this says something musical: extreme must ask for a
    // finer subdivision than easy, not merely more of the same figure. Easy and
    // medium were both quarter-notes-only, which is why clearing easy taught a
    // player nothing that prepared them for the next rung.
    expect(extreme.medianGapBeats).toBeLessThan(easy.medianGapBeats);
  });
});
