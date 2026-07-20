import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HapticMode } from './haptics.js';

/**
 * The module keeps throttle state at module scope, so each test imports a fresh
 * copy after stubbing the globals it reads.
 */
async function freshHaptics(options: { supported: boolean; mode?: HapticMode }) {
  vi.resetModules();

  const vibrate = vi.fn<(pattern: number | number[]) => boolean>(() => true);
  vi.stubGlobal('navigator', options.supported ? { vibrate } : {});

  const store = new Map<string, string>();
  if (options.mode) store.set('tap-tap.hapticMode', options.mode);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });

  const mod = await import('./haptics.js');
  return { ...mod, vibrate };
}

beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('modes', () => {
  it('defaults to hits', async () => {
    const h = await freshHaptics({ supported: true });
    expect(h.getHapticMode()).toBe('hits');
  });

  it('cycles off → hits → misses → off', async () => {
    const h = await freshHaptics({ supported: true });
    expect(h.nextHapticMode('off')).toBe('hits');
    expect(h.nextHapticMode('hits')).toBe('misses');
    expect(h.nextHapticMode('misses')).toBe('off');
  });

  it('falls back to the default for a corrupt stored value', async () => {
    const h = await freshHaptics({ supported: true, mode: 'nonsense' as HapticMode });
    expect(h.getHapticMode()).toBe('hits');
  });
});

describe('vibrateTap', () => {
  it('fires on every tap, identically', async () => {
    const h = await freshHaptics({ supported: true, mode: 'hits' });

    h.vibrateTap();
    h.vibrateTap();
    h.vibrateTap();

    const patterns = h.vibrate.mock.calls.map((c) => c[0]);
    expect(patterns).toHaveLength(3);
    // Uniform on purpose: a worse hit must not produce a bigger buzz, and the
    // motor cannot render differences that fine anyway.
    expect(new Set(patterns).size).toBe(1);
  });

  it('is never throttled — feedback that appears only sometimes reads as late', async () => {
    const h = await freshHaptics({ supported: true, mode: 'hits' });
    for (let i = 0; i < 8; i++) h.vibrateTap();
    expect(h.vibrate).toHaveBeenCalledTimes(8);
  });

  it('is silent in misses mode and when off', async () => {
    const misses = await freshHaptics({ supported: true, mode: 'misses' });
    misses.vibrateTap();
    expect(misses.vibrate).not.toHaveBeenCalled();

    const off = await freshHaptics({ supported: true, mode: 'off' });
    off.vibrateTap();
    expect(off.vibrate).not.toHaveBeenCalled();
  });

  it('is a no-op where the device cannot vibrate', async () => {
    const h = await freshHaptics({ supported: false, mode: 'hits' });
    expect(() => h.vibrateTap()).not.toThrow();
    expect(h.hapticsSupported()).toBe(false);
  });
});

describe('vibrateMiss', () => {
  it('is silent in hits mode and when off', async () => {
    const hits = await freshHaptics({ supported: true, mode: 'hits' });
    hits.vibrateMiss();
    expect(hits.vibrate).not.toHaveBeenCalled();

    const off = await freshHaptics({ supported: true, mode: 'off' });
    off.vibrateMiss();
    expect(off.vibrate).not.toHaveBeenCalled();
  });

  it('uses a longer pulse than a tap, so the two cannot be confused', async () => {
    const hits = await freshHaptics({ supported: true, mode: 'hits' });
    hits.vibrateTap();
    const tapPulse = hits.vibrate.mock.calls[0]?.[0] as number;

    const misses = await freshHaptics({ supported: true, mode: 'misses' });
    misses.vibrateMiss();
    const missPulse = misses.vibrate.mock.calls[0]?.[0] as number;

    expect(missPulse).toBeGreaterThan(tapPulse);
  });

  it('collapses a burst of misses into one buzz', async () => {
    const h = await freshHaptics({ supported: true, mode: 'misses' });
    for (let i = 0; i < 6; i++) h.vibrateMiss();
    expect(h.vibrate).toHaveBeenCalledTimes(1);
  });

  it('allows another miss once the throttle window has passed', async () => {
    const h = await freshHaptics({ supported: true, mode: 'misses' });

    h.vibrateMiss();
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    h.vibrateMiss();

    expect(h.vibrate).toHaveBeenCalledTimes(2);
  });
});
