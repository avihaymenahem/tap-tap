/**
 * Integrated loudness, per ITU-R BS.1770 / EBU R128.
 *
 * Songs come from wherever the player pasted a link, so their levels are all
 * over the place — easily 8 LU apart between two tracks in the same library.
 * That is audible as a lurch between songs, and it is what makes any fixed-level
 * sound effect impossible to balance: a hit click mixed to sit under a loud
 * master vanishes under a quiet one. Normalising is therefore a prerequisite for
 * the audio work, not a polish item.
 *
 * The measurement is arithmetic over a buffer that is already being decoded at
 * ingest, so it costs one extra pass and no dependency — the same reason the FFT
 * and the beat tracker are hand-rolled here.
 *
 * **What is stored is a gain, never a re-encode.** See `replayGainDb`.
 *
 * Two honest caveats, both consequences of where this sits in the pipeline:
 *
 *  - It measures the **mono downmix**, because that is what `analyze` is handed
 *    (`decodeAudio` averages the channels before anything sees them). True
 *    BS.1770 sums per-channel powers with per-channel weights; for L/R those
 *    weights are both 1.0, so a downmix differs only where the channels are
 *    decorrelated, and then by a fraction of a LU. `DUAL_MONO_GAIN` puts the
 *    result back on the same scale as a stereo measurement so the numbers are
 *    comparable with any other tool.
 *  - It is the **integrated** measurement only. Short-term and momentary
 *    loudness, and true-peak, are not computed — nothing here needs them.
 */

/** Gating and block geometry, fixed by the spec. */
const BLOCK_SEC = 0.4;
/** 75% overlap. */
const HOP_SEC = 0.1;
/** Absolute gate: blocks quieter than this contribute nothing. */
const ABSOLUTE_GATE_LUFS = -70;
/** Relative gate: blocks more than this far below the ungated mean are dropped. */
const RELATIVE_GATE_LU = -10;
/** The spec's calibration offset. */
const LOUDNESS_OFFSET = -0.691;

/**
 * +3.01 dB — a mono signal treated as identical L and R, which is twice the
 * power. Without it every track would measure ~3 LU quieter than the same track
 * measured by a stereo-aware tool, and a target lifted from any published
 * reference would be wrong by that much.
 */
const DUAL_MONO_GAIN = 10 * Math.log10(2);

/** Returned for silence — there is no finite loudness for no signal. */
export const SILENT_LUFS = Number.NEGATIVE_INFINITY;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Stage 1: the head/torso shelf, a high shelf near 1.68 kHz.
 *
 * The spec tabulates coefficients at 48 kHz only. Using those at another rate
 * puts the corner in the wrong place, so they are redesigned per rate from the
 * analogue prototype the tabulated values come from — which is what any correct
 * implementation does, and matters here because decoded rates vary.
 */
function highShelf(sampleRate: number): Biquad {
  const f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const q = 0.7071752369554196;

  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const denom = 1 + k / q + k * k;

  return {
    b0: (vh + (vb * k) / q + k * k) / denom,
    b1: (2 * (k * k - vh)) / denom,
    b2: (vh - (vb * k) / q + k * k) / denom,
    a1: (2 * (k * k - 1)) / denom,
    a2: (1 - k / q + k * k) / denom,
  };
}

/** Stage 2: the RLB high-pass at ~38 Hz, which discounts sub-bass rumble. */
function highPass(sampleRate: number): Biquad {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;

  const k = Math.tan((Math.PI * f0) / sampleRate);
  const denom = 1 + k / q + k * k;

  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / denom,
    a2: (1 - k / q + k * k) / denom,
  };
}

function biquad(input: Float32Array, c: Biquad, out: Float32Array): Float32Array {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i]!;
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

/**
 * The K-weighting pre-filter: shelf then high-pass.
 *
 * Exported so its frequency response can be measured directly in tests — the
 * filter and the gating are the two halves that can each be wrong on their own,
 * and a test that only checks the final number cannot tell which broke.
 */
export function kWeight(pcm: Float32Array, sampleRate: number): Float32Array {
  const stage1 = biquad(pcm, highShelf(sampleRate), new Float32Array(pcm.length));
  return biquad(stage1, highPass(sampleRate), stage1);
}

/**
 * Integrated loudness in LUFS, or `SILENT_LUFS` for silence.
 *
 * The two-pass gate is the part worth understanding: an absolute floor first,
 * then a relative one computed from what survived it. Without the relative gate
 * a track with long quiet passages measures far quieter than it sounds, because
 * the silence is averaged in — which for this library would mean a ballad with
 * an ambient intro getting boosted until its chorus clipped.
 */
export function integratedLoudness(pcm: Float32Array, sampleRate: number): number {
  if (pcm.length === 0 || sampleRate <= 0) return SILENT_LUFS;

  const blockLen = Math.round(BLOCK_SEC * sampleRate);
  const hopLen = Math.round(HOP_SEC * sampleRate);
  if (blockLen <= 0 || hopLen <= 0 || pcm.length < blockLen) return SILENT_LUFS;

  const weighted = kWeight(pcm, sampleRate);

  // Mean square per block. Held as power, not dB: the gates compare in dB but
  // the final average must be over power, and averaging dB would be wrong.
  const powers: number[] = [];
  for (let start = 0; start + blockLen <= weighted.length; start += hopLen) {
    let sum = 0;
    for (let i = start; i < start + blockLen; i++) {
      const v = weighted[i]!;
      sum += v * v;
    }
    powers.push(sum / blockLen);
  }
  if (powers.length === 0) return SILENT_LUFS;

  const loudnessOf = (power: number): number =>
    power > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(power) + DUAL_MONO_GAIN : SILENT_LUFS;

  // Pass 1 — absolute gate.
  const aboveAbsolute = powers.filter((p) => loudnessOf(p) > ABSOLUTE_GATE_LUFS);
  if (aboveAbsolute.length === 0) return SILENT_LUFS;

  const meanPower = (ps: number[]): number => ps.reduce((s, p) => s + p, 0) / ps.length;

  // Pass 2 — relative gate, referenced to the ungated mean of what survived.
  const relativeThreshold = loudnessOf(meanPower(aboveAbsolute)) + RELATIVE_GATE_LU;
  const gated = aboveAbsolute.filter((p) => loudnessOf(p) > relativeThreshold);
  if (gated.length === 0) return SILENT_LUFS;

  return loudnessOf(meanPower(gated));
}

/**
 * Streaming services land around -14 LUFS and it is a sensible target here too:
 * loud enough to use the output range, quiet enough that a dense master has
 * headroom left rather than being pulled down hard.
 */
export const TARGET_LUFS = -14;

/**
 * How much to turn a track up or down, in dB, to reach `target`.
 *
 * **Applied at playback as a gain — the audio file is never re-encoded.** A gain
 * is one number and reversible; a re-encode destroys the original irreversibly,
 * adds a generation of lossy loss, and makes re-tuning the target later mean
 * re-downloading the whole library.
 *
 * Clamped, because the measurement can be misled: a track that is mostly silence
 * with one loud moment, or a badly mastered upload, would otherwise ask for a
 * boost that clips everything. Attenuation is allowed to go further than boost
 * for the same reason — turning something down cannot clip it.
 */
export const MAX_BOOST_DB = 6;
export const MAX_CUT_DB = -18;

export function replayGainDb(lufs: number, target: number = TARGET_LUFS): number {
  if (!Number.isFinite(lufs)) return 0;
  return Math.max(MAX_CUT_DB, Math.min(MAX_BOOST_DB, target - lufs));
}

/** dB to a linear multiplier, for a `GainNode`. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}
