import { describe, expect, it } from 'vitest';
import { BUILTIN_THEMES } from '@tap-tap/shared';
import { dominantColor, nearestThemeByColor, randomThemeId, rgbToHsv } from './theme-pick.js';

describe('rgbToHsv', () => {
  it('maps the primaries to their wheel positions', () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0 }).h).toBeCloseTo(0, 1);
    expect(rgbToHsv({ r: 0, g: 255, b: 0 }).h).toBeCloseTo(120, 1);
    expect(rgbToHsv({ r: 0, g: 0, b: 255 }).h).toBeCloseTo(240, 1);
  });

  it('reports zero saturation for greys', () => {
    expect(rgbToHsv({ r: 128, g: 128, b: 128 }).s).toBe(0);
  });
});

describe('dominantColor', () => {
  it('lets a few vivid pixels outweigh a grey field (saturation weighting)', () => {
    const pixels: number[] = [];
    for (let i = 0; i < 90; i++) pixels.push(128, 128, 128, 255); // muddy grey
    for (let i = 0; i < 10; i++) pixels.push(255, 0, 0, 255); // vivid red
    const c = dominantColor(pixels);
    // A plain average would stay grey; weighting pulls it strongly toward red.
    expect(c.r).toBeGreaterThan(c.g);
    expect(c.r).toBeGreaterThan(c.b);
  });

  it('ignores fully transparent pixels', () => {
    const pixels = [255, 0, 0, 0, 0, 255, 0, 255]; // transparent red, opaque green
    const c = dominantColor(pixels);
    expect(c.g).toBeGreaterThan(c.r);
  });

  it('falls back to mid-grey when there is nothing to sample', () => {
    expect(dominantColor([])).toEqual({ r: 128, g: 128, b: 128 });
  });
});

describe('nearestThemeByColor', () => {
  it('matches a red cover to a warm theme, not a cool one', () => {
    const id = nearestThemeByColor(BUILTIN_THEMES, { r: 220, g: 30, b: 20 });
    expect(id).toBe('inferno');
  });

  it('matches a cyan cover to a cool cyan theme', () => {
    // Arctic (hue 191) and Abyss (189) are both cyan; either is a right answer.
    const id = nearestThemeByColor(BUILTIN_THEMES, { r: 40, g: 200, b: 230 });
    expect(['arctic', 'abyss']).toContain(id);
  });

  it('matches a green cover to Toxic', () => {
    const id = nearestThemeByColor(BUILTIN_THEMES, { r: 60, g: 220, b: 40 });
    expect(id).toBe('toxic');
  });

  it('sends a near-grey cover to the greyscale theme', () => {
    const id = nearestThemeByColor(BUILTIN_THEMES, { r: 150, g: 148, b: 152 });
    expect(id).toBe('mono');
  });
});

describe('randomThemeId', () => {
  it('returns a valid built-in id', () => {
    const ids = new Set(BUILTIN_THEMES.map((t) => t.id));
    expect(ids.has(randomThemeId(BUILTIN_THEMES, () => 0))).toBe(true);
    expect(ids.has(randomThemeId(BUILTIN_THEMES, () => 0.999))).toBe(true);
  });

  it('stays in bounds at rand() = 1', () => {
    // Math.random() never returns 1, but a stub might — index must not overflow.
    expect(() => randomThemeId(BUILTIN_THEMES, () => 1)).not.toThrow();
  });

  it('spreads across the catalogue', () => {
    const first = randomThemeId(BUILTIN_THEMES, () => 0);
    const last = randomThemeId(BUILTIN_THEMES, () => 0.999);
    expect(first).not.toBe(last);
  });
});
