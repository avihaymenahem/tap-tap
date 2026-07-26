import { describe, expect, it } from 'vitest';
import { EXACT_WINDOW } from './judge.js';
import {
  HISTOGRAM_BIN_SEC,
  HISTOGRAM_BINS,
  HISTOGRAM_CENTRE,
  SECTION_COUNT,
  binCentreSec,
  binForDelta,
  emptyHistogram,
  emptySections,
  histogramPeak,
  sectionAccuracies,
  sectionFor,
} from './timingStats.js';

describe('the histogram shape', () => {
  it('has an odd bin count so one bin is centred on zero', () => {
    // With an even count the origin falls on a boundary and a perfectly centred
    // distribution cannot render as centred — the whole point of the chart.
    expect(HISTOGRAM_BINS % 2).toBe(1);
    expect(HISTOGRAM_CENTRE).toBe((HISTOGRAM_BINS - 1) / 2);
  });

  it('resolves the exact window to about one bin', () => {
    // `EXACT_WINDOW` is the "dead on" threshold. A bin much wider than it would
    // hide the narrow-spike-off-centre case that means "recalibrate".
    expect(HISTOGRAM_BIN_SEC).toBeLessThanOrEqual(EXACT_WINDOW);
  });

  it('starts empty at the right length', () => {
    const h = emptyHistogram();
    expect(h).toHaveLength(HISTOGRAM_BINS);
    expect(h.every((n) => n === 0)).toBe(true);
  });
});

describe('binForDelta', () => {
  it('puts a dead-on hit in the centre bin', () => {
    expect(binForDelta(0)).toBe(HISTOGRAM_CENTRE);
  });

  it('puts early hits below centre and late hits above', () => {
    // Sign convention is the engine's: negative delta means early. Flipping this
    // would mirror the chart and invert the advice a player reads off it.
    expect(binForDelta(-0.1)).toBeLessThan(HISTOGRAM_CENTRE);
    expect(binForDelta(0.1)).toBeGreaterThan(HISTOGRAM_CENTRE);
  });

  it('is symmetric about zero', () => {
    for (const delta of [0.02, 0.05, 0.11]) {
      expect(HISTOGRAM_CENTRE - binForDelta(-delta)).toBe(binForDelta(delta) - HISTOGRAM_CENTRE);
    }
  });

  it('clamps rather than dropping a delta beyond the span', () => {
    // A hit at the edge of a wide judgement window is still a real hit; dropping it
    // would make the histogram total disagree with the hit count.
    expect(binForDelta(-99)).toBe(0);
    expect(binForDelta(99)).toBe(HISTOGRAM_BINS - 1);
  });

  it('never returns an index outside the array', () => {
    for (const delta of [-1, -0.5, -0.19, 0, 0.19, 0.5, 1]) {
      const bin = binForDelta(delta);
      expect(bin, `delta ${delta}`).toBeGreaterThanOrEqual(0);
      expect(bin, `delta ${delta}`).toBeLessThan(HISTOGRAM_BINS);
      expect(Number.isInteger(bin)).toBe(true);
    }
  });

  it('survives a non-finite delta rather than writing NaN into the array', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(binForDelta(bad)).toBe(HISTOGRAM_CENTRE);
    }
  });

  it('round-trips against binCentreSec', () => {
    for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
      expect(binForDelta(binCentreSec(bin))).toBe(bin);
    }
  });
});

describe('sectionFor', () => {
  it('spreads a song across every section', () => {
    const duration = 200;
    const seen = new Set<number>();
    for (let t = 0; t < duration; t += 1) seen.add(sectionFor(t, duration));
    expect(seen.size).toBe(SECTION_COUNT);
  });

  it('puts the start in the first section and the end in the last', () => {
    expect(sectionFor(0, 100)).toBe(0);
    expect(sectionFor(99.99, 100)).toBe(SECTION_COUNT - 1);
  });

  it('clamps a time at or past the duration into the last section', () => {
    // The outro rides past the final note, and a run can be scored slightly beyond
    // the nominal duration. That must not index off the end of the array.
    expect(sectionFor(100, 100)).toBe(SECTION_COUNT - 1);
    expect(sectionFor(500, 100)).toBe(SECTION_COUNT - 1);
  });

  it('is defensive about a zero or nonsense duration', () => {
    for (const duration of [0, -1, Number.NaN]) {
      expect(sectionFor(10, duration), `duration ${duration}`).toBe(0);
    }
    expect(sectionFor(Number.NaN, 100)).toBe(0);
  });
});

describe('sectionAccuracies', () => {
  it('reports a ratio for played sections', () => {
    const sections = emptySections();
    sections[0] = { judged: 10, earned: 300, possible: 375 };
    expect(sectionAccuracies(sections)[0]).toBeCloseTo(0.8, 6);
  });

  it('reports null — not zero — for a section with nothing in it', () => {
    // A section the chart never reached is not one the player failed. Drawing it
    // as a floor-height bar would say exactly that.
    const all = sectionAccuracies(emptySections());
    expect(all).toHaveLength(SECTION_COUNT);
    expect(all.every((v) => v === null)).toBe(true);
  });

  it('reports null rather than dividing by a zero possible', () => {
    const sections = emptySections();
    sections[3] = { judged: 4, earned: 0, possible: 0 };
    expect(sectionAccuracies(sections)[3]).toBeNull();
  });
});

describe('histogramPeak', () => {
  it('finds the tallest bar', () => {
    expect(histogramPeak([0, 3, 7, 2])).toBe(7);
  });

  it('is zero for an empty histogram, so bar heights do not become NaN', () => {
    expect(histogramPeak(emptyHistogram())).toBe(0);
  });
});
