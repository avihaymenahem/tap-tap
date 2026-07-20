import { type Chart, type Note, isHold, noteEnd } from '@tap-tap/shared';
import {
  HIT_WINDOWS,
  type HitWindows,
  TIERS,
  type Tier,
  type Timing,
  accuracyOf,
  baseScore,
  comboMultiplier,
  hitWindowsFor,
  holdBonus,
  releaseWindowFor,
  tierFor,
  timingOf,
} from './judge.js';

/**
 * The game engine.
 *
 * Deliberately free of three.js, React, and Web Audio: it takes a chart and a
 * song time, and answers questions about notes and score. That keeps it fully
 * unit-testable and means the renderer can be replaced without touching rules.
 */

/**
 * Lifecycle of a hold, beyond the head judgement it shares with a tap.
 *
 *   pending ──head hit──> held ──released in window, or tail reached──> complete
 *      │                    │
 *      │                    └──released early────────────────────────> broken
 *      └──head missed────────────────────────────────────────────────> miss
 *
 * `complete` and `broken` are terminal: a released hold cannot be re-grabbed.
 * That is a rule, not an oversight — allowing a re-grab would mean a hold could
 * be farmed by tapping along its length, and it would make the state genuinely
 * hard to reason about for no gain a player would notice.
 */
export type HoldState = 'pending' | 'held' | 'complete' | 'broken';

export interface NoteState {
  note: Note;
  /** Index into the chart's note array — stable identity for the renderer. */
  id: number;
  tier: Tier | null;
  timing: Timing | null;
  /** Holds only; `null` on taps. */
  hold: HoldState | null;
}

export interface HitResult {
  noteId: number;
  lane: number;
  tier: Tier;
  timing: Timing;
  /** Signed seconds: negative = early, positive = late. */
  delta: number;
  score: number;
  combo: number;
  /** True when this tap grabbed a hold, so the lane is now held. */
  startedHold: boolean;
}

/** Outcome of letting go of a lane. */
export interface ReleaseResult {
  noteId: number;
  lane: number;
  completed: boolean;
  /** The completion bonus, already multiplied by combo. Zero on a break. */
  score: number;
}

export interface EngineOptions {
  /**
   * Seconds to subtract from input and playback time. Positive values suit a
   * player whose taps consistently register late (Bluetooth latency, slow display).
   */
  calibrationSec?: number;
  /**
   * The difficulty's note spacing, so judging windows can be capped to it
   * (`hitWindowsFor`). Omitting it uses the base windows — correct for any chart
   * spaced at 0.19s or wider, which is every difficulty except Extreme.
   */
  minGapSec?: number;
}

export interface GameSnapshot {
  score: number;
  combo: number;
  maxCombo: number;
  counts: Record<Tier, number>;
  timingCounts: Record<Timing, number>;
  /** Signed mean error across all hits, in seconds. Negative = hitting early. */
  meanDelta: number;
  /** Holds carried to their tail. Reported separately: accuracy counts the head. */
  holdsCompleted: number;
  totalHolds: number;
  accuracy: number;
  notesJudged: number;
  totalNotes: number;
  finished: boolean;
}

export class GameEngine {
  readonly laneCount: number;
  readonly totalNotes: number;
  readonly totalHolds: number;

  private readonly notes: NoteState[];
  /** Per-lane note ids, plus a cursor to the earliest unjudged note. */
  private readonly lanes: { ids: number[]; cursor: number }[];
  private readonly calibrationSec: number;
  /** Judging windows for this chart, capped to its spacing. */
  private readonly windows: HitWindows;
  /** Outer edge of `windows` — the miss threshold and retirement horizon. */
  private readonly missWindow: number;
  /** Note id currently held in each lane, or -1. At most one per lane. */
  private readonly heldByLane: number[];
  /**
   * Longest hold in the chart, so `visibleNotes` knows how far back to scan.
   * A hold that started four seconds ago is still on screen; a binary search
   * from `songTime` alone would have skipped past it.
   */
  private readonly maxHoldDuration: number;

  private score = 0;
  private combo = 0;
  private maxCombo = 0;
  private counts: Record<Tier, number> = { perfect: 0, great: 0, good: 0, miss: 0 };
  private timingCounts: Record<Timing, number> = { exact: 0, early: 0, late: 0 };
  private deltaSum = 0;
  private hits = 0;
  private judged = 0;
  private holdsCompleted = 0;

  constructor(chart: Chart, options: EngineOptions = {}) {
    this.laneCount = chart.laneCount;
    this.calibrationSec = options.calibrationSec ?? 0;
    this.windows = options.minGapSec !== undefined ? hitWindowsFor(options.minGapSec) : { ...HIT_WINDOWS };
    this.missWindow = this.windows.good;
    this.notes = chart.notes.map((note, id) => ({
      note,
      id,
      tier: null,
      timing: null,
      hold: isHold(note) ? ('pending' as const) : null,
    }));
    this.totalNotes = this.notes.length;
    this.totalHolds = this.notes.filter((state) => state.hold !== null).length;
    this.maxHoldDuration = this.notes.reduce(
      (longest, state) => Math.max(longest, state.note.duration ?? 0),
      0,
    );

    this.lanes = Array.from({ length: chart.laneCount }, () => ({ ids: [], cursor: 0 }));
    this.heldByLane = Array.from({ length: chart.laneCount }, () => -1);
    this.notes.forEach((state) => {
      this.lanes[state.note.lane]?.ids.push(state.id);
    });
  }

  /**
   * Clock time converted into the time the player actually sees and hears.
   *
   * **Rendering must go through this, or a calibrated device becomes
   * unplayable.** The clock tracks what has been *scheduled*; the audio reaches
   * the player one output latency later, and the calibration offset is that
   * latency. Judgement already works in this shifted space — `update` and
   * `hitLane` both subtract it — but the renderer used the raw clock, so on a
   * phone with a 280ms offset the pill crossed the receptor 280ms before the
   * beat was audible, and a tap that looked perfect was judged 280ms early.
   * Past `MISS_WINDOW` that is not even a bad hit: `hitLane` matches nothing and
   * the tap vanishes with no feedback at all.
   *
   * Drawing at this time instead lines up all three: the pill touches the
   * receptor exactly when the beat is heard and exactly when the engine calls
   * the delta zero.
   */
  judgementTime(songTime: number): number {
    return songTime - this.calibrationSec;
  }

  /**
   * Advance to `songTime`, retiring notes whose window has fully passed.
   * Call once per frame before rendering.
   */
  update(songTime: number): NoteState[] {
    const now = songTime - this.calibrationSec;
    const missed: NoteState[] = [];

    // Holds still down whose tail has passed complete themselves. Without this
    // a player doing the right thing — holding to the end — would be waiting on
    // a release that scores nothing, and a hold held past the end of the song
    // would never resolve at all.
    for (let lane = 0; lane < this.heldByLane.length; lane++) {
      const id = this.heldByLane[lane]!;
      if (id < 0) continue;
      const state = this.notes[id]!;
      if (now >= noteEnd(state.note)) this.finishHold(state, lane, true);
    }

    for (const lane of this.lanes) {
      while (lane.cursor < lane.ids.length) {
        const state = this.notes[lane.ids[lane.cursor]!]!;
        if (state.tier !== null) {
          lane.cursor++;
          continue;
        }
        if (state.note.t + this.missWindow >= now) break;

        this.retire(state, 'miss', null, 0);
        missed.push(state);
        lane.cursor++;
      }
    }

    return missed;
  }

  /** Tap in a lane. Returns null when there is no note close enough to judge. */
  hitLane(lane: number, songTime: number): HitResult | null {
    const queue = this.lanes[lane];
    if (!queue) return null;

    const now = songTime - this.calibrationSec;
    let best: NoteState | null = null;
    let bestDelta = 0;

    // Scan forward from the cursor: the nearest unjudged note is within the
    // first few entries, since anything older has already been retired.
    for (let i = queue.cursor; i < queue.ids.length; i++) {
      const state = this.notes[queue.ids[i]!]!;
      if (state.tier !== null) continue;

      const delta = now - state.note.t;
      if (delta > this.missWindow) continue;
      if (delta < -this.missWindow) break; // sorted: everything later is further away

      if (best === null || Math.abs(delta) < Math.abs(bestDelta)) {
        best = state;
        bestDelta = delta;
      }
    }

    if (!best) return null;

    const tier = tierFor(bestDelta, this.windows);
    if (tier === 'miss') return null;

    const timing = timingOf(bestDelta);
    const gained = this.retire(best, tier, timing, bestDelta);

    // The head of a hold is judged exactly like a tap — same tier, same score,
    // same combo — and then the lane stays down. The bonus is settled later, on
    // release or at the tail.
    const startedHold = best.hold === 'pending';
    if (startedHold) {
      best.hold = 'held';
      this.heldByLane[lane] = best.id;
    }

    return {
      noteId: best.id,
      lane,
      tier,
      timing,
      delta: bestDelta,
      score: gained,
      combo: this.combo,
      startedHold,
    };
  }

  /**
   * Let go of a lane. Returns null when nothing was being held there.
   *
   * Takes raw clock time and subtracts calibration itself, matching `hitLane`
   * and `update` — passing an already-shifted time double-counts the offset,
   * which on a phone is the difference between working and unplayable.
   */
  releaseLane(lane: number, songTime: number): ReleaseResult | null {
    const id = this.heldByLane[lane];
    if (id === undefined || id < 0) return null;

    const state = this.notes[id]!;
    const now = songTime - this.calibrationSec;
    const remaining = noteEnd(state.note) - now;
    // Forgiving, and capped at a share of the note's own length so a short hold
    // cannot be completed by tapping it. See `releaseWindowFor`.
    const completed = remaining <= releaseWindowFor(state.note.duration ?? 0);

    return this.finishHold(state, lane, completed);
  }

  /** Settles a held note. Shared by an explicit release and the tail in `update`. */
  private finishHold(state: NoteState, lane: number, completed: boolean): ReleaseResult {
    state.hold = completed ? 'complete' : 'broken';
    this.heldByLane[lane] = -1;

    // A break costs the bonus and nothing else: the head score stands and the
    // combo is untouched, so a hold is never worth less than the same note
    // would have been as a tap. Deliberate — these charts are machine-made, and
    // a sustain the generator imagined should not be able to end a run.
    if (!completed) return { noteId: state.id, lane, completed: false, score: 0 };

    const gained = holdBonus(state.note.duration ?? 0) * comboMultiplier(this.combo);
    this.score += gained;
    this.holdsCompleted++;
    return { noteId: state.id, lane, completed: true, score: gained };
  }

  /** Note id held in this lane, or -1. The renderer lights the lane from this. */
  heldNoteId(lane: number): number {
    return this.heldByLane[lane] ?? -1;
  }

  /** Notes that should currently be on screen, nearest first. */
  visibleNotes(songTime: number, approachSec: number): NoteState[] {
    const from = songTime - 0.25;
    const to = songTime + approachSec;

    // Scan back far enough to catch a hold whose *head* is long past but whose
    // body is still on the track. Searching from `from` alone would skip it and
    // the note would vanish the instant it was grabbed.
    const start = lowerBound(this.notes, from - this.maxHoldDuration);
    const visible: NoteState[] = [];
    for (let i = start; i < this.notes.length; i++) {
      const state = this.notes[i]!;
      if (state.note.t > to) break;
      // Its tail, for a hold — that is what decides when it leaves the screen.
      if (noteEnd(state.note) < from) continue;

      // A held note has a tier already (its head was judged) but is very much
      // still in play, so the tap rule alone would drop it mid-hold.
      const live = state.tier === null || state.tier === 'miss' || state.hold === 'held';
      if (live) visible.push(state);
    }
    return visible;
  }

  get snapshot(): GameSnapshot {
    return {
      score: this.score,
      combo: this.combo,
      maxCombo: this.maxCombo,
      counts: { ...this.counts },
      timingCounts: { ...this.timingCounts },
      meanDelta: this.hits > 0 ? this.deltaSum / this.hits : 0,
      holdsCompleted: this.holdsCompleted,
      totalHolds: this.totalHolds,
      accuracy: accuracyOf(this.counts),
      notesJudged: this.judged,
      totalNotes: this.totalNotes,
      finished: this.judged >= this.totalNotes,
    };
  }

  private retire(state: NoteState, tier: Tier, timing: Timing | null, delta: number): number {
    state.tier = tier;
    state.timing = timing;
    this.counts[tier]++;
    this.judged++;

    if (tier === 'miss' || timing === null) {
      this.combo = 0;
      return 0;
    }

    this.timingCounts[timing]++;
    this.deltaSum += delta;
    this.hits++;

    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    const gained = baseScore(tier, timing) * comboMultiplier(this.combo);
    this.score += gained;
    return gained;
  }
}

/** First index whose note time is >= `t`. `notes` must be sorted by time. */
function lowerBound(notes: NoteState[], t: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (notes[mid]!.note.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export { TIERS };
