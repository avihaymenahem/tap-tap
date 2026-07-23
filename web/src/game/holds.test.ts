import type { Chart } from '@tap-tap/shared';
import { describe, expect, it } from 'vitest';
import { GameEngine } from './engine.js';
import {
  HIT_WINDOWS,
  HOLD_RELEASE_WINDOW,
  MAX_SCORED_HOLD_SEC,
  comboMultiplier,
  holdBonus,
  releaseWindowFor,
} from './judge.js';

/**
 * Written relative to the windows, never with literal deltas. The windows are
 * feel knobs and get retuned; a literal silently lands on a boundary when they
 * move, which is exactly how the tier tests broke once already.
 */
function holdChart(
  holds: [time: number, lane: number, duration: number][],
  laneCount = 3,
): Chart {
  return {
    laneCount,
    notes: holds.map(([t, lane, duration]) => ({
      t,
      lane,
      type: 'hold' as const,
      duration,
    })),
  };
}

/** A hold long enough that the release window is the flat one, not the capped one. */
const LONG = 2;

describe('releaseWindowFor', () => {
  it('is the flat window for a long hold', () => {
    expect(releaseWindowFor(LONG)).toBe(HOLD_RELEASE_WINDOW);
  });

  it('shrinks for a short hold, so tapping one cannot complete it', () => {
    // Without the cap the flat window would span a short note entirely and the
    // head tap alone would satisfy the release check.
    const short = 0.2;
    expect(releaseWindowFor(short)).toBeLessThan(short);
    expect(releaseWindowFor(short)).toBeLessThan(HOLD_RELEASE_WINDOW);
  });
});

describe('holdBonus', () => {
  it('scales with duration', () => {
    expect(holdBonus(2)).toBeGreaterThan(holdBonus(1));
  });

  it('caps, so one long sustain cannot outweigh the rest of the chart', () => {
    expect(holdBonus(MAX_SCORED_HOLD_SEC * 10)).toBe(holdBonus(MAX_SCORED_HOLD_SEC));
  });
});

describe('grabbing a hold', () => {
  it('judges the head exactly like a tap and reports the grab', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    const result = engine.hitLane(0, 1);

    expect(result?.tier).toBe('perfect');
    expect(result?.startedHold).toBe(true);
    expect(engine.heldNoteId(0)).toBe(result?.noteId);
  });

  it('does not report a grab for a tap', () => {
    const engine = new GameEngine({
      laneCount: 3,
      notes: [{ t: 1, lane: 0, type: 'tap' }],
    });

    expect(engine.hitLane(0, 1)?.startedHold).toBe(false);
    expect(engine.heldNoteId(0)).toBe(-1);
  });

  it('misses a hold whose head was never hit', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    const missed = engine.update(1 + MISS_WINDOW_PAD);

    expect(missed).toHaveLength(1);
    expect(missed[0]?.hold).toBe('pending');
    expect(engine.snapshot.counts.miss).toBe(1);
  });
});

const MISS_WINDOW_PAD = HIT_WINDOWS.good + 0.05;

describe('completing a hold', () => {
  it('awards the bonus when released at the tail', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);
    const headScore = engine.snapshot.score;

    const release = engine.releaseLane(0, 1 + LONG);

    expect(release?.completed).toBe(true);
    expect(release?.score).toBe(holdBonus(LONG) * comboMultiplier(1));
    expect(engine.snapshot.score).toBe(headScore + (release?.score ?? 0));
    expect(engine.snapshot.holdsCompleted).toBe(1);
  });

  it('forgives a release inside the window', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);

    const release = engine.releaseLane(0, 1 + LONG - HOLD_RELEASE_WINDOW * 0.5);
    expect(release?.completed).toBe(true);
  });

  it('completes on its own at the tail when the player keeps holding', () => {
    // The player doing the right thing must not be left waiting on a release
    // that scores nothing — and a hold still down when the song ends has to
    // resolve regardless.
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);

    engine.update(1 + LONG + 0.01);

    expect(engine.snapshot.holdsCompleted).toBe(1);
    expect(engine.heldNoteId(0)).toBe(-1);
  });

  it('ignores a release after the tail already completed it', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);
    engine.update(1 + LONG + 0.01);
    const settled = engine.snapshot.score;

    expect(engine.releaseLane(0, 1 + LONG + 0.5)).toBeNull();
    expect(engine.snapshot.score).toBe(settled);
  });
});

describe('breaking a hold', () => {
  it('costs the bonus but keeps the head score', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);
    const headScore = engine.snapshot.score;

    const release = engine.releaseLane(0, 1 + LONG * 0.25);

    expect(release?.completed).toBe(false);
    expect(release?.score).toBe(0);
    expect(engine.snapshot.score).toBe(headScore);
    expect(engine.snapshot.holdsCompleted).toBe(0);
  });

  it('does not break the combo', () => {
    // The decision that makes holds strictly additive: these charts are
    // machine-generated, so a sustain the generator imagined must not be able
    // to end a run.
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);
    const comboAfterHead = engine.snapshot.combo;

    engine.releaseLane(0, 1 + LONG * 0.25);

    expect(engine.snapshot.combo).toBe(comboAfterHead);
    expect(comboAfterHead).toBe(1);
  });

  it('leaves accuracy measuring the head, so a break is not a miss', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);
    engine.releaseLane(0, 1 + LONG * 0.25);

    expect(engine.snapshot.counts.perfect).toBe(1);
    expect(engine.snapshot.counts.miss).toBe(0);
    expect(engine.snapshot.accuracy).toBe(1);
  });

  it('cannot be re-grabbed once released', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);
    engine.releaseLane(0, 1 + LONG * 0.25);

    // Terminal on purpose: a re-grab would let a hold be farmed by tapping
    // along its length.
    expect(engine.hitLane(0, 1 + LONG * 0.3)).toBeNull();
    expect(engine.heldNoteId(0)).toBe(-1);
  });

  it('releasing a lane that holds nothing is a no-op', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    expect(engine.releaseLane(0, 1)).toBeNull();
    expect(engine.releaseLane(2, 1)).toBeNull();
  });
});

describe('hold ticks', () => {
  it('awards score ticks while the hold is down', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);
    const headScore = engine.snapshot.score;

    engine.update(1 + LONG * 0.5); // held halfway
    expect(engine.snapshot.holdTicks).toBeGreaterThan(0);
    expect(engine.snapshot.score).toBeGreaterThan(headScore);
  });

  it('never double-awards a tick across frames at the same time', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);
    engine.update(1 + LONG * 0.5);
    const ticks = engine.snapshot.holdTicks;

    engine.update(1 + LONG * 0.5); // same instant sampled again
    expect(engine.snapshot.holdTicks).toBe(ticks);
  });

  it('stops ticking after a break — the drop forfeits only the rest', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);
    engine.update(1 + LONG * 0.25);
    const ticks = engine.snapshot.holdTicks;

    engine.releaseLane(0, 1 + LONG * 0.25); // break, combo-safe
    engine.update(1 + LONG); // time rolls on, but nothing is held now
    expect(engine.snapshot.holdTicks).toBe(ticks);
    // The break kept combo (strictly additive) — reasserted here beside ticks.
    expect(engine.snapshot.combo).toBe(1);
  });

  it('reports an auto-completed lane once, then clears it', () => {
    // A hold carried to its tail completes inside `update`, not `releaseLane`, so
    // the play loop learns of it through this queue to fire a completion burst.
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);
    expect(engine.takeCompletedHoldLanes()).toEqual([]);

    engine.update(1 + LONG + 0.01);
    expect(engine.takeCompletedHoldLanes()).toEqual([0]);
    // Drained — a second read is empty, so the burst fires exactly once.
    expect(engine.takeCompletedHoldLanes()).toEqual([]);
  });

  it('does not report a lane released early (that path bursts itself)', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);
    engine.releaseLane(0, 1 + LONG * 0.25); // break
    engine.update(1 + LONG);
    expect(engine.takeCompletedHoldLanes()).toEqual([]);
  });

  it('a completed hold ticks along its whole length and still pays the tail bonus', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);
    const headScore = engine.snapshot.score;

    engine.update(1 + LONG + 0.01); // held to the tail, auto-completes
    expect(engine.snapshot.holdsCompleted).toBe(1);
    expect(engine.snapshot.holdTicks).toBeGreaterThan(0);
    // Score gained = ticks + the completion bonus, both on top of the head.
    expect(engine.snapshot.score).toBeGreaterThan(headScore + holdBonus(LONG));
  });
});

describe('several holds at once', () => {
  it('tracks one held note per lane independently', () => {
    const engine = new GameEngine(
      holdChart([
        [1, 0, LONG],
        [1, 2, LONG],
      ]),
    );

    engine.hitLane(0, 1);
    engine.hitLane(2, 1);
    expect(engine.heldNoteId(0)).toBeGreaterThanOrEqual(0);
    expect(engine.heldNoteId(2)).toBeGreaterThanOrEqual(0);

    // Breaking one must not disturb the other.
    engine.releaseLane(0, 1 + LONG * 0.2);
    expect(engine.heldNoteId(0)).toBe(-1);
    expect(engine.heldNoteId(2)).toBeGreaterThanOrEqual(0);

    engine.releaseLane(2, 1 + LONG);
    expect(engine.snapshot.holdsCompleted).toBe(1);
  });
});

describe('visibility', () => {
  const APPROACH = 1.5;

  it('keeps a held note on screen after its head has passed', () => {
    // The head is judged, so the tap rule alone would drop it and the body
    // would vanish the instant the player grabbed it.
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);

    const midway = 1 + LONG * 0.5;
    const visible = engine.visibleNotes(midway, APPROACH);

    expect(visible.map((state) => state.id)).toContain(0);
  });

  it('drops a hold once its tail has passed', () => {
    const engine = new GameEngine(holdChart([[1, 0, LONG]]));
    engine.hitLane(0, 1);
    engine.update(1 + LONG + 0.01);

    const visible = engine.visibleNotes(1 + LONG + 1, APPROACH);
    expect(visible.map((state) => state.id)).not.toContain(0);
  });

  it('finds a long hold whose head is far behind the search window', () => {
    // `maxHoldDuration` exists for exactly this: a binary search from the
    // current time would start past the head and never see the note.
    const long = 6;
    const engine = new GameEngine(holdChart([[1, 0, long]]));
    engine.hitLane(0, 1);

    const late = 1 + long - 0.5;
    expect(engine.visibleNotes(late, APPROACH).map((s) => s.id)).toContain(0);
  });
});

describe('totals', () => {
  it('counts holds separately from notes', () => {
    const engine = new GameEngine({
      laneCount: 3,
      notes: [
        { t: 1, lane: 0, type: 'tap' },
        { t: 2, lane: 1, type: 'hold', duration: LONG },
      ],
    });

    expect(engine.totalNotes).toBe(2);
    expect(engine.totalHolds).toBe(1);
    expect(engine.snapshot.totalHolds).toBe(1);
  });

  it('treats a hold with no duration as a tap', () => {
    // Defensive: `isHold` guards the flag, so a malformed note degrades to a
    // tap rather than becoming an ungrabbable, never-resolving hold.
    const engine = new GameEngine({
      laneCount: 3,
      notes: [{ t: 1, lane: 0, type: 'hold' }],
    });

    expect(engine.totalHolds).toBe(0);
    expect(engine.hitLane(0, 1)?.startedHold).toBe(false);
  });
});
