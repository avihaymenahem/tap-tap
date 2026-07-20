import { describe, expect, it } from 'vitest';
import { type LaneMotion, pickLaneContour } from './lanes.js';

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
