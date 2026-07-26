import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The module caches its reads, so each case stubs `localStorage` and imports a
 * fresh copy — the same pattern the haptics, quality and scroll-speed tests use.
 */
async function freshMixer(stored: Record<string, string> = {}) {
  vi.resetModules();
  const store = new Map<string, string>(Object.entries(stored));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return { ...(await import('./mixer.js')), store };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('levels', () => {
  it('defaults both to full, so nothing sounds different until asked', async () => {
    const m = await freshMixer();
    expect(m.musicLevel()).toBe(1);
    expect(m.sfxLevel()).toBe(1);
  });

  it('offers full volume as the head of each cycle', async () => {
    const m = await freshMixer();
    expect(m.MUSIC_LEVELS[0]).toBe(1);
    expect(m.SFX_LEVELS[0]).toBe(1);
  });

  it('descends, so cycling reads as turning it down', async () => {
    const m = await freshMixer();
    for (const levels of [m.MUSIC_LEVELS, m.SFX_LEVELS]) {
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i]!).toBeLessThan(levels[i - 1]!);
      }
    }
  });

  it('lets effects go fully off but never the music', async () => {
    const m = await freshMixer();
    // Silencing effects is a real preference. Silencing the music would leave a
    // rhythm game with nothing to play to — that is what the phone's own volume
    // keys are for.
    expect(m.SFX_LEVELS).toContain(0);
    expect(Math.min(...m.MUSIC_LEVELS)).toBeGreaterThan(0);
  });

  it('reads back stored levels', async () => {
    const m = await freshMixer({ 'tap-tap.musicLevel': '0.7', 'tap-tap.sfxLevel': '0' });
    expect(m.musicLevel()).toBe(0.7);
    expect(m.sfxLevel()).toBe(0);
  });

  it('falls back to full for a level no longer offered', async () => {
    for (const junk of ['0.123', '9', 'loud', '']) {
      const m = await freshMixer({ 'tap-tap.musicLevel': junk });
      expect(m.musicLevel(), `stored ${junk}`).toBe(1);
    }
  });

  it('refreshes the cache on set, so a menu change applies at once', async () => {
    const m = await freshMixer();
    m.setMusicLevel(0.45);
    expect(m.musicLevel()).toBe(0.45);
    expect(m.store.get('tap-tap.musicLevel')).toBe('0.45');

    m.setSfxLevel(0);
    expect(m.sfxLevel()).toBe(0);
  });

  it('refuses a level that is not offered', async () => {
    const m = await freshMixer();
    m.setMusicLevel(0.01);
    expect(m.musicLevel()).toBe(1);
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
    const m = await import('./mixer.js');
    expect(m.musicLevel()).toBe(1);
    expect(() => m.setMusicLevel(0.7)).not.toThrow();
    expect(m.musicLevel()).toBe(0.7);
  });
});

describe('nextLevel', () => {
  it('walks each cycle and wraps', async () => {
    const m = await freshMixer();
    let level = m.SFX_LEVELS[0]!;
    const seen = [level];
    for (let i = 1; i < m.SFX_LEVELS.length; i++) {
      level = m.nextLevel(level, m.SFX_LEVELS);
      seen.push(level);
    }
    expect(seen).toEqual([...m.SFX_LEVELS]);
    expect(m.nextLevel(level, m.SFX_LEVELS)).toBe(m.SFX_LEVELS[0]);
  });

  it('recovers from a level outside the cycle', async () => {
    const m = await freshMixer();
    expect(m.MUSIC_LEVELS).toContain(m.nextLevel(0.321, m.MUSIC_LEVELS));
  });
});

describe('levelLabel', () => {
  it('reads as a percentage, and names silence', async () => {
    const m = await freshMixer();
    expect(m.levelLabel(1)).toBe('100%');
    expect(m.levelLabel(0.45)).toBe('45%');
    expect(m.levelLabel(0)).toBe('Off');
  });
});
