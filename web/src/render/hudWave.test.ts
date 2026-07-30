import { describe, expect, it } from 'vitest';
import { comboMeter, easeBars, spectrumBars, MULTIPLIER_STEPS } from './hudWave.js';

describe('comboMeter', () => {
  it('starts at x1 with no combo', () => {
    expect(comboMeter(0)).toEqual({ multiplier: 1, progress: 0 });
  });

  it('steps on every ladder rung', () => {
    for (let i = 1; i < MULTIPLIER_STEPS.length; i++) {
      const at = MULTIPLIER_STEPS[i] as number;
      expect(comboMeter(at).multiplier).toBe(i + 1);
      expect(comboMeter(at - 1).multiplier).toBe(i);
    }
  });

  it('fills the arc across a rung', () => {
    // Rung 1 spans combo 0..10.
    expect(comboMeter(5).progress).toBeCloseTo(0.5, 5);
    expect(comboMeter(9).progress).toBeCloseTo(0.9, 5);
  });

  it('pins the arc full at the top rung, at any combo', () => {
    const top = MULTIPLIER_STEPS.length;
    expect(comboMeter(100)).toEqual({ multiplier: top, progress: 1 });
    expect(comboMeter(9999)).toEqual({ multiplier: top, progress: 1 });
  });
});

describe('spectrumBars', () => {
  it('reads zero from silence', () => {
    const out = spectrumBars(new Uint8Array(512), new Float32Array(32));
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it('normalises a pegged spectrum to 1', () => {
    const spec = new Uint8Array(512).fill(255);
    const out = spectrumBars(spec, new Float32Array(32));
    expect(Array.from(out).every((v) => v > 0.99)).toBe(true);
  });

  /*
   * The exponential mapping is the whole reason this is not a one-liner: energy
   * placed in the low bins must land in the low bars and leave the high ones dark.
   */
  it('puts low-frequency energy in the low bars', () => {
    const spec = new Uint8Array(512);
    for (let i = 1; i < 12; i++) spec[i] = 255;
    const out = spectrumBars(spec, new Float32Array(32));
    expect(out[0]).toBeGreaterThan(0.5);
    expect(out[31]).toBe(0);
  });

  it('ignores the inaudible top of the array', () => {
    const spec = new Uint8Array(512);
    spec.fill(255, 480);
    const out = spectrumBars(spec, new Float32Array(32));
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it('never reads bin 0, which is DC and would peg the first bar', () => {
    const spec = new Uint8Array(512);
    spec[0] = 255;
    const out = spectrumBars(spec, new Float32Array(32));
    expect(out[0]).toBe(0);
  });
});

describe('easeBars', () => {
  it('attacks faster than it releases', () => {
    const rising = new Float32Array([0]);
    easeBars(rising, new Float32Array([1]));
    const falling = new Float32Array([1]);
    easeBars(falling, new Float32Array([0]));
    expect(rising[0] as number).toBeGreaterThan(1 - (falling[0] as number));
  });

  it('converges on the target', () => {
    const cur = new Float32Array([0]);
    for (let i = 0; i < 60; i++) easeBars(cur, new Float32Array([0.8]));
    expect(cur[0]).toBeCloseTo(0.8, 3);
  });
});
