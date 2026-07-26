import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The module caches its read at module scope, so — like the haptics and quality
 * tests — each case stubs `localStorage` and imports a fresh copy. That isolation
 * also means the cache itself is under test: if the setter ever stopped
 * refreshing it, the setting would appear to do nothing until a reload.
 */
async function freshScroll(stored?: string) {
  vi.resetModules();
  const store = new Map<string, string>();
  if (stored !== undefined) store.set('tap-tap.scrollSpeed', stored);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  const mod = await import('./scrollSpeed.js');
  return { ...mod, store };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('approachSecFor', () => {
  it('is the identity at 1x, so no chart changes by default', async () => {
    // The whole migration rests on this: a player who never opens the setting
    // sees precisely the game they had.
    const { approachSecFor, DEFAULT_SCROLL_SPEED } = await freshScroll();
    for (const base of [1.9, 1.6, 1.3, 0.95]) {
      expect(approachSecFor(base, DEFAULT_SCROLL_SPEED)).toBe(base);
    }
  });

  it('divides, so a higher multiplier means less time on screen', async () => {
    // "Higher is faster" is the genre convention, and getting the direction
    // backwards would pass any test that only checked the value changed.
    const { approachSecFor } = await freshScroll();
    expect(approachSecFor(1.9, 2)).toBeCloseTo(0.95, 10);
    expect(approachSecFor(0.95, 2)).toBeCloseTo(0.475, 10);
    expect(approachSecFor(1.3, 2)).toBeLessThan(approachSecFor(1.3, 1));
    expect(approachSecFor(1.3, 0.75)).toBeGreaterThan(approachSecFor(1.3, 1));
  });

  it('keeps a nonsense speed from producing a zero or negative approach', async () => {
    // A zero approach divides by zero in the highway's `zOf` and would stack
    // every note at one z; a negative one scrolls the board backwards.
    const { approachSecFor } = await freshScroll();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(approachSecFor(1.3, bad), `speed ${bad}`).toBe(1.3);
    }
  });

  it('never returns a non-positive approach for any offered speed', async () => {
    const { approachSecFor, SCROLL_SPEEDS } = await freshScroll();
    for (const speed of SCROLL_SPEEDS) {
      for (const base of [1.9, 1.6, 1.3, 0.95]) {
        expect(approachSecFor(base, speed), `${base} at ${speed}x`).toBeGreaterThan(0);
      }
    }
  });
});

describe('the offered speeds', () => {
  it('includes exactly one entry equal to the default', async () => {
    const { SCROLL_SPEEDS, DEFAULT_SCROLL_SPEED } = await freshScroll();
    expect(SCROLL_SPEEDS.filter((s) => s === DEFAULT_SCROLL_SPEED)).toHaveLength(1);
  });

  it('is sorted ascending, which the cycle order relies on', async () => {
    const { SCROLL_SPEEDS } = await freshScroll();
    for (let i = 1; i < SCROLL_SPEEDS.length; i++) {
      expect(SCROLL_SPEEDS[i]!).toBeGreaterThan(SCROLL_SPEEDS[i - 1]!);
    }
  });

  it('keeps extreme readable at the top end', async () => {
    // Extreme's 0.95s base is the tightest in the game; the fastest offered speed
    // must not take it below ~0.45s, about the floor for reading a lane and
    // reacting to it.
    const { SCROLL_SPEEDS, approachSecFor } = await freshScroll();
    const fastest = SCROLL_SPEEDS[SCROLL_SPEEDS.length - 1]!;
    expect(approachSecFor(0.95, fastest)).toBeGreaterThanOrEqual(0.45);
  });

  it('labels speeds the way the genre writes them', async () => {
    const { scrollSpeedLabel } = await freshScroll();
    expect(scrollSpeedLabel(1)).toBe('1x');
    expect(scrollSpeedLabel(1.25)).toBe('1.25x');
  });
});

describe('nextScrollSpeed', () => {
  it('advances through every offered speed and wraps', async () => {
    const { SCROLL_SPEEDS, nextScrollSpeed } = await freshScroll();
    let speed = SCROLL_SPEEDS[0]!;
    const seen = [speed];
    for (let i = 1; i < SCROLL_SPEEDS.length; i++) {
      speed = nextScrollSpeed(speed);
      seen.push(speed);
    }
    expect(seen).toEqual([...SCROLL_SPEEDS]);
    expect(nextScrollSpeed(speed)).toBe(SCROLL_SPEEDS[0]);
  });

  it('recovers to a real speed from a value that is not offered', async () => {
    const { SCROLL_SPEEDS, nextScrollSpeed } = await freshScroll();
    expect(SCROLL_SPEEDS).toContain(nextScrollSpeed(3.7));
  });
});

describe('persistence', () => {
  it('defaults to 1x with nothing stored', async () => {
    const { getScrollSpeed, DEFAULT_SCROLL_SPEED } = await freshScroll();
    expect(getScrollSpeed()).toBe(DEFAULT_SCROLL_SPEED);
  });

  it('reads back a stored speed', async () => {
    const { getScrollSpeed } = await freshScroll('1.5');
    expect(getScrollSpeed()).toBe(1.5);
  });

  it('falls back to the default for a value no longer offered', async () => {
    // Deliberately a fallback rather than a clamp to the nearest neighbour: the
    // list is a set of chosen options, and moving someone to one they did not
    // pick is worse than returning them to the default.
    for (const junk of ['0.1', '99', 'fast', '']) {
      const { getScrollSpeed, DEFAULT_SCROLL_SPEED } = await freshScroll(junk);
      expect(getScrollSpeed(), `stored ${junk}`).toBe(DEFAULT_SCROLL_SPEED);
    }
  });

  it('refreshes its cache on set, so a menu change is visible immediately', async () => {
    const { getScrollSpeed, setScrollSpeed, DEFAULT_SCROLL_SPEED, store } = await freshScroll();
    expect(getScrollSpeed()).toBe(DEFAULT_SCROLL_SPEED);
    setScrollSpeed(1.5);
    expect(getScrollSpeed()).toBe(1.5);
    expect(store.get('tap-tap.scrollSpeed')).toBe('1.5');
  });

  it('refuses to store a speed that is not offered', async () => {
    const { getScrollSpeed, setScrollSpeed, DEFAULT_SCROLL_SPEED } = await freshScroll();
    setScrollSpeed(42);
    expect(getScrollSpeed()).toBe(DEFAULT_SCROLL_SPEED);
  });

  it('survives a localStorage that throws', async () => {
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('private mode');
      },
      removeItem: () => {},
    });
    const { getScrollSpeed, setScrollSpeed, DEFAULT_SCROLL_SPEED } = await import('./scrollSpeed.js');
    expect(getScrollSpeed()).toBe(DEFAULT_SCROLL_SPEED);
    // And setting still updates the in-memory value, so the current session works
    // even though nothing persists.
    expect(() => setScrollSpeed(1.5)).not.toThrow();
    expect(getScrollSpeed()).toBe(1.5);
  });
});
