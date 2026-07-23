import type { Chart, Note } from '@tap-tap/shared';

/**
 * The tutorial's synthetic chart — hand-built, not generated.
 *
 * Two phases at a slow tempo: a few *isolated* notes spread across the lanes so
 * the player learns to aim and tap, then a short *on-the-beat* run so they learn
 * timing. Pure and deterministic, so it is unit-tested rather than eyeballed, and
 * the screen reads the phase hints and the end time straight off it.
 */

export const TUTORIAL_BPM = 80;
export const TUTORIAL_LANES = 4;
export const TUTORIAL_APPROACH_SEC = 1.6;

const BEAT = 60 / TUTORIAL_BPM; // 0.75s

export interface TutorialPhase {
  /** Song-time (seconds from the first beat) this hint starts showing at. */
  at: number;
  hint: string;
}

export interface TutorialLesson {
  chart: Chart;
  /** Hints keyed to song-time; the screen shows the latest one reached. */
  phases: TutorialPhase[];
  /** Song-time at which the whole lesson is over (last note + a breath). */
  endSec: number;
}

function round(t: number): number {
  return Number(t.toFixed(4));
}

export function buildTutorialLesson(): TutorialLesson {
  const notes: Note[] = [];
  const tap = (t: number, lane: number): void => {
    notes.push({ t: round(t), lane, type: 'tap' });
  };

  // Phase 1 — one note at a time, ~2.25s apart, moving across the lanes.
  let t = 3 * BEAT; // runway before the first note
  const beatPhaseStart = (() => {
    for (const lane of [1, 2, 0, 3]) {
      tap(t, lane);
      t += 3 * BEAT;
    }
    return t + 2 * BEAT; // a short pause, then the beat phase
  })();

  // Phase 2 — a run on the beat, out and back across the board.
  t = beatPhaseStart;
  for (const lane of [0, 1, 2, 3, 3, 2, 1, 0]) {
    tap(t, lane);
    t += BEAT;
  }

  return {
    chart: { laneCount: TUTORIAL_LANES, notes },
    phases: [
      { at: 0, hint: 'Tap the lane when the tile reaches the frame' },
      { at: round(beatPhaseStart - BEAT), hint: 'Now tap on the beat' },
    ],
    endSec: round(t + 2 * BEAT),
  };
}

/** The hint to show at `songTime` — the latest phase whose time has been reached. */
export function tutorialHintAt(phases: readonly TutorialPhase[], songTime: number): string {
  let hint = '';
  for (const phase of phases) {
    if (songTime >= phase.at) hint = phase.hint;
  }
  return hint;
}
