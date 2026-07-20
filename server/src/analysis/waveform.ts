import type { Waveform } from '@tap-tap/shared';

/**
 * Resolution of the cached waveform.
 *
 * 50 buckets per second is 20ms per peak — fine enough that a sixteenth note at
 * 200 BPM (75ms) still spans several buckets, so transients stay visible when
 * the editor zooms in, while a four-minute track is still only ~12k numbers.
 */
const PEAKS_PER_SECOND = 50;

/** Peak absolute amplitude per bucket, for drawing the editor timeline. */
export function computeWaveform(
  pcm: Float32Array,
  sampleRate: number,
  peaksPerSecond = PEAKS_PER_SECOND,
): Waveform {
  const samplesPerPeak = Math.max(1, Math.round(sampleRate / peaksPerSecond));
  const count = Math.ceil(pcm.length / samplesPerPeak);
  const peaks = new Array<number>(count);

  let loudest = 0;
  for (let i = 0; i < count; i++) {
    const from = i * samplesPerPeak;
    const to = Math.min(pcm.length, from + samplesPerPeak);

    // Peak rather than RMS: transients are what an editor needs to see, and
    // averaging is exactly what hides them.
    let peak = 0;
    for (let s = from; s < to; s++) {
      const value = Math.abs(pcm[s]!);
      if (value > peak) peak = value;
    }

    peaks[i] = peak;
    if (peak > loudest) loudest = peak;
  }

  // Normalize so quietly-mastered tracks still fill the timeline.
  const scale = loudest > 0 ? 1 / loudest : 1;
  for (let i = 0; i < count; i++) {
    peaks[i] = Number((peaks[i]! * scale).toFixed(3));
  }

  return { secondsPerPeak: samplesPerPeak / sampleRate, peaks };
}
