import { describe, expect, it } from 'vitest';
import { RenderClock } from './renderClock';

/**
 * The measured shape of the input: `AudioContext.currentTime` republished once
 * per 512-sample quantum at 48kHz, sampled from rAF. This is not a guess — see
 * the table in `renderClock.ts`.
 */
const QUANTUM = 512 / 48000;
const quantize = (t: number): number => Math.floor(t / QUANTUM) * QUANTUM;

/** Per-frame deltas of a series, and how far the worst one strays from the mean. */
function jitter(series: readonly number[]): { mean: number; worst: number } {
  const d: number[] = [];
  for (let i = 1; i < series.length; i++) d.push(series[i]! - series[i - 1]!);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const worst = Math.max(...d.map((x) => Math.abs(x - mean) / mean));
  return { mean, worst };
}

/** Run `frames` frames at `fps`, returning the raw and smoothed time series. */
function run(fps: number, frames: number, rate = 1): { raw: number[]; smooth: number[] } {
  const clock = new RenderClock();
  const raw: number[] = [];
  const smooth: number[] = [];
  for (let i = 0; i < frames; i++) {
    const wall = i / fps;
    const audio = quantize(wall * rate);
    raw.push(audio);
    smooth.push(clock.update(audio, wall));
  }
  // Drop the first few frames: the loop is locking on, not yet steady.
  return { raw: raw.slice(10), smooth: smooth.slice(10) };
}

describe('RenderClock', () => {
  it('starts exactly on the audio clock', () => {
    expect(new RenderClock().update(12.5, 100)).toBe(12.5);
  });

  it('removes the audio clock\'s quantisation judder at 120Hz', () => {
    const { raw, smooth } = run(120, 400);
    // The defect, restated as a number: the raw clock's per-frame advance
    // strays by more than a whole frame's worth of motion.
    expect(jitter(raw).worst).toBeGreaterThan(0.5);
    expect(jitter(smooth).worst).toBeLessThan(0.15);
  });

  it('removes it at 149Hz too, where the raw clock stalls whole frames', () => {
    const { raw, smooth } = run(149, 400);
    expect(jitter(raw).worst).toBeGreaterThan(0.9); // a frame with zero advance
    expect(jitter(smooth).worst).toBeLessThan(0.15);
  });

  it('advances at the same average rate as the audio clock', () => {
    const { raw, smooth } = run(120, 600);
    expect(jitter(smooth).mean).toBeCloseTo(jitter(raw).mean, 4);
  });

  it('never drifts away from the audio clock', () => {
    const clock = new RenderClock();
    let worst = 0;
    for (let i = 0; i < 3000; i++) {
      const wall = i / 120;
      const audio = quantize(wall);
      worst = Math.max(worst, Math.abs(clock.update(audio, wall) - audio));
    }
    expect(worst).toBeLessThan(0.012);
  });

  it('follows a speed modifier without special-casing it', () => {
    const { smooth } = run(120, 600, 0.75);
    const { mean } = jitter(smooth);
    expect(mean).toBeCloseTo(0.75 / 120, 4);
  });

  it('never steps backwards', () => {
    const clock = new RenderClock();
    let prev = -Infinity;
    for (let i = 0; i < 500; i++) {
      const v = clock.update(quantize(i / 149), i / 149);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('snaps on a restart or seek rather than sliding across it', () => {
    const clock = new RenderClock();
    for (let i = 0; i < 60; i++) clock.update(quantize(i / 120), i / 120);
    expect(clock.update(0, 60 / 120)).toBe(0);
  });

  it('creeps at most one quantum while the audio clock is stalled (paused)', () => {
    const clock = new RenderClock();
    for (let i = 0; i < 120; i++) clock.update(quantize(i / 120), i / 120);
    let v = 0;
    for (let i = 120; i < 300; i++) v = clock.update(quantize(119 / 120), i / 120);
    expect(v - quantize(119 / 120)).toBeLessThanOrEqual(0.011 + 1e-9);
  });

  it('resets to a cold lock on demand', () => {
    const clock = new RenderClock();
    for (let i = 0; i < 60; i++) clock.update(quantize(i / 120), i / 120);
    clock.reset();
    expect(clock.update(99, 999)).toBe(99);
  });

  /**
   * The intermittent stutter. A resync used to restart the rate estimator from
   * zero accumulators, which left `rate` equal to a *single* frame's ratio — of
   * a step function — for the following several frames, replaying the raw
   * staircase. The S25 measurements in CLAUDE.md record 108ms and 116ms frames
   * mid-run, each of which is past `RESYNC_SEC` and so triggered one of these
   * bursts: notes stuttering at some point in a run while the frame rate reads
   * fine.
   */
  describe('after a mid-run frame hitch', () => {
    /** Run `fps` frames with one long frame at index `at`, returning per-frame advances (ms). */
    function withHitch(hitchSec: number, fps = 120, at = 100): number[] {
      const clock = new RenderClock();
      let wall = 0;
      let prev: number | null = null;
      const advances: number[] = [];
      for (let i = 0; i < 160; i++) {
        wall += i === at ? hitchSec : 1 / fps;
        const v = clock.update(quantize(wall), wall);
        if (prev !== null) advances.push((v - prev) * 1000);
        prev = v;
      }
      return advances;
    }

    const nominal = 1000 / 120;
    // Frames straight after the hitch, skipping the long frame itself (which
    // *should* advance by a long frame's worth of song).
    const recovery = (adv: number[], at = 100): number[] => adv.slice(at, at + 8);
    const worst = (xs: number[]): number =>
      Math.max(...xs.map((x) => Math.abs(x - nominal) / nominal));

    for (const hitchMs of [108, 116, 200]) {
      it(`re-locks smoothly across a ${hitchMs}ms frame`, () => {
        const adv = recovery(withHitch(hitchMs / 1000));
        // The regression bound: the old code produced 10.67ms advances here —
        // the raw quantum, 28% over nominal — for three or four frames running.
        expect(worst(adv)).toBeLessThan(0.2);
        // And nothing freezes: every frame keeps moving.
        for (const a of adv) expect(a).toBeGreaterThan(nominal * 0.5);
      });
    }

    it('does NOT keep a rate learned while the clock was stopped', () => {
      // A frozen lead-in / a pause decays the estimator toward zero. Carrying
      // that across the resync into the run would crawl the board for the ~17
      // frames it takes to re-lock — an intermittent stutter traded for a
      // guaranteed one at every song start.
      const clock = new RenderClock();
      let wall = 0;
      // 200 frames watching a clock that never moves.
      for (let i = 0; i < 200; i++) {
        wall += 1 / 120;
        clock.update(-2, wall);
      }
      // Playback starts: a discontinuity, so a resync.
      wall += 1 / 120;
      clock.update(0, wall);
      let prev = 0;
      const advances: number[] = [];
      for (let i = 0; i < 12; i++) {
        wall += 1 / 120;
        const v = clock.update(quantize(i / 120), wall);
        advances.push((v - prev) * 1000);
        prev = v;
      }
      // Nothing crawls: the board covers a frame's worth of song per frame from
      // the off. Retaining the stalled estimate (rate ~0) leaves the smoother
      // creeping on phase feedback alone, a few percent of a frame at a time.
      const mean = advances.reduce((a, b) => a + b, 0) / advances.length;
      expect(mean).toBeGreaterThan((1000 / 120) * 0.85);
      for (const a of advances) expect(a).toBeGreaterThan(0);
    });

    it('keeps the measured rate across the resync rather than assuming 1', () => {
      // A 0.75x run: the pre-hitch rate is 0.75, and after the hitch the frames
      // must resume at 0.75x, not sprint at 1x while the estimator re-locks.
      const clock = new RenderClock();
      let wall = 0;
      let prev: number | null = null;
      const advances: number[] = [];
      for (let i = 0; i < 200; i++) {
        wall += i === 120 ? 0.12 : 1 / 120;
        const v = clock.update(quantize(wall * 0.75), wall);
        if (prev !== null) advances.push((v - prev) * 1000);
        prev = v;
      }
      const after = advances.slice(120, 128);
      const target = 0.75 * nominal;
      for (const a of after) expect(Math.abs(a - target) / target).toBeLessThan(0.25);
    });
  });

  /**
   * `MAX_ERROR_SEC` was one quantum *on the dev machine*. The publish
   * granularity belongs to the device's audio path and was never measured on
   * the S25, so the bound is learned from the clock's own steps. Without that,
   * a 40ms granularity clamps most frames and re-quantises the motion.
   */
  describe('an audio clock coarser than the dev machine', () => {
    function smoothAt(quantumSec: number, fps = 120): number {
      const clock = new RenderClock();
      const out: number[] = [];
      for (let i = 0; i < 2000; i++) {
        const wall = i / fps;
        out.push(clock.update(Math.floor(wall / quantumSec) * quantumSec, wall));
      }
      return jitter(out.slice(300)).worst;
    }

    it('still smooths a 20ms granularity', () => {
      expect(smoothAt(0.02)).toBeLessThan(0.25);
    });

    it('still smooths a 40ms granularity, where a fixed 11ms bound could not', () => {
      // Shipped constants measured 1.16 here (a 116% per-frame velocity error)
      // with 57.9% of frames hitting the clamp.
      expect(smoothAt(0.04)).toBeLessThan(0.45);
    });

    /**
     * **The monotonic guard must be dead code, and this is what proves it.**
     *
     * `if (next < this.value) next = this.value` freezes render time for a whole
     * frame whenever the clamp pulls backwards — and a freeze followed by a
     * catch-up is exactly the intermittent stutter that was reported. Reasoning
     * says it cannot fire (the upper clamp is `audioTime + maxError` and
     * `audioTime` never decreases, so it can never sit below a `value` that was
     * itself clamped there last frame; and the correction term is at most
     * `CORRECTION * maxError`, far under a frame's motion), but the guard is a
     * safety net whose failure mode is silent. So it is measured across the
     * whole plausible device matrix instead of argued.
     *
     * Simulated on the shipped constants: **zero frozen frames at every one of
     * the twenty fps/granularity combinations below**, and a worst per-frame
     * velocity error of 11.3% at any granularity an Android audio path
     * plausibly produces (<= 10.7ms).
     */
    it('never freezes a frame, at any refresh rate / granularity ratio', () => {
      for (const fps of [60, 90, 120, 144]) {
        for (const quantumSec of [128, 256, 512, 1024, 2048].map((n) => n / 48000)) {
          const clock = new RenderClock();
          const out: number[] = [];
          for (let i = 0; i < 1200; i++) {
            const wall = i / fps;
            out.push(clock.update(Math.floor(wall / quantumSec) * quantumSec, wall));
          }
          // Warm frames only; the first few are the loop locking on.
          const nominal = 1 / fps;
          for (let i = 301; i < out.length; i++) {
            const advance = out[i]! - out[i - 1]!;
            expect(
              advance,
              `frozen frame at ${fps}Hz / ${(quantumSec * 1000).toFixed(2)}ms`,
            ).toBeGreaterThan(nominal * 0.5);
          }
        }
      }
    });

    it('never freezes a frame while re-locking after a long hitch', () => {
      // The S25 logs a 108ms frame mid-run and frames over 50ms; each of those
      // is past RESYNC_SEC, so this is the path the phone actually takes.
      for (const hitchMs of [60, 90, 108, 116, 200, 350]) {
        const clock = new RenderClock();
        const quantumSec = 512 / 48000;
        let wall = 0;
        let prev: number | null = null;
        const advances: number[] = [];
        for (let i = 0; i < 400; i++) {
          wall += i === 200 ? hitchMs / 1000 : 1 / 120;
          const v = clock.update(Math.floor(wall / quantumSec) * quantumSec, wall);
          if (prev !== null) advances.push(v - prev);
          prev = v;
        }
        for (const a of advances.slice(200, 220)) {
          expect(a, `frozen frame after a ${hitchMs}ms hitch`).toBeGreaterThan(1 / 240);
        }
      }
    });

    it('never lets the renderer diverge past the ceiling', () => {
      const clock = new RenderClock();
      let worst = 0;
      for (let i = 0; i < 3000; i++) {
        const wall = i / 120;
        const audio = Math.floor(wall / 0.04) * 0.04;
        worst = Math.max(worst, Math.abs(clock.update(audio, wall) - audio));
      }
      expect(worst).toBeLessThanOrEqual(0.04 + 1e-9);
    });
  });
});
