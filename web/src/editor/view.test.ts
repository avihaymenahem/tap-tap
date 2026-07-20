import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEWPORT,
  clampCursor,
  laneAtX,
  laneGeometry,
  timeToY,
  visibleRange,
  yToTime,
  type Viewport,
} from './view.js';

const HEIGHT = 800;
const WIDTH = 600;
const view: Viewport = { cursor: 10, ...DEFAULT_VIEWPORT };

describe('timeToY', () => {
  it('puts the cursor at the playhead', () => {
    expect(timeToY(10, view, HEIGHT)).toBeCloseTo(HEIGHT * 0.78, 5);
  });

  it('places later times higher on screen', () => {
    expect(timeToY(11, view, HEIGHT)).toBeLessThan(timeToY(10, view, HEIGHT));
  });

  it('scales with zoom', () => {
    const zoomed: Viewport = { ...view, pixelsPerSecond: 300 };
    const oneSecond = timeToY(10, view, HEIGHT) - timeToY(11, view, HEIGHT);
    const zoomedSecond = timeToY(10, zoomed, HEIGHT) - timeToY(11, zoomed, HEIGHT);
    expect(zoomedSecond).toBeCloseTo(oneSecond * 2, 5);
  });
});

describe('yToTime', () => {
  it('inverts timeToY', () => {
    for (const t of [0, 5, 10, 12.345, 200]) {
      expect(yToTime(timeToY(t, view, HEIGHT), view, HEIGHT)).toBeCloseTo(t, 6);
    }
  });
});

describe('visibleRange', () => {
  it('brackets the cursor with more ahead than behind', () => {
    const { from, to } = visibleRange(view, HEIGHT);
    expect(from).toBeLessThan(view.cursor);
    expect(to).toBeGreaterThan(view.cursor);
    expect(to - view.cursor).toBeGreaterThan(view.cursor - from);
  });
});

describe('laneGeometry', () => {
  it('tiles lanes without gaps or overlap', () => {
    const gutter = 100;
    const lanes = [0, 1, 2, 3].map((l) => laneGeometry(l, 4, WIDTH, gutter));

    expect(lanes[0]!.x).toBe(gutter);
    for (let i = 1; i < lanes.length; i++) {
      expect(lanes[i]!.x).toBeCloseTo(lanes[i - 1]!.x + lanes[i - 1]!.width, 6);
    }
    const last = lanes[3]!;
    expect(last.x + last.width).toBeCloseTo(WIDTH, 6);
  });
});

describe('laneAtX', () => {
  const gutter = 100;

  it('is the inverse of laneGeometry', () => {
    for (const lane of [0, 1, 2, 3, 4]) {
      const { x, width } = laneGeometry(lane, 5, WIDTH, gutter);
      expect(laneAtX(x + width / 2, 5, WIDTH, gutter)).toBe(lane);
    }
  });

  it('returns null over the waveform gutter', () => {
    expect(laneAtX(10, 4, WIDTH, gutter)).toBeNull();
    expect(laneAtX(gutter - 1, 4, WIDTH, gutter)).toBeNull();
  });

  it('returns null past the right edge', () => {
    expect(laneAtX(WIDTH + 50, 4, WIDTH, gutter)).toBeNull();
  });
});

describe('clampCursor', () => {
  it('allows a little lead-in but not beyond the track', () => {
    expect(clampCursor(-99, 120)).toBe(-1);
    expect(clampCursor(50, 120)).toBe(50);
    expect(clampCursor(999, 120)).toBe(120);
  });
});
