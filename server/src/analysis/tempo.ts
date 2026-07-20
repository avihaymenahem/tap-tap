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
   * 0..1 — the weaker of beat contrast (energy collected at the fitted grid,
   * against the track average) and beat hit rate (fraction of beats landing on
   * above-average energy). This is only half of the published `bpmConfidence`:
   * `analyze` blends it with `gridAlignment`, which checks the extrapolated
   * grid against the onsets it is supposed to describe.
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
  /** Seconds. One entry per beat, covering the whole track. */
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
    return { bpm: 120, confidence: 0, beatGrid: [] };
  }

  let mean = 0;
  for (let i = 0; i < n; i++) mean += odf[i]!;
  mean /= n;
  if (mean <= 0) {
    // Silence: no energy, no beat, and — deliberately — no grid to snap to.
    return { bpm: 120, confidence: 0, beatGrid: [] };
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
  const { periodSec, phaseSec, energy } = refineGrid(comp, refinedLag * hopSec, hopSec);
  const bpm = 60 / periodSec;

  // Two complementary periodicity measures, and confidence is the *weaker* of
  // them, because each one alone has a blind spot the other covers:
  //
  //   Beat contrast — energy per beat at the fitted grid against the track's
  //   average level. 1 means the grid collects nothing beyond baseline; a
  //   clean click track measures 10+. Blind spot: sparse audio. With a
  //   near-silent baseline, a grid that overfits a handful of *irregular*
  //   clicks still towers over the average — measured, aperiodic test clicks
  //   saturated this at 1.0.
  //
  //   Beat hit rate — the fraction of beat positions that land on above-
  //   average energy. Real rhythmic music puts something audible on nearly
  //   every beat, so a correct grid scores near 1; the overfitted grid above
  //   hits ~20% of its beats. Blind spot: dense uniform activity, where any
  //   grid clears an average-level bar about half the time — which is exactly
  //   where contrast is honestly low.
  const contrast = compMean > 0 ? energy / compMean : 0;
  const contrastConf = Math.max(0, Math.min(1, (contrast - 1) / 1.5));
  const hitRate = beatHitRate(comp, compMean, periodSec, phaseSec, hopSec);
  const confidence = Math.min(contrastConf, hitRate);

  const beatGrid: number[] = [];
  // Same origin as the onset times, so beats and onsets share a timebase.
  // Multiplicative rather than accumulative so a fractional period cannot
  // compound floating error across a few hundred beats.
  for (let k = 0; ; k++) {
    const t = phaseSec + originSec + k * periodSec;
    if (t >= duration) break;
    beatGrid.push(Number(t.toFixed(4)));
  }

  return { bpm: Number(bpm.toFixed(2)), confidence: Number(confidence.toFixed(3)), beatGrid };
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

/** Fraction of the grid's beat positions that land on above-average ODF energy. */
function beatHitRate(
  odf: Float64Array,
  meanLevel: number,
  periodSec: number,
  phaseSec: number,
  hopSec: number,
): number {
  if (meanLevel <= 0) return 0;
  const durationSec = odf.length * hopSec;
  let beats = 0;
  let hits = 0;
  for (let t = phaseSec; t < durationSec; t += periodSec) {
    beats++;
    if (sampleOdf(odf, t / hopSec) >= meanLevel) hits++;
  }
  return beats > 0 ? hits / beats : 0;
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

  const first = beatGrid[0]!;
  const spacing = (beatGrid[beatGrid.length - 1]! - first) / (beatGrid.length - 1);
  if (spacing <= 0) return null;
  const tolerance = Math.min(0.035, spacing * 0.12);

  const strengths = onsets.map((o) => o.strength).sort((a, b) => a - b);
  const median = strengths[strengths.length >> 1]!;
  const strong = onsets.filter((o) => o.strength >= median);
  if (strong.length === 0) return null;

  let aligned = 0;
  for (const onset of strong) {
    // The grid is uniform by construction, so distance-to-nearest-half-beat is
    // arithmetic, not a search.
    const beats = (onset.t - first) / spacing;
    const offBeats = Math.abs(beats - Math.round(beats * 2) / 2);
    if (offBeats * spacing <= tolerance) aligned++;
  }

  const raw = aligned / strong.length;
  // Chance rate: two tolerance windows per half-beat slot.
  const chance = Math.min(0.6, (4 * tolerance) / spacing);
  return Math.max(0, Math.min(1, (raw - chance) / (0.95 - chance)));
}
