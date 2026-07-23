import type { AnalysisResult, Onset, Waveform } from '@tap-tap/shared';
import { DIFFICULTIES, type DifficultyName, type DifficultyParams, isHold, noteEnd } from '@tap-tap/shared';
import { describe, expect, it } from 'vitest';
import { generateChart, holdRecoverySec, peakConcurrency } from './generate.js';

const SECONDS_PER_PEAK = 0.02;

/**
 * A track of widely spaced hits, each of which is a level plateau — so every
 * onset is a sustain candidate and the *generator's* rules are what decide
 * which become holds. Sustain detection itself is covered in `sustain.test.ts`.
 */
function sustainedAnalysis(spacing = 2, duration = 60): AnalysisResult {
  const beatGrid: number[] = [];
  for (let t = 0; t < duration; t += 0.5) beatGrid.push(Number(t.toFixed(4)));

  const onsets: Onset[] = [];
  for (let t = 1; t < duration - 2; t += spacing) {
    const phase = Math.round(t / spacing) % 3;
    onsets.push({
      t: Number(t.toFixed(3)),
      strength: 0.9,
      low: phase === 0 ? 0.7 : 0.15,
      mid: phase === 1 ? 0.7 : 0.15,
      high: phase === 2 ? 0.7 : 0.15,
    });
  }

  return { duration, bpm: 120, bpmConfidence: 0.9, beatGrid, onsets };
}

/**
 * Onsets that actually chord: a dominant low band with a real mid secondary
 * (above the 0.2 content floor), packed close so a hold and a chord overlap and
 * the two-finger cleanup has something to remove.
 */
function chordyAnalysis(duration = 40): AnalysisResult {
  const beatGrid: number[] = [];
  for (let t = 0; t < duration; t += 0.5) beatGrid.push(Number(t.toFixed(4)));

  const onsets: Onset[] = [];
  for (let t = 1; t < duration - 2; t += 0.5) {
    onsets.push({ t: Number(t.toFixed(3)), strength: 0.9, low: 0.6, mid: 0.5, high: 0.2 });
  }

  return { duration, bpm: 120, bpmConfidence: 0.9, beatGrid, onsets };
}

/** Level everywhere from the first onset: every onset sustains until the next. */
function plateauWaveform(duration = 60): Waveform {
  const count = Math.round(duration / SECONDS_PER_PEAK);
  return {
    secondsPerPeak: SECONDS_PER_PEAK,
    peaks: Array.from({ length: count }, (_, i) => (i * SECONDS_PER_PEAK >= 1 ? 0.8 : 0.02)),
  };
}

/**
 * Holds are enabled in the shipped config (the overhaul turned them back on).
 * `enabled()` used to restore the tuned shares while the feature was dark; it
 * now just pins them, so the generation tests keep working against a known share
 * even if the shipped numbers are later tuned. The shares here must track
 * `difficulty.ts` — the `shipped configuration` test below asserts they do.
 */
const TUNED_SHARE: Record<DifficultyName, number> = {
  easy: 0.1,
  medium: 0.14,
  hard: 0.18,
  extreme: 0.2,
};

function enabled(params: DifficultyParams): DifficultyParams {
  return { ...params, holdShare: TUNED_SHARE[params.name] };
}

const hard = enabled(DIFFICULTIES.hard);

describe('peakConcurrency', () => {
  it('counts overlapping spans at the busiest instant', () => {
    expect(peakConcurrency([{ start: 0, end: 2 }, { start: 1, end: 3 }], 0, 3)).toBe(2);
    expect(
      peakConcurrency([{ start: 0, end: 3 }, { start: 1, end: 3 }, { start: 2, end: 3 }], 0, 3),
    ).toBe(3);
  });

  it('does not count spans that merely touch', () => {
    // One hold ending exactly as the next begins is a hand-off, not two hands.
    expect(peakConcurrency([{ start: 0, end: 1 }, { start: 1, end: 2 }], 0, 2)).toBe(1);
  });

  it('is not fooled by spans that overlap the window but not each other', () => {
    // The reason this is a sweep and not a count. Both spans overlap [0.5, 2.5],
    // yet at no instant are two of them live together with anything else — a
    // naive "how many overlap me" would answer 2 and reject a playable hold.
    const spans = [{ start: 0, end: 1 }, { start: 2, end: 3 }];
    expect(peakConcurrency(spans, 0.5, 2.5)).toBe(1);
  });

  it('clips to the window', () => {
    expect(peakConcurrency([{ start: 0, end: 10 }], 20, 30)).toBe(0);
    expect(peakConcurrency([], 0, 1)).toBe(0);
  });
});

describe('shipped configuration', () => {
  it('enables holds on every difficulty, climbing with difficulty', () => {
    // The overhaul turned holds back on. This asserts the *shipped* behaviour so
    // an accidental return to zero (which would silently switch a difficulty's
    // holds back off) fails here rather than shipping. The shares are what the
    // generation tests below pin via `enabled()`.
    for (const params of Object.values(DIFFICULTIES)) {
      expect(params.holdShare, `${params.name} holdShare`).toBe(TUNED_SHARE[params.name]);
      expect(params.holdShare, `${params.name} holdShare > 0`).toBeGreaterThan(0);
    }
    expect(DIFFICULTIES.easy.holdShare).toBeLessThan(DIFFICULTIES.hard.holdShare);
  });

  it('produces holds on a sustained track with the shipped config', () => {
    // Not just the parameter — the pipeline end to end with the real difficulty
    // params (no `enabled()` override) must yield holds when the audio sustains.
    const chart = generateChart(sustainedAnalysis(), DIFFICULTIES.hard, 1, plateauWaveform());
    expect(chart.notes.some(isHold)).toBe(true);
  });
});

describe('hold generation', () => {
  it('produces no holds without a waveform', () => {
    // The whole reason the parameter is optional: a song with no cached
    // waveform charts exactly as it did before holds existed, rather than
    // failing.
    const chart = generateChart(sustainedAnalysis(), hard, 1);
    expect(chart.notes.some(isHold)).toBe(false);
  });

  it('produces holds when the audio sustains', () => {
    const chart = generateChart(sustainedAnalysis(), hard, 1, plateauWaveform());
    expect(chart.notes.filter(isHold).length).toBeGreaterThan(0);
  });

  it('never exceeds the difficulty’s hold share', () => {
    const chart = generateChart(sustainedAnalysis(), hard, 1, plateauWaveform());
    const holds = chart.notes.filter(isHold).length;

    // A ceiling, not a target — every onset here is a candidate, so this is the
    // binding constraint rather than the supply of sustains.
    expect(holds).toBeLessThanOrEqual(Math.floor(chart.notes.length * hard.holdShare));
  });

  it('respects minHoldSec and maxHoldSec', () => {
    const chart = generateChart(sustainedAnalysis(), hard, 1, plateauWaveform());
    for (const note of chart.notes.filter(isHold)) {
      expect(note.duration!).toBeGreaterThanOrEqual(hard.minHoldSec);
      expect(note.duration!).toBeLessThanOrEqual(hard.maxHoldSec);
    }
  });

  it('never lets a hold run into the next note in its own lane', () => {
    // **The playability rule.** A hold occupies its lane for its whole length,
    // so a later note in that lane would be physically unhittable — the finger
    // is already down. Checked across every difficulty because the spacing that
    // makes it safe is per-difficulty.
    for (const raw of Object.values(DIFFICULTIES)) {
      const params = enabled(raw);
      const chart = generateChart(sustainedAnalysis(1.2), params, 7, plateauWaveform());
      const byLane = new Map<number, typeof chart.notes>();
      for (const note of chart.notes) {
        byLane.set(note.lane, [...(byLane.get(note.lane) ?? []), note]);
      }

      for (const [lane, notes] of byLane) {
        for (let i = 0; i < notes.length - 1; i++) {
          const end = noteEnd(notes[i]!);
          const next = notes[i + 1]!.t;
          expect(
            end,
            `${params.name} lane ${lane}: note at ${notes[i]!.t} ends ${end}, next at ${next}`,
          ).toBeLessThanOrEqual(next);
        }
      }
    }
  });

  it('keeps the usual spacing after a hold ends', () => {
    const chart = generateChart(sustainedAnalysis(1.2), hard, 7, plateauWaveform());
    const sorted = [...chart.notes].sort((a, b) => a.lane - b.lane || a.t - b.t);

    for (let i = 0; i < sorted.length - 1; i++) {
      const note = sorted[i]!;
      const next = sorted[i + 1]!;
      if (!isHold(note) || next.lane !== note.lane) continue;
      // Trimmed to leave `minGapSec`, not merely to avoid touching.
      expect(next.t - noteEnd(note)).toBeGreaterThanOrEqual(hard.minGapSec - 1e-6);
    }
  });

  it('never asks for more simultaneous holds than the difficulty allows', () => {
    // The physical constraint: the keymaps are one left hand and touch is two
    // thumbs. A third concurrent hold cannot be honoured, and it strands every
    // note in the remaining lanes for its whole length.
    //
    // `sustainedAnalysis(0.6)` deliberately packs onsets close together, which
    // is what makes sustains in different bands land simultaneously — the exact
    // situation that produced stacks of holds before the cap existed.
    for (const raw of Object.values(DIFFICULTIES)) {
      const params = enabled(raw);
      const chart = generateChart(sustainedAnalysis(0.6), params, 11, plateauWaveform());
      const holds = chart.notes.filter(isHold).map((n) => ({ start: n.t, end: noteEnd(n) }));

      for (const hold of holds) {
        // Including itself, hence the +1 on the others.
        const others = holds.filter((h) => h !== hold);
        const peak = peakConcurrency(others, hold.start, hold.end) + 1;
        expect(peak, `${params.name}: ${peak} holds at once near ${hold.start}s`).toBeLessThanOrEqual(
          params.maxConcurrentHolds,
        );
      }
    }
  });

  it('is deterministic', () => {
    const once = generateChart(sustainedAnalysis(), hard, 42, plateauWaveform());
    const twice = generateChart(sustainedAnalysis(), hard, 42, plateauWaveform());
    expect(twice.notes).toEqual(once.notes);
  });

  it('leaves taps alone as taps', () => {
    const chart = generateChart(sustainedAnalysis(), hard, 1, plateauWaveform());
    for (const note of chart.notes) {
      if (note.type === 'tap') expect(note.duration).toBeUndefined();
    }
  });

  it('places every hold on an outer lane', () => {
    // Two-finger rule: while one thumb pins a hold, the other must reach every
    // other note. An edge-lane hold leaves the rest of the board contiguous for
    // the free thumb; an inner one splits it and strands a side.
    for (const raw of Object.values(DIFFICULTIES)) {
      const params = enabled(raw);
      const chart = generateChart(sustainedAnalysis(), params, 1, plateauWaveform());
      for (const note of chart.notes.filter(isHold)) {
        expect([0, chart.laneCount - 1], `${params.name} hold lane`).toContain(note.lane);
      }
    }
  });

  it('never lets a chord land inside a hold', () => {
    // While a hold is down the free thumb can take only one tap at a time, so no
    // two notes may share a timestamp strictly inside a hold's span. `chordy`
    // has a real secondary band so chords are actually generated to be culled.
    const chart = generateChart(chordyAnalysis(), enabled(DIFFICULTIES.hard), 5, plateauWaveform());
    const holds = chart.notes.filter(isHold).map((n) => ({ start: n.t, end: noteEnd(n) }));
    expect(holds.length).toBeGreaterThan(0);

    const countAt = new Map<number, number>();
    for (const n of chart.notes) countAt.set(n.t, (countAt.get(n.t) ?? 0) + 1);

    for (const [t, count] of countAt) {
      const insideAHold = holds.some((h) => t > h.start + 1e-4 && t <= h.end + 1e-4);
      if (insideAHold) expect(count, `chord at ${t}s inside a hold`).toBeLessThanOrEqual(1);
    }
  });

  it('leaves a recovery gap after every hold', () => {
    // A hold must resolve into a beat of rest: no tap may land in the recovery
    // window after its tail (another hold may follow — holds are their own
    // transition). Fixes the "double bar with zero gap right after a hold".
    for (const raw of Object.values(DIFFICULTIES)) {
      const params = enabled(raw);
      const recovery = holdRecoverySec(params.minGapSec);
      const chart = generateChart(chordyAnalysis(), params, 5, plateauWaveform());
      const holds = chart.notes.filter(isHold);

      for (const h of holds) {
        const end = noteEnd(h);
        for (const n of chart.notes) {
          if (n === h || isHold(n)) continue;
          const inWindow = n.t > end + 1e-4 && n.t < end + recovery;
          expect(inWindow, `${params.name}: tap at ${n.t}s inside recovery after ${end}s`).toBe(
            false,
          );
        }
      }
    }
  });

  it('gives easy fewer holds than hard', () => {
    const analysis = sustainedAnalysis();
    const wave = plateauWaveform();
    const easy = generateChart(analysis, enabled(DIFFICULTIES.easy), 3, wave).notes.filter(isHold);
    const hardHolds = generateChart(analysis, hard, 3, wave).notes.filter(isHold);

    expect(easy.length).toBeLessThanOrEqual(hardHolds.length);
  });
});
