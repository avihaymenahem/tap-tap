/**
 * Browser-side audio decode for on-device ingest (PLAN.md §6h).
 *
 * The server decodes with ffmpeg; the browser has `decodeAudioData`, which also
 * resamples to the decoding context's sample rate for free. Decoding on an
 * `OfflineAudioContext` created at the analysis rate therefore hands
 * `@tap-tap/core` the exact `Float32Array` shape the ffmpeg path produces — the
 * whole reason the same analysis can run on device without a re-implementation.
 */

/** The slice of `AudioBuffer` the downmix needs. Narrow on purpose so it is testable without Web Audio. */
export interface AudioBufferLike {
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * Average every channel into one.
 *
 * Analysis is mono — a stereo pass would double the FFT work for a result the
 * chart generator collapses anyway. A single channel is copied out rather than
 * returned by reference so the caller owns a detached buffer it can transfer.
 */
export function downmixToMono(buffer: AudioBufferLike): Float32Array {
  const { numberOfChannels, length } = buffer;
  if (numberOfChannels <= 1) return Float32Array.from(buffer.getChannelData(0));

  const mono = new Float32Array(length);
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) mono[i] += data[i]!;
  }
  const scale = 1 / numberOfChannels;
  for (let i = 0; i < length; i++) mono[i]! *= scale;
  return mono;
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

/**
 * Decode compressed audio (m4a/webm/…) to mono PCM at `sampleRate`.
 *
 * `decodeAudioData` resamples to the context's sample rate, so an
 * `OfflineAudioContext` at the analysis rate yields PCM ready for the analyzer
 * with no separate resample step. Note the input `ArrayBuffer` is detached by
 * `decodeAudioData`; pass a copy (`buf.slice(0)`) if the original is still
 * needed for playback storage.
 */
export async function decodeAudioToMonoPcm(
  data: ArrayBuffer,
  sampleRate: number,
): Promise<Float32Array> {
  const Offline =
    (globalThis as { OfflineAudioContext?: OfflineCtor }).OfflineAudioContext ??
    (globalThis as { webkitOfflineAudioContext?: OfflineCtor }).webkitOfflineAudioContext;
  if (!Offline) {
    throw new Error('Web Audio is unavailable — cannot decode audio in this context.');
  }
  // Length must be >= 1; decodeAudioData ignores it and sizes the result itself.
  const ctx = new Offline(1, 1, sampleRate);
  const buffer = await ctx.decodeAudioData(data);
  return downmixToMono(buffer);
}
