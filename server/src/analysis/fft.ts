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

/** Periodic Hann window of the given length. */
export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  return w;
}
