import { describe, expect, it } from 'vitest';
import type { RunResult } from './run.js';
import { decideWinner, tugRatio } from './versus.js';

/** A minimal run; only score and accuracy matter to the winner rule. */
function run(score: number, accuracy: number): RunResult {
  return {
    score,
    accuracy,
    maxCombo: 0,
    grade: 'C',
    counts: { perfect: 0, great: 0, good: 0, miss: 0 },
    timingCounts: { exact: 0, early: 0, late: 0 },
    meanDelta: 0,
    totalNotes: 0,
  };
}

describe('decideWinner', () => {
  it('awards the higher score', () => {
    expect(decideWinner(run(1000, 0.9), run(800, 0.99))).toBe('p1');
    expect(decideWinner(run(800, 0.99), run(1000, 0.9))).toBe('p2');
  });

  it('breaks a score tie on accuracy', () => {
    expect(decideWinner(run(1000, 0.92), run(1000, 0.9))).toBe('p1');
    expect(decideWinner(run(1000, 0.9), run(1000, 0.92))).toBe('p2');
  });

  it('is a draw only when score and accuracy both tie', () => {
    expect(decideWinner(run(1000, 0.9), run(1000, 0.9))).toBe('draw');
  });
});

describe('tugRatio', () => {
  it('starts centred before anyone scores', () => {
    expect(tugRatio(0, 0)).toBe(0.5);
  });

  it('leans toward the leader in proportion to the scores', () => {
    expect(tugRatio(300, 100)).toBeCloseTo(0.75);
    expect(tugRatio(100, 300)).toBeCloseTo(0.25);
  });

  it('clamps so a runaway lead never buries the trailing colour', () => {
    expect(tugRatio(1000, 0)).toBe(0.95);
    expect(tugRatio(0, 1000)).toBe(0.05);
  });
});
