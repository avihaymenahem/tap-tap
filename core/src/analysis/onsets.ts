import type { Onset } from '@tap-tap/shared';
import { FFT, hannWindow } from './fft.js';

/**
 * Spectral-flux onset detection with an adaptive median threshold.
 *
 * These are the knobs that matter for making generated charts feel good.
 * Raising `thresholdMultiplier` yields fewer, more confident onsets; lowering
 * it picks up quieter detail at the cost of false positives.
 */
export interface OnsetOptions {
  frameSize: number;
  hopSize: number;
  /** Local-median multiplier for the adaptive threshold. Higher = fewer onsets. */
  thresholdMultiplier: number;
  /** Half-width, in frames, of the adaptive-threshold window. */
  medianWindowFrames: number;
  /** Minimum seconds between detected onsets. */
  minSeparationSec: number;
  /**
   * Bounds on the local threshold, as multiples of the track's global median.
   *
   * The threshold has to stay *local* — a quiet intro must be measured against
   * itself, not against the loud chorus two minutes later — but it must not run
   * away in either direction:
   *
   *   too high (dense, loud section)  the section raises its own bar and a
   *                                   wall-of-sound chorus ends up with the
   *                                   fewest notes in the song
   *   too low  (quiet intro)          silence and room tone clear the bar and
   *                                   generate notes out of nothing
   *
   * A linear blend toward the global median fixes the first and causes the
   * second: a track with a quiet intro and a loud body detects nothing at all
   * for the first minute. Clamping keeps the threshold locally adaptive within
   * a sane band instead of trading one failure for the other.
   */
  minReferenceRatio: number;
  maxReferenceRatio: number;
}

/**
 * Tuned by sweeping against a rock track and measuring the correlation between
 * per-second loudness and per-second onset count — a chart should get busier
 * where the music does. The original values scored -0.04 (i.e. the chorus had
 * the *fewest* notes); these score about +0.75 while leaving roughly 5 onsets
 * per second for the generator to choose from.
 */
export const DEFAULT_ONSET_OPTIONS: OnsetOptions = {
  frameSize: 2048,
  hopSize: 512,
  thresholdMultiplier: 1.25,
  medianWindowFrames: 20,
  minSeparationSec: 0.045,
  // Swept against two opposing failure cases: a track with a loud wall-of-sound
  // chorus (which must not starve itself) and one with a quiet intro under a
  // loud body (which must not go silent for a minute). Below 0.6 the loudness
  // correlation collapses; at 0.75 and above the quiet intro goes dead for its
  // first 32 seconds. 0.6 / 1.2 is the point that satisfies both.
  minReferenceRatio: 0.6,
  maxReferenceRatio: 1.2,
};

/**
 * Band edges in Hz, chosen to line up with drum-kit anatomy so that lane
 * assignment maps onto what the player hears: kick, snare/body, hats/melody.
 */
const LOW_MIN_HZ = 20;
const LOW_MAX_HZ = 250;
const MID_MAX_HZ = 2000;
const HIGH_MAX_HZ = 16000;

export interface OnsetAnalysis {
  onsets: Onset[];
  /** Onset detection function, one value per frame. Reused by tempo estimation. */
  odf: Float64Array;
  odfHopSec: number;
  /**
   * Seconds from an ODF frame index to the centre of the audio it describes.
   * Tempo estimation must add this too, so beats and onsets share a timebase.
   */
  odfOriginSec: number;
}

export function detectOnsets(
  pcm: Float32Array,
  sampleRate: number,
  opts: OnsetOptions = DEFAULT_ONSET_OPTIONS,
): OnsetAnalysis {
  const { frameSize, hopSize } = opts;
  const fft = new FFT(frameSize);
  const window = hannWindow(frameSize);
  const bins = frameSize / 2;
  const hzPerBin = sampleRate / frameSize;

  const binAt = (hz: number): number =>
    Math.max(0, Math.min(bins - 1, Math.round(hz / hzPerBin)));
  const lowLo = binAt(LOW_MIN_HZ);
  const lowHi = binAt(LOW_MAX_HZ);
  const midHi = binAt(MID_MAX_HZ);
  const highHi = binAt(HIGH_MAX_HZ);

  // Bands are compared as energy *density*, not as summed magnitude. The bands
  // cover wildly different bin counts — roughly 12 bins below 250Hz against
  // ~650 above 2kHz — so summing raw magnitude measures bandwidth rather than
  // tone, and the widest band wins even for a pure bass note.
  const lowBins = Math.max(1, lowHi - lowLo + 1);
  const midBins = Math.max(1, midHi - lowHi);
  const highBins = Math.max(1, highHi - midHi);

  const frameCount = Math.max(0, Math.floor((pcm.length - frameSize) / hopSize) + 1);
  const odf = new Float64Array(frameCount);
  const bandLow = new Float64Array(frameCount);
  const bandMid = new Float64Array(frameCount);
  const bandHigh = new Float64Array(frameCount);

  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  let prevMag = new Float64Array(bins);
  let mag = new Float64Array(bins);

  for (let f = 0; f < frameCount; f++) {
    const start = f * hopSize;
    for (let i = 0; i < frameSize; i++) {
      re[i] = pcm[start + i]! * window[i]!;
      im[i] = 0;
    }
    fft.transform(re, im);

    let flux = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    for (let b = 0; b < bins; b++) {
      const m = Math.hypot(re[b]!, im[b]!);
      mag[b] = m;

      // Half-wave rectified difference: only energy *increases* signal an onset.
      const d = m - prevMag[b]!;
      if (d > 0) flux += d;

      if (b >= lowLo && b <= lowHi) low += m;
      else if (b > lowHi && b <= midHi) mid += m;
      else if (b > midHi && b <= highHi) high += m;
    }

    odf[f] = flux;
    bandLow[f] = low / lowBins;
    bandMid[f] = mid / midBins;
    bandHigh[f] = high / highBins;

    const swap = prevMag;
    prevMag = mag;
    mag = swap;
  }

  const odfHopSec = hopSize / sampleRate;
  // Frame f covers samples [f*hop, f*hop+frameSize). A transient anywhere in
  // that window raises the flux, so reporting the window *start* times every
  // onset early by up to a full window. Reporting the centre removes that bias.
  const odfOriginSec = frameSize / 2 / sampleRate;
  const peaks = pickPeaks(odf, odfHopSec, opts);

  // Normalize strength against the 95th percentile rather than the max, so a
  // single loud transient does not crush every other onset toward zero.
  const sorted = peaks.map((p) => odf[p]!).sort((a, b) => a - b);
  const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)]! : 1;
  const scale = p95 > 0 ? p95 : 1;

  // Each onset is ranked within its OWN band's distribution across the track,
  // then the three ranks are compared.
  //
  // Comparing band energies directly asks "which band is loudest?", and the
  // answer is a property of the mix, not of the moment — a bright, hat-forward
  // master answers "high" on essentially every onset and collapses the whole
  // chart into one lane. Ranking asks "which band is this hit most exceptional
  // in, relative to every other hit in this song?", which is invariant to
  // overall brightness, per-band scaling, and bin counts alike, and cannot
  // degenerate to a constant answer the way an absolute comparison can.
  const lowRanks = percentileRanks(peaks.map((f) => bandLow[f]!));
  const midRanks = percentileRanks(peaks.map((f) => bandMid[f]!));
  const highRanks = percentileRanks(peaks.map((f) => bandHigh[f]!));

  const onsets: Onset[] = peaks.map((f, i) => {
    // The epsilon keeps the shares defined when every rank is zero.
    const low = (lowRanks[i] ?? 0) + 0.02;
    const mid = (midRanks[i] ?? 0) + 0.02;
    const high = (highRanks[i] ?? 0) + 0.02;
    const norm = low + mid + high;
    return {
      t: f * odfHopSec + odfOriginSec,
      strength: Math.min(1, odf[f]! / scale),
      low: low / norm,
      mid: mid / norm,
      high: high / norm,
    };
  });

  return { onsets, odf, odfHopSec, odfOriginSec };
}

/**
 * Map each value to its rank within the set, scaled to 0..1.
 *
 * Scale-free by construction: any monotonic change to a band — a brighter
 * master, a different bin count, a gain change — leaves the ranks untouched.
 * Exported because lane assignment ranks spectral centroids with exactly the
 * same reasoning (charts/generate.ts).
 */
export function percentileRanks(values: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];

  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(n).fill(0);
  for (let rank = 0; rank < n; rank++) {
    out[order[rank]!.i] = rank / (n - 1);
  }
  return out;
}

/** Local maxima above an adaptive median threshold, thinned by minimum spacing. */
function pickPeaks(odf: Float64Array, hopSec: number, opts: OnsetOptions): number[] {
  const n = odf.length;
  if (n === 0) return [];

  const w = opts.medianWindowFrames;
  const minGapFrames = Math.max(1, Math.round(opts.minSeparationSec / hopSec));

  let mean = 0;
  for (let i = 0; i < n; i++) mean += odf[i]!;
  mean /= n;
  // Floor the threshold so near-silent passages do not generate onsets from noise.
  const floor = mean * 0.1;

  // Track-wide reference level, blended with the local median below so that a
  // loud dense section cannot raise its own bar out of reach.
  const sortedOdf = Float64Array.from(odf).sort();
  const globalMedian = sortedOdf[sortedOdf.length >> 1] ?? 0;
  const referenceFloor = globalMedian * opts.minReferenceRatio;
  const referenceCeiling = globalMedian * opts.maxReferenceRatio;

  const scratch: number[] = [];
  const peaks: number[] = [];
  let lastPeak = -Infinity;

  for (let i = 1; i < n - 1; i++) {
    const v = odf[i]!;
    if (v < odf[i - 1]! || v <= odf[i + 1]!) continue;

    scratch.length = 0;
    const lo = Math.max(0, i - w);
    const hi = Math.min(n - 1, i + w);
    for (let j = lo; j <= hi; j++) scratch.push(odf[j]!);
    scratch.sort((a, b) => a - b);
    const median = scratch[scratch.length >> 1]!;

    const reference = Math.min(Math.max(median, referenceFloor), referenceCeiling);
    if (v < reference * opts.thresholdMultiplier + floor) continue;

    if (i - lastPeak < minGapFrames) {
      // Too close to the previous peak — keep whichever is stronger.
      const prev = peaks[peaks.length - 1];
      if (prev !== undefined && v > odf[prev]!) {
        peaks[peaks.length - 1] = i;
        lastPeak = i;
      }
      continue;
    }

    peaks.push(i);
    lastPeak = i;
  }

  return peaks;
}
