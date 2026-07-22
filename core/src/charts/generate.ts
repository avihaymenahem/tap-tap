import type {
  AnalysisResult,
  Chart,
  DifficultyName,
  DifficultyParams,
  Note,
  Onset,
  Waveform,
} from '@tap-tap/shared';
import { DIFFICULTIES, DIFFICULTY_NAMES } from '@tap-tap/shared';
import { percentileRanks } from '../analysis/onsets.js';
import { type Sustain, detectSustains } from '../analysis/sustain.js';
import { hashString, mulberry32 } from '../util/rng.js';
import {
  type Band,
  dominantBand,
  laneRangesByPopulation,
  pickLane,
  pickLaneContour,
} from './lanes.js';

/**
 * Turn a shared onset pool into a playable chart.
 *
 * Analysis runs once per song; each difficulty is a filter over the same
 * onsets. Nothing here touches audio, so regenerating charts after a parameter
 * change is instant.
 */
export function generateChart(
  analysis: AnalysisResult,
  params: DifficultyParams,
  seed: number,
  waveform?: Waveform | null,
): Chart {
  const rand = mulberry32(seed);
  // Optional on purpose: without a waveform there are simply no holds, and the
  // chart is exactly what it was before holds existed. That keeps every caller
  // that has not been given one — and every song whose waveform is missing —
  // working rather than failing.
  const sustains = waveform
    ? detectSustains(waveform, analysis.onsets, {
        minSec: params.minHoldSec,
        maxSec: params.maxHoldSec,
      })
    : [];
  const grid = buildGrid(analysis.beatGrid, params.subdivision);
  // A low-confidence grid gets no say at all. Confidence now measures whether
  // the grid actually sits on the onsets (see analysis/tempo.ts), so below the
  // threshold "the grid already agrees" is coincidence, and nudging even 30ms
  // toward a wrong grid only adds noise to ground truth.
  const gridTrusted = analysis.bpmConfidence >= MIN_GRID_CONFIDENCE;
  const tolerance = gridTrusted ? gridTolerance(grid) : 0;

  // 1. Nudge onsets onto the subdivision grid, but ONLY where the grid already
  //    agrees with them.
  //
  //    The onsets are ground truth measured from the audio. The beat grid is an
  //    estimate extrapolated from a single constant tempo, so it drifts on any
  //    track that is not machine-perfect — a 0.5 BPM error is over a full beat
  //    of drift across three minutes. Snapping unconditionally drags correctly
  //    timed notes onto a wrong grid, and the damage compounds the further into
  //    the song you get, which reads to a player as notes that have nothing to
  //    do with the music.
  const byTime = new Map<string, PoolOnset>();
  for (const onset of analysis.onsets) {
    const nearest = grid.length > 0 ? snapToGrid(grid, onset.t) : onset.t;
    const onGrid = tolerance > 0 && Math.abs(nearest - onset.t) <= tolerance;
    const t = onGrid ? nearest : onset.t;
    const key = t.toFixed(3);
    const existing = byTime.get(key);
    if (!existing || onset.strength > existing.strength) {
      byTime.set(key, { ...onset, t, onGrid });
    }
  }

  // 2. Choose which onsets become notes, section by section.
  const accepted = selectNotes([...byTime.values()], analysis.duration, params);

  // 3. Assign lanes by frequency band, following the music's contour within
  //    each band. The centroid is ranked within the band's own accepted onsets
  //    — the same scale-free reasoning as band classification itself (§2.1):
  //    absolute brightness describes the mix, relative brightness describes
  //    the phrase.
  //
  //    Lane *widths* are sized to how many onsets each band carries, not fixed
  //    at 1/N/1. A hat-driven song is almost all high-band onsets; on a fixed
  //    split those all pile onto the single high lane (the "85% on the right"
  //    report). Sizing the high band's range to its share spreads them across
  //    several lanes, which the contour then rolls through.
  const bands = accepted.map((onset) => dominantBand(onset));
  const bandCounts: Record<Band, number> = { low: 0, mid: 0, high: 0 };
  for (const band of bands) bandCounts[band]++;
  const ranges = laneRangesByPopulation(params.laneCount, bandCounts);
  const contours = contoursByBand(accepted, bands);

  const notes: Note[] = [];
  let previousLane: number | null = null;
  const motion = { direction: 1 as 1 | -1 };

  for (let i = 0; i < accepted.length; i++) {
    const onset = accepted[i]!;
    const band = bands[i]!;
    const lane = pickLaneContour(ranges[band], previousLane, contours[i]!, motion);
    notes.push({ t: round(onset.t), lane, type: 'tap' });
    previousLane = lane;

    if (!params.chords) continue;
    // Chords go to strong onsets with real energy outside their dominant band,
    // so they land on hits that genuinely sound "bigger" — and, when the grid
    // is trusted, only on the grid. An off-beat two-hand hit is something a
    // human charter essentially never writes; on the beat it reads as an
    // accent, off it it reads as a mistake.
    const secondary = secondaryBand(onset, band);
    const onAccent = !gridTrusted || onset.onGrid;
    // The chord goes to the secondary band's lanes, unless that band carried no
    // dominant onsets of its own and so was allocated none (a single-band song).
    // Then it falls to another lane of the primary band, which now spans
    // several — so the two-hand accent still lands rather than being dropped.
    const chordRange =
      secondary && ranges[secondary].length > 0 ? ranges[secondary] : ranges[band];
    if (
      secondary &&
      chordRange.length > 0 &&
      onAccent &&
      onset.strength > 0.55 &&
      rand() < params.chordChance
    ) {
      const chordLane = pickLane(chordRange, lane, rand);
      if (chordLane !== lane) {
        notes.push({ t: round(onset.t), lane: chordLane, type: 'tap' });
      }
    }
  }

  notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
  if (sustains.length > 0) applyHolds(notes, sustains, params);
  return { laneCount: params.laneCount, notes };
}

/**
 * Promote some notes to holds, in place.
 *
 * Runs after lane assignment and sorting because the binding constraint is a
 * lane one: **a hold occupies its lane for its whole length**, so it can only
 * extend as far as the next note in that same lane. Deciding durations before
 * lanes were known would produce holds a player physically cannot honour.
 */
function applyHolds(notes: Note[], sustains: readonly Sustain[], params: DifficultyParams): void {
  const budget = Math.floor(notes.length * params.holdShare);
  if (budget <= 0) return;

  // Next note time per lane, so a hold can be trimmed to end before it.
  const nextInLane = new Map<number, number>();
  const lastSeen = new Array<number>(params.laneCount).fill(Number.POSITIVE_INFINITY);
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i]!;
    nextInLane.set(i, lastSeen[note.lane] ?? Number.POSITIVE_INFINITY);
    lastSeen[note.lane] = note.t;
  }

  // Candidate = a note whose time matches a detected sustain. Matching by
  // rounded time because snapping may have nudged the note off the onset.
  const byTime = new Map<string, Sustain>();
  for (const sustain of sustains) byTime.set(sustain.t.toFixed(2), sustain);

  const candidates: { index: number; sustain: Sustain; duration: number }[] = [];
  notes.forEach((note, index) => {
    const sustain = byTime.get(note.t.toFixed(2));
    if (!sustain) return;

    // Trim so the lane is free again before its next note, with the usual
    // spacing preserved. If that leaves too little, this is a tap.
    const gap = nextInLane.get(index) ?? Number.POSITIVE_INFINITY;
    const room = gap - note.t - params.minGapSec;
    const duration = Math.min(sustain.duration, params.maxHoldSec, room);
    if (duration < params.minHoldSec) return;

    candidates.push({ index, sustain, duration });
  });

  // Steadiest first: when a chart has more candidates than budget, the ones
  // kept should be the most unambiguously sustained, not merely the earliest.
  candidates.sort((a, b) => b.sustain.steadiness - a.sustain.steadiness);

  const accepted: Span[] = [];
  for (const { index, duration } of candidates) {
    if (accepted.length >= budget) break;

    const note = notes[index]!;
    const start = note.t;
    const end = start + round(duration);

    // Cap simultaneous holds. Sustains in different bands land in different
    // lanes at the same instant, so without this the generator stacks three or
    // four of them — which one hand physically cannot hold, and which strands
    // every note in the remaining lanes underneath.
    if (peakConcurrency(accepted, start, end) >= params.maxConcurrentHolds) continue;

    note.type = 'hold';
    note.duration = round(duration);
    accepted.push({ start, end });
  }
}

interface Span {
  start: number;
  end: number;
}

/**
 * The most spans overlapping at any single instant within `[from, to]`.
 *
 * A sweep rather than a count of overlapping spans, because those are not the
 * same question. Given holds at [0,1] and [2,3], a candidate spanning [0.5,2.5]
 * overlaps *both* — but at no instant are three things held, so counting
 * overlaps would reject a perfectly playable hold.
 *
 * Exported for tests: the equal-time ordering below is exactly the kind of
 * off-by-one that would silently let three holds through.
 */
export function peakConcurrency(spans: readonly Span[], from: number, to: number): number {
  const events: { t: number; delta: number }[] = [];
  for (const span of spans) {
    const start = Math.max(span.start, from);
    const end = Math.min(span.end, to);
    if (end <= start) continue;
    events.push({ t: start, delta: 1 }, { t: end, delta: -1 });
  }

  // Ends before starts at an identical time, so spans that merely touch — one
  // finishing exactly as the next begins — are not counted as simultaneous.
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);

  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

/** Generate every difficulty from one analysis pass. */
export function generateAllCharts(
  analysis: AnalysisResult,
  songId: string,
  waveform?: Waveform | null,
): Record<DifficultyName, Chart> {
  const seed = hashString(songId);
  // Driven off DIFFICULTY_NAMES so a new difficulty is generated the moment it
  // is added to the shared list — no second place to update. Each gets a seed
  // offset by its index, so difficulties stay independent of one another and
  // every chart is still deterministic for a given song.
  const charts = {} as Record<DifficultyName, Chart>;
  DIFFICULTY_NAMES.forEach((name, i) => {
    charts[name] = generateChart(analysis, DIFFICULTIES[name], seed + i, waveform);
  });
  return charts;
}

/**
 * Below this `bpmConfidence` the beat grid is ignored entirely: no snapping,
 * no on-grid selection preference, no chord gating. Matches the documented
 * meaning of the score ("below ~0.5 the grid is probably wrong") — and since
 * confidence is now discounted by measured grid/onset agreement, a drifting
 * grid lands under this line instead of quietly steering the chart.
 */
const MIN_GRID_CONFIDENCE = 0.5;

/**
 * Selection multiplier for onsets sitting on a trusted grid. Strength still
 * dominates — this only breaks ties in a crowded neighbourhood — but when a
 * beat and a nearby off-beat scuffle both cannot fit inside `minGapSec`, the
 * note the player gets should be the one on the pulse they are nodding to.
 * That choice is most of what "feels handcrafted" means at selection time.
 */
const ON_GRID_BONUS = 1.2;

/** An onset routed through snapping, remembering whether it landed on the grid. */
interface PoolOnset extends Onset {
  onGrid: boolean;
}

/** Length of each budgeting section, in seconds. */
const SELECTION_WINDOW_SEC = 8;

/**
 * Floor on a section's note count, as a fraction of the difficulty's target
 * density. Guarantees a quiet passage still gets *something*.
 */
const MIN_DENSITY_FRACTION = 0.25;

/**
 * Pick which onsets become notes.
 *
 * Ranking every candidate by absolute strength and taking the top N looks
 * right and fails badly on any track with real dynamics. The note budget is
 * `targetNps × duration`, and a detector finding ~5 onsets/sec offers three
 * times that many candidates — so the cap binds, and since every onset in a
 * quiet passage is weak in absolute terms, *all* of them lose to the loud
 * sections. A track with a soft intro gets literally no notes until it kicks in.
 *
 * Instead the song is split into short sections, each of which is allocated a
 * quota: a floor so nothing is ever empty, plus a share of the remaining budget
 * proportional to how much onset energy that section actually contains. Loud
 * sections still get more notes — which is what makes a chart track the music —
 * but no section gets none.
 */
function selectNotes(pool: PoolOnset[], duration: number, params: DifficultyParams): PoolOnset[] {
  const budget = Math.max(1, Math.floor(params.targetNps * duration));
  const windowCount = Math.max(1, Math.ceil(duration / SELECTION_WINDOW_SEC));

  const buckets: PoolOnset[][] = Array.from({ length: windowCount }, () => []);
  const weights = new Float64Array(windowCount);

  for (const onset of pool) {
    const w = Math.max(0, Math.min(windowCount - 1, Math.floor(onset.t / SELECTION_WINDOW_SEC)));
    buckets[w]!.push(onset);
    weights[w] = weights[w]! + onset.strength;
  }

  const perWindowFloor = Math.max(
    1,
    Math.round(SELECTION_WINDOW_SEC * params.targetNps * MIN_DENSITY_FRACTION),
  );

  const floors = new Int32Array(windowCount);
  let floorTotal = 0;
  let weightSum = 0;
  for (let w = 0; w < windowCount; w++) {
    // An empty section gets nothing — there is genuinely no audio event there.
    floors[w] = Math.min(buckets[w]!.length, perWindowFloor);
    floorTotal += floors[w]!;
    weightSum += weights[w]!;
  }

  const discretionary = Math.max(0, budget - floorTotal);

  const acceptedTimes: number[] = [];
  const accepted: PoolOnset[] = [];

  for (let w = 0; w < windowCount; w++) {
    const bucket = buckets[w]!;
    if (bucket.length === 0) continue;

    const share = weightSum > 0 ? weights[w]! / weightSum : 0;
    const quota = Math.min(bucket.length, floors[w]! + Math.round(discretionary * share));

    // Strongest first within the section, so the notes that survive are the
    // ones a listener would pick out as beats — with a thumb on the scale for
    // onsets on a trusted grid, so when a beat and an off-beat neighbour fight
    // over the same `minGapSec`, the beat wins. (`onGrid` is only ever set when
    // the grid cleared MIN_GRID_CONFIDENCE, so no gate is needed here.)
    const score = (o: PoolOnset): number => o.strength * (o.onGrid ? ON_GRID_BONUS : 1);
    bucket.sort((a, b) => score(b) - score(a));

    let taken = 0;
    for (const onset of bucket) {
      if (taken >= quota) break;
      // Spacing is checked globally, so notes never crowd across a boundary.
      const at = insertionPoint(acceptedTimes, onset.t);
      if (tooClose(acceptedTimes, at, onset.t, params.minGapSec)) continue;
      acceptedTimes.splice(at, 0, onset.t);
      accepted.push(onset);
      taken++;
    }
  }

  accepted.sort((a, b) => a.t - b.t);
  return accepted;
}

// --- helpers ---------------------------------------------------------------

/**
 * Per-note melodic contour, 0..1, ranked within each band separately.
 *
 * The scalar is a spectral centroid of the onset's band shares — where its
 * energy sits on the low→high axis. Ranking it only against other notes in the
 * *same* band matters: a kick is always darker than a hat, so ranked globally
 * every low-band note would pin to 0 and every high-band note to 1, and the
 * lanes inside the mid range would never move. Within a band the rank traces
 * the phrase — verse riff darker, chorus stab brighter — which is the movement
 * `pickLaneContour` turns into lane sweeps.
 */
function contoursByBand(onsets: readonly Onset[], bands: readonly Band[]): number[] {
  const contours = new Array<number>(onsets.length).fill(0.5);
  for (const band of ['low', 'mid', 'high'] as const) {
    const indices: number[] = [];
    for (let i = 0; i < onsets.length; i++) {
      if (bands[i] === band) indices.push(i);
    }
    const ranks = percentileRanks(indices.map((i) => onsets[i]!.high + 0.5 * onsets[i]!.mid));
    indices.forEach((onsetIndex, j) => {
      contours[onsetIndex] = ranks[j]!;
    });
  }
  return contours;
}

function round(t: number): number {
  return Number(t.toFixed(4));
}

/** Expand a beat grid into `subdivision` slots per beat. */
export function buildGrid(beatGrid: number[], subdivision: number): number[] {
  if (beatGrid.length < 2) return [];
  const grid: number[] = [];
  for (let i = 0; i < beatGrid.length - 1; i++) {
    const a = beatGrid[i]!;
    const b = beatGrid[i + 1]!;
    for (let s = 0; s < subdivision; s++) {
      grid.push(a + ((b - a) * s) / subdivision);
    }
  }
  grid.push(beatGrid[beatGrid.length - 1]!);
  return grid;
}

/**
 * How far an onset may be nudged, as a fraction of the grid spacing. Wide
 * enough to tidy detector jitter, tight enough to leave genuinely off-grid
 * notes — and every note on a drifting grid — exactly where they were heard.
 */
const SNAP_TOLERANCE_FRACTION = 0.25;

/**
 * Hard ceiling on snapping, in seconds. The fractional tolerance alone is not
 * enough: a quarter-note grid at 120 BPM would permit 125ms of movement, which
 * is wider than the game's entire "good" hit window. 30ms is below what a
 * player can perceive as being off the beat, so snapping can tidy detector
 * jitter but can never itself make a chart feel out of time.
 */
const MAX_SNAP_SEC = 0.03;

function gridTolerance(grid: number[]): number {
  if (grid.length < 2) return 0;
  const spacing = (grid[grid.length - 1]! - grid[0]!) / (grid.length - 1);
  return Math.min(spacing * SNAP_TOLERANCE_FRACTION, MAX_SNAP_SEC);
}

/** Snap to the grid only if it is already within `tolerance`; otherwise keep `t`. */
export function snapNear(grid: number[], t: number, tolerance: number): number {
  if (grid.length === 0 || tolerance <= 0) return t;
  const nearest = snapToGrid(grid, t);
  return Math.abs(nearest - t) <= tolerance ? nearest : t;
}

/** Nearest grid time to `t`. `grid` must be ascending. */
export function snapToGrid(grid: number[], t: number): number {
  const i = insertionPoint(grid, t);
  const before = grid[i - 1];
  const after = grid[i];
  if (before === undefined) return after ?? t;
  if (after === undefined) return before;
  return t - before <= after - t ? before : after;
}

function insertionPoint(sorted: number[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function tooClose(sorted: number[], at: number, t: number, gap: number): boolean {
  const epsilon = 1e-6;
  const before = sorted[at - 1];
  const after = sorted[at];
  if (before !== undefined && t - before < gap - epsilon) return true;
  if (after !== undefined && after - t < gap - epsilon) return true;
  return false;
}

/** The strongest band other than the dominant one, if it carries real energy. */
function secondaryBand(onset: Onset, dominant: 'low' | 'mid' | 'high') {
  const others = (['low', 'mid', 'high'] as const).filter((b) => b !== dominant);
  let best: 'low' | 'mid' | 'high' | null = null;
  let bestValue = 0.2; // below this the band is background bleed, not content
  for (const b of others) {
    if (onset[b] > bestValue) {
      bestValue = onset[b];
      best = b;
    }
  }
  return best;
}
