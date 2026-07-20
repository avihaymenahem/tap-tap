import type { Chart } from '@tap-tap/shared';
import { DIFFICULTIES, DIFFICULTY_NAMES } from '@tap-tap/shared';
import { describe, expect, it } from 'vitest';
import { GameEngine } from './engine.js';
import {
  EXACT_BONUS,
  EXACT_WINDOW,
  HIT_WINDOWS,
  MISS_WINDOW,
  accuracyOf,
  baseScore,
  biasAdvice,
  comboMultiplier,
  gradeFor,
  tierFor,
  timingOf,
} from './judge.js';

function chartOf(notes: [time: number, lane: number][], laneCount = 3): Chart {
  return {
    laneCount,
    notes: notes.map(([t, lane]) => ({ t, lane, type: 'tap' as const })),
  };
}

describe('tierFor', () => {
  // Expressed relative to the windows rather than as literals. The windows are
  // tuned for feel, and literals silently land on a boundary when they move —
  // which is exactly how this test broke when they were last widened.
  const midway = (inner: number, outer: number): number => (inner + outer) / 2;

  it('grades by absolute error', () => {
    expect(tierFor(0)).toBe('perfect');
    expect(tierFor(-HIT_WINDOWS.perfect / 2)).toBe('perfect');
    expect(tierFor(midway(HIT_WINDOWS.perfect, HIT_WINDOWS.great))).toBe('great');
    expect(tierFor(-midway(HIT_WINDOWS.great, HIT_WINDOWS.good))).toBe('good');
    expect(tierFor(HIT_WINDOWS.good * 1.5)).toBe('miss');
  });

  it('treats early and late symmetrically for tier', () => {
    const error = midway(HIT_WINDOWS.perfect, HIT_WINDOWS.great);
    expect(tierFor(error)).toBe(tierFor(-error));
  });

  it('places window boundaries inclusively', () => {
    expect(tierFor(HIT_WINDOWS.perfect)).toBe('perfect');
    expect(tierFor(HIT_WINDOWS.perfect + 0.001)).toBe('great');
    expect(tierFor(HIT_WINDOWS.good)).toBe('good');
  });

  it('keeps the windows ordered, with exact strictly inside perfect', () => {
    // These get retuned for feel. Ordering is what makes the tiers mean
    // anything, and an exact window wider than perfect would award the
    // precision bonus to taps that were not even perfect.
    expect(EXACT_WINDOW).toBeLessThan(HIT_WINDOWS.perfect);
    expect(HIT_WINDOWS.perfect).toBeLessThan(HIT_WINDOWS.great);
    expect(HIT_WINDOWS.great).toBeLessThan(HIT_WINDOWS.good);
    // A tap outside the widest window belongs to no note at all.
    expect(MISS_WINDOW).toBe(HIT_WINDOWS.good);
  });

  it('keeps the miss window inside the tightest note spacing any chart can have', () => {
    // The windows are a feel knob and get widened whenever fast sections feel
    // unfair. This is the ceiling on that.
    //
    // Chart spacing is enforced globally, so the smallest `minGapSec` across all
    // difficulties is the closest two notes can ever be — including two in the
    // same lane. `hitLane` resolves a tap to the *nearest* candidate, so once
    // the window is wider than that gap, a tap aimed at one note can sit closer
    // to the next one and retire it instead, leaving the intended note to miss
    // by itself. That reads as the game eating inputs, which is worse than the
    // plain miss it was widened to prevent.
    const tightest = Math.min(...DIFFICULTY_NAMES.map((name) => DIFFICULTIES[name].minGapSec));
    expect(MISS_WINDOW).toBeLessThanOrEqual(tightest);
  });
});

describe('timingOf', () => {
  it('separates exact, early, and late', () => {
    expect(timingOf(0)).toBe('exact');
    expect(timingOf(0.01)).toBe('exact');
    expect(timingOf(-0.01)).toBe('exact');
    expect(timingOf(-0.06)).toBe('early');
    expect(timingOf(0.06)).toBe('late');
  });
});

describe('baseScore', () => {
  it('pays a bonus for landing dead-on', () => {
    expect(baseScore('perfect', 'exact')).toBe(Math.round(300 * EXACT_BONUS));
    expect(baseScore('perfect', 'early')).toBe(300);
    expect(baseScore('perfect', 'late')).toBe(300);
  });

  it('scores early and late identically within a tier', () => {
    expect(baseScore('great', 'early')).toBe(baseScore('great', 'late'));
    expect(baseScore('good', 'early')).toBe(baseScore('good', 'late'));
  });

  it('scores an exact hit above an off-centre one in the same tier', () => {
    expect(baseScore('great', 'exact')).toBeGreaterThan(baseScore('great', 'late'));
  });

  it('pays nothing for a miss', () => {
    expect(baseScore('miss', 'early')).toBe(0);
  });
});

describe('comboMultiplier', () => {
  it('steps every 25 notes and caps at 4x', () => {
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(24)).toBe(1);
    expect(comboMultiplier(25)).toBe(2);
    expect(comboMultiplier(75)).toBe(4);
    expect(comboMultiplier(10_000)).toBe(4);
  });
});

describe('GameEngine hits', () => {
  it('reports an exact tap as perfect/exact', () => {
    const engine = new GameEngine(chartOf([[1, 0]]));
    const result = engine.hitLane(0, 1);
    expect(result?.tier).toBe('perfect');
    expect(result?.timing).toBe('exact');
    expect(result?.delta).toBeCloseTo(0, 5);
    expect(engine.snapshot.score).toBe(375);
  });

  it('distinguishes an early tap from a late one at the same distance', () => {
    const early = new GameEngine(chartOf([[1, 0]]));
    const earlyHit = early.hitLane(0, 0.965);

    const late = new GameEngine(chartOf([[1, 0]]));
    const lateHit = late.hitLane(0, 1.035);

    expect(earlyHit?.timing).toBe('early');
    expect(lateHit?.timing).toBe('late');
    expect(earlyHit?.delta).toBeLessThan(0);
    expect(lateHit?.delta).toBeGreaterThan(0);

    // Same tier, same points — but recorded on opposite sides.
    expect(earlyHit?.tier).toBe(lateHit?.tier);
    expect(earlyHit?.score).toBe(lateHit?.score);
    expect(early.snapshot.timingCounts.early).toBe(1);
    expect(early.snapshot.timingCounts.late).toBe(0);
    expect(late.snapshot.timingCounts.late).toBe(1);
    expect(late.snapshot.timingCounts.early).toBe(0);
  });

  it('scores an exact hit higher than an off-centre hit of the same tier', () => {
    const exact = new GameEngine(chartOf([[1, 0]]));
    exact.hitLane(0, 1);
    const offCentre = new GameEngine(chartOf([[1, 0]]));
    offCentre.hitLane(0, 1.04);

    expect(exact.snapshot.score).toBeGreaterThan(offCentre.snapshot.score);
  });

  it('grades a slightly late tap as great', () => {
    const engine = new GameEngine(chartOf([[1, 0]]));
    // Relative to the windows, not a literal. This was `1.07`, which was the
    // perfect boundary when it was written and landed *inside* perfect the next
    // time the windows were widened — the same way the tier tests broke.
    const late = (HIT_WINDOWS.perfect + HIT_WINDOWS.great) / 2;
    const result = engine.hitLane(0, 1 + late);
    expect(result?.tier).toBe('great');
    expect(result?.timing).toBe('late');
  });

  it('scores a tap that lands where the note is drawn, however large the calibration', () => {
    // The reported bug: on a phone calibrated to +280ms the renderer drew notes
    // in raw clock time while judgement ran in shifted time. The pill crossed
    // the receptor 280ms before the beat was audible, so a visually perfect tap
    // was judged 280ms early — past MISS_WINDOW, which means hitLane matched
    // nothing at all and the tap disappeared with no feedback.
    //
    // Asserted for a range of offsets because the failure only appears once the
    // calibration exceeds the miss window; a small desktop offset hid it.
    for (const calibrationSec of [0, 0.02, 0.15, 0.28, 0.4]) {
      const engine = new GameEngine(chartOf([[5, 0]]), { calibrationSec });

      // Solve for the frame where the renderer puts the note on the receptor:
      // judgementTime(songTime) === note time.
      const songTime = 5 + calibrationSec;
      expect(engine.judgementTime(songTime)).toBeCloseTo(5);

      const result = engine.hitLane(0, songTime);
      expect(result?.tier, `calibration ${calibrationSec}`).toBe('perfect');
      expect(result?.timing, `calibration ${calibrationSec}`).toBe('exact');
    }
  });

  it('ignores a tap with no note in range', () => {
    const engine = new GameEngine(chartOf([[10, 0]]));
    expect(engine.hitLane(0, 1)).toBeNull();
    expect(engine.snapshot.score).toBe(0);
  });

  it('ignores a tap in the wrong lane', () => {
    const engine = new GameEngine(chartOf([[1, 0]]));
    expect(engine.hitLane(2, 1)).toBeNull();
  });

  it('does not judge the same note twice', () => {
    const engine = new GameEngine(chartOf([[1, 0]]));
    expect(engine.hitLane(0, 1)).not.toBeNull();
    expect(engine.hitLane(0, 1.01)).toBeNull();
    expect(engine.snapshot.notesJudged).toBe(1);
  });

  it('picks the nearest note when two are close', () => {
    const engine = new GameEngine(chartOf([[1, 0], [1.12, 0]]));
    expect(engine.hitLane(0, 1.1)?.noteId).toBe(1);
  });

  it('rejects an out-of-range lane index', () => {
    const engine = new GameEngine(chartOf([[1, 0]]));
    expect(engine.hitLane(99, 1)).toBeNull();
  });
});

describe('GameEngine timing bias', () => {
  it('averages signed error so a consistent bias is visible', () => {
    const notes: [number, number][] = [[1, 0], [2, 0], [3, 0]];
    const engine = new GameEngine(chartOf(notes));
    // Always 50ms early.
    for (const [t] of notes) engine.hitLane(0, t - 0.05);

    expect(engine.snapshot.meanDelta).toBeCloseTo(-0.05, 3);
    expect(engine.snapshot.timingCounts.early).toBe(3);
  });

  it('cancels out when errors are symmetric', () => {
    const engine = new GameEngine(chartOf([[1, 0], [2, 0]]));
    engine.hitLane(0, 0.95);
    engine.hitLane(0, 2.05);
    expect(engine.snapshot.meanDelta).toBeCloseTo(0, 5);
  });

  it('advises only on a real, well-sampled bias', () => {
    expect(biasAdvice(-0.05, 20)).toMatch(/early/);
    expect(biasAdvice(0.05, 20)).toMatch(/late/);
    expect(biasAdvice(-0.05, 3)).toBeNull();
    expect(biasAdvice(0.002, 40)).toBeNull();
  });
});

describe('GameEngine misses', () => {
  it('retires notes whose window has passed', () => {
    const engine = new GameEngine(chartOf([[1, 0]]));
    expect(engine.update(1.05)).toHaveLength(0);
    expect(engine.update(2)).toHaveLength(1);
    expect(engine.snapshot.counts.miss).toBe(1);
  });

  it('does not record a miss as early or late', () => {
    const engine = new GameEngine(chartOf([[1, 0]]));
    engine.update(2);
    const { timingCounts } = engine.snapshot;
    expect(timingCounts.early + timingCounts.late + timingCounts.exact).toBe(0);
  });

  it('breaks the combo on a miss', () => {
    const engine = new GameEngine(chartOf([[1, 0], [2, 1], [3, 0]]));
    engine.hitLane(0, 1);
    engine.hitLane(1, 2);
    expect(engine.snapshot.combo).toBe(2);
    engine.update(4);
    expect(engine.snapshot.combo).toBe(0);
    expect(engine.snapshot.maxCombo).toBe(2);
  });

  it('reports finished once every note is judged', () => {
    const engine = new GameEngine(chartOf([[1, 0], [2, 1]]));
    expect(engine.snapshot.finished).toBe(false);
    engine.update(5);
    expect(engine.snapshot.finished).toBe(true);
  });
});

describe('GameEngine scoring', () => {
  it('applies the combo multiplier', () => {
    const notes: [number, number][] = Array.from({ length: 30 }, (_, i) => [i * 0.5 + 1, 0]);
    const engine = new GameEngine(chartOf(notes));
    for (const [t] of notes) engine.hitLane(0, t);

    // Exact perfects are 375; the first 24 at 1x, the remainder at 2x.
    expect(engine.snapshot.score).toBe(24 * 375 + 6 * 750);
    expect(engine.snapshot.combo).toBe(30);
  });

  it('computes accuracy from the tier mix, ignoring the exact bonus', () => {
    expect(accuracyOf({ perfect: 1, great: 0, good: 0, miss: 0 })).toBe(1);
    expect(accuracyOf({ perfect: 0, great: 0, good: 0, miss: 1 })).toBe(0);
    expect(accuracyOf({ perfect: 1, great: 0, good: 0, miss: 1 })).toBeCloseTo(0.5, 5);
    expect(accuracyOf({ perfect: 0, great: 0, good: 0, miss: 0 })).toBe(1);
  });

  it('reaches 100% accuracy without every hit being exact', () => {
    const notes: [number, number][] = [[1, 0], [2, 0]];
    const engine = new GameEngine(chartOf(notes));
    engine.hitLane(0, 1.04); // perfect tier, but late
    engine.hitLane(0, 2.04);
    expect(engine.snapshot.accuracy).toBe(1);
    expect(engine.snapshot.timingCounts.late).toBe(2);
  });

  it('maps accuracy to a grade', () => {
    expect(gradeFor(1)).toBe('S');
    expect(gradeFor(0.92)).toBe('A');
    expect(gradeFor(0.5)).toBe('F');
  });
});

describe('GameEngine calibration', () => {
  it('shifts the judgement window by the calibration offset', () => {
    // A player who taps 60ms late everywhere is corrected by a +60ms offset.
    const engine = new GameEngine(chartOf([[1, 0]]), { calibrationSec: 0.06 });
    const result = engine.hitLane(0, 1.06);
    expect(result?.tier).toBe('perfect');
    expect(result?.timing).toBe('exact');
  });
});

describe('GameEngine visibleNotes', () => {
  it('returns only notes inside the approach window', () => {
    const engine = new GameEngine(chartOf([[1, 0], [2, 1], [10, 2]]));
    expect(engine.visibleNotes(0, 2.5).map((v) => v.id)).toEqual([0, 1]);
  });

  it('drops notes once they are hit', () => {
    const engine = new GameEngine(chartOf([[1, 0], [2, 1]]));
    engine.hitLane(0, 1);
    expect(engine.visibleNotes(0.5, 3).map((v) => v.id)).toEqual([1]);
  });

  it('keeps missed notes visible so they can fall past the line', () => {
    const engine = new GameEngine(chartOf([[1, 0]]));
    engine.update(2);
    expect(engine.visibleNotes(0.9, 1).map((v) => v.id)).toEqual([0]);
  });

  it('handles an empty chart', () => {
    const engine = new GameEngine(chartOf([]));
    expect(engine.visibleNotes(0, 2)).toEqual([]);
    expect(engine.snapshot.finished).toBe(true);
  });
});
