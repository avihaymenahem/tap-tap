import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The module caches the setting at module scope, so — like the haptics tests —
 * each case imports a fresh copy after stubbing the globals it reads.
 */
async function freshQuality(env: {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  stored?: Record<string, string>;
  noNavigator?: boolean;
}) {
  vi.resetModules();

  if (env.noNavigator) {
    vi.stubGlobal('navigator', undefined);
  } else {
    vi.stubGlobal('navigator', {
      deviceMemory: env.deviceMemory,
      hardwareConcurrency: env.hardwareConcurrency,
    });
  }

  const store = new Map<string, string>(Object.entries(env.stored ?? {}));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });

  const mod = await import('./quality.js');
  return { ...mod, store };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('qualityProfile', () => {
  it('high runs the full pipeline', async () => {
    const { qualityProfile } = await freshQuality({});
    const high = qualityProfile('high');
    expect(high.bloom).toBe(true);
    expect(high.antialias).toBe(true);
    expect(high.pixelRatioCap).toBe(2);
    expect(high.trails).toBe(true);
  });

  it('low strips the expensive effects', async () => {
    const { qualityProfile } = await freshQuality({});
    const low = qualityProfile('low');
    expect(low.bloom).toBe(false);
    expect(low.antialias).toBe(false);
    expect(low.pixelRatioCap).toBe(1);
    expect(low.trails).toBe(false);
    // And thins the pools rather than leaving them at capacity.
    expect(low.starCount).toBeLessThan(qualityProfile('high').starCount);
    expect(low.particleBudget).toBeLessThan(qualityProfile('high').particleBudget);
  });
});

describe('detectQuality', () => {
  it('flags 2GB-or-less as low', async () => {
    const { detectQuality } = await freshQuality({ deviceMemory: 2, hardwareConcurrency: 8 });
    expect(detectQuality()).toBe('low');
  });

  it('does not flag 4GB — common on capable phones', async () => {
    const { detectQuality } = await freshQuality({ deviceMemory: 4, hardwareConcurrency: 8 });
    expect(detectQuality()).toBe('high');
  });

  it('flags four-or-fewer cores as low', async () => {
    const { detectQuality } = await freshQuality({ hardwareConcurrency: 4 });
    expect(detectQuality()).toBe('low');
  });

  it('defaults to high when the platform exposes nothing', async () => {
    const { detectQuality } = await freshQuality({});
    expect(detectQuality()).toBe('high');
  });

  it('defaults to high with no navigator (SSR/tests)', async () => {
    const { detectQuality } = await freshQuality({ noNavigator: true });
    expect(detectQuality()).toBe('high');
  });
});

describe('the stored setting', () => {
  it('defaults to auto', async () => {
    const { getQualitySetting } = await freshQuality({});
    expect(getQualitySetting()).toBe('auto');
  });

  it('cycles auto → high → medium → low → auto', async () => {
    const { nextQualitySetting } = await freshQuality({});
    expect(nextQualitySetting('auto')).toBe('high');
    expect(nextQualitySetting('high')).toBe('medium');
    expect(nextQualitySetting('medium')).toBe('low');
    expect(nextQualitySetting('low')).toBe('auto');
  });

  it('persists a choice', async () => {
    const { setQualitySetting, getQualitySetting, store } = await freshQuality({});
    setQualitySetting('low');
    expect(getQualitySetting()).toBe('low');
    expect(store.get('tap-tap.quality')).toBe('low');
  });

  it('clears the remembered auto-downgrade on any deliberate choice', async () => {
    const { setQualitySetting, autoTier } = await freshQuality({
      stored: { 'tap-tap.quality.autoLow': 'medium' },
    });
    expect(autoTier()).toBe('medium');
    setQualitySetting('auto');
    expect(autoTier()).toBeNull();
  });

  it("reads the boolean version's '1' as low", async () => {
    // Written by the build before the downgrade could stop at medium. Losing it
    // would silently put a known-slow device back on high for a whole song.
    const { autoTier } = await freshQuality({
      stored: { 'tap-tap.quality.autoLow': '1' },
    });
    expect(autoTier()).toBe('low');
  });

  it('ignores a value that is not a tier', async () => {
    const { autoTier } = await freshQuality({
      stored: { 'tap-tap.quality.autoLow': 'garbage' },
    });
    expect(autoTier()).toBeNull();
  });
});

describe('the tier ladder', () => {
  it('steps one rung at a time and stops at the bottom', async () => {
    const { nextTierDown } = await freshQuality({});
    expect(nextTierDown('high')).toBe('medium');
    expect(nextTierDown('medium')).toBe('low');
    expect(nextTierDown('low')).toBeNull();
  });

  it('keeps the neon identity at medium and drops it only at low', async () => {
    const { qualityProfile } = await freshQuality({});
    const medium = qualityProfile('medium');
    // Bloom and trails are what the game looks like; medium buys headroom from
    // resolution instead of from the look.
    expect(medium.bloom).toBe(true);
    expect(medium.trails).toBe(true);
    expect(qualityProfile('low').bloom).toBe(false);
  });

  it('never resolves bloom above half resolution on any tier', async () => {
    const { qualityProfile, QUALITY_TIERS } = await freshQuality({});
    for (const tier of QUALITY_TIERS) {
      const p = qualityProfile(tier);
      if (p.bloom) expect(p.bloomScale).toBeLessThanOrEqual(0.5);
    }
  });

  it('gets cheaper monotonically down the ladder', async () => {
    const { qualityProfile, QUALITY_TIERS } = await freshQuality({});
    const profiles = QUALITY_TIERS.map(qualityProfile);
    for (let i = 1; i < profiles.length; i++) {
      const prev = profiles[i - 1]!;
      const next = profiles[i]!;
      expect(next.pixelRatioCap).toBeLessThanOrEqual(prev.pixelRatioCap);
      expect(next.starCount).toBeLessThanOrEqual(prev.starCount);
      expect(next.particleBudget).toBeLessThanOrEqual(prev.particleBudget);
    }
  });
});

describe('resolveQuality', () => {
  it('honors a manual low pin over capable hardware', async () => {
    const { resolveQuality } = await freshQuality({
      deviceMemory: 8,
      hardwareConcurrency: 8,
      stored: { 'tap-tap.quality': 'low' },
    });
    expect(resolveQuality()).toBe('low');
  });

  it('honors a manual high pin over weak hardware', async () => {
    const { resolveQuality } = await freshQuality({
      deviceMemory: 2,
      stored: { 'tap-tap.quality': 'high' },
    });
    expect(resolveQuality()).toBe('high');
  });

  it('returns low under auto once a downgrade is remembered', async () => {
    const { resolveQuality } = await freshQuality({
      deviceMemory: 8,
      hardwareConcurrency: 8,
      stored: { 'tap-tap.quality.autoLow': '1' },
    });
    expect(resolveQuality()).toBe('low');
  });

  it('falls back to static detection under auto', async () => {
    const { resolveQuality } = await freshQuality({ deviceMemory: 2 });
    expect(resolveQuality()).toBe('low');
  });
});

describe('adaptiveAllowed', () => {
  it('is on under auto', async () => {
    const { adaptiveAllowed } = await freshQuality({});
    expect(adaptiveAllowed()).toBe(true);
  });

  it('is off when a tier is pinned', async () => {
    const { adaptiveAllowed } = await freshQuality({ stored: { 'tap-tap.quality': 'high' } });
    expect(adaptiveAllowed()).toBe(false);
  });
});
