import { describe, expect, it } from 'vitest';
import { AURA_PRESETS, hueOf, pickAuraVariant, rgbFromAccent } from './aura.js';

describe('rgbFromAccent', () => {
  it('splits a hex accent into channels', () => {
    expect(rgbFromAccent(0xff3fa4)).toEqual({ r: 255, g: 63, b: 164 });
    expect(rgbFromAccent(0x000000)).toEqual({ r: 0, g: 0, b: 0 });
    expect(rgbFromAccent(0xffffff)).toEqual({ r: 255, g: 255, b: 255 });
  });
});

describe('hueOf', () => {
  it('returns the primary hues', () => {
    expect(hueOf({ r: 255, g: 0, b: 0 })).toBeCloseTo(0);
    expect(hueOf({ r: 0, g: 255, b: 0 })).toBeCloseTo(120);
    expect(hueOf({ r: 0, g: 0, b: 255 })).toBeCloseTo(240);
  });

  it('returns 0 for greys rather than NaN', () => {
    expect(hueOf({ r: 128, g: 128, b: 128 })).toBe(0);
  });

  it('places our default neon pink in the magenta range', () => {
    // #ff3fa4 — the burst threshold depends on this landing ~329°.
    expect(hueOf(rgbFromAccent(0xff3fa4))).toBeGreaterThan(300);
    expect(hueOf(rgbFromAccent(0xff3fa4))).toBeLessThan(340);
  });
});

describe('pickAuraVariant', () => {
  it('burns warm songs as embers', () => {
    expect(pickAuraVariant(0xff5a1f)).toBe('ember'); // fire orange
    expect(pickAuraVariant(0xf5c04a)).toBe('ember'); // gold
    expect(pickAuraVariant(0xe23b3b)).toBe('ember'); // red
  });

  it('explodes magenta / hot pink as a starburst', () => {
    expect(pickAuraVariant(0xff3fa4)).toBe('burst'); // our default neon pink
    expect(pickAuraVariant(0xff2e9c)).toBe('burst');
  });

  it('gives cool songs the smooth glow', () => {
    expect(pickAuraVariant(0x2ee0ff)).toBe('glow'); // cyan
    expect(pickAuraVariant(0x3f7bff)).toBe('glow'); // blue
    expect(pickAuraVariant(0x3cff9d)).toBe('glow'); // green
    expect(pickAuraVariant(0x7a4fff)).toBe('glow'); // violet
  });

  it('has a preset for every variant', () => {
    for (const v of ['ember', 'burst', 'glow'] as const) {
      expect(AURA_PRESETS[v]).toBeDefined();
      expect(AURA_PRESETS[v].spawnRate).toBeGreaterThan(0);
    }
  });
});
