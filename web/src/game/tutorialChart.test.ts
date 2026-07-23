import { isHold } from '@tap-tap/shared';
import { describe, expect, it } from 'vitest';
import {
  TUTORIAL_LANES,
  buildTutorialLesson,
  tutorialHintAt,
} from './tutorialChart.js';

describe('buildTutorialLesson', () => {
  const lesson = buildTutorialLesson();

  it('is all taps on the tutorial board', () => {
    expect(lesson.chart.laneCount).toBe(TUTORIAL_LANES);
    for (const note of lesson.chart.notes) {
      expect(isHold(note)).toBe(false);
      expect(note.lane).toBeGreaterThanOrEqual(0);
      expect(note.lane).toBeLessThan(TUTORIAL_LANES);
    }
  });

  it('is sorted in time and ends after the last note', () => {
    const times = lesson.chart.notes.map((n) => n.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(lesson.endSec).toBeGreaterThan(times[times.length - 1]!);
  });

  it('opens with wide gaps, then tightens to the beat', () => {
    const gaps = lesson.chart.notes.slice(1).map((n, i) => n.t - lesson.chart.notes[i]!.t);
    // The first gap (isolated phase) is far wider than the last (on-beat run).
    expect(gaps[0]!).toBeGreaterThan(gaps[gaps.length - 1]! * 2);
  });

  it('uses every lane, so the lesson covers the whole board', () => {
    expect(new Set(lesson.chart.notes.map((n) => n.lane)).size).toBe(TUTORIAL_LANES);
  });
});

describe('tutorialHintAt', () => {
  const { phases } = buildTutorialLesson();

  it('shows the first hint from the start', () => {
    expect(tutorialHintAt(phases, 0)).toBe(phases[0]!.hint);
  });

  it('advances to the on-beat hint once its phase is reached', () => {
    const beatPhase = phases[phases.length - 1]!;
    expect(tutorialHintAt(phases, beatPhase.at + 0.1)).toBe(beatPhase.hint);
    expect(tutorialHintAt(phases, beatPhase.at - 0.1)).toBe(phases[0]!.hint);
  });
});
