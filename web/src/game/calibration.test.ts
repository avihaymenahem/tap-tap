import { describe, expect, it } from 'vitest';
import {
  AUTO_CAL,
  MAX_LEAD_SEC,
  MIN_STORED_SEC,
  autoCalibrationStep,
  foldTapDelta,
  resolveCalibration,
} from './calibration.js';
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

describe('autoCalibrationStep', () => {
  const full = (v: number): number[] => new Array(AUTO_CAL.window).fill(v);

  it('does nothing until the window has filled', () => {
    const almost = new Array(AUTO_CAL.window - 1).fill(0.1);
    expect(autoCalibrationStep(almost, 0)).toBe(0);
  });

  it('does nothing inside the deadzone', () => {
    expect(autoCalibrationStep(full(AUTO_CAL.deadzoneSec * 0.5), 0)).toBe(0);
    expect(autoCalibrationStep(full(-AUTO_CAL.deadzoneSec * 0.5), 0)).toBe(0);
  });

  it('pulls a LATE bias back with a POSITIVE step', () => {
    // The sign that matters. hitLane judges `songTime - calibration`, so late
    // hits (positive delta) are corrected by *raising* the offset. A wrong sign
    // here would drive the game away from the beat — the exact historical bug.
    const step = autoCalibrationStep(full(0.08), 0);
    expect(step).toBeGreaterThan(0);
  });

  it('pushes an EARLY bias forward with a NEGATIVE step', () => {
    const step = autoCalibrationStep(full(-0.08), 0);
    expect(step).toBeLessThan(0);
  });

  it('never steps more than the per-step cap, however large the bias', () => {
    expect(autoCalibrationStep(full(1.0), 0)).toBeCloseTo(AUTO_CAL.maxStepSec);
    expect(autoCalibrationStep(full(-1.0), 0)).toBeCloseTo(-AUTO_CAL.maxStepSec);
  });

  it('is damped near convergence — a small residual gets a fraction of a step', () => {
    const bias = AUTO_CAL.deadzoneSec * 1.5; // just outside the deadzone
    const step = autoCalibrationStep(full(bias), 0);
    expect(step).toBeCloseTo(bias * AUTO_CAL.gain);
    expect(step).toBeLessThan(bias); // moved toward zero, not past it
  });

  it('uses the median, so one wild tap does not swing it', () => {
    const deltas = full(0.005); // a steady on-time player, inside the deadzone
    deltas[0] = 0.9; // one huge fumble
    // Median is still ~0.005, inside the deadzone → no correction.
    expect(autoCalibrationStep(deltas, 0)).toBe(0);
  });

  it('respects the total-drift budget', () => {
    // Already at the cap, still measuring late — must not push further.
    expect(autoCalibrationStep(full(0.5), AUTO_CAL.maxDriftSec)).toBeCloseTo(0);
    // Just under the cap — the step is clamped to land exactly on it.
    const drift = AUTO_CAL.maxDriftSec - AUTO_CAL.maxStepSec / 2;
    const step = autoCalibrationStep(full(0.5), drift);
    expect(drift + step).toBeCloseTo(AUTO_CAL.maxDriftSec);
  });

  it('converges a large bias over repeated windows', () => {
    // Simulate: a player 120ms late. Each window applies a capped step; the
    // residual shrinks by that step. It should reach the deadzone eventually and
    // never overshoot into a negative offset.
    let residual = 0.12;
    let drift = 0;
    for (let i = 0; i < 40 && Math.abs(residual) >= AUTO_CAL.deadzoneSec; i++) {
      const step = autoCalibrationStep(full(residual), drift);
      if (step === 0) break;
      drift += step;
      residual -= step; // raising the offset reduces the measured late bias
    }
    expect(Math.abs(residual)).toBeLessThan(AUTO_CAL.deadzoneSec);
    expect(residual).toBeGreaterThan(-AUTO_CAL.deadzoneSec); // no overshoot past zero
  });
});
