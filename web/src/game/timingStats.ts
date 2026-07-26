/**
 * Timing distribution and per-section accuracy — the two things a summary
 * statistic cannot tell a player.
 *
 * The results card already reports a mean offset and an early/late split. Neither
 * distinguishes the cases that call for different actions: a **wide symmetric
 * spread** means practise, a **narrow spike sitting off centre** means recalibrate,
 * and **two humps** usually means one hand is lagging the other. Those are shapes,
 * so the fix is to keep the shape rather than another average.
 *
 * A histogram rather than the raw deltas, for two reasons: it is bounded (a long
 * extreme chart is ~1000 hits) and it is what gets persisted with the run, so the
 * results card can be revisited without storing a growing array of floats.
 *
 * Pure, so both are unit-testable without an engine.
 */

/**
 * Bin width, in seconds.
 *
 * 20ms is a deliberate compromise. Finer bins on a short easy chart give a comb of
 * ones and twos with no readable shape; coarser ones hide the thing the histogram
 * exists to show, since `EXACT_WINDOW` is 22ms and a spike one bin wide is exactly
 * the "recalibrate" signal.
 */
export const HISTOGRAM_BIN_SEC = 0.02;

/**
 * Number of bins. Odd on purpose, so one bin is centred on zero rather than the
 * origin falling on a boundary — a histogram whose middle straddles "dead on"
 * cannot show a centred distribution as centred.
 */
export const HISTOGRAM_BINS = 21;

/** Index of the bin straddling zero. */
export const HISTOGRAM_CENTRE = (HISTOGRAM_BINS - 1) / 2;

/** Widest delta the histogram represents; anything beyond clamps into the end bins. */
export const HISTOGRAM_SPAN_SEC = (HISTOGRAM_BINS / 2) * HISTOGRAM_BIN_SEC;

/**
 * How many slices a song is divided into for per-section accuracy.
 *
 * Eight is enough to locate a collapse ("the last eighth fell apart") without
 * implying the game knows where the chorus is — it does not. Equal time slices are
 * honest about that; naming them after song structure would not be.
 */
export const SECTION_COUNT = 8;

export function emptyHistogram(): number[] {
  return new Array<number>(HISTOGRAM_BINS).fill(0);
}

/**
 * Bin index for a signed timing delta, in seconds. Negative is early.
 *
 * Clamped rather than dropped: a delta at the edge of a wide judgement window is
 * still a real hit, and silently discarding it would make the histogram's total
 * disagree with the hit count.
 */
export function binForDelta(deltaSec: number): number {
  if (!Number.isFinite(deltaSec)) return HISTOGRAM_CENTRE;
  // Rounded on the magnitude, then re-signed, because `Math.round` is not
  // symmetric at a half: it takes 2.5 up to 3 but −2.5 up to −2. A delta landing
  // exactly on a bin boundary would otherwise bin differently depending on its
  // sign, putting a small false early/late skew into the very chart whose job is
  // to show whether a skew exists.
  const steps = Math.round(Math.abs(deltaSec) / HISTOGRAM_BIN_SEC);
  const offset = deltaSec < 0 ? -steps : steps;
  return Math.max(0, Math.min(HISTOGRAM_BINS - 1, HISTOGRAM_CENTRE + offset));
}

/** The signed delta at the centre of a bin, for axis labels. */
export function binCentreSec(bin: number): number {
  return (bin - HISTOGRAM_CENTRE) * HISTOGRAM_BIN_SEC;
}

/**
 * Which section a song time falls in.
 *
 * `duration` is the song's, not the chart's last note — a chart that stops early
 * should show its final sections as empty rather than stretching the rest to fill
 * the bar.
 */
export function sectionFor(t: number, duration: number): number {
  if (!(duration > 0) || !Number.isFinite(t)) return 0;
  const index = Math.floor((t / duration) * SECTION_COUNT);
  return Math.max(0, Math.min(SECTION_COUNT - 1, index));
}

export interface SectionTally {
  /** Notes judged in this section. */
  judged: number;
  /** Sum of tier score values earned, for the accuracy ratio. */
  earned: number;
  /** The maximum those judged notes could have earned. */
  possible: number;
}

export function emptySections(): SectionTally[] {
  return Array.from({ length: SECTION_COUNT }, () => ({ judged: 0, earned: 0, possible: 0 }));
}

/**
 * Accuracy per section, 0..1, or `null` for a section with nothing in it.
 *
 * Null rather than zero: a section a chart never reached is not a section the
 * player failed, and drawing it as a floor-height bar reads as exactly that.
 */
export function sectionAccuracies(sections: readonly SectionTally[]): (number | null)[] {
  return sections.map((s) => (s.judged > 0 && s.possible > 0 ? s.earned / s.possible : null));
}

/**
 * The largest count in the histogram, for scaling the bars.
 *
 * Returned rather than computed in the view so the empty case has one obvious
 * answer — dividing by a zero peak would put `NaN` into every bar's height.
 */
export function histogramPeak(histogram: readonly number[]): number {
  return histogram.reduce((max, n) => (n > max ? n : max), 0);
}
