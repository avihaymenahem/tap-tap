/**
 * Radix-2 Cooley-Tukey FFT.
 *
 * Written out rather than pulled from npm because the analysis pipeline is the
 * part of this project most likely to need tuning, and an opaque dependency in
 * the middle of it would make that harder. Twiddle factors and the bit-reversal
 * permutation are precomputed once per size and reused across every frame.
 */

export class FFT {
  readonly size: number;
  private readonly levels: number;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly reverse: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.levels = Math.log2(size) | 0;

    this.cosTable = new Float64Array(size / 2);
    this.sinTable = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }

    this.reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let j = 0; j < this.levels; j++) {
        r |= ((i >>> j) & 1) << (this.levels - 1 - j);
      }
      this.reverse[i] = r >>> 0;
    }
  }

  /** In-place complex transform. `re` and `im` must both have length `size`. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    if (re.length !== n || im.length !== n) {
      throw new Error('FFT input length must equal FFT size');
    }

    for (let i = 0; i < n; i++) {
      const j = this.reverse[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }

    for (let halfSize = 1; halfSize < n; halfSize *= 2) {
      const step = n / (halfSize * 2);
      for (let i = 0; i < n; i += halfSize * 2) {
        for (let j = i, k = 0; j < i + halfSize; j++, k += step) {
          const l = j + halfSize;
          const cos = this.cosTable[k]!;
          const sin = this.sinTable[k]!;
          const tre = re[l]! * cos + im[l]! * sin;
          const tim = -re[l]! * sin + im[l]! * cos;
          re[l] = re[j]! - tre;
          im[l] = im[j]! - tim;
          re[j] = re[j]! + tre;
          im[j] = im[j]! + tim;
        }
      }
    }
  }
}

/**
 * FFT specialised for real-valued input — half the transform size for the same
 * spectrum.
 *
 * Audio samples are real, so feeding them to a complex FFT wastes half the work:
 * the imaginary input is all zeros and the output is conjugate-symmetric, so the
 * upper half of the spectrum is redundant. The standard packing trick computes an
 * N-point real transform with an N/2-point complex one — pack the even samples
 * into the real part and the odd samples into the imaginary part, transform, then
 * untangle. Analysis runs one transform per hop across an entire track, on a
 * phone, so halving it is worth the twenty lines.
 *
 * Produces bins 0..N/2-1, which is exactly what `detectOnsets` consumes. The
 * Nyquist bin is not emitted; nothing here uses it.
 */
export class RealFFT {
  /** Length of the real input this accepts. */
  readonly size: number;
  private readonly half: number;
  private readonly inner: FFT;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly packRe: Float64Array;
  private readonly packIm: Float64Array;

  constructor(size: number) {
    if (size < 4 || (size & (size - 1)) !== 0) {
      throw new Error(`RealFFT size must be a power of two >= 4, got ${size}`);
    }
    this.size = size;
    this.half = size / 2;
    this.inner = new FFT(this.half);
    this.packRe = new Float64Array(this.half);
    this.packIm = new Float64Array(this.half);

    // Twiddles at the *full* size, applied during the untangle.
    this.cosTable = new Float64Array(this.half);
    this.sinTable = new Float64Array(this.half);
    for (let k = 0; k < this.half; k++) {
      this.cosTable[k] = Math.cos((-2 * Math.PI * k) / size);
      this.sinTable[k] = Math.sin((-2 * Math.PI * k) / size);
    }
  }

  /**
   * Transform `input` (length `size`) into `outRe`/`outIm` (length `size / 2`).
   *
   * Output matches a full complex transform of the same signal bin for bin, to
   * floating-point tolerance — `fft.test.ts` asserts exactly that, because a
   * subtly wrong spectrum would not throw, it would just quietly shift every
   * onset in the library.
   */
  transform(input: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
    const n = this.size;
    const h = this.half;
    if (input.length !== n) throw new Error('RealFFT input length must equal size');
    if (outRe.length < h || outIm.length < h) {
      throw new Error('RealFFT output arrays must hold size / 2 bins');
    }

    // z[j] = x[2j] + i·x[2j+1]
    for (let j = 0; j < h; j++) {
      this.packRe[j] = input[2 * j]!;
      this.packIm[j] = input[2 * j + 1]!;
    }
    this.inner.transform(this.packRe, this.packIm);

    const zr = this.packRe;
    const zi = this.packIm;
    for (let k = 0; k < h; k++) {
      // Z[h] wraps to Z[0] by periodicity, which is what makes k = 0 work.
      const m = (h - k) % h;
      // Even-sample transform: Xe = (Z[k] + conj(Z[h-k])) / 2
      const evenRe = 0.5 * (zr[k]! + zr[m]!);
      const evenIm = 0.5 * (zi[k]! - zi[m]!);
      // Odd-sample transform: Xo = -i·(Z[k] - conj(Z[h-k])) / 2
      const oddRe = 0.5 * (zi[k]! + zi[m]!);
      const oddIm = -0.5 * (zr[k]! - zr[m]!);

      // X[k] = Xe[k] + e^{-2πik/N}·Xo[k]
      const c = this.cosTable[k]!;
      const s = this.sinTable[k]!;
      outRe[k] = evenRe + (oddRe * c - oddIm * s);
      outIm[k] = evenIm + (oddRe * s + oddIm * c);
    }
  }
}

/** Periodic Hann window of the given length. */
export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  return w;
}
