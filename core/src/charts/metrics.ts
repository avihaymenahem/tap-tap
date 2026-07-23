import type { AnalysisResult, Chart } from '@tap-tap/shared';

/**
 * A measured read on a generated chart — the numbers, not a listen.
 *
 * The repo's doctrine is that chart quality is *measured, not listened to*
 * (PLAN.md §2.4): the per-second RMS↔note-count correlation alone caught two
 * separate generation bugs. This formalizes that instinct into a scorecard so
 * every future tuning change can be judged against numbers instead of vibes,
 * and so tests can assert regression floors ("density correlation stays
 * positive", "no single lane runs away with the chart").
 *
 * Pure over the chart and its analysis — no audio, no DOM. The intensity proxy
 * is per-second onset strength rather than decoded RMS, because that is what a
 * pure core function has to hand; the two track each other closely enough for
 * the correlation to mean the same thing.
 */
export interface ChartMetrics {
  /** Notes (chord voices included) per second across the song. */
  notesPerSec: number;
  /**
   * Pearson correlation between per-second onset intensity and per-second note
   * count. A chart should get busier where the music does; near zero or
   * negative means the chart is fighting the song. −1..1.
   */
  densityCorrelation: number;
  /**
   * Normalized Shannon entropy of the note-per-lane distribution, 0..1. 1 is a
   * perfectly even spread across lanes; low values mean the chart crowds a few
   * lanes.
   */
  laneShareEntropy: number;
  /** Fraction of notes on the single busiest lane — the "85% on one lane" alarm. */
  maxLaneShare: number;
  /** Fraction of distinct timestamps that carry more than one note (chords). */
  chordRate: number;
  /**
   * Fraction of notes landing within a tight tolerance of a beat or half-beat.
   * High on an on-grid chart with a trusted grid; ~0 when there is no grid.
   */
  onGridShare: number;
  /** Longest run of consecutive notes each within `STREAM_GAP_SEC` of the last. */
  longestStream: number;
  /**
   * How concentrated notes are on a few recurring bar-phase positions, 0..1.
   * A repetitive groove scores high; a chart that reshuffles its rhythm every
   * bar scores low. Rescaled so a perfectly uniform spread maps to 0. Measured
   * at a fixed sixteenth-note resolution so it is comparable across
   * difficulties. 0 when there is no grid to phase against.
   */
  patternConcentration: number;
}

/** Bar length and slot resolution the phase metric measures at. */
const METRIC_BEATS_PER_BAR = 4;
const METRIC_SUBDIVISION = 4;

/** Consecutive notes closer than this are part of the same stream. */
const STREAM_GAP_SEC = 0.3;

/** Tolerance ceiling for counting a note as on-grid. */
const ON_GRID_TOLERANCE_SEC = 0.035;

export function chartMetrics(chart: Chart, analysis: AnalysisResult): ChartMetrics {
  const { notes } = chart;
  const duration = analysis.duration > 0 ? analysis.duration : 1;

  const empty: ChartMetrics = {
    notesPerSec: 0,
    densityCorrelation: 0,
    laneShareEntropy: 0,
    maxLaneShare: 0,
    chordRate: 0,
    onGridShare: 0,
    longestStream: 0,
    patternConcentration: 0,
  };
  if (notes.length === 0) return empty;

  return {
    notesPerSec: notes.length / duration,
    densityCorrelation: densityCorrelation(chart, analysis),
    ...laneStats(chart),
    chordRate: chordRate(chart),
    onGridShare: onGridShare(chart, analysis.beatGrid),
    longestStream: longestStream(chart),
    patternConcentration: patternConcentration(chart, analysis.beatGrid),
  };
}

/** Per-second onset intensity vs per-second note count, correlated. */
function densityCorrelation(chart: Chart, analysis: AnalysisResult): number {
  const bins = Math.max(1, Math.ceil(analysis.duration));
  const intensity = new Float64Array(bins);
  const counts = new Float64Array(bins);

  for (const onset of analysis.onsets) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(onset.t)));
    intensity[b] = intensity[b]! + onset.strength;
  }
  for (const note of chart.notes) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(note.t)));
    counts[b] = counts[b]! + 1;
  }

  return pearson(intensity, counts);
}

function laneStats(chart: Chart): { laneShareEntropy: number; maxLaneShare: number } {
  const hist = new Array<number>(Math.max(1, chart.laneCount)).fill(0);
  for (const note of chart.notes) {
    if (note.lane >= 0 && note.lane < hist.length) hist[note.lane]!++;
  }
  const total = chart.notes.length;
  if (total === 0) return { laneShareEntropy: 0, maxLaneShare: 0 };

  let entropy = 0;
  let max = 0;
  for (const count of hist) {
    if (count > max) max = count;
    if (count > 0) {
      const p = count / total;
      entropy -= p * Math.log(p);
    }
  }
  // Normalize against the maximum possible entropy (a perfectly even spread).
  const norm = hist.length > 1 ? Math.log(hist.length) : 1;
  return { laneShareEntropy: entropy / norm, maxLaneShare: max / total };
}

function chordRate(chart: Chart): number {
  const perTime = new Map<number, number>();
  for (const note of chart.notes) {
    perTime.set(note.t, (perTime.get(note.t) ?? 0) + 1);
  }
  if (perTime.size === 0) return 0;
  let chorded = 0;
  for (const count of perTime.values()) if (count > 1) chorded++;
  return chorded / perTime.size;
}

function onGridShare(chart: Chart, beatGrid: number[]): number {
  if (beatGrid.length < 2) return 0;
  const spacing = medianGap(beatGrid);
  if (spacing <= 0) return 0;
  const tolerance = Math.min(ON_GRID_TOLERANCE_SEC, spacing * 0.12);

  let aligned = 0;
  for (const note of chart.notes) {
    if (nearestBeatDistance(note.t, beatGrid) <= tolerance) aligned++;
  }
  return chart.notes.length > 0 ? aligned / chart.notes.length : 0;
}

function longestStream(chart: Chart): number {
  const times = [...new Set(chart.notes.map((n) => n.t))].sort((a, b) => a - b);
  if (times.length === 0) return 0;
  let longest = 1;
  let run = 1;
  for (let i = 1; i < times.length; i++) {
    if (times[i]! - times[i - 1]! <= STREAM_GAP_SEC + 1e-9) run++;
    else run = 1;
    if (run > longest) longest = run;
  }
  return longest;
}

function patternConcentration(chart: Chart, beatGrid: number[]): number {
  if (beatGrid.length < 2) return 0;
  const bucketCount = METRIC_BEATS_PER_BAR * METRIC_SUBDIVISION;
  const hist = new Float64Array(bucketCount);
  let total = 0;
  for (const note of chart.notes) {
    const bucket = barPhaseBucket(note.t, beatGrid);
    if (bucket === null) continue;
    hist[bucket] = hist[bucket]! + 1;
    total++;
  }
  if (total === 0) return 0;

  // Herfindahl concentration, rescaled so uniform → 0, single-bucket → 1.
  let hhi = 0;
  for (const count of hist) {
    const p = count / total;
    hhi += p * p;
  }
  const floor = 1 / bucketCount;
  return Math.max(0, Math.min(1, (hhi - floor) / (1 - floor)));
}

// --- shared helpers --------------------------------------------------------

function pearson(xs: Float64Array, ys: Float64Array): number {
  const n = xs.length;
  if (n < 2) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return 0;
  return num / Math.sqrt(dx * dy);
}

/** The bar-phase bucket of a time, at the metric's fixed resolution, or null. */
function barPhaseBucket(t: number, beatGrid: number[]): number | null {
  // Enclosing beat: last grid entry at or before t (the +epsilon makes a note
  // sitting exactly on a beat belong to that beat, not the interval before it).
  const j = lowerBound(beatGrid, t + 1e-9) - 1;
  if (j < 0 || j >= beatGrid.length - 1) return null;
  const b0 = beatGrid[j]!;
  const b1 = beatGrid[j + 1]!;
  if (b1 <= b0) return null;

  const f = (t - b0) / (b1 - b0);
  let slot = Math.round(f * METRIC_SUBDIVISION);
  let beat = j;
  if (slot >= METRIC_SUBDIVISION) {
    slot = 0;
    beat = j + 1;
  }
  return (beat % METRIC_BEATS_PER_BAR) * METRIC_SUBDIVISION + slot;
}

function nearestBeatDistance(t: number, beatGrid: number[]): number {
  const i = lowerBound(beatGrid, t);
  const before = beatGrid[i - 1];
  const after = beatGrid[i];
  let distance = Number.POSITIVE_INFINITY;
  if (before !== undefined) distance = Math.min(distance, t - before);
  if (after !== undefined) distance = Math.min(distance, after - t);
  if (before !== undefined && after !== undefined) {
    distance = Math.min(distance, Math.abs(t - (before + after) / 2));
  }
  return distance;
}

function medianGap(beatGrid: number[]): number {
  const gaps = beatGrid.slice(1).map((b, i) => b - beatGrid[i]!).sort((a, b) => a - b);
  return gaps.length > 0 ? gaps[gaps.length >> 1]! : 0;
}

/** First index whose value is >= t. `sorted` must be ascending. */
function lowerBound(sorted: number[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
