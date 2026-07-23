import type { Onset, Waveform } from '@tap-tap/shared';

/**
 * Finds sustained sounds — the spans that become hold notes.
 *
 * **Reads the cached `Waveform`, not new analysis output.** That is the whole
 * reason holds can be added to the existing library: `analysis.json` is what
 * lets `regenerateCharts` skip decoding, so putting sustain spans in there would
 * mean re-analysing every song already ingested. The waveform is already stored
 * per song, and the server rebuilds it on demand for songs from before it was
 * cached. 50 buckets/second is 20ms — ample for deciding whether energy holds.
 *
 * The onset pool cannot answer this on its own: it records *attacks*, and a
 * sustain is defined by what happens between them.
 */

export interface Sustain {
  /** Start time, matching the onset it grew from. */
  t: number;
  /** Seconds. */
  duration: number;
  /**
   * 0..1 — how level the envelope stayed, late energy against early energy.
   * Used to rank candidates when a chart wants fewer holds than it found.
   */
  steadiness: number;
}

export interface SustainOptions {
  /** Shorter than this is not worth holding. */
  minSec?: number;
  /** Longer than this is trimmed; nothing musical needs a 20-second hold. */
  maxSec?: number;
  /** Strength percentile above which an onset ends a sustain. See INTERRUPT_PERCENTILE. */
  interruptPercentile?: number;
}

const DEFAULT_MIN_SEC = 0.45;
const DEFAULT_MAX_SEC = 4;

/**
 * How far the envelope may fall from the attack before the sound is over.
 *
 * This alone is not a sustain test — a decaying drum passes it for a while —
 * it only bounds how far forward to look.
 */
const FLOOR_SHARE = 0.4;

/**
 * The actual discriminator: late energy against early energy.
 *
 * **This is what separates a held note from a decay tail**, and it is the whole
 * point of the module. A cymbal or a piano note stays above `FLOOR_SHARE` for a
 * long time while falling steadily the entire way; a held vocal or a pad
 * plateaus. Requiring the back third to still carry most of the front third's
 * energy accepts the second and rejects the first.
 *
 * Measured against synthetic envelopes rather than guessed, and it has real
 * margin either side — this is not a knife edge:
 *
 *   exponential decay, tau 0.3s .. 5s   all rejected
 *   exponential decay, tau 8s           accepted (flat over any window we look at)
 *   plateau fading 0 .. 20%/sec         accepted
 *   plateau fading 30%/sec or faster    rejected
 */
const MIN_STEADINESS = 0.68;

/** Peak amplitude below this is background, and a "sustain" there is noise. */
const MIN_ATTACK = 0.16;

/** Buckets after the onset used to measure the attack level. ~60ms. */
const ATTACK_BUCKETS = 3;

/** Leave this much room before the interrupting onset, so spans do not run into it. */
const NEXT_ONSET_MARGIN_SEC = 0.06;

/**
 * Only onsets this strong, *relative to the song*, end a sustain.
 *
 * The first version stopped at the very next onset, on the reasoning that past
 * a new attack the energy belongs to the next sound. That is true of a solo
 * instrument and false of every real mix: a held vocal rings straight through
 * the drums, and the onset stream is mostly percussion. Measured on the
 * library, onsets fire every 80-130ms and only 0.5-2.2% of gaps reach even
 * 0.4s — so that rule capped essentially every sustain below the minimum hold
 * length, and the feature yielded 0.4% holds.
 *
 * A quiet hi-hat tick does not end a pad; a downbeat does. Expressed as a
 * **percentile of the song's own onset strengths** rather than an absolute,
 * for the same reason lane assignment is (§2.1): absolute energy describes the
 * mix, not the moment, so a fixed threshold means something different on every
 * master.
 *
 * Measured across the library, hold share of all notes:
 *
 *   stop at every onset      easy 0.0%   hard 0.4%   (the feature did not exist)
 *   stop above p75 strength  easy ~9%    hard 10-18%
 *
 * And it still varies with the music, which is the sign it is measuring
 * something real: "Could You Be Loved" — dense, percussive, genuinely little
 * sustain — stays at ~1% while "Nothing Else Matters" fills up.
 */
const INTERRUPT_PERCENTILE = 0.75;

function strengthAtPercentile(onsets: readonly Onset[], percentile: number): number {
  if (onsets.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = onsets.map((onset) => onset.strength).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))] ?? 0;
}

function meanOf(peaks: readonly number[], from: number, to: number): number {
  const start = Math.max(0, from);
  const end = Math.min(peaks.length, to);
  if (end <= start) return 0;

  let sum = 0;
  for (let i = start; i < end; i++) sum += peaks[i] ?? 0;
  return sum / (end - start);
}

/**
 * Sustains, one at most per onset, ordered by time.
 *
 * Pure and synchronous: given a waveform and onsets it always returns the same
 * spans, which is what lets it be tested against synthetic envelopes with known
 * shapes rather than by listening to a song.
 */
export function detectSustains(
  waveform: Waveform,
  onsets: readonly Onset[],
  options: SustainOptions = {},
): Sustain[] {
  const minSec = options.minSec ?? DEFAULT_MIN_SEC;
  const maxSec = options.maxSec ?? DEFAULT_MAX_SEC;

  const { peaks, secondsPerPeak } = waveform;
  if (peaks.length === 0 || secondsPerPeak <= 0) return [];

  const bucketOf = (t: number): number => Math.floor(t / secondsPerPeak);
  const interruptAbove = strengthAtPercentile(onsets, options.interruptPercentile ?? INTERRUPT_PERCENTILE);
  const sustains: Sustain[] = [];

  for (let i = 0; i < onsets.length; i++) {
    const onset = onsets[i]!;
    const start = bucketOf(onset.t);
    if (start >= peaks.length) continue;

    const attack = meanOf(peaks, start, start + ATTACK_BUCKETS);
    if (attack < MIN_ATTACK) continue;

    // A sustain ends at the next *significant* attack — not merely the next
    // onset. See INTERRUPT_PERCENTILE.
    let next = Number.POSITIVE_INFINITY;
    for (let j = i + 1; j < onsets.length; j++) {
      if (onsets[j]!.strength >= interruptAbove) {
        next = onsets[j]!.t;
        break;
      }
    }
    const limit = Math.min(
      peaks.length,
      bucketOf(Math.min(onset.t + maxSec, next - NEXT_ONSET_MARGIN_SEC)),
    );

    const floor = attack * FLOOR_SHARE;
    let end = start + ATTACK_BUCKETS;
    while (end < limit && (peaks[end] ?? 0) >= floor) end++;

    const duration = (end - start) * secondsPerPeak;
    if (duration < minSec) continue;

    // Late energy against early energy. A decay fails here even though it stayed
    // above the floor the whole way; a plateau passes.
    const bodyStart = start + ATTACK_BUCKETS;
    const third = Math.max(1, Math.floor((end - bodyStart) / 3));
    const early = meanOf(peaks, bodyStart, bodyStart + third);
    const late = meanOf(peaks, end - third, end);
    const steadiness = early > 0 ? Math.min(1, late / early) : 0;
    if (steadiness < MIN_STEADINESS) continue;

    sustains.push({
      t: onset.t,
      duration: Number(duration.toFixed(3)),
      steadiness: Number(steadiness.toFixed(3)),
    });
  }

  return sustains;
}
