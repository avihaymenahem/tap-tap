import { describe, expect, it } from 'vitest';
import { type LaneMotion, laneRangesByPopulation, pickLaneContour } from './lanes.js';

describe('laneRangesByPopulation', () => {
  it('reproduces the kit-mirror for a balanced song', () => {
    // Unchanged behaviour for the case the fixed split was designed for.
    const r = laneRangesByPopulation(4, { low: 30, mid: 40, high: 30 });
    expect(r.low).toEqual([0]);
    expect(r.mid).toEqual([1, 2]);
    expect(r.high).toEqual([3]);
  });

  it('gives a dominant band more lanes so it cannot pile on one', () => {
    // The fix: an ~85%-high song spreads across two lanes instead of one.
    const r = laneRangesByPopulation(4, { low: 7, mid: 13, high: 80 });
    expect(r.high.length).toBeGreaterThanOrEqual(2);
    // Ordering preserved: bass left, treble right, contiguous, no gaps.
    expect([...r.low, ...r.mid, ...r.high]).toEqual([0, 1, 2, 3]);
  });

  it('hands the whole board to a single-band song', () => {
    const r = laneRangesByPopulation(4, { low: 0, mid: 0, high: 100 });
    expect(r.high).toEqual([0, 1, 2, 3]);
    expect(r.low).toEqual([]);
    expect(r.mid).toEqual([]);
  });

  it('keeps every present band on at least one lane', () => {
    const r = laneRangesByPopulation(4, { low: 1, mid: 1, high: 98 });
    expect(r.low.length).toBeGreaterThanOrEqual(1);
    expect(r.mid.length).toBeGreaterThanOrEqual(1);
    expect(r.high.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the fixed split when there are no onsets', () => {
    expect(laneRangesByPopulation(4, { low: 0, mid: 0, high: 0 })).toEqual({
      low: [0],
      mid: [1, 2],
      high: [3],
    });
  });
});

describe('pickLaneContour', () => {
  const mid = [1, 2, 3] as const;

  it('returns the only lane of a single-lane range', () => {
    const motion: LaneMotion = { direction: 1 };
    expect(pickLaneContour([0], null, 0.9, motion)).toBe(0);
  });

  it('follows a rising contour across the range', () => {
    const motion: LaneMotion = { direction: 1 };
    let lane: number | null = null;
    const lanes: number[] = [];
    for (const contour of [0.1, 0.5, 0.9]) {
      lane = pickLaneContour(mid, lane, contour, motion);
      lanes.push(lane);
    }
    expect(lanes).toEqual([1, 2, 3]);
  });

  it('never repeats a lane when the range allows movement', () => {
    // A flat contour is the jackhammer trap: the ideal lane is the same every
    // time, and a human chart would roll instead.
    const motion: LaneMotion = { direction: 1 };
    let lane: number | null = null;
    for (let i = 0; i < 20; i++) {
      const next = pickLaneContour(mid, lane, 0.5, motion);
      expect(next).not.toBe(lane);
      lane = next;
    }
  });

  it('bounces at the range edges instead of walking out', () => {
    const motion: LaneMotion = { direction: 1 };
    let lane: number | null = null;
    const lanes: number[] = [];
    for (let i = 0; i < 8; i++) {
      lane = pickLaneContour(mid, lane, 0.99, motion);
      lanes.push(lane);
    }
    for (const l of lanes) {
      expect(l).toBeGreaterThanOrEqual(1);
      expect(l).toBeLessThanOrEqual(3);
    }
    // Pinned to the top of the range, a stream must oscillate off it and back.
    expect(lanes.slice(0, 4)).toEqual([3, 2, 3, 2]);
  });

  it('is unaffected by a previous lane outside the range', () => {
    // The previous note belonged to another band; its lane must not derail the
    // contour mapping here.
    const motion: LaneMotion = { direction: 1 };
    expect(pickLaneContour(mid, 0, 0.1, motion)).toBe(1);
  });
});
