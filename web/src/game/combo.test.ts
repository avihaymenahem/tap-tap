import { describe, expect, it } from 'vitest';
import { comboMilestone, comboTier, isComboMilestone } from './combo.js';

describe('isComboMilestone', () => {
  it('fires at the early pair and every 50 from 100', () => {
    expect(isComboMilestone(25)).toBe(true);
    expect(isComboMilestone(50)).toBe(true);
    expect(isComboMilestone(100)).toBe(true);
    expect(isComboMilestone(150)).toBe(true);
    expect(isComboMilestone(500)).toBe(true);
  });

  it('does not fire on 75 — the gap widens after 50 on purpose', () => {
    expect(isComboMilestone(75)).toBe(false);
    expect(isComboMilestone(125)).toBe(false);
    expect(isComboMilestone(10)).toBe(false);
    expect(isComboMilestone(0)).toBe(false);
  });
});

describe('comboMilestone', () => {
  it('fires exactly on the hit that reaches a milestone', () => {
    expect(comboMilestone(24, 25)).toBe(25);
    expect(comboMilestone(49, 50)).toBe(50);
    expect(comboMilestone(99, 100)).toBe(100);
  });

  it('is silent between milestones', () => {
    expect(comboMilestone(25, 26)).toBeNull();
    expect(comboMilestone(50, 51)).toBeNull();
  });

  it('never fires on a reset', () => {
    // A dropped combo goes to 0; that must not read as crossing every
    // milestone below it on the way down.
    expect(comboMilestone(120, 0)).toBeNull();
    expect(comboMilestone(50, 1)).toBeNull();
  });

  it('reports only the highest milestone if several are crossed at once', () => {
    // Combo climbs one at a time in practice, but the helper must not
    // double-fire if it ever sees a jump.
    expect(comboMilestone(48, 100)).toBe(100);
  });
});

describe('comboTier', () => {
  it('steps up at 10, 25, 50, 100', () => {
    expect(comboTier(0)).toBe(0);
    expect(comboTier(9)).toBe(0);
    expect(comboTier(10)).toBe(1);
    expect(comboTier(24)).toBe(1);
    expect(comboTier(25)).toBe(2);
    expect(comboTier(50)).toBe(3);
    expect(comboTier(100)).toBe(4);
    expect(comboTier(999)).toBe(4);
  });
});
