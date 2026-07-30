import type { DifficultyName } from './beatmap.js';

export interface DifficultyParams {
  name: DifficultyName;
  laneCount: number;
  /** Beat subdivision notes snap to. 1 = quarter notes, 4 = sixteenths. */
  subdivision: number;
  /**
   * **Absolute floor** on the seconds between consecutive notes anywhere on the
   * board — the physical-playability limit, and the fallback when the song's
   * tempo is not trustworthy enough to convert `minGapBeats` through.
   *
   * This used to be the whole spacing rule, and that made difficulty
   * tempo-dependent in a way nobody chose: the same 0.19s is 0.285 beats at
   * 90 BPM (nearly every sixteenth) but 0.538 beats at 170 BPM (only eighths).
   * So "hard" asked for a much finer musical figure on slow songs than fast
   * ones. `minGapBeats` is the musical target; this is what stops that target
   * from producing something unplayable. See {@link effectiveMinGapSec}.
   */
  minGapSec: number;
  /**
   * Minimum **beats** between consecutive notes — the musical spacing target.
   * 1 is a quarter note, 0.5 an eighth, 0.25 a sixteenth.
   *
   * Each value deliberately sits *between* two subdivisions, which is the tuning
   * logic this table already followed in wall-clock form: a gap between an eighth
   * and a quarter lets the generator place eighths as accents without being able
   * to place every single one. Sitting exactly on a subdivision would let a chart
   * fill every slot of it, which is the "wall of evenly spaced notes rather than
   * a rhythm" failure.
   *
   * **Calibrated so 120 BPM is unchanged.** At a 0.5s beat every value here
   * resolves to exactly the `minGapSec` above it, so a 120 BPM song generates the
   * chart it already generated. Slower songs get proportionally wider gaps;
   * faster songs sit on the floor and are also unchanged. Nothing gets tighter
   * than it is today — that direction would make charts harder without anyone
   * asking, and would push `hitWindowsFor` into windows no one has played.
   */
  minGapBeats: number;
  /** Whether two notes may share a timestamp. */
  chords: boolean;
  /** 0..1 — how often an eligible strong onset becomes a chord. */
  chordChance: number;
  /**
   * Target for the average notes per second across the song.
   *
   * **An average, and that is its limitation.** It says nothing about any
   * particular moment, so a chart can spend this budget in full and still leave
   * a dead multi-second hole — which is exactly what the shipped library did
   * (easy on a 128 BPM track: eleven gaps over 1.5s, worst 7.50s). The local
   * guarantee lives in `MAX_REST_SEC` (`charts/generate.ts`), and it outranks
   * this: closing a rest the music had onsets for may push a song a few notes
   * past the target, the same way the per-section density floor already can.
   */
  targetNps: number;
  /** Seconds a note is visible before it reaches the hit line. */
  approachSec: number;

  /**
   * Selection multiplier for onsets sitting on a trusted beat grid, per
   * difficulty. Strength still dominates; this only breaks ties when a beat and
   * a nearby off-beat both want the same `minGapSec` slot, tipping the note the
   * player gets toward the pulse.
   *
   * Higher on the easy end on purpose. Syncopation is the single hardest thing
   * to read, so a beginner chart should be nearly all on-beat notes, while an
   * extreme chart wants the off-beat texture. A flat bonus gave a novice the
   * same off-grid rate as an expert — "hard, but sparser" rather than
   * "designed for beginners". Only ever applied when the grid cleared
   * `MIN_GRID_CONFIDENCE`; below that `onGrid` is never set, so the bonus is a
   * no-op and the value is moot.
   */
  onGridBonus: number;

  /**
   * Floor on `Onset.percussive` for an onset to be eligible at all — the
   * harmonic/percussive layering axis (PLAN.md §2.10).
   *
   * This is the difficulty axis density is a poor substitute for. An easy chart
   * should be **the beat you can already hear**: the kick, the snare, the hats.
   * Harder charts progressively admit the harmonic layer — the bass line, the
   * melody, the chord changes — which is how a human charter builds a spread.
   * Before this, every difficulty saw the same onsets and differed only in how
   * many of them survived, so clearing easy taught you nothing that prepared you
   * for medium.
   *
   * **An absolute threshold, deliberately, against the usual rule here.** Band
   * classification and sustain-ending both use per-song percentiles because the
   * quantity is continuous and a master's balance shifts it. This one is
   * measured against ground truth and is sharply *bimodal*: real drum hits read
   * 0.95+ and the false onsets a wobbling tone manufactures read 0.015
   * (`analysis.test.ts`). There is nothing in between to be wrong about, and a
   * percentile would instead throw away half the kit on a pure drum track, where
   * every onset is legitimately percussive.
   *
   * **Zero means "admit everything"** and is what extreme uses — the full mix,
   * melody included. `admitPercussive` also relaxes this whenever the gate would
   * starve the density budget, so a song with no percussion still charts; the
   * floor expresses a preference, not a hard requirement.
   */
  minPercussive: number;

  /**
   * 0..1 — the most of a chart's notes that may become holds.
   *
   * A ceiling, not a target: a song with no sustained sounds gets no holds, and
   * that is the correct chart for it. The generator takes the steadiest, most
   * on-beat candidates up to this share rather than manufacturing holds to fill
   * a quota.
   *
   * **Re-enabled with the holds overhaul.** Holds were dark (0 everywhere) while
   * they played badly — the problem was that breaking one cost nothing, so
   * holding had no payoff. They now tick for score along the body and pay a
   * strong tail bonus (still strictly additive — a drop only forfeits the rest,
   * never combo or health), and generation prefers on-beat, clearly-sustained
   * heads. `holdShare` climbs with difficulty; a zero here would switch a
   * difficulty back off (`applyHolds` returns immediately on a zero budget).
   */
  holdShare: number;
  /** Shorter than this is a tap. Below ~0.35s a hold reads as a sloppy tap. */
  minHoldSec: number;
  /** Longer than this is trimmed, so one sustain cannot occupy a lane forever. */
  maxHoldSec: number;
  /**
   * How many holds may be down at once.
   *
   * **One.** Touch is two thumbs, and a hold ties up one of them for its whole
   * length — so a second concurrent hold would leave no free finger for any
   * other note. The game must stay playable with two fingers at every
   * difficulty (holds are the only thing that can break that), so the generator
   * allows a single hold at a time and, with it, always an edge lane (see
   * `applyHolds`) so the free thumb can still sweep the rest of the board.
   */
  maxConcurrentHolds: number;
}

/**
 * Difficulty calibration.
 *
 * The gap matters more than `targetNps`. The target only sets the average across
 * the song; the gap sets the hard ceiling on a sustained stream, at `1 / gap`
 * notes per second. A generous target with a tight gap produces a chart that sits
 * permanently on the spacing floor — a wall of evenly spaced notes rather than a
 * rhythm — which is what made medium unplayable at a 0.2s gap: on a 126 BPM track
 * that is a note on every eighth note, forever.
 *
 * **Tune `minGapBeats`, not `minGapSec`.** The beats value is the musical
 * intent and is what shapes a chart on all but the fastest songs;
 * `minGapSec` is the floor beneath it (see both fields, and
 * {@link effectiveMinGapSec}). Changing one without the other breaks the 120 BPM
 * calibration that keeps the existing library's charts stable — `difficulty.test.ts`
 * asserts that calibration, so it will tell you.
 *
 * A useful check against a real song: quarter note = 60/BPM seconds, eighth =
 * half that. Medium's gap should sit *between* the two, so it can place eighths
 * as accents without being able to place every single one — which in beats is
 * simply `0.5 < minGapBeats < 1`, the same statement without the tempo in it.
 */
export const DIFFICULTIES: Record<DifficultyName, DifficultyParams> = {
  easy: {
    name: 'easy',
    // Four lanes at every difficulty — the board is always `A S D F`. Only the
    // density, spacing, speed and chording change between tiers, so a player's
    // hand position never has to be relearned moving up. (Charts generated
    // before this change keep their old lane count until regenerated.)
    laneCount: 4,
    subdivision: 1,
    // ~2.2 notes/sec ceiling: roughly quarter notes at typical tempos.
    minGapSec: 0.45,
    // Just under a quarter note: quarters yes, eighths never.
    minGapBeats: 0.9,
    chords: false,
    chordChance: 0,
    targetNps: 1.2,
    approachSec: 1.9,
    // Strongly on-beat: a beginner should almost never face a syncopated note.
    onGridBonus: 2.5,
    // The beat only. A first chart should be the drums a listener is already
    // nodding along to, with the melody left out entirely.
    minPercussive: 0.6,
    // Few and long — on easy a hold is a rest, not a demand. Re-enabled with the
    // holds overhaul (tick scoring + strong tail bonus + on-beat generation).
    holdShare: 0.1,
    minHoldSec: 0.6,
    maxHoldSec: 2.2,
    maxConcurrentHolds: 1,
  },
  medium: {
    name: 'medium',
    laneCount: 4,
    subdivision: 2,
    // ~3.3 notes/sec ceiling: between quarters and eighths, so streams breathe.
    minGapSec: 0.3,
    // Between an eighth and a quarter: eighths land as accents, not as a wall.
    minGapBeats: 0.6,
    chords: true,
    chordChance: 0.05,
    targetNps: 2,
    approachSec: 1.6,
    onGridBonus: 1.6,
    // Beat plus the bass line — the first melodic layer, and the one that most
    // often doubles the kick, so it reinforces the groove rather than fighting it.
    minPercussive: 0.4,
    holdShare: 0.14,
    minHoldSec: 0.5,
    maxHoldSec: 1.8,
    maxConcurrentHolds: 1,
  },
  hard: {
    name: 'hard',
    laneCount: 4,
    subdivision: 4,
    // ~5.2 notes/sec ceiling: comfortable eighths with sixteenth-note bursts.
    minGapSec: 0.19,
    // Between a sixteenth and an eighth: every eighth is available, sixteenths
    // only as bursts. At 90 BPM the old flat 0.19s allowed nearly every
    // sixteenth; this is the difference that fix is about.
    minGapBeats: 0.38,
    chords: true,
    chordChance: 0.15,
    targetNps: 3.6,
    approachSec: 1.3,
    // The old flat value; hard is where off-beat detail starts to belong.
    onGridBonus: 1.2,
    // Most of the mix: drums, bass and sustained harmony. Only the softest
    // melodic movement is still held back.
    minPercussive: 0.2,
    // More and shorter than easy/medium.
    holdShare: 0.18,
    minHoldSec: 0.4,
    maxHoldSec: 1.5,
    maxConcurrentHolds: 1,
  },
  /**
   * Extreme is hard turned up on every axis, spacing included.
   *
   * `minGapSec` is 0.14 — tighter than hard's 0.19, which lifts the sustained-
   * stream ceiling from ~5.2 to ~7.1 notes/sec, so genuinely more pills come
   * through in a dense passage. This is only safe because judging windows are
   * now **per difficulty** (`hitWindowsFor` in `judge.ts`): the `good`/miss
   * window is capped to the chart's own gap, so `hitLane` still cannot retire a
   * neighbouring same-lane note. The cost is that Extreme is judged on a
   * proportionally tighter window (~0.14s good vs 0.19s) — which is exactly
   * what an extreme tier should feel like: less room to be sloppy.
   *
   * The other levers stack on top of the tighter gap:
   *
   *   - `approachSec` 0.95 vs hard's 1.3 — notes cover the highway ~27% faster,
   *     so there is far less time to read each one.
   *   - `targetNps` 5.4 vs 3.6 — the average sits near the new ceiling, so the
   *     dense passages actually fill in rather than breathe.
   *   - `chordChance` 0.32 vs 0.15 — roughly double the two-hand hits.
   */
  extreme: {
    name: 'extreme',
    laneCount: 4,
    subdivision: 4,
    minGapSec: 0.14,
    // Barely wider than a sixteenth — sixteenth streams are on the table, which
    // is the point of the tier. Sits on the floor for anything at or above
    // 120 BPM, so a fast song plays exactly as it does today.
    minGapBeats: 0.28,
    chords: true,
    chordChance: 0.32,
    targetNps: 5.4,
    approachSec: 0.95,
    // Barely tips toward the grid: extreme should keep syncopation as texture.
    onGridBonus: 1.1,
    // Everything, melody included. Zero is the documented "admit all" value and
    // is also what an un-regenerated song effectively gets at every tier.
    minPercussive: 0,
    // Same shape as hard, a touch shorter.
    holdShare: 0.2,
    minHoldSec: 0.35,
    maxHoldSec: 1.3,
    maxConcurrentHolds: 1,
  },
};

/**
 * The spacing a chart is actually generated with: the musical target
 * (`minGapBeats` converted through the song's tempo), floored at the absolute
 * `minGapSec`.
 *
 * Two reasons this is a function of the song rather than a constant:
 *
 *  - **`max`, not a plain conversion.** A fast song would otherwise get a very
 *    tight gap in seconds — 0.28 beats at 180 BPM is 93ms, roughly 10.7
 *    notes/sec — which is past what two thumbs can do and past any window
 *    `hitWindowsFor` has been played at. The floor means the change only ever
 *    *widens* a gap, so no existing chart becomes harder and the fast end keeps
 *    exactly the spacing it has now.
 *  - **`gridTrusted` gates it.** Converting through a tempo nobody believes is
 *    worse than not converting at all: a wrong BPM would scale every gap in the
 *    song by the size of its own error. Below `MIN_GRID_CONFIDENCE` the grid gets
 *    no say anywhere else in generation either (no snapping, no on-beat bonus, no
 *    chord gating), and this is the same rule applied to spacing.
 *
 * Callers must pass the tempo the chart is being built against. Charts record
 * the result on themselves (`Chart.minGapSec`) so judgement can use the same
 * number later without having to recompute it from a tempo that may since have
 * been re-analysed.
 */
export function effectiveMinGapSec(
  params: DifficultyParams,
  bpm: number,
  gridTrusted: boolean,
): number {
  if (!gridTrusted || !Number.isFinite(bpm) || bpm <= 0) return params.minGapSec;
  const beatSec = 60 / bpm;
  return Math.max(params.minGapSec, params.minGapBeats * beatSec);
}

/**
 * Lane -> keyboard key, left hand, scaling outward from the home row.
 * Desktop-first; touch input derives lane geometry independently.
 */
export const KEYMAPS: Record<number, readonly string[]> = {
  3: ['s', 'd', 'f'],
  4: ['a', 's', 'd', 'f'],
  5: ['a', 's', 'd', 'f', 'g'],
};

export function keymapFor(laneCount: number): readonly string[] {
  const keys = KEYMAPS[laneCount];
  if (!keys) throw new Error(`No keymap defined for ${laneCount} lanes`);
  return keys;
}
