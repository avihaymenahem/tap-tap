/**
 * Harmonic/percussive separation by median filtering (Fitzgerald, 2010).
 *
 * The observation the method rests on is simple enough to state in a sentence:
 * **harmonic content is stable in frequency and drawn out in time, percussive
 * content is spread across frequency and brief in time.** So a median taken along
 * time preserves the harmonic part and erases transients, and a median taken along
 * frequency preserves the percussive part and erases steady tones. Those two
 * estimates are then turned into soft masks that split the original spectrogram.
 *
 * No model, no weights, no dependency — which is why it is the right tool at this
 * budget. Neural stem separators are hundreds of megabytes and minutes per song, on
 * a phone, for an app already downloading audio in the background.
 *
 * **Streaming, not whole-spectrogram.** A four-minute track is ~20,600 frames of
 * 1024 bins; holding that as Float32 is 84MB before any filtering, which is not a
 * thing to allocate inside an Android WebView. This keeps only the median window —
 * `timeFrames` frames — in a ring buffer, and therefore emits each masked frame with
 * a lag of half the window. Callers deal with the lag rather than the memory.
 */

export interface HpssOptions {
  /**
   * Median width across time, in frames. Odd.
   *
   * At a 512-sample hop and 44.1kHz each frame is 11.6ms, so 17 frames is ~200ms —
   * long enough that a drum hit is a blip inside the window and gets erased by the
   * median, short enough that a real chord change is not smeared into the one
   * before it.
   */
  timeFrames: number;
  /**
   * Median width across frequency, in bins. Odd.
   *
   * At 2048 samples and 44.1kHz each bin is ~21.5Hz, so 17 bins is ~366Hz — wide
   * enough to step over the individual partials of a tone (whose spacing is the
   * fundamental) and narrow enough not to flatten the broadband shape of a hit.
   */
  freqBins: number;
  /**
   * Mask exponent. 2 is the usual choice: it makes the split closer to a hard
   * assignment than a gentle blend, without the artefacts of a binary mask.
   */
  power: number;
}

export const DEFAULT_HPSS_OPTIONS: HpssOptions = {
  timeFrames: 17,
  freqBins: 17,
  power: 2,
};

/** Guards the mask against 0/0 where both estimates are silent. */
const EPSILON = 1e-12;

/**
 * Median of a window of `scratch[0..n-1]`, sorted in place.
 *
 * Insertion sort rather than anything cleverer: n is 17, where insertion sort beats
 * quickselect on real hardware because it is branch-predictable and touches no extra
 * memory. This runs once per bin per frame, so its constant factor is the whole cost
 * of the method.
 */
function medianInPlace(scratch: Float64Array, n: number): number {
  for (let i = 1; i < n; i++) {
    const v = scratch[i]!;
    let j = i - 1;
    while (j >= 0 && scratch[j]! > v) {
      scratch[j + 1] = scratch[j]!;
      j--;
    }
    scratch[j + 1] = v;
  }
  return scratch[n >> 1]!;
}

/**
 * Turns a stream of magnitude frames into percussive-masked ones.
 *
 * Push frames in order; each `push` returns the masked frame for the position
 * `lag` behind the one just pushed, or `null` while the window is still filling.
 * `flush` drains the tail by repeating the final frame, which is the standard edge
 * handling for a median filter and avoids inventing a fade at the end of every song.
 */
export class PercussiveMask {
  readonly bins: number;
  /** Frames of delay between pushing a frame and getting its mask back. */
  readonly lag: number;

  private readonly opts: HpssOptions;
  private readonly ring: Float64Array[];
  private readonly timeScratch: Float64Array;
  private readonly freqScratch: Float64Array;
  private readonly out: Float64Array;
  /** Next ring slot to write. */
  private cursor = 0;
  /** Frames pushed so far, saturating at the ring size. */
  private filled = 0;

  constructor(bins: number, opts: HpssOptions = DEFAULT_HPSS_OPTIONS) {
    if (opts.timeFrames % 2 === 0 || opts.freqBins % 2 === 0) {
      throw new Error('HPSS median widths must be odd');
    }
    this.bins = bins;
    this.opts = opts;
    this.lag = (opts.timeFrames - 1) / 2;
    this.ring = Array.from({ length: opts.timeFrames }, () => new Float64Array(bins));
    this.timeScratch = new Float64Array(opts.timeFrames);
    this.freqScratch = new Float64Array(opts.freqBins);
    this.out = new Float64Array(bins);
  }

  /**
   * Push one magnitude frame. Returns the masked frame `lag` positions back, or
   * `null` until enough frames have arrived to centre the window on it.
   *
   * The returned array is reused between calls — copy it if you need to keep it.
   */
  push(mag: Float64Array): Float64Array | null {
    this.ring[this.cursor]!.set(mag);
    this.cursor = (this.cursor + 1) % this.opts.timeFrames;
    if (this.filled < this.opts.timeFrames) this.filled++;
    return this.filled === this.opts.timeFrames ? this.maskCentre() : null;
  }

  /**
   * Drain the frames still inside the window, by repeating the last one pushed.
   *
   * Edge padding rather than shortening the output: a median filter has to invent
   * *something* at the boundary, and repeating the edge is the conventional choice.
   * Letting the window shrink instead would make the final frames' masks measurably
   * different from every other frame's, which reads as a burst of onsets at the end
   * of every song.
   */
  *flush(): Generator<Float64Array> {
    if (this.filled < this.opts.timeFrames) return;
    const last = this.ring[(this.cursor - 1 + this.opts.timeFrames) % this.opts.timeFrames]!;
    const tail = Float64Array.from(last);
    for (let i = 0; i < this.lag; i++) {
      const frame = this.push(tail);
      if (frame) yield frame;
    }
  }

  /** Mask for the frame at the centre of the current window. */
  private maskCentre(): Float64Array {
    const { timeFrames, freqBins, power } = this.opts;
    const half = (freqBins - 1) / 2;
    // The centre of the window is `lag` slots behind the write cursor.
    const centre = this.ring[(this.cursor - 1 - this.lag + timeFrames) % timeFrames]!;

    for (let b = 0; b < this.bins; b++) {
      // Harmonic estimate: median across time at this bin.
      for (let f = 0; f < timeFrames; f++) this.timeScratch[f] = this.ring[f]![b]!;
      const harmonic = medianInPlace(this.timeScratch, timeFrames);

      // Percussive estimate: median across frequency within the centre frame.
      // Clamped at the edges rather than wrapped — bin 0 and Nyquist are not
      // neighbours, and wrapping would mix bass into treble.
      let n = 0;
      for (let k = b - half; k <= b + half; k++) {
        const clamped = k < 0 ? 0 : k >= this.bins ? this.bins - 1 : k;
        this.freqScratch[n++] = centre[clamped]!;
      }
      const percussive = medianInPlace(this.freqScratch, n);

      const hp = harmonic ** power;
      const pp = percussive ** power;
      this.out[b] = centre[b]! * (pp / (pp + hp + EPSILON));
    }
    return this.out;
  }
}
