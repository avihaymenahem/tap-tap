import { describe, expect, it } from 'vitest';
import type { RunResult } from './run.js';
import {
  ACHIEVEMENTS,
  applyRun,
  emptyStats,
  isAllPerfect,
  isFullCombo,
  newlyUnlocked,
  unlockedIds,
} from './achievements.js';

/** A run with sensible defaults; override the fields a case cares about. */
function run(over: Partial<RunResult> = {}): RunResult {
  return {
    score: 1000,
    accuracy: 0.9,
    maxCombo: 50,
    grade: 'A',
    counts: { perfect: 90, great: 8, good: 2, miss: 0 },
    timingCounts: { exact: 80, early: 10, late: 10 },
    meanDelta: 0,
    totalNotes: 100,
    ...over,
  };
}

describe('run classification', () => {
  it('a full combo has no misses', () => {
    expect(isFullCombo(run({ counts: { perfect: 60, great: 30, good: 10, miss: 0 } }))).toBe(true);
    expect(isFullCombo(run({ counts: { perfect: 60, great: 30, good: 9, miss: 1 } }))).toBe(false);
  });

  it('an all-perfect has only perfects', () => {
    expect(isAllPerfect(run({ counts: { perfect: 100, great: 0, good: 0, miss: 0 } }))).toBe(true);
    expect(isAllPerfect(run({ counts: { perfect: 99, great: 1, good: 0, miss: 0 } }))).toBe(false);
  });

  it('a failed run is neither, even with no misses recorded yet', () => {
    expect(isFullCombo(run({ failed: true, counts: { perfect: 10, great: 0, good: 0, miss: 0 } }))).toBe(false);
  });

  it('an empty chart is not a clear', () => {
    expect(isFullCombo(run({ totalNotes: 0, counts: { perfect: 0, great: 0, good: 0, miss: 0 } }))).toBe(false);
  });
});

describe('applyRun', () => {
  it('accumulates without mutating the input', () => {
    const s0 = emptyStats();
    const s1 = applyRun(s0, run(), 'songA', 'hard');
    expect(s0.runs).toBe(0); // untouched
    expect(s1.runs).toBe(1);
    expect(s1.clears).toBe(1);
    expect(s1.clearsByDifficulty.hard).toBe(1);
    expect(s1.songIds).toEqual(['songA']);
  });

  it('keeps the best combo, not the latest', () => {
    let s = emptyStats();
    s = applyRun(s, run({ maxCombo: 200 }), 'a', 'hard');
    s = applyRun(s, run({ maxCombo: 30 }), 'b', 'hard');
    expect(s.bestCombo).toBe(200);
  });

  it('counts distinct songs once', () => {
    let s = emptyStats();
    s = applyRun(s, run(), 'a', 'easy');
    s = applyRun(s, run(), 'a', 'hard');
    s = applyRun(s, run(), 'b', 'easy');
    expect(s.songIds).toEqual(['a', 'b']);
  });

  it('does not count a failed run as a clear, but still counts the run', () => {
    const s = applyRun(emptyStats(), run({ failed: true }), 'a', 'hard');
    expect(s.runs).toBe(1);
    expect(s.clears).toBe(0);
    expect(s.clearsByDifficulty.hard).toBe(0);
  });

  it('tracks full combos per difficulty', () => {
    const fc = run({ counts: { perfect: 100, great: 0, good: 0, miss: 0 } });
    const s = applyRun(emptyStats(), fc, 'a', 'extreme');
    expect(s.fullCombosByDifficulty.extreme).toBe(1);
    expect(s.fullCombos).toBe(1);
  });
});

describe('unlocking', () => {
  it('all badge ids are unique', () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a first clear unlocks First Steps', () => {
    const s = applyRun(emptyStats(), run(), 'a', 'easy');
    expect(unlockedIds(s)).toContain('first-clear');
  });

  it('reports only the badges that just crossed', () => {
    const before = applyRun(emptyStats(), run({ maxCombo: 90 }), 'a', 'easy');
    const prev = unlockedIds(before);
    expect(prev).not.toContain('combo-100');

    const after = applyRun(before, run({ maxCombo: 120 }), 'a', 'easy');
    const fresh = newlyUnlocked(prev, after).map((a) => a.id);
    expect(fresh).toContain('combo-100');
    // First Steps was already earned on the previous run — not re-reported.
    expect(fresh).not.toContain('first-clear');
  });

  it('an earned badge never un-earns after a bad run', () => {
    let s = applyRun(emptyStats(), run({ maxCombo: 350 }), 'a', 'hard'); // On Fire
    expect(unlockedIds(s)).toContain('combo-300');
    s = applyRun(s, run({ maxCombo: 5, counts: { perfect: 1, great: 0, good: 0, miss: 99 } }), 'a', 'hard');
    expect(unlockedIds(s)).toContain('combo-300'); // bestCombo stayed at 350
  });
});
