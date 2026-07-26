import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FLASH_HZ, flashEffectsEnabled, flashStride, setFlashEffects } from './flash.js';

/**
 * The rate cap is the whole point, so it is asserted as a *rate* — beats per
 * second divided by the stride, checked against `MAX_FLASH_HZ` — rather than
 * against literal stride numbers. Literals would silently stop testing anything
 * the moment the threshold moved, which is the same trap the hit-window tests
 * document.
 */
function flashesPerSecond(bpm: number): number {
  const beatSec = 60 / bpm;
  const grid = Array.from({ length: 64 }, (_, i) => i * beatSec);
  return 1 / beatSec / flashStride(grid);
}

describe('flashStride', () => {
  it('holds every tempo within the flash-rate ceiling', () => {
    for (const bpm of [60, 90, 120, 140, 160, 174, 180, 200, 240, 300, 400]) {
      expect(flashesPerSecond(bpm)).toBeLessThanOrEqual(MAX_FLASH_HZ);
    }
  });

  it('leaves ordinary tempos flashing on every beat', () => {
    // Nothing at or under 3 beats/sec needs thinning, and thinning it would cost
    // the effect for no safety gain.
    const beatSec = 60 / 120;
    expect(flashStride(Array.from({ length: 32 }, (_, i) => i * beatSec))).toBe(1);
  });

  it('thins a fast song rather than letting it strobe', () => {
    const beatSec = 60 / 240; // 4 beats/sec — over the line on every beat
    expect(flashStride(Array.from({ length: 32 }, (_, i) => i * beatSec))).toBeGreaterThan(1);
  });

  it('ignores a few stretched beats around a tempo change', () => {
    // The grid is tracked, not extrapolated, so odd gaps are expected. A median
    // shrugs them off where a mean would be dragged into a different stride.
    const beatSec = 60 / 128;
    const grid = Array.from({ length: 40 }, (_, i) => i * beatSec);
    grid[20] = grid[20]! + 0.4;
    grid[21] = grid[21]! + 0.35;
    expect(flashStride(grid)).toBe(1);
  });

  it('is safe on a grid too short or too degenerate to measure', () => {
    expect(flashStride([])).toBe(1);
    expect(flashStride([1.5])).toBe(1);
    // Duplicate timestamps produce zero gaps, which would divide to Infinity.
    expect(flashStride([2, 2, 2])).toBe(1);
  });
});

describe('the player switch', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    // The module caches; start each case from a known state.
    setFlashEffects(true);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is on by default and survives a round trip', () => {
    expect(flashEffectsEnabled()).toBe(true);
    setFlashEffects(false);
    expect(flashEffectsEnabled()).toBe(false);
    setFlashEffects(true);
    expect(flashEffectsEnabled()).toBe(true);
  });
});
