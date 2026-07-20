/**
 * Tempo and beat-grid estimation from an onset detection function.
 *
 * Two stages: autocorrelate the ODF to find the beat period, then sweep phase
 * to find where the downbeats actually land. Both operate on the same ODF the
 * onset detector produced, so onset times and beat times share a timebase.
 */

const MIN_BPM = 60;
const MAX_BPM = 200;

/**
 * Tempo estimation is octave-ambiguous: a 75 BPM track correlates just as well
 * at 150. Candidates inside this range are preferred, which matches where most
 * popular music actually sits and keeps charts from feeling half- or double-time.
 */
const PREFERRED_MIN_BPM = 90;
const PREFERRED_MAX_BPM = 180;
const OCTAVE_PREFERENCE_BONUS = 1.15;

export interface TempoResult {
  bpm: number;
  /**
   * 0..1 — the weakest of beat contrast (energy collected at the tracked
   * beats, against the track average), beat hit rate (fraction of beats
   * landing on above-average energy) and gap steadiness. This is only part of
   * the published `bpmConfidence`: `analyze` blends it with `gridAlignment`,
   * which checks the grid against the onsets it is supposed to describe.
   *
   * Grid-based measures, not autocorrelation prominence. The first confidence
   * was a z-score of the winning lag against the whole lag field, and real
   * music fails that test while having a perfectly good beat: a rhythmic track
   * has autocorrelation peaks at *every* harmonic of its tempo (half, double,
   * triple...), all of which inflate the field's mean and spread, so only a
   * metronome ever scored high. The complaint that surfaced it was exactly
   * that — solid steady songs reporting 0.4 "confidence".
   */
  confidence: number;
  /**
   * 0..1 — share of inter-beat gaps within ±12% of the typical gap. Exposed
   * separately because it must also *cap* the blended `bpmConfidence`: onset
   * alignment is trivially perfect against beats that were tracked onto
   * arrhythmic hits, so no amount of alignment may rescue an unsteady pulse.
   */
  steadiness: number;
  /** Seconds. One entry per tracked beat, covering the whole track. */
  beatGrid: number[];
}

export function estimateTempo(
  odf: Float64Array,
  hopSec: number,
  duration: number,
  originSec = 0,
): TempoResult {
  const n = odf.length;
  if (n < 4) {
    return { bpm: 120, confidence: 0, steadiness: 0, beatGrid: [] };
  }

  let mean = 0;
  for (let i = 0; i < n; i++) mean += odf[i]!;
  mean /= n;
  if (mean <= 0) {
    // Silence: no energy, no beat, and — deliberately — no grid to snap to.
    return { bpm: 120, confidence: 0, steadiness: 0, beatGrid: [] };
  }

  // Log-compress the ODF before any periodicity work. Raw spectral flux gives
  // a loud chorus several times the weight of a quiet verse, so the
  // autocorrelation ends up describing whichever section is loudest rather
  // than the song — and a grid fitted to one section is exactly the kind that
  // drifts everywhere else. Compression is *local* to tempo estimation: the
  // onset detector's thresholds were swept against the raw ODF (§2.4) and
  // must not inherit this.
  const comp = new Float64Array(n);
  let compMean = 0;
  for (let i = 0; i < n; i++) {
    comp[i] = Math.log1p(odf[i]! / mean);
    compMean += comp[i]!;
  }
  compMean /= n;

  // Remove DC so autocorrelation measures periodicity, not overall loudness.
  const centered = new Float64Array(n);
  for (let i = 0; i < n; i++) centered[i] = comp[i]! - compMean;

  const minLag = Math.max(1, Math.floor(60 / (MAX_BPM * hopSec)));
  const maxLag = Math.min(n - 1, Math.ceil(60 / (MIN_BPM * hopSec)));
  // The ACF extends to double the candidate range so every candidate can see
  // the score at twice its own lag (harmonic aggregation below).
  const extendedMax = Math.min(n - 1, 2 * (maxLag + 1));

  const acf = new Float64Array(extendedMax + 1);
  for (let lag = minLag; lag <= extendedMax; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += centered[i]! * centered[i + lag]!;
    acf[lag] = acc / (n - lag);
  }

  // Harmonic aggregation: a candidate is scored by its own lag *plus* half the
  // score at double its lag. The true beat period correlates at every multiple
  // of itself, so this rewards the tempo whose whole harmonic family is
  // present — and demotes the classic half-period (double-time) error, whose
  // doubled lag is the true period's own peak but whose own peak is weak.
  // Indexed by lag (not offset) so the parabola below reads neighbours
  // directly; one slot past maxLag is filled for that reason.
  const totals = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= Math.min(extendedMax, maxLag + 1); lag++) {
    const doubled = 2 * lag;
    totals[lag] = acf[lag]! + (doubled <= extendedMax ? 0.5 * acf[doubled]! : 0);
  }

  let bestLag = minLag;
  let bestWeighted = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const candidateBpm = 60 / (lag * hopSec);
    const weighted =
      candidateBpm >= PREFERRED_MIN_BPM && candidateBpm <= PREFERRED_MAX_BPM
        ? totals[lag]! * OCTAVE_PREFERENCE_BONUS
        : totals[lag]!;

    if (weighted > bestWeighted) {
      bestWeighted = weighted;
      bestLag = lag;
    }
  }

  // The integer lag quantizes the period to whole ODF hops (~11.6ms), which at
  // 120 BPM is a BPM step of ~2.8 — the true tempo can sit up to ~1.4 BPM off
  // the nearest representable value, and 0.5 BPM of error is already over a
  // full beat of drift across three minutes (§2.2). Interpolating a parabola
  // through the winning lag's neighbours recovers most of the sub-hop period;
  // `refineGrid` below then polishes period and phase jointly against the ODF,
  // which removes the parabola's own bias (an autocorrelation peak is not a
  // parabola — measured, the vertex alone still left ~40ms of drift at the end
  // of a one-minute track).
  const refinedLag = refineLag(totals, bestLag, minLag);
  const { periodSec, phaseSec } = refineGrid(comp, refinedLag * hopSec, hopSec);

  // Track beats through the song instead of extrapolating one constant grid.
  //
  // A constant (period, phase) is only right for machine-quantized music.
  // Anything played by humans drifts a few percent, and against a drifting
  // song a constant grid is wrong *everywhere except one lucky stretch* — the
  // fitted average tempo walks off the music in both directions. Dynamic
  // programming lets each beat land where the music actually put it, paying a
  // penalty for straying from the estimated tempo, so slow drift is followed
  // while genuinely aperiodic audio still cannot fabricate a steady pulse.
  // The refined constant grid seeds the search and remains the fallback.
  let beats = trackBeats(comp, periodSec / hopSec, compMean);
  if (beats.length < 2) {
    beats = [];
    for (let k = 0; phaseSec + k * periodSec < n * hopSec; k++) {
      beats.push((phaseSec + k * periodSec) / hopSec);
    }
  }

  // The typical tracked gap, not the seed period: on a drifting song this is
  // the honest single number for "the" tempo. Interquartile mean rather than
  // either plain statistic — the median picks one side of the slight
  // alternation real material shows (a kick's flux peaks later in its envelope
  // than a hat's), and the raw mean is skewed by the occasional extra or
  // dropped beat.
  const gaps = beats.slice(1).map((b, i) => b - beats[i]!);
  const typicalGapFrames = interquartileMean(gaps) || periodSec / hopSec;
  const bpm = 60 / (typicalGapFrames * hopSec);

  // Steadiness: the share of inter-beat gaps within ±12% of the typical gap.
  // This is what separates "a pulse that drifts" from "no pulse at all" now
  // that beats are tracked rather than extrapolated — the tracker will happily
  // place beats on every click of an *arrhythmic* track (that is its job), and
  // those beats collect plenty of energy, so contrast, hit rate and alignment
  // all pass. Their gaps give it away: a human drummer wanders a couple of
  // percent per beat, an accelerando a few more, while arrhythmia shows gaps
  // scattered across half an octave.
  //
  // Rescaled so that chance-level regularity maps to 0: even on arrhythmic
  // audio the tracker's stray penalty keeps about half the gaps near the
  // period (measured ~0.4-0.5 on the irregular-clicks fixture), so the raw
  // share never approaches 0 and using it directly would leave noise floors
  // around 0.5 "confidence" — the exact under/over-reporting this score keeps
  // being rebuilt to kill.
  const medianGap = median(gaps);
  let steady = 0;
  for (const gap of gaps) {
    if (medianGap > 0 && Math.abs(gap - medianGap) <= medianGap * 0.12) steady++;
  }
  const steadyShare = gaps.length > 0 ? steady / gaps.length : 0;
  const steadiness = Math.max(0, Math.min(1, (steadyShare - 0.5) / 0.45));

  // Two complementary periodicity measures against the *tracked* beats, and
  // confidence is the weaker of them, because each alone has a blind spot the
  // other covers:
  //
  //   Beat contrast — energy per beat against the track's average level. 1
  //   means the beats collect nothing beyond baseline; a clean click track
  //   measures 10+. Blind spot: sparse audio. With a near-silent baseline,
  //   beats overfitted onto a handful of *irregular* clicks still tower over
  //   the average — measured, aperiodic test clicks saturated this at 1.0.
  //
  //   Beat hit rate — the fraction of beat positions that land on above-
  //   average energy. Real rhythmic music puts something audible on nearly
  //   every beat, so correct beats score near 1; the overfitted ones above hit
  //   ~20%. Blind spot: dense uniform activity, where any position clears an
  //   average-level bar about half the time — which is exactly where contrast
  //   is honestly low.
  let energySum = 0;
  let hits = 0;
  for (const b of beats) {
    const v = sampleOdf(comp, b);
    energySum += v;
    if (v >= compMean) hits++;
  }
  const contrast = compMean > 0 && beats.length > 0 ? energySum / beats.length / compMean : 0;
  const contrastConf = Math.max(0, Math.min(1, (contrast - 1) / 1.5));
  const hitRate = beats.length > 0 ? hits / beats.length : 0;
  const confidence = Math.min(contrastConf, hitRate, steadiness);

  // Same origin as the onset times, so beats and onsets share a timebase.
  const beatGrid = beats
    .map((b) => Number((b * hopSec + originSec).toFixed(4)))
    .filter((t) => t < duration);

  return {
    bpm: Number(bpm.toFixed(2)),
    confidence: Number(confidence.toFixed(3)),
    steadiness: Number(steadiness.toFixed(3)),
    beatGrid,
  };
}

/**
 * Dynamic-programming beat tracking over the (compressed) ODF, after Ellis.
 *
 * Every frame scores as a potential beat: its own onset energy plus the best
 * predecessor's score one period back, minus a penalty that grows with how far
 * the actual gap strays from the estimated period. The tightness constant is
 * the whole character of the tracker — too loose and beats wander onto
 * syncopation, too tight and it cannot follow a human drummer. Tuned against
 * the tempoRamp fixture (must follow a 118→126 BPM ramp beat for beat) and the
 * steady-click fixtures (must not lose to the constant grid there).
 *
 * Beats are refined to fractional frames afterwards by fitting a parabola at
 * the local ODF peak, but only where there is a real event to refine against —
 * beats extrapolated through silence keep their DP position.
 */
function trackBeats(comp: Float64Array, periodFrames: number, compMean: number): number[] {
  const n = comp.length;
  if (n === 0 || periodFrames < 2 || compMean <= 0) return [];

  // Scale-free onset weight: the penalty must mean the same thing on a loud
  // master and a quiet one.
  const weight = new Float64Array(n);
  for (let i = 0; i < n; i++) weight[i] = comp[i]! / compMean;

  // Sets how expensive straying from the estimated period is, against onset
  // energy measured in track-average units. The failure it must prevent: hats
  // sit on every half-beat, so a loose tracker profitably halves its gaps and
  // double-times the whole song (measured at tightness 3 on the groove
  // fixture). At 10, halving costs (ln 0.5)² × 10 ≈ 4.8 per beat — more than a
  // hat is worth — while a real tempo ramp's ~3% gap changes cost under 0.01.
  const TIGHTNESS = 10;
  const minGap = Math.max(1, Math.round(periodFrames * 0.5));
  const maxGap = Math.round(periodFrames * 1.8);

  const score = new Float64Array(n).fill(-Infinity);
  const prev = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    score[i] = weight[i]!;
    const lo = Math.max(0, i - maxGap);
    const hi = i - minGap;
    let bestScore = -Infinity;
    let bestJ = -1;
    for (let j = lo; j <= hi; j++) {
      const gap = i - j;
      const stray = Math.log(gap / periodFrames);
      const s = score[j]! - TIGHTNESS * stray * stray;
      if (s > bestScore) {
        bestScore = s;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      score[i] = weight[i]! + bestScore;
      prev[i] = bestJ;
    }
  }

  // End on the best-scoring frame near the end of the track, then backtrack.
  let end = -1;
  let endScore = -Infinity;
  for (let i = Math.max(0, n - Math.round(periodFrames * 1.2)); i < n; i++) {
    if (score[i]! > endScore) {
      endScore = score[i]!;
      end = i;
    }
  }
  if (end < 0) return [];

  const beats: number[] = [];
  for (let i = end; i >= 0; i = prev[i]!) {
    beats.push(i);
    if (prev[i]! < 0) break;
  }
  beats.reverse();

  // Sub-frame refinement against the local ODF peak, where one exists. The
  // edge guard matters: a beat at frame 0 has no left neighbour, and a parabola
  // through `undefined` silently NaNs the beat and everything derived from it.
  return beats.map((b) => {
    let peak = Math.min(Math.max(b, 1), n - 2);
    for (let j = Math.max(1, b - 2); j <= Math.min(n - 2, b + 2); j++) {
      if (comp[j]! > comp[peak]!) peak = j;
    }
    if (comp[peak]! < compMean) return b;
    const before = comp[peak - 1]!;
    const at = comp[peak]!;
    const after = comp[peak + 1]!;
    const denom = before - 2 * at + after;
    if (denom >= 0) return peak;
    const delta = (0.5 * (before - after)) / denom;
    return peak + Math.max(-0.5, Math.min(0.5, delta));
  });
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

/** Mean of the middle half of the values. */
function interquartileMean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const lo = Math.floor(sorted.length / 4);
  const hi = Math.max(lo + 1, Math.ceil((3 * sorted.length) / 4));
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += sorted[i]!;
  return sum / (hi - lo);
}

/**
 * Sub-hop refinement of the winning autocorrelation lag: fit a parabola through
 * the peak and its two neighbours and take the vertex. `totals` is indexed by
 * lag. Falls back to the integer peak at the candidate-range edges or when the
 * octave-preference bonus picked a shoulder rather than a genuine local
 * maximum, where a parabola has no vertex to find.
 */
function refineLag(totals: Float64Array, lag: number, minLag: number): number {
  if (lag - 1 < minLag || lag + 1 >= totals.length) return lag;
  const before = totals[lag - 1]!;
  const at = totals[lag]!;
  const after = totals[lag + 1]!;

  const denom = before - 2 * at + after;
  if (denom >= 0) return lag;

  const delta = (0.5 * (before - after)) / denom;
  return lag + Math.max(-0.5, Math.min(0.5, delta));
}

/**
 * Polish period and phase jointly: pick the (period, phase) pair whose beat
 * positions collect the most ODF energy per beat.
 *
 * This optimizes the exact quantity chart generation depends on — "does the
 * extrapolated grid sit on the onsets all the way to the end?" — rather than a
 * proxy for it. Period error compounds (0.3ms per beat is 40ms of drift by the
 * end of a one-minute track, and the whole hit window on hard is ~90ms), so
 * the search is two-pass: a coarse sweep of ±0.6 hops around the guess, then a
 * fine sweep of ±0.06 hops around the coarse winner, ending at sub-0.1ms
 * period resolution for the cost of ~50 candidate evaluations.
 */
function refineGrid(
  odf: Float64Array,
  periodGuessSec: number,
  hopSec: number,
): { periodSec: number; phaseSec: number; energy: number } {
  let best = { periodSec: periodGuessSec, phaseSec: 0, energy: -Infinity };

  const sweep = (centerSec: number, halfWidthSec: number, steps: number): void => {
    for (let s = 0; s <= steps; s++) {
      const period = centerSec - halfWidthSec + (2 * halfWidthSec * s) / steps;
      if (period <= hopSec) continue;
      const { phaseSec, energy } = bestPhase(odf, period, hopSec);
      if (energy > best.energy) best = { periodSec: period, phaseSec, energy };
    }
  };

  sweep(periodGuessSec, hopSec * 0.6, 24);
  sweep(best.periodSec, hopSec * 0.06, 24);

  return best;
}

/**
 * Given a beat period, find the offset whose beat positions collect the most
 * onset energy. Returns the offset in seconds within the ODF's own timebase.
 *
 * The period is fractional (see `refineLag`), so this cannot stride the ODF by
 * whole frames the way the first version did. It sweeps phase at quarter-hop
 * resolution (~3ms) and samples the ODF with linear interpolation, which also
 * replaces the old max-of-three-frames neighbourhood — a beat between two
 * frames now contributes its interpolated value instead of whichever
 * neighbour happened to be larger.
 *
 * Energy is per beat, not summed: candidate periods place slightly different
 * beat counts across the track, and a raw sum would bias toward whichever
 * candidate fits one more beat in.
 */
function bestPhase(
  odf: Float64Array,
  periodSec: number,
  hopSec: number,
): { phaseSec: number; energy: number } {
  const durationSec = odf.length * hopSec;
  const step = hopSec / 4;
  let bestPhaseSec = 0;
  let bestEnergy = -Infinity;

  for (let phase = 0; phase < periodSec; phase += step) {
    let energy = 0;
    let beats = 0;
    for (let t = phase; t < durationSec; t += periodSec) {
      energy += sampleOdf(odf, t / hopSec);
      beats++;
    }
    if (beats === 0) continue;
    energy /= beats;
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestPhaseSec = phase;
    }
  }

  return { phaseSec: bestPhaseSec, energy: bestEnergy };
}

/** Linearly interpolated ODF value at a fractional frame index. */
function sampleOdf(odf: Float64Array, x: number): number {
  const i = Math.floor(x);
  const a = odf[i];
  if (a === undefined) return 0;
  const b = odf[i + 1] ?? a;
  return a + (b - a) * (x - i);
}

/**
 * How well the song's strong onsets actually sit on the estimated grid, 0..1 —
 * or `null` when there is too little evidence to judge either way.
 *
 * Beat contrast (above) answers "does the grid collect energy?" — which says
 * little about whether the *extrapolated grid* stayed on the music. A tempo
 * that is wrong by under half a hop still autocorrelates perfectly, then
 * drifts through every phase over a three-minute song. This measures the
 * failure directly: take the stronger half of the onsets and ask what fraction
 * land within a tight tolerance of a beat or half-beat. A drifting grid decays
 * toward the chance rate; a correct one stays near 1 for the whole track.
 *
 * Half-beats, not beats: offbeat hits (hats, snares on 2 and 4 are fine — they
 * are ON the grid at subdivision 2) must not read as misalignment. Finer
 * subdivisions are excluded on purpose — at sixteenths the slots are so dense
 * that random times "align" half the time and the measure stops measuring.
 *
 * The result is rescaled against the chance rate — the fraction of random
 * times that would land inside a tolerance window by accident — so 0 means
 * "no better than chance" rather than "no onsets aligned".
 */
export function gridAlignment(
  onsets: readonly { t: number; strength: number }[],
  beatGrid: readonly number[],
): number | null {
  // Too little evidence to judge either way. Null, not a neutral score: the
  // caller decides what "unknown" means, and folding it into a number here
  // would let a near-silent track borrow confidence it never earned.
  if (beatGrid.length < 2 || onsets.length < 8) return null;

  const spacing = median(beatGrid.slice(1).map((b, i) => b - beatGrid[i]!));
  if (spacing <= 0) return null;
  const tolerance = Math.min(0.035, spacing * 0.12);

  const strengths = onsets.map((o) => o.strength).sort((a, b) => a - b);
  const strengthMedian = strengths[strengths.length >> 1]!;
  const strong = onsets.filter((o) => o.strength >= strengthMedian);
  if (strong.length === 0) return null;

  let aligned = 0;
  for (const onset of strong) {
    // The tracked grid is not uniform, so this is a search, not arithmetic:
    // distance to the nearest of the surrounding beats or their midpoint.
    const i = lowerBound(beatGrid, onset.t);
    const before = beatGrid[i - 1];
    const after = beatGrid[i];
    let distance = Number.POSITIVE_INFINITY;
    if (before !== undefined) distance = Math.min(distance, onset.t - before);
    if (after !== undefined) distance = Math.min(distance, after - onset.t);
    if (before !== undefined && after !== undefined) {
      distance = Math.min(distance, Math.abs(onset.t - (before + after) / 2));
    }
    if (distance <= tolerance) aligned++;
  }

  const raw = aligned / strong.length;
  // Chance rate: two tolerance windows per half-beat slot.
  const chance = Math.min(0.6, (4 * tolerance) / spacing);
  return Math.max(0, Math.min(1, (raw - chance) / (0.95 - chance)));
}

/** First index whose value is >= t. `sorted` must be ascending. */
function lowerBound(sorted: readonly number[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
