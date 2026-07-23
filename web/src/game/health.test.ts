import { describe, expect, it } from 'vitest';
import { HEALTH_CONFIG, applyHealthDelta, clampHealth, isDead } from './health.js';
import type { Tier } from './judge.js';

/**
 * Written against `HEALTH_CONFIG` relatively, never with literal deltas: the
 * numbers are feel knobs and will be retuned, exactly like the hit windows.
 */

describe('applyHealthDelta', () => {
  it('drains on a miss and heals on a perfect', () => {
    expect(applyHealthDelta(0.5, 'miss')).toBeLessThan(0.5);
    expect(applyHealthDelta(0.5, 'perfect')).toBeGreaterThan(0.5);
  });

  it('leaves a good hit unchanged — imprecise is not punished', () => {
    expect(applyHealthDelta(0.5, 'good')).toBe(0.5);
  });

  it('never heals above full', () => {
    expect(applyHealthDelta(1, 'perfect')).toBe(1);
  });

  it('never drains below empty', () => {
    expect(applyHealthDelta(0, 'miss')).toBe(0);
  });

  it('costs more on a miss than it heals on a perfect, so bad runs trend down', () => {
    const drain = HEALTH_CONFIG.start - applyHealthDelta(HEALTH_CONFIG.start, 'miss');
    const heal = applyHealthDelta(0.5, 'perfect') - 0.5;
    expect(drain).toBeGreaterThan(heal);
  });

  it('a sustained run of misses reaches zero', () => {
    let health = HEALTH_CONFIG.start;
    for (let i = 0; i < 100; i++) health = applyHealthDelta(health, 'miss');
    expect(isDead(health)).toBe(true);
  });

  it('a clean run of hits stays at full', () => {
    let health = HEALTH_CONFIG.start;
    const hits: Tier[] = ['perfect', 'great', 'perfect', 'perfect'];
    for (let i = 0; i < 50; i++) health = applyHealthDelta(health, hits[i % hits.length]!);
    expect(health).toBe(1);
    expect(isDead(health)).toBe(false);
  });
});

describe('clampHealth', () => {
  it('bounds to 0..1', () => {
    expect(clampHealth(-0.3)).toBe(0);
    expect(clampHealth(1.4)).toBe(1);
    expect(clampHealth(0.42)).toBe(0.42);
  });
});

describe('isDead', () => {
  it('is true only at or below zero', () => {
    expect(isDead(0)).toBe(true);
    expect(isDead(0.01)).toBe(false);
  });
});
