import { describe, expect, it } from 'vitest';
import { MAX_LEAD_SEC, MIN_STORED_SEC, foldTapDelta, resolveCalibration } from './calibration.js';
import { MISS_WINDOW } from './judge.js';

describe('foldTapDelta', () => {
  // 120 BPM — the rate the calibration screen originally ran at, and the one
  // that produced the bad reading.
  const FAST = 0.5;

  it('leaves a small late tap alone', () => {
    expect(foldTapDelta(0.04, FAST)).toBeCloseTo(0.04);
  });

  it('reads a small early tap as anticipation', () => {
    expect(foldTapDelta(-0.05, FAST)).toBeCloseTo(-0.05);
    expect(foldTapDelta(-MAX_LEAD_SEC / 2, FAST)).toBeCloseTo(-MAX_LEAD_SEC / 2);
  });

  it('recovers a Bluetooth-scale latency that nearest-click matching flips', () => {
    // The reported bug. A 300ms-late tap is nearer the *next* click at 120 BPM,
    // so nearest-click matching measured it as 200ms early and the screen
    // offered to store -200ms.
    expect(foldTapDelta(-0.2, FAST)).toBeCloseTo(0.3);
    expect(foldTapDelta(-0.25, FAST)).toBeCloseTo(0.25);
  });

  it('never returns a lead longer than a player could plausibly anticipate', () => {
    for (const delta of [-0.49, -0.3, -0.2, -0.13, 0, 0.1, 0.37, 0.6, 1.2]) {
      const folded = foldTapDelta(delta, FAST);
      expect(folded).toBeGreaterThanOrEqual(-MAX_LEAD_SEC);
      expect(folded).toBeLessThan(FAST - MAX_LEAD_SEC);
    }
  });

  it('survives taps more than a whole period out', () => {
    // Folding, not clamping: a tap a full beat late is the same phase as an
    // on-time one and must not be recorded as a huge latency.
    expect(foldTapDelta(FAST + 0.04, FAST)).toBeCloseTo(0.04);
    expect(foldTapDelta(-FAST - 0.05, FAST)).toBeCloseTo(-0.05);
  });

  it('measures further before wrapping when the metronome is slower', () => {
    // Why the screen dropped to 90 BPM: the usable range is the period minus
    // the lead allowance, so a slow click is what makes 300ms+ measurable.
    const slow = 60 / 90;
    expect(foldTapDelta(0.42, slow)).toBeCloseTo(0.42);
    // The same reading at 120 BPM has already wrapped into anticipation.
    expect(foldTapDelta(0.42, FAST)).toBeLessThan(0);
  });
});

describe('resolveCalibration', () => {
  it('uses the hardware latency when the device was never calibrated', () => {
    expect(resolveCalibration(null, 0.18)).toBeCloseTo(0.18);
  });

  it('prefers a stored value over the hardware reading', () => {
    // Calibrating by ear already measures the output latency. Adding it again
    // would double-count and push every note the other way.
    expect(resolveCalibration(0.04, 0.18)).toBeCloseTo(0.04);
  });

  it('respects a deliberate zero', () => {
    // The bug this guards: treating "calibrated to 0" as "never calibrated"
    // would silently re-apply latency the player explicitly tuned out.
    expect(resolveCalibration(0, 0.18)).toBe(0);
  });

  it('keeps a stored negative offset — players can genuinely tap early', () => {
    expect(resolveCalibration(-0.03, 0.18)).toBeCloseTo(-0.03);
  });

  it('floors a stored offset that would make every tap unhittable', () => {
    // The reported bug: the old metronome aliasing stored -200ms, which shifts
    // every tap 200ms later than it landed — past the miss window, so hitLane
    // matches nothing and the whole song reads as 100% miss.
    expect(resolveCalibration(-0.2, 0)).toBe(MIN_STORED_SEC);
  });

  it('never floors a large positive offset', () => {
    // Bluetooth genuinely runs to 300ms. Clamping these would break the exact
    // players this whole feature exists for.
    expect(resolveCalibration(0.3, 0)).toBeCloseTo(0.3);
  });

  it('keeps the floor inside the miss window', () => {
    // The invariant that matters, tied to the judge rather than restated: a
    // resolvable calibration must never on its own push a dead-on tap out of
    // range. Both numbers are feel knobs and get retuned independently.
    expect(Math.abs(MIN_STORED_SEC)).toBeLessThan(MISS_WINDOW);
  });

  it('ignores implausible or missing hardware readings', () => {
    // Shifting every note by a wrong constant is indistinguishable from a
    // broken chart, so a bad reading must fall back to no compensation.
    expect(resolveCalibration(null, 3)).toBe(0);
    expect(resolveCalibration(null, Number.NaN)).toBe(0);
    expect(resolveCalibration(null, -0.2)).toBe(0);
    expect(resolveCalibration(null, 0)).toBe(0);
  });
});
