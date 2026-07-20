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
  /** 0..1. Below ~0.5 the grid is probably wrong. */
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

  const bpm = 60 / (bestLag * hopSec);

  // Confidence is how far the winning lag stands above the *spread* of all lag
  // scores. Comparing against the mean does not work: autocorrelation of a
  // mean-centered signal oscillates around zero, so the mean is routinely
  // negative and any ratio against it is meaningless.
  const confidence = peakProminence(scores, bestLag - minLag);

  const phaseFrames = estimatePhase(odf, bestLag);
  const periodSec = bestLag * hopSec;
  const beatGrid: number[] = [];
  // Same origin as the onset times, so beats and onsets share a timebase.
  for (let t = phaseFrames * hopSec + originSec; t < duration; t += periodSec) {
    beatGrid.push(Number(t.toFixed(4)));
  }

  return { bpm: Number(bpm.toFixed(2)), confidence: Number(confidence.toFixed(3)), beatGrid };
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
 * Given a beat period, find the offset whose beat positions collect the most
 * onset energy. Returns the offset in frames.
 */
function estimatePhase(odf: Float64Array, lagFrames: number): number {
  const n = odf.length;
  let bestPhase = 0;
  let bestEnergy = -Infinity;

  for (let phase = 0; phase < lagFrames; phase++) {
    let energy = 0;
    for (let i = phase; i < n; i += lagFrames) {
      // Sample a small neighbourhood: real beats rarely land exactly on a frame.
      const a = odf[i - 1] ?? 0;
      const b = odf[i]!;
      const c = odf[i + 1] ?? 0;
      energy += Math.max(a, b, c);
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestPhase = phase;
    }
  }

  return bestPhase;
}
