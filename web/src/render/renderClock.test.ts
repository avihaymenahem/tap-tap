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
});
