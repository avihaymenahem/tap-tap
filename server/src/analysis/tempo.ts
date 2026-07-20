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
   * 0..1 — how strongly the ODF is periodic at the chosen tempo. This is only
   * half of the published `bpmConfidence`: `analyze` scales it by
   * `gridAlignment`, which checks the extrapolated grid against the onsets it
   * is supposed to describe.
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

  // Remove DC so autocorrelation measures periodicity, not overall loudness.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += odf[i]!;
  mean /= n;

  const centered = new Float64Array(n);
  for (let i = 0; i < n; i++) centered[i] = odf[i]! - mean;

  const minLag = Math.max(1, Math.floor(60 / (MAX_BPM * hopSec)));
  const maxLag = Math.min(n - 1, Math.ceil(60 / (MIN_BPM * hopSec)));

  let bestLag = minLag;
  let bestWeighted = -Infinity;
  const scores: number[] = [];

  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += centered[i]! * centered[i + lag]!;
    acc /= n - lag;
    scores.push(acc);

    const candidateBpm = 60 / (lag * hopSec);
    const weighted =
      candidateBpm >= PREFERRED_MIN_BPM && candidateBpm <= PREFERRED_MAX_BPM
        ? acc * OCTAVE_PREFERENCE_BONUS
        : acc;

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
  const refinedLag = refineLag(scores, bestLag - minLag) + minLag;
  const { periodSec, phaseSec } = refineGrid(odf, refinedLag * hopSec, hopSec);
  const bpm = 60 / periodSec;

  // Confidence is how far the winning lag stands above the *spread* of all lag
  // scores. Comparing against the mean does not work: autocorrelation of a
  // mean-centered signal oscillates around zero, so the mean is routinely
  // negative and any ratio against it is meaningless.
  const confidence = peakProminence(scores, bestLag - minLag);
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
 * the peak and its two neighbours and take the vertex. Returns the (possibly
 * fractional) index into `scores`; falls back to the integer peak at the array
 * edges or when the octave-preference bonus picked a shoulder rather than a
 * genuine local maximum, where a parabola has no vertex to find.
 */
function refineLag(scores: number[], i: number): number {
  const before = scores[i - 1];
  const at = scores[i];
  const after = scores[i + 1];
  if (before === undefined || at === undefined || after === undefined) return i;

  const denom = before - 2 * at + after;
  if (denom >= 0) return i;

  const delta = (0.5 * (before - after)) / denom;
  return i + Math.max(-0.5, Math.min(0.5, delta));
}

/**
 * How far the winning score stands above the field, in standard deviations,
 * squashed to 0..1. A strongly periodic track lands around z = 4 or higher;
 * unstructured audio sits near 0.
 */
function peakProminence(scores: number[], bestIndex: number): number {
  const n = scores.length;
  const best = scores[bestIndex];
  if (n < 2 || best === undefined) return 0;

  let mean = 0;
  for (const s of scores) mean += s;
  mean /= n;

  let variance = 0;
  for (const s of scores) variance += (s - mean) ** 2;
  variance /= n;

  const stddev = Math.sqrt(variance);
  if (stddev <= 0) return 0;

  return Math.max(0, Math.min(1, (best - mean) / stddev / 4));
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
): { periodSec: number; phaseSec: number } {
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

  return { periodSec: best.periodSec, phaseSec: best.phaseSec };
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
 * How well the song's strong onsets actually sit on the estimated grid, 0..1.
 *
 * `peakProminence` above answers "is the ODF periodic?" — which says nothing
 * about whether the *extrapolated grid* stayed on the music. A tempo that is
 * wrong by under half a hop still autocorrelates perfectly, then drifts through
 * every phase over a three-minute song. This measures the failure directly:
 * take the stronger half of the onsets and ask what fraction land within a
 * tight tolerance of a beat or half-beat. A drifting grid decays toward the
 * chance rate; a correct one stays near 1 for the whole track.
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
): number {
  // Too little evidence to judge either way: stay neutral rather than
  // penalizing short or sparse tracks for being short.
  if (beatGrid.length < 2 || onsets.length < 8) return 1;

  const first = beatGrid[0]!;
  const spacing = (beatGrid[beatGrid.length - 1]! - first) / (beatGrid.length - 1);
  if (spacing <= 0) return 1;
  const tolerance = Math.min(0.035, spacing * 0.12);

  const strengths = onsets.map((o) => o.strength).sort((a, b) => a - b);
  const median = strengths[strengths.length >> 1]!;
  const strong = onsets.filter((o) => o.strength >= median);
  if (strong.length === 0) return 1;

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
