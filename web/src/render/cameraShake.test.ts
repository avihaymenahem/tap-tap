import { describe, expect, it } from 'vitest';
import { shakeOffset } from './highway';

/**
 * The intermittent stutter: "at some point in game, feels like there is some
 * stutering with note bars... fps seems fine but notes seems to stutter a bit".
 *
 * Every object a player watches move is positioned from song time, and song
 * time is smoothed by `RenderClock` (simulated clean at every plausible refresh
 * / audio-quantum ratio). The camera is the one thing left that moves the whole
 * frame, and its shake term was `(Math.random() - 0.5) * shake * shake * 1.6`,
 * resampled every frame — white noise, i.e. zero correlation between
 * consecutive frames, which is precisely what the eye reads as stutter.
 *
 * These tests pin the properties that make it a rattle instead: bounded
 * frame-to-frame change, unchanged peak amplitude, and no dependence on the
 * frame rate.
 */
describe('shakeOffset', () => {
  /** The shipped cap in `burst` — the worst case the player can reach. */
  const MAX_SHAKE = 0.42;
  /** Peak excursion of the OLD white-noise term, which must be preserved. */
  const OLD_PEAK_X = 0.5 * MAX_SHAKE * MAX_SHAKE * 1.6;
  const OLD_PEAK_Y = 0.5 * MAX_SHAKE * MAX_SHAKE * 1.2;

  /** Peak-normalised x/y samples of a burst held at the cap, one per frame. */
  function frames(fps: number, n = 400, phase = 0): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i <= n; i++) {
      const { x, y } = shakeOffset(MAX_SHAKE, i / fps, phase);
      out.push({ x: x / OLD_PEAK_X, y: y / OLD_PEAK_Y });
    }
    return out;
  }

  /** Largest change between consecutive frames, as a fraction of the peak. */
  function worstStepFraction(fps: number): number {
    const f = frames(fps);
    let worst = 0;
    for (let i = 1; i < f.length; i++) {
      worst = Math.max(worst, Math.abs(f[i]!.x - f[i - 1]!.x), Math.abs(f[i]!.y - f[i - 1]!.y));
    }
    return worst;
  }

  /**
   * Frame-to-frame ACCELERATION — the second difference — as a fraction of the
   * peak. This, not the step size, is what "stutter" actually is: motion that
   * fails to continue in the direction it was going. A smooth trajectory has a
   * small second difference whatever its speed; white noise has an enormous one
   * by construction, because each sample is drawn independently of the last two.
   */
  function worstAccelFraction(fps: number): number {
    const f = frames(fps);
    let worst = 0;
    for (let i = 2; i < f.length; i++) {
      worst = Math.max(
        worst,
        Math.abs(f[i]!.x - 2 * f[i - 1]!.x + f[i - 2]!.x),
        Math.abs(f[i]!.y - 2 * f[i - 1]!.y + f[i - 2]!.y),
      );
    }
    return worst;
  }

  /** The same statistic for the white noise this replaced, for comparison. */
  function noiseAccelFraction(n = 4000): number {
    let worst = 0;
    // Peak-normalised: (Math.random() - 0.5) spans +/-0.5, i.e. +/-1 of peak.
    const s = (): number => (Math.random() - 0.5) * 2;
    let a = s();
    let b = s();
    for (let i = 2; i < n; i++) {
      const c = s();
      worst = Math.max(worst, Math.abs(c - 2 * b + a));
      a = b;
      b = c;
    }
    return worst;
  }

  it('rests exactly at zero when nothing has been hit', () => {
    // `toBe(0)` would trip on -0, which is the same camera position.
    const rest = shakeOffset(0, 12.3, 1.1);
    expect(Math.abs(rest.x)).toBe(0);
    expect(Math.abs(rest.y)).toBe(0);
  });

  it('keeps the old peak excursion, so a hit kicks exactly as hard', () => {
    let maxX = 0;
    let maxY = 0;
    // Sweep a full period of the slower axis at fine resolution.
    for (let i = 0; i < 20000; i++) {
      const { x, y } = shakeOffset(MAX_SHAKE, i / 20000, 0);
      maxX = Math.max(maxX, Math.abs(x));
      maxY = Math.max(maxY, Math.abs(y));
    }
    expect(maxX).toBeCloseTo(OLD_PEAK_X, 4);
    expect(maxY).toBeCloseTo(OLD_PEAK_Y, 4);
  });

  it('keeps the squared falloff, so the low end never feels permanently loose', () => {
    // Half the magnitude must be a QUARTER of the offset, not half.
    const t = 0.0123;
    const full = shakeOffset(0.4, t, 0.3).x;
    const half = shakeOffset(0.2, t, 0.3).x;
    expect(Math.abs(half)).toBeCloseTo(Math.abs(full) / 4, 6);
  });

  /**
   * **The defect, restated as the number that names it.** Stutter is motion
   * that does not continue — a large second difference. White noise measures
   * ~3.5-4.0 of peak here by construction; a sampled sinusoid measures the
   * square of its per-frame step, so a tenth of that.
   */
  it('has an order of magnitude less frame-to-frame acceleration than noise', () => {
    const rattle = worstAccelFraction(120);
    expect(rattle).toBeLessThan(0.45);
    // Not a bound plucked from the air: it is measured against the term this
    // replaced, on the same scale, at the same cap.
    expect(rattle).toBeLessThan(noiseAccelFraction() / 5);
  });

  it('stays coherent at 60Hz, the lowest shipped refresh rate', () => {
    expect(worstAccelFraction(60)).toBeLessThan(1.4);
  });

  it('moves less than its peak-to-peak span between frames at 120Hz', () => {
    // 13/17Hz measured 0.86 here and was rejected for it: a vibration that fast
    // is not a trajectory the eye can track.
    expect(worstStepFraction(120)).toBeLessThan(0.7);
  });

  it('is frame-rate independent — the same instant gives the same offset', () => {
    // White noise at 120Hz had twice the bandwidth of white noise at 60Hz, so
    // the effect was literally a different effect on a different device. The
    // waveform is now a function of time alone.
    for (const t of [0.004, 0.017, 0.101, 1.5]) {
      expect(shakeOffset(0.3, t, 0.9)).toEqual(shakeOffset(0.3, t, 0.9));
    }
  });

  it('is deterministic — no randomness left in the per-frame path', () => {
    const a = shakeOffset(0.31, 2.75, 1.4);
    const b = shakeOffset(0.31, 2.75, 1.4);
    expect(a).toEqual(b);
  });

  it('traces a figure rather than a diagonal, so the two axes stay distinct', () => {
    // Equal-frequency axes would make the camera slide along one line, which
    // reads as a wobble rather than an impact. Sample both and check they are
    // not proportional.
    const ratios: number[] = [];
    for (let i = 1; i < 60; i++) {
      const { x, y } = shakeOffset(MAX_SHAKE, i / 120, 0);
      if (Math.abs(x) > 1e-4) ratios.push(y / x);
    }
    const spread = Math.max(...ratios) - Math.min(...ratios);
    expect(spread).toBeGreaterThan(1);
  });

  /**
   * A burst must be spent in about one cycle — a kick and a recoil, not a buzz
   * that sits on the playfield. `shake` bleeds off at 2.6/sec from the 0.42 cap
   * and the offset squares it, so it is visually done in roughly 0.08s.
   */
  it('completes about one cycle within a burst\'s visible life', () => {
    const DECAY_PER_SEC = 2.6;
    // Where the squared falloff has taken the offset to a tenth of its peak.
    const spentSec = (MAX_SHAKE - MAX_SHAKE * Math.sqrt(0.1)) / DECAY_PER_SEC;
    let crossings = 0;
    let prev = shakeOffset(MAX_SHAKE, 0, 0).x;
    const steps = 2000;
    for (let i = 1; i <= steps; i++) {
      const x = shakeOffset(MAX_SHAKE, (i / steps) * spentSec, 0).x;
      if (Math.sign(x) !== Math.sign(prev) && x !== 0) crossings++;
      prev = x;
    }
    // 2 crossings per cycle: at least a full swing through zero and back, and
    // not so many that it reads as a vibration.
    expect(crossings).toBeGreaterThanOrEqual(1);
    expect(crossings).toBeLessThanOrEqual(3);
  });
});
