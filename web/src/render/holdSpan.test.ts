import { describe, expect, it } from 'vitest';
import { holdSpan } from './highway.js';

/**
 * Geometry of a hold body over time. Pure, so it is testable without a WebGL
 * context — which matters here because the visual result is exactly the kind of
 * thing that is easy to get subtly wrong and hard to eyeball.
 */
const APPROACH = 1.6;
const AT = 10;
const DURATION = 2;

function span(songTime: number) {
  return holdSpan(AT, DURATION, songTime, APPROACH);
}

describe('holdSpan', () => {
  it('is null for a note with no duration', () => {
    expect(holdSpan(AT, 0, AT, APPROACH)).toBeNull();
    expect(holdSpan(AT, -1, AT, APPROACH)).toBeNull();
  });

  it('places the whole body ahead of the player before the head arrives', () => {
    const s = span(AT - 1)!;
    expect(s.nearZ).toBeLessThan(0);
    expect(s.farZ).toBeLessThan(s.nearZ);
  });

  it('puts the near end exactly on the hit line when the head arrives', () => {
    // `Math.abs` only to normalise -0, which `Math.min(-0, 0)` produces and
    // `toBe` distinguishes from +0. Identical for every purpose here.
    expect(Math.abs(span(AT)!.nearZ)).toBe(0);
  });

  it('clamps the near end at the hit line, so the body drains instead of sliding past', () => {
    // The defining behaviour. Midway through the hold the near end must still
    // be at the line, not somewhere behind the camera.
    const s = span(AT + DURATION / 2)!;
    expect(s.nearZ).toBe(0);
    expect(s.farZ).toBeLessThan(0);
  });

  it('shrinks monotonically while it is being held', () => {
    const lengths = [0, 0.25, 0.5, 0.75].map((f) => {
      const s = span(AT + DURATION * f)!;
      return s.nearZ - s.farZ;
    });

    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]!).toBeLessThan(lengths[i - 1]!);
    }
  });

  it('disappears once the tail reaches the line', () => {
    expect(span(AT + DURATION)).toBeNull();
    expect(span(AT + DURATION + 0.5)).toBeNull();
  });

  it('keeps a constant length until the head lands', () => {
    // The body travels at a fixed speed, so its *world* length never changes
    // while it is approaching — it only starts shrinking once the near end is
    // pinned to the hit line. (Perspective still makes it look longer as it
    // nears; that happens in projection, not here.) Asserted because the first
    // version of this test assumed it grew, which is the more intuitive and
    // wrong answer.
    const lengths = [-1.5, -1.0, -0.5, -0.2].map((offset) => {
      const s = span(AT + offset)!;
      return s.nearZ - s.farZ;
    });

    for (const length of lengths) expect(length).toBeCloseTo(lengths[0]!, 9);
  });

  it('never returns an inverted span', () => {
    for (let t = AT - APPROACH * 2; t < AT + DURATION + 1; t += 0.05) {
      const s = holdSpan(AT, DURATION, t, APPROACH);
      if (s) expect(s.nearZ, `at songTime ${t.toFixed(2)}`).toBeGreaterThan(s.farZ);
    }
  });

  it('scales with approachSec, so a slower difficulty shows more of the track', () => {
    const fast = holdSpan(AT, DURATION, AT - 0.5, 1.3)!;
    const slow = holdSpan(AT, DURATION, AT - 0.5, 1.9)!;
    // The same hold occupies less track when notes travel further per second.
    expect(slow.nearZ - slow.farZ).toBeLessThan(fast.nearZ - fast.farZ);
  });
});
