import type { AnalysisResult, Onset } from '@tap-tap/shared';
import { DIFFICULTIES } from '@tap-tap/shared';
import { describe, expect, it } from 'vitest';
import { buildGrid, generateAllCharts, generateChart, snapNear, snapToGrid } from './generate.js';

function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  const duration = 60;
  const bpm = 120;
  const period = 60 / bpm;

  const beatGrid: number[] = [];
  for (let t = 0; t < duration; t += period) beatGrid.push(Number(t.toFixed(4)));

  // Onsets on every eighth note, cycling through the three bands.
  const onsets: Onset[] = [];
  for (let t = 0; t < duration; t += period / 2) {
    const phase = Math.round(t / (period / 2)) % 3;
    onsets.push({
      t,
      strength: 0.5 + 0.5 * ((phase + 1) / 3),
      low: phase === 0 ? 0.7 : 0.15,
      mid: phase === 1 ? 0.7 : 0.15,
      high: phase === 2 ? 0.7 : 0.15,
    });
  }

  return { duration, bpm, bpmConfidence: 0.9, beatGrid, onsets, ...overrides };
}

describe('grid helpers', () => {
  it('subdivides a beat grid', () => {
    expect(buildGrid([0, 1, 2], 2)).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it('returns an empty grid when there are too few beats', () => {
    expect(buildGrid([1], 4)).toEqual([]);
  });

  it('snaps to the nearest slot', () => {
    const grid = [0, 0.5, 1];
    expect(snapToGrid(grid, 0.4)).toBe(0.5);
    expect(snapToGrid(grid, 0.1)).toBe(0);
    expect(snapToGrid(grid, 99)).toBe(1);
    expect(snapToGrid(grid, -99)).toBe(0);
  });
});

describe('snapNear', () => {
  const grid = [0, 0.5, 1, 1.5];

  it('snaps an onset that is already essentially on the grid', () => {
    expect(snapNear(grid, 0.51, 0.03)).toBe(0.5);
  });

  it('leaves an onset alone when the grid disagrees with it', () => {
    expect(snapNear(grid, 0.62, 0.03)).toBe(0.62);
  });

  it('is a no-op with no grid or no tolerance', () => {
    expect(snapNear([], 0.62, 0.03)).toBe(0.62);
    expect(snapNear(grid, 0.51, 0)).toBe(0.51);
  });
});

describe('timing fidelity against a drifting grid', () => {
  it('follows the onsets, not a beat grid running at the wrong tempo', () => {
    // The detector heard a genuine 121 BPM; tempo estimation guessed 120. Over
    // a minute that grid drifts by more than a full beat. Notes must track what
    // was actually heard — this is the regression guard for charts that start
    // in sync and progressively drift away from the music.
    const duration = 60;
    const truePeriod = 60 / 121;
    const gridPeriod = 60 / 120;

    const beatGrid: number[] = [];
    for (let t = 0; t < duration; t += gridPeriod) beatGrid.push(t);

    const onsets: Onset[] = [];
    for (let t = 0; t < duration; t += truePeriod) {
      onsets.push({ t, strength: 0.9, low: 0.7, mid: 0.15, high: 0.15 });
    }

    const analysis: AnalysisResult = {
      duration,
      bpm: 120,
      bpmConfidence: 0.4,
      beatGrid,
      onsets,
    };

    const chart = generateChart(analysis, DIFFICULTIES.easy, 1);
    expect(chart.notes.length).toBeGreaterThan(30);

    for (const note of chart.notes) {
      const nearestOnset = onsets.reduce(
        (best, o) => (Math.abs(o.t - note.t) < Math.abs(best - note.t) ? o.t : best),
        Infinity,
      );
      // Below MIN_GRID_CONFIDENCE the grid gets no say at all: every note sits
      // exactly on the onset that produced it (up to storage rounding), because
      // "the grid already agrees" is meaningless when the grid is wrong.
      expect(Math.abs(nearestOnset - note.t)).toBeLessThan(0.001);
    }

    // And specifically: late notes track the onsets rather than the drifting
    // grid. Averaged over the final quarter, because an individual note may
    // legitimately sit on a grid line that happens to coincide with an onset —
    // the claim is about the population, not any one note.
    const late = chart.notes.filter((n) => n.t > duration * 0.75);
    expect(late.length).toBeGreaterThan(5);

    const nearest = (t: number, times: number[]): number =>
      times.reduce((best, x) => Math.min(best, Math.abs(x - t)), Infinity);

    const onsetTimes = onsets.map((o) => o.t);
    const meanToOnset =
      late.reduce((sum, n) => sum + nearest(n.t, onsetTimes), 0) / late.length;
    const meanToGrid = late.reduce((sum, n) => sum + nearest(n.t, beatGrid), 0) / late.length;

    expect(meanToOnset).toBeLessThan(meanToGrid);
  });
});

describe('musicality: the grid shapes selection when it is trusted', () => {
  it('prefers the onset on the beat when a rival off-beat onset crowds it', () => {
    // Every beat has a companion scuffle 220ms later that is slightly STRONGER.
    // Only one of each pair fits inside minGapSec — and the one the player gets
    // should be the beat they are nodding to, not the scuffle. Raw strength
    // ranking picks the scuffle every time, which is precisely the
    // "computer-generated" feel: locally defensible, musically wrong.
    const duration = 40;
    const beatGrid: number[] = [];
    for (let t = 0; t < duration; t += 0.5) beatGrid.push(t);

    const onsets: Onset[] = [];
    for (let t = 0; t < duration - 0.5; t += 0.5) {
      onsets.push({ t, strength: 0.6, low: 0.6, mid: 0.2, high: 0.2 });
      onsets.push({ t: t + 0.22, strength: 0.68, low: 0.6, mid: 0.2, high: 0.2 });
    }

    const analysis: AnalysisResult = { duration, bpm: 120, bpmConfidence: 0.9, beatGrid, onsets };
    // Generous target so the note budget does not bind: the on-beat/off-beat
    // choice must come from spacing + the on-grid preference, nothing else.
    const chart = generateChart(analysis, { ...DIFFICULTIES.easy, targetNps: 4 }, 1);

    expect(chart.notes.length).toBeGreaterThan(30);
    for (const note of chart.notes) {
      expect(Math.abs(note.t - Math.round(note.t * 2) / 2)).toBeLessThan(0.001);
    }
  });

  it('sweeps lanes along the melodic contour instead of shuffling them', () => {
    // Mid-band onsets whose brightness climbs across the song. A human charter
    // maps a rising line onto a left-to-right walk; random assignment turns the
    // same music into noise. Asserted on the population: the last third of the
    // chart must sit meaningfully to the right of the first third.
    const duration = 30;
    const beatGrid: number[] = [];
    for (let t = 0; t < duration; t += 0.5) beatGrid.push(t);

    const onsets: Onset[] = [];
    for (let t = 0; t < duration; t += 0.25) {
      const progress = t / duration;
      onsets.push({
        t,
        strength: 0.9,
        low: 0.15,
        mid: 0.5,
        high: 0.05 + 0.3 * progress,
      });
    }

    const analysis: AnalysisResult = { duration, bpm: 120, bpmConfidence: 0.9, beatGrid, onsets };
    // Chords off so every note comes from the mid range and the sweep is clean.
    const chart = generateChart(analysis, { ...DIFFICULTIES.hard, chords: false }, 1);
    expect(chart.notes.length).toBeGreaterThan(60);

    // All mid-band notes stay in the mid lanes of a 5-lane chart.
    for (const note of chart.notes) {
      expect(note.lane).toBeGreaterThanOrEqual(1);
      expect(note.lane).toBeLessThanOrEqual(3);
    }

    const third = Math.floor(chart.notes.length / 3);
    const mean = (notes: typeof chart.notes) =>
      notes.reduce((sum, n) => sum + n.lane, 0) / notes.length;
    const firstThird = mean(chart.notes.slice(0, third));
    const lastThird = mean(chart.notes.slice(-third));
    expect(lastThird - firstThird).toBeGreaterThan(0.8);
  });

  it('never places a chord off the beat when the grid is trusted', () => {
    // Strong off-grid onsets with chord-worthy secondary energy: eligible by
    // strength, vetoed by position. An off-beat two-hand hit reads as a
    // generator mistake, not an accent.
    const duration = 60;
    const beatGrid: number[] = [];
    for (let t = 0; t < duration; t += 0.5) beatGrid.push(t);

    const onsets: Onset[] = [];
    // +0.19 sits between hard's subdivision slots (every 0.125s) and outside
    // the 30ms snap tolerance, so these stay genuinely off-grid.
    for (let t = 0; t < duration - 1; t += 0.5) {
      onsets.push({ t, strength: 0.9, low: 0.55, mid: 0.15, high: 0.3 });
      onsets.push({ t: t + 0.19, strength: 0.9, low: 0.55, mid: 0.15, high: 0.3 });
    }

    const analysis: AnalysisResult = { duration, bpm: 120, bpmConfidence: 0.9, beatGrid, onsets };
    const chart = generateChart(
      { ...analysis },
      { ...DIFFICULTIES.hard, targetNps: 6, minGapSec: 0.1, chordChance: 1 },
      1,
    );

    const byTime = new Map<number, number>();
    for (const note of chart.notes) byTime.set(note.t, (byTime.get(note.t) ?? 0) + 1);

    let chords = 0;
    for (const [t, count] of byTime) {
      if (count < 2) continue;
      chords++;
      // Chorded timestamps only ever land on the subdivision grid.
      const offGrid = Math.abs(t - Math.round(t * 8) / 8) > 0.001;
      expect(offGrid).toBe(false);
    }
    // The gate must not have starved the feature entirely.
    expect(chords).toBeGreaterThan(5);
  });
});

describe('dynamics: quiet sections still get notes', () => {
  it('does not starve a quiet intro under a loud body', () => {
    // Regression guard for a track opening softly: every onset in the intro is
    // weak in absolute terms, so a global strength ranking drops all of them
    // and the first minute comes out completely empty.
    const duration = 240;
    const quietUntil = 60;
    const onsets: Onset[] = [];
    for (let t = 0; t < duration; t += 0.25) {
      onsets.push({
        t,
        strength: t < quietUntil ? 0.08 : 0.9,
        low: 0.5,
        mid: 0.3,
        high: 0.2,
      });
    }

    const beatGrid: number[] = [];
    for (let t = 0; t < duration; t += 0.5) beatGrid.push(t);

    const analysis: AnalysisResult = {
      duration,
      bpm: 120,
      bpmConfidence: 0.9,
      beatGrid,
      onsets,
    };

    const chart = generateChart(analysis, DIFFICULTIES.medium, 1);
    const intro = chart.notes.filter((n) => n.t < quietUntil);
    const body = chart.notes.filter((n) => n.t >= quietUntil);

    expect(chart.notes[0]!.t).toBeLessThan(10);
    // Not empty...
    expect(intro.length).toBeGreaterThan(20);
    // ...but the loud body is still denser per second, so dynamics survive.
    const introNps = intro.length / quietUntil;
    const bodyNps = body.length / (duration - quietUntil);
    expect(bodyNps).toBeGreaterThan(introNps);
  });

  it('leaves genuinely silent stretches empty', () => {
    const duration = 120;
    const onsets: Onset[] = [];
    // Nothing at all between 30s and 60s.
    for (let t = 0; t < duration; t += 0.25) {
      if (t >= 30 && t < 60) continue;
      onsets.push({ t, strength: 0.8, low: 0.5, mid: 0.3, high: 0.2 });
    }

    const beatGrid: number[] = [];
    for (let t = 0; t < duration; t += 0.5) beatGrid.push(t);

    const chart = generateChart(
      { duration, bpm: 120, bpmConfidence: 0.9, beatGrid, onsets },
      DIFFICULTIES.medium,
      1,
    );

    expect(chart.notes.filter((n) => n.t >= 31 && n.t < 59)).toHaveLength(0);
  });
});

describe('generateChart', () => {
  it('respects the minimum gap', () => {
    const analysis = makeAnalysis();
    for (const params of Object.values(DIFFICULTIES)) {
      const chart = generateChart(analysis, params, 1);
      // Collapse chords: they intentionally share a timestamp.
      const times = [...new Set(chart.notes.map((n) => n.t))].sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(params.minGapSec - 1e-4);
      }
    }
  });

  it('keeps every lane inside the difficulty lane count', () => {
    const analysis = makeAnalysis();
    for (const params of Object.values(DIFFICULTIES)) {
      const chart = generateChart(analysis, params, 7);
      expect(chart.laneCount).toBe(params.laneCount);
      for (const note of chart.notes) {
        expect(note.lane).toBeGreaterThanOrEqual(0);
        expect(note.lane).toBeLessThan(params.laneCount);
      }
    }
  });

  it('emits notes sorted by time', () => {
    const chart = generateChart(makeAnalysis(), DIFFICULTIES.hard, 3);
    for (let i = 1; i < chart.notes.length; i++) {
      expect(chart.notes[i]!.t).toBeGreaterThanOrEqual(chart.notes[i - 1]!.t);
    }
  });

  it('stays under the target note density', () => {
    const analysis = makeAnalysis();
    for (const params of Object.values(DIFFICULTIES)) {
      const chart = generateChart(analysis, params, 5);
      const uniqueTimes = new Set(chart.notes.map((n) => n.t)).size;
      expect(uniqueTimes).toBeLessThanOrEqual(params.targetNps * analysis.duration);
    }
  });

  it('never emits chords on easy', () => {
    const chart = generateChart(makeAnalysis(), DIFFICULTIES.easy, 11);
    const times = chart.notes.map((n) => n.t);
    expect(new Set(times).size).toBe(times.length);
  });

  it('is deterministic for a given seed', () => {
    const analysis = makeAnalysis();
    const a = generateChart(analysis, DIFFICULTIES.hard, 42);
    const b = generateChart(analysis, DIFFICULTIES.hard, 42);
    expect(a).toEqual(b);
  });

  it('routes bands to their designated lanes on easy', () => {
    // Only low-band onsets: on a 3-lane chart they must all land in lane 0.
    const analysis = makeAnalysis({
      onsets: Array.from({ length: 40 }, (_, i) => ({
        t: i * 0.5,
        strength: 0.9,
        low: 0.8,
        mid: 0.1,
        high: 0.1,
      })),
    });
    const chart = generateChart(analysis, DIFFICULTIES.easy, 1);
    expect(chart.notes.length).toBeGreaterThan(0);
    for (const note of chart.notes) expect(note.lane).toBe(0);
  });

  it('handles a song with no detected beats', () => {
    const analysis = makeAnalysis({ beatGrid: [], onsets: [] });
    const chart = generateChart(analysis, DIFFICULTIES.easy, 1);
    expect(chart.notes).toEqual([]);
  });
});

describe('generateAllCharts', () => {
  it('produces all three difficulties with increasing density', () => {
    const charts = generateAllCharts(makeAnalysis(), 'test-song');
    expect(Object.keys(charts).sort()).toEqual(['easy', 'hard', 'medium']);
    expect(charts.easy.notes.length).toBeLessThan(charts.medium.notes.length);
    expect(charts.medium.notes.length).toBeLessThan(charts.hard.notes.length);
  });
});
